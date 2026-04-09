// db.js – better-sqlite3 connection (fast, reliable, no native fallback issues)
const Database = require('better-sqlite3');
const path = require('path');

// Determine path
const isProd = process.env.NODE_ENV === 'production';
const dbPath = isProd ? '/tmp/bank.db' : path.resolve(__dirname, 'bank.db');

let db;
try {
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL'); // Optimizes for concurrent reads/writes
  console.log('✅ Connected to SQLite DB at', dbPath);
} catch (err) {
  console.error('❌ SQLite connection error:', err.message);
  process.exit(1);
}

// Export wrapper (identical API to your previous code)
module.exports = {
  run: (sql, params = []) => {
    const stmt = db.prepare(sql);
    const result = stmt.run(params);
    return { lastID: result.lastInsertRowid, changes: result.changes };
  },
  get: (sql, params = []) => db.prepare(sql).get(params),
  all: (sql, params = []) => db.prepare(sql).all(params)
};