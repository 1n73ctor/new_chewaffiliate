'use strict';
// Support tickets from the Help page (Vanessa's queue).
const router = require('express').Router();
const db = require('../../db');
const audit = require('../../lib/audit');
const { requirePerm } = require('../../lib/auth');
const { sendEmail } = require('../../lib/notify');
const { TICKET_STATUSES } = require('../../lib/constants');
const { paginate, clampStr } = require('../../lib/util');

router.get('/tickets', requirePerm('tickets.view'), (req, res) => {
  const status = TICKET_STATUSES[req.query.status] ? req.query.status : req.query.status === 'all' ? '' : 'open';
  const w = status ? 'WHERE t.status = ?' : '';
  const params = status ? [status] : [];
  const total = db.get(`SELECT COUNT(*) AS n FROM support_tickets t ${w}`, ...params).n;
  const pg = paginate(total, req.query.page, 30);
  const rows = db.all(
    `SELECT t.*, u.affiliate_id, a.first_name AS assignee FROM support_tickets t
     LEFT JOIN users u ON u.id = t.user_id LEFT JOIN users a ON a.id = t.assigned_to
     ${w} ORDER BY t.id DESC LIMIT ${pg.perPage} OFFSET ${pg.offset}`,
    ...params,
  );
  const counts = Object.fromEntries(db.all('SELECT status, COUNT(*) AS n FROM support_tickets GROUP BY status').map((r) => [r.status, r.n]));
  res.page('admin/tickets', { title: 'Support tickets', nav: 'tickets', rows, status, pg, counts });
});

function loadTicket(req, res, next) {
  req.ticket = db.get('SELECT * FROM support_tickets WHERE id = ?', Number(req.params.id) || 0);
  if (!req.ticket) return next('route');
  next();
}

router.get('/tickets/:id(\\d+)', requirePerm('tickets.view'), loadTicket, (req, res) => {
  const t = req.ticket;
  const account = t.user_id
    ? db.get('SELECT * FROM users WHERE id = ?', t.user_id)
    : db.get('SELECT * FROM users WHERE email = ?', t.email);
  res.page('admin/ticket', {
    title: `Ticket #${t.id}`,
    nav: 'tickets',
    t,
    account,
    notes: db.all('SELECT n.*, u.first_name AS author FROM ticket_notes n LEFT JOIN users u ON u.id = n.author_id WHERE n.ticket_id = ? ORDER BY n.id', t.id),
    staff: db.all("SELECT id, first_name, last_name, role FROM users WHERE role IN ('admin','support') AND status = 'active' ORDER BY first_name"),
  });
});

router.post('/tickets/:id(\\d+)', requirePerm('tickets.manage'), loadTicket, async (req, res) => {
  const t = req.ticket;
  const reply = clampStr(req.body.reply, 5000);
  const internal = clampStr(req.body.note, 2000);
  const status = TICKET_STATUSES[req.body.status] ? req.body.status : t.status;
  const assignee = req.body.assigned_to ? Number(req.body.assigned_to) || null : null;
  if (reply) {
    await sendEmail({
      to: t.email,
      userId: t.user_id,
      subject: `Re: ${t.subject} (#${t.id})`,
      text: `Hi ${t.name || 'there'},\n\n${reply}\n\n— ${req.user.first_name}, Chew Network Support`,
    });
    db.run('INSERT INTO ticket_notes (ticket_id, author_id, body) VALUES (?, ?, ?)', t.id, req.user.id, `Replied by email:\n${reply}`);
  }
  if (internal) db.run('INSERT INTO ticket_notes (ticket_id, author_id, body) VALUES (?, ?, ?)', t.id, req.user.id, internal);
  db.run("UPDATE support_tickets SET status = ?, assigned_to = ?, updated_at = datetime('now') WHERE id = ?", status, assignee, t.id);
  audit(req, 'ticket.update', 'ticket', t.id, { status, replied: !!reply });
  res.flash('success', reply ? 'Reply sent.' : 'Ticket updated.');
  res.redirect(`/admin/tickets/${t.id}`);
});

module.exports = router;
