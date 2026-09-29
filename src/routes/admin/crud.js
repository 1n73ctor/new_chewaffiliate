'use strict';
// Generic list / create / edit / delete for resources declared in resources.js.
const router = require('express').Router();
const db = require('../../db');
const audit = require('../../lib/audit');
const { can } = require('../../lib/permissions');
const { slugify, paginate, clampStr } = require('../../lib/util');
const RESOURCES = require('./resources');

function resource(req, res, next) {
  const r = RESOURCES[req.params.res];
  if (!r) return next('route');
  if (!can(req.user, r.perm)) return res.status(403).page('admin/forbidden', { title: 'No access' });
  req.resource = { ...r, key: req.params.res };
  res.locals.nav = `m-${req.params.res}`;
  next();
}

const optionList = (field) => (typeof field.options === 'function' ? field.options() : field.options || []);

// Pre-computed option labels for display in the list.
function labelMaps(r) {
  const maps = {};
  for (const f of r.fields) if (f.type === 'select') maps[f.name] = Object.fromEntries(optionList(f).map(([v, l]) => [String(v), l]));
  return maps;
}

function parse(r, body, existing = null) {
  const values = {};
  const errors = {};
  for (const f of r.fields) {
    let v = body[f.name];
    switch (f.type) {
      case 'checkbox':
        v = v === '1' ? 1 : 0;
        break;
      case 'number':
        v = v === '' || v == null ? (f.name === 'sort' ? 0 : null) : Number(v);
        if (v != null && !Number.isFinite(v)) errors[f.name] = 'Enter a number.';
        break;
      case 'money':
        v = v === '' || v == null ? 0 : Math.round(Number(String(v).replace(/[^0-9.-]/g, '')) * 100);
        if (!Number.isFinite(v) || v < 0) errors[f.name] = 'Enter an amount like 5.00';
        break;
      case 'percent':
        v = v === '' || v == null ? 0 : Math.round(Number(v) * 100);
        if (!Number.isFinite(v) || v < 0 || v > 10000) errors[f.name] = 'Enter a percentage between 0 and 100.';
        break;
      case 'select': {
        v = v == null ? '' : String(v);
        const allowed = optionList(f).map(([val]) => String(val));
        if (v && !allowed.includes(v)) errors[f.name] = 'Choose a valid option.';
        if (!v) v = null;
        break;
      }
      case 'slug':
        v = slugify(v || body[f.from] || (existing && existing[f.name]) || '');
        if (!v) errors[f.name] = 'Required.';
        break;
      case 'url':
        v = clampStr(v, 500) || null;
        if (v && !/^(https?:\/\/|\/(?!\/))/i.test(v)) errors[f.name] = 'Use a full https:// URL or a path starting with /.';
        break;
      case 'date':
        v = clampStr(v, 10) || null;
        if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) errors[f.name] = 'Use YYYY-MM-DD.';
        break;
      default:
        v = clampStr(v, f.type === 'markdown' || f.type === 'textarea' ? 20000 : 300);
        if (v === '') v = f.default != null && !existing ? f.default : null;
    }
    if (f.required && (v == null || v === '')) errors[f.name] = errors[f.name] || 'Required.';
    values[f.name] = v;
  }
  if (!Object.keys(errors).length && r.validate) {
    const problem = r.validate(values);
    if (problem) errors._ = problem;
  }
  return { values, errors };
}

