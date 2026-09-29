'use strict';
// Development-only helpers (not mounted when NODE_ENV=production).
const router = require('express').Router();
const db = require('../db');

// Read verification codes / emails sent by the console driver.
router.get('/outbox', (req, res) => {
  const messages = db.all('SELECT * FROM outbox ORDER BY id DESC LIMIT 50');
  res.page('public/dev-outbox', { title: 'Dev outbox', messages });
});

module.exports = router;
