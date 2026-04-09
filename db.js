// db.js – SQLite connection wrapper
// ---------------------------------------------------------------
// Works locally and on production hosting platforms
// ---------------------------------------------------------------

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// Use /tmp for writable location on serverless platforms (Railway, Render, etc.)
// Local development uses project root
const dbPath = process.env.NODE_ENV === 'production' 
  ? '/tmp/bank.db' 
  : path.join(__dirname, 'bank.db');

// Ensure /tmp exists (for production)
if (process.env.NODE_ENV === 'production') {
  const tmpDir = '/tmp';
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }
}

const db = new sqlite3.Database(dbPath, err => {
  if (err) {
    console.error('❌ SQLite connection error:', err);
  } else {
    console.log('✅ Connected to SQLite DB at', dbPath);
  }
});

module.exports = db;