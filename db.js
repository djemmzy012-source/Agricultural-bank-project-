// db.js – libSQL client (pure JS, Railway-compatible)
const { createClient } = require('@libsql/client');
const path = require('path');

// Determine connection URL
const isProd = process.env.NODE_ENV === 'production';
const rawPath = isProd ? '/tmp/bank.db' : path.resolve(__dirname, 'bank.db');

// ✅ libSQL requires 'file:' prefix for local paths
const dbUrl = rawPath.startsWith('file:') || rawPath.startsWith('libsql:') || rawPath.startsWith('http')
  ? rawPath
  : `file:${rawPath}`;

// Create client
const client = createClient({ url: dbUrl });

console.log('✅ Connected to SQLite DB at', dbUrl);

// Export async API (libSQL client is async)
module.exports = {
  run: async (sql, params = []) => {
    const rs = await client.execute({ sql, args: params });
    return { lastID: rs.lastInsertRowid, changes: rs.rowsAffected };
  },
  get: async (sql, params = []) => {
    const rs = await client.execute({ sql, args: params });
    return rs.rows[0] || null;
  },
  all: async (sql, params = []) => {
    const rs = await client.execute({ sql, args: params });
    return rs.rows;
  }
};