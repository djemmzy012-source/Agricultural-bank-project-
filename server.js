// server.js – 100% Railway-proof minimal test
const express = require('express');
const app = express();

// Railway sets PORT env var; fallback to 3000 for local testing
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // Critical: bind to all interfaces

// Simple routes
app.get('/health', (req, res) => {
  res.set('Content-Type', 'application/json');
  res.status(200).send(JSON.stringify({ status: 'ok', port: PORT, host: HOST }));
});

app.get('/', (req, res) => {
  res.set('Content-Type', 'text/html');
  res.status(200).send('<h1>✅ Railway server is LIVE!</h1><p><a href="/health">/health</a></p>');
});

// Start server AND only log AFTER port is bound
const server = app.listen(PORT, HOST, () => {
  // This callback fires ONLY when the port is actually listening
  console.log(`🚀 SERVER READY: Listening on ${HOST}:${PORT}`);
  console.log(`🔗 Test URL: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/health`);
});

// Catch startup errors
server.on('error', (err) => {
  console.error('💥 Server failed to start:', err.message);
  process.exit(1);
});

// Keep process alive
process.on('SIGTERM', () => {
  console.log('🔄 SIGTERM received');
  server.close(() => process.exit(0));
});