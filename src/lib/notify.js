'use strict';
// Email + SMS delivery. Drivers:
//   email: "smtp" when SMTP_HOST is set, otherwise "console" (logs + dev outbox)
//   sms:   "twilio" when TWILIO_ACCOUNT_SID is set, otherwise "console"
// Every message is recorded in the outbox table so support can see what was sent.
const config = require('../config');
const db = require('../db');
const settings = require('./settings');

let transport = null;
function smtp() {
  if (!transport) {
    const nodemailer = require('nodemailer');
    transport = nodemailer.createTransport({
      host: config.mail.host,
      port: config.mail.port,
      secure: config.mail.secure,
      auth: config.mail.user ? { user: config.mail.user, pass: config.mail.pass } : undefined,
    });
  }
  return transport;
}

function record({ userId, channel, recipient, subject, body, driver, status, error, sensitive }) {
  // In production never persist message bodies that contain codes or tokens.
  const storedBody = config.isProd && sensitive ? '[redacted]' : body;
  db.run(
    'INSERT INTO outbox (user_id, channel, recipient, subject, body, driver, status, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    userId || null,
    channel,
    recipient,
    subject || null,
    storedBody,
    driver,
    status,
    error || null,
  );
}

function wrapHtml(text) {
  const site = settings.get('site_name') || 'Chew Network';
  const paragraphs = String(text)
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 16px">${p.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]).replace(/\n/g, '<br>')}</p>`)
    .join('');
  return `<!doctype html><html><body style="margin:0;background:#f6f7f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1d2521">
  <div style="max-width:560px;margin:0 auto;padding:32px 20px">
    <div style="font-weight:800;font-size:20px;color:#0e4d2c;letter-spacing:.02em;margin-bottom:20px">${site.toUpperCase()}</div>
    <div style="background:#fff;border:1px solid #e3e7e4;border-radius:12px;padding:28px;font-size:16px;line-height:1.55">${paragraphs}</div>
    <p style="font-size:12px;color:#66706b;margin-top:20px">You received this because of activity on your ${site} affiliate account.</p>
  </div></body></html>`;
}

async function sendEmail({ to, subject, text, userId, sensitive = false }) {
  const driver = config.mail.driver;
  try {
    if (driver === 'smtp') {
      await smtp().sendMail({ from: config.mail.from, to, subject, text, html: wrapHtml(text) });
    } else if (!config.isTest) {
      console.log(`\n[email → ${to}] ${subject}\n${text}\n`);
    }
    record({ userId, channel: 'email', recipient: to, subject, body: text, driver, status: 'sent', sensitive });
    return true;
  } catch (err) {
    console.error('Email delivery failed:', err.message);
    record({ userId, channel: 'email', recipient: to, subject, body: text, driver, status: 'failed', error: err.message, sensitive });
    return false;
  }
}

async function sendSms({ to, body, userId, sensitive = false }) {
  const driver = config.sms.driver;
  try {
    if (driver === 'twilio') {
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${config.sms.sid}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${config.sms.sid}:${config.sms.token}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: to, From: config.sms.from, Body: body }),
      });
      if (!res.ok) throw new Error(`Twilio ${res.status}: ${(await res.text()).slice(0, 200)}`);
    } else if (!config.isTest) {
      console.log(`\n[sms → ${to}] ${body}\n`);
    }
    record({ userId, channel: 'sms', recipient: to, subject: null, body, driver, status: 'sent', sensitive });
    return true;
  } catch (err) {
    console.error('SMS delivery failed:', err.message);
    record({ userId, channel: 'sms', recipient: to, subject: null, body, driver, status: 'failed', error: err.message, sensitive });
    return false;
  }
}

const smsAvailable = () => settings.get('sms_verification') === '1';

module.exports = { sendEmail, sendSms, smsAvailable };
