// db.js – libsql SQLite (pure JS, Railway-compatible)
const { Database } = require('@libsql/sqlite3');
const path = require('path');

// Determine path
const isProd = process.env.NODE_ENV === 'production';
const rawPath = isProd ? '/tmp/bank.db' : path.resolve(__dirname, 'bank.db');

// ✅ CRITICAL: libsql requires 'file:' prefix for local paths
const dbPath = rawPath.startsWith('file:') || rawPath.startsWith('libsql:') || rawPath.startsWith('http')
  ? rawPath
  : `file:${rawPath}`;

let db;
try {
  db = new Database(dbPath);
  console.log('✅ Connected to SQLite DB at', dbPath);
} catch (err) {
  console.error('❌ SQLite connection error:', err.message);
  process.exit(1);
}

// Export simple SYNC API (libsql is synchronous)
module.exports = {
  run: (sql, params = []) => db.prepare(sql).run(params),
  get: (sql, params = []) => db.prepare(sql).get(params),
  all: (sql, params = []) => db.prepare(sql).all(params)
};