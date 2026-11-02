
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Allow the database location to be configured by the hosting environment.
// Set DB_PATH to a persistent disk location in production.
const defaultDbPath = path.resolve(__dirname, 'bank.db');
const dbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : defaultDbPath;

// Ensure the parent directory exists when using a custom database path.
const dbDirectory = path.dirname(dbPath);

if (!fs.existsSync(dbDirectory)) {
  fs.mkdirSync(dbDirectory, { recursive: true });
}

const db = new Database(dbPath);

// Improve SQLite reliability for concurrent reads and writes.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

console.log('Connected to SQLite database at:', dbPath);


module.exports = {
  run: (sql, params = []) => {
    const stmt = db.prepare(sql);
    const result = stmt.run(...(Array.isArray(params) ? params : [params]));

    return {
      lastID: result.lastInsertRowid,
      changes: result.changes
    };
  },

  get: (sql, params = []) => {
    const stmt = db.prepare(sql);
    return stmt.get(...(Array.isArray(params) ? params : [params]));
  },

  all: (sql, params = []) => {
    const stmt = db.prepare(sql);
    return stmt.all(...(Array.isArray(params) ? params : [params]));
  },

  transaction: (callback) => {
    if (typeof callback !== 'function') {
      throw new TypeError('Transaction requires a callback function.');
    }

    return db.transaction(callback)();
  }
};
