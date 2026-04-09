// db.js – libsql SQLite connection (pure JavaScript, no native modules)
const { Database } = require('@libsql/sqlite3');
const path = require('path');

const dbPath = process.env.NODE_ENV === 'production' 
  ? '/tmp/bank.db' 
  : path.join(__dirname, 'bank.db');

let db;
try {
  db = new Database(dbPath);
  console.log('✅ Connected to SQLite DB at', dbPath);
} catch (err) {
  console.error('❌ SQLite connection error:', err);
  process.exit(1);
}

// Export wrapper with same API as before
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