function listQuery(r, q) {
  const where = [];
  const params = [];
  if (q.search && r.search) {
    where.push('(' + r.search.map((c) => `${c} LIKE ?`).join(' OR ') + ')');
    r.search.forEach(() => params.push(`%${q.search}%`));
  }
  for (const f of r.filters || []) {
    if (q[f] != null && q[f] !== '') {
      where.push(`${f} = ?`);
      params.push(q[f]);
    }
  }
  return { where: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

router.get('/:res', resource, (req, res) => {
  const r = req.resource;
  const q = { search: clampStr(req.query.q, 80) };
  for (const f of r.filters || []) q[f] = req.query[f] || '';
  const { where, params } = listQuery(r, q);
  const total = db.get(`SELECT COUNT(*) AS n FROM ${r.table} ${where}`, ...params).n;
  const pg = paginate(total, req.query.page, r.perPage || 25);
  const rows = db.all(`SELECT * FROM ${r.table} ${where} ORDER BY ${r.order} LIMIT ${pg.perPage} OFFSET ${pg.offset}`, ...params);
  res.page('admin/crud-list', {
    title: r.title,
    r,
    rows,
    q,
    pg,
    maps: labelMaps(r),
    fieldsByName: Object.fromEntries(r.fields.map((f) => [f.name, f])),
    filterFields: (r.filters || []).map((name) => ({ ...r.fields.find((f) => f.name === name), options: optionList(r.fields.find((f) => f.name === name)) })),
    inlineField: r.inline ? { ...r.fields.find((f) => f.name === r.inline), options: optionList(r.fields.find((f) => f.name === r.inline)) } : null,
  });
});

function renderForm(req, res, row, errors = {}, status = 200) {
  const r = req.resource;
  res.status(status).page('admin/crud-form', {
    title: row.id ? `Edit ${r.singular}` : `New ${r.singular}`,
    r,
    row,
    errors,
    fields: r.fields.map((f) => ({ ...f, options: f.type === 'select' ? optionList(f) : null })),
  });
}

router.get('/:res/new', resource, (req, res) => {
  const row = {};
  for (const f of req.resource.fields) if (f.default != null) row[f.name] = f.default;
  renderForm(req, res, row);
});

router.post('/:res', resource, (req, res) => {
  const r = req.resource;
  const { values, errors } = parse(r, req.body);
  if (Object.keys(errors).length) return renderForm(req, res, { ...req.body, ...values }, errors, 422);
  const cols = Object.keys(values);
  try {
    const { lastInsertRowid: id } = db.run(`INSERT INTO ${r.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => values[c]));
    audit(req, `${r.key}.create`, r.table, id, values);
    res.flash('success', `Saved ${r.singular}.`);
    res.redirect(`/admin/m/${r.key}`);
  } catch (err) {
    if (!String(err.message).includes('UNIQUE')) throw err;
    renderForm(req, res, values, { _: 'That value is already used — slugs and keys must be unique.' }, 422);
  }
});

router.post('/:res/bulk', resource, (req, res) => {
  const r = req.resource;
  const field = r.inline && r.fields.find((f) => f.name === r.inline);
  const ids = [].concat(req.body.ids || []).map(Number).filter(Boolean);
  const value = String(req.body.value || '');
  if (field && ids.length && optionList(field).some(([v]) => String(v) === value)) {
    db.tx(() => {
      for (const id of ids) db.run(`UPDATE ${r.table} SET ${field.name} = ?${r.touch ? ", updated_at = datetime('now')" : ''} WHERE id = ?`, value, id);
    });
    audit(req, `${r.key}.bulk_${field.name}`, r.table, ids.join(','), { value });
    res.flash('success', `Updated ${ids.length} ${r.singular}${ids.length > 1 ? 's' : ''}.`);
  } else {
    res.flash('error', 'Select at least one row and a value.');
  }
  res.redirect(`/admin/m/${r.key}?${new URLSearchParams(req.body.back || '').toString()}`);
});

router.get('/:res/:id(\\d+)', resource, (req, res, next) => {
  const row = db.get(`SELECT * FROM ${req.resource.table} WHERE id = ?`, req.params.id);
  if (!row) return next();
  renderForm(req, res, row);
});

router.post('/:res/:id(\\d+)', resource, (req, res, next) => {
  const r = req.resource;
  const existing = db.get(`SELECT * FROM ${r.table} WHERE id = ?`, req.params.id);
  if (!existing) return next();
  const { values, errors } = parse(r, req.body, existing);
  if (Object.keys(errors).length) return renderForm(req, res, { ...existing, ...values }, errors, 422);
  const cols = Object.keys(values);
  try {
    db.run(
      `UPDATE ${r.table} SET ${cols.map((c) => `${c} = ?`).join(', ')}${r.touch ? ", updated_at = datetime('now')" : ''} WHERE id = ?`,
      ...cols.map((c) => values[c]),
      existing.id,
    );
  } catch (err) {
    if (!String(err.message).includes('UNIQUE')) throw err;
    return renderForm(req, res, { ...existing, ...values }, { _: 'That value is already used — slugs and keys must be unique.' }, 422);
  }
  audit(req, `${r.key}.update`, r.table, existing.id, values);
  res.flash('success', `Saved ${r.singular}.`);
  res.redirect(`/admin/m/${r.key}`);
});

router.post('/:res/:id(\\d+)/inline', resource, (req, res) => {
  const r = req.resource;
  const field = r.inline && r.fields.find((f) => f.name === r.inline);
  const value = String(req.body.value || '');
  if (field && optionList(field).some(([v]) => String(v) === value)) {
    db.run(`UPDATE ${r.table} SET ${field.name} = ?${r.touch ? ", updated_at = datetime('now')" : ''} WHERE id = ?`, value, req.params.id);
    audit(req, `${r.key}.${field.name}`, r.table, req.params.id, { value });
    res.flash('success', 'Updated.');
  }
  res.redirect(`/admin/m/${r.key}?${new URLSearchParams(req.body.back || '').toString()}`);
});

router.post('/:res/:id(\\d+)/delete', resource, (req, res) => {
  const r = req.resource;
  try {
    db.run(`DELETE FROM ${r.table} WHERE id = ?`, req.params.id);
    audit(req, `${r.key}.delete`, r.table, req.params.id);
    res.flash('success', `Deleted ${r.singular}.`);
  } catch (err) {
    if (!String(err.message).includes('FOREIGN KEY')) throw err;
    res.flash('error', `This ${r.singular} is still in use, so it can’t be deleted. Deactivate or unpublish it instead.`);
  }
  res.redirect(`/admin/m/${r.key}`);
});

module.exports = router;
