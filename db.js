// db.js – libsql SQLite connection
const { Database } = require('@libsql/sqlite3');
const path = require('path');

// Build the database path
const rawPath = process.env.NODE_ENV === 'production' 
  ? '/tmp/bank.db' 
  : path.join(__dirname, 'bank.db');

// Add 'file:' prefix for libSQL compatibility
const dbPath = rawPath.startsWith('file:') || rawPath.startsWith('libsql:') || rawPath.startsWith('http')
  ? rawPath
  : `file:${rawPath}`;

let db;
try {
  db = new Database(dbPath);
  console.log('✅ Connected to SQLite DB at', dbPath);
} catch (err) {
  console.error('❌ SQLite connection error:', err);
  process.exit(1);
}

module.exports = {
  run: function(sql, params = []) {
    const stmt = db.prepare(sql);
    const result = stmt.run(params);
    return { lastID: result.lastInsertRowid, changes: result.changes };
  },
  get: function(sql, params = []) {
    const stmt = db.prepare(sql);
    return stmt.get(params);
  },
  all: function(sql, params = []) {
    const stmt = db.prepare(sql);
    return stmt.all(params);
  }
};