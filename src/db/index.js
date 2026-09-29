'use strict';
const Database = require('better-sqlite3');
const config = require('../config');
const migrations = require('./migrations');

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

function migrate() {
  const current = db.pragma('user_version', { simple: true });
  migrations.forEach((sql, i) => {
    const version = i + 1;
    if (version <= current) return;
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${version}`);
    })();
  });
}

const cache = new Map();
function stmt(sql) {
  let s = cache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    cache.set(sql, s);
  }
  return s;
}

module.exports = {
  raw: db,
  migrate,
  get: (sql, ...params) => stmt(sql).get(...params),
  all: (sql, ...params) => stmt(sql).all(...params),
  run: (sql, ...params) => stmt(sql).run(...params),
  tx: (fn) => db.transaction(fn)(),
};
