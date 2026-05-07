const Database = require('better-sqlite3');
const path = require('path');

const isProd = process.env.NODE_ENV === 'production';
const dbPath = isProd ? '/tmp/bank.db' : path.resolve(__dirname, 'bank.db');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

console.log('✅ Connected to SQLite DB at', dbPath);

module.exports = {
  run: (sql, params = []) => {
    const stmt = db.prepare(sql);
    const result = stmt.run(params);
    return { lastID: result.lastInsertRowid, changes: result.changes };
  },
  get: (sql, params = []) => db.prepare(sql).get(params),
  all: (sql, params = []) => db.prepare(sql).all(params)
};
