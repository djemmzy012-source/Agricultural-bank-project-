// db.js
const { Database } = require('@libsql/sqlite3');
const path = require('path');

// 1. Determine path
const isProd = process.env.NODE_ENV === 'production';
const rawPath = isProd ? '/tmp/bank.db' : path.resolve(__dirname, 'bank.db');

// 2. FORCE 'file:' URL format (required by @libsql/sqlite3)
const dbPath = `file:${rawPath}`;

let db;
try {
  db = new Database(dbPath);
  console.log('✅ DB connected:', dbPath);
} catch (err) {
  console.error('❌ SQLite error:', err.message);
  process.exit(1);
}

module.exports = {
  run: (sql, params = []) => { const s = db.prepare(sql); return s.run(params); },
  get: (sql, params = []) => { const s = db.prepare(sql); return s.get(params); },
  all: (sql, params = []) => { const s = db.prepare(sql); return s.all(params); }
};