'use strict';
const db = require('../db');

function audit(req, action, targetType = null, targetId = null, detail = null) {
  db.run(
    'INSERT INTO audit_log (actor_id, action, target_type, target_id, detail, ip) VALUES (?, ?, ?, ?, ?, ?)',
    req && req.user ? req.user.id : null,
    action,
    targetType,
    targetId == null ? null : String(targetId),
    detail == null ? null : typeof detail === 'string' ? detail : JSON.stringify(detail),
    req ? req.ip : null,
  );
}

module.exports = audit;
