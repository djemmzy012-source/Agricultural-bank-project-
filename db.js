// db.js – better-sqlite3 connection wrapper
const Database = require('better-sqlite3');
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

// Export wrapper with similar API to sqlite3
module.exports = {
  run: function(sql, params = []) {
    return db.prepare(sql).run(params);
  },
  get: function(sql, params = []) {
    return db.prepare(sql).get(params);
  },
  all: function(sql, params = []) {
    return db.prepare(sql).all(params);
  }
};