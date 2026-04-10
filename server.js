// server.js – Minimal Railway Test (NO DATABASE)
const express = require('express');
const app = express();

const PORT = process.env.PORT || 3000;

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    port: PORT, 
    nodeEnv: process.env.NODE_ENV || 'undefined',
    time: new Date().toISOString()
  });
});

// Root route
app.get('/', (req, res) => {
  res.send('✅ Railway server is running! <a href="/health">/health</a>');
});

// Start
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Test server running on port ${PORT}`);
});

// Catch errors
process.on('uncaughtException', err => console.error('💥 Uncaught:', err.message));
process.on('unhandledRejection', err => console.error('💥 Unhandled:', err.message));