/********************************************************************
 *  AgriBank Texas – Full DB‑backed server with admin controls
 *  ✅ Railway-compatible: better-sqlite3, health endpoint, clean helpers
 ********************************************************************/
require('dotenv').config();

const express = require('express');
const session = require('express-session');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// ---------------------------------------------------------------
// Express / session config
// ---------------------------------------------------------------
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    secret: process.env.SESSION_SECRET || 'fallback-dev-secret-only',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000
    }
}));

// ---------------------------------------------------------------
// Database helpers (SYNC - for better-sqlite3)
// ---------------------------------------------------------------
function sqlRun(sql, params = []) {
  const result = db.run(sql, params);
  return { lastID: result.lastID, changes: result.changes };
}
function sqlGet(sql, params = []) { return db.get(sql, params); }
function sqlAll(sql, params = []) { return db.all(sql, params); }

// ---------------------------------------------------------------
// DB initialization & migrations
// ---------------------------------------------------------------
async function initDB() {
  await sqlRun(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT,
    firstName TEXT, lastName TEXT, email TEXT, memberSince TEXT,
    address TEXT, city TEXT, state TEXT, zip TEXT, created_at TEXT
  )`);
  await sqlRun(`CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, userId INTEGER, name TEXT, type TEXT,
    number TEXT, balance REAL, icon TEXT
  )`);
  await sqlRun(`CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, userId INTEGER, accountId INTEGER,
    type TEXT, amount REAL, description TEXT, date TEXT
  )`);
  await sqlRun(`CREATE TABLE IF NOT EXISTS billpay_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, userId INTEGER, fromAccount INTEGER,
    amount REAL, date TEXT, payeeName TEXT
  )`);
  await sqlRun(`CREATE TABLE IF NOT EXISTS transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT, userId INTEGER, fromAccount INTEGER,
    toAccount INTEGER, amount REAL, date TEXT, status TEXT
  )`);

  const userInfo = await sqlAll(`PRAGMA table_info(users)`);
  const colNames = userInfo.map(c => c.name);
  async function addColumnIfMissing(colDef) {
    const colName = colDef.split(' ')[0];
    if (!colNames.includes(colName)) await sqlRun(`ALTER TABLE users ADD COLUMN ${colDef}`);
  }
  await addColumnIfMissing('isAdmin INTEGER DEFAULT 0');
  await addColumnIfMissing('isLocked INTEGER DEFAULT 0');
  await addColumnIfMissing('lockUntil TEXT');

  const userCnt = await sqlGet(`SELECT COUNT(*) AS c FROM users`);
  if (!userCnt || userCnt.c === 0) {
    const regularHash = bcrypt.hashSync('Andre44225', 10);
    await sqlRun(
      `INSERT INTO users (username, password, firstName, lastName, email, memberSince, address, city, state, zip, isAdmin, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      ['Alejandro$12', regularHash, 'Andrew', 'Alejandro', 'andrew.alejandro@email.com', '2018', '742 Sycamore Lane', 'Indianapolis', 'IN', '46204', 0, new Date().toISOString()]
    );
    await sqlRun(`INSERT INTO accounts (userId, name, type, number, balance, icon) VALUES (1,'Primary Checking','checking','****4521',42420.50,'🏦')`);
    await sqlRun(`INSERT INTO accounts (userId, name, type, number, balance, icon) VALUES (1,'Savings Account','savings','****8934',325890.25,'💰')`);
    await sqlRun(`INSERT INTO accounts (userId, name, type, number, balance, icon) VALUES (1,'Business Operating','checking','****2156',595697.25,'🏢')`);
  }
  const adminExists = await sqlGet(`SELECT * FROM users WHERE isAdmin = 1 LIMIT 1`);
  if (!adminExists) {
    const adminHash = bcrypt.hashSync('Admin!Secure1', 10);
    await sqlRun(
      `INSERT INTO users (username, password, firstName, lastName, email, memberSince, address, city, state, zip, isAdmin, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      ['admin', adminHash, 'Admin', 'User', 'admin@bank.com', '2020', 'HQ', 'Metropolis', 'TX', '00000', 1, new Date().toISOString()]
    );
  }
}

// ---------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------
function requireLogin(req, res, next) { if (req.session.user) return next(); res.redirect('/login'); }
function requireAdmin(req, res, next) { if (req.session.user && req.session.user.isAdmin === 1) return next(); res.redirect('/login'); }

// ---------------------------------------------------------------
// Routes (Keep as async for safety, though DB calls are sync)
// ---------------------------------------------------------------
app.get('/', (req, res) => { if (req.session.user) return res.redirect('/dashboard'); res.render('landing'); });
app.get('/login', (req, res) => { res.render('login', { error: req.query.error || null, success: req.query.registered === 'true' ? 'Account created successfully!' : null }); });
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await sqlGet(`SELECT * FROM users WHERE username = ?`, [username]);
  if (!user) return res.render('login', { error: 'Invalid credentials.', success: null });
  if (user.isLocked === 1) {
    const now = new Date(); const lockUntil = user.lockUntil ? new Date(user.lockUntil) : null;
    if (lockUntil && now < lockUntil) return res.render('login', { error: `Account locked. Try again in ${Math.round((lockUntil - now)/60000)} minute(s).`, success: null });
    await sqlRun(`UPDATE users SET isLocked = 0, lockUntil = NULL WHERE id = ?`, [user.id]);
  }
  if (!bcrypt.compareSync(password, user.password)) return res.render('login', { error: 'Invalid credentials.', success: null });
  const clean = { ...user }; delete clean.password; req.session.user = clean;
  if (clean.isAdmin === 1) return res.redirect('/admin'); res.redirect('/dashboard');
});
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });
app.get('/register', (req, res) => { res.render('register', { error: null }); });
app.post('/register', async (req, res) => {
  const { firstName, lastName, email, username, password, confirmPassword, accountType } = req.body;
  if (password !== confirmPassword) return res.render('register', { error: 'Passwords do not match.' });
  if (await sqlGet(`SELECT id FROM users WHERE username = ?`, [username])) return res.render('register', { error: 'Username already taken.' });
  const hashed = bcrypt.hashSync(password, 10);
  const result = await sqlRun(`INSERT INTO users (username, password, firstName, lastName, email, memberSince, address, city, state, zip, isAdmin, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [username, hashed, firstName, lastName, email, new Date().getFullYear().toString(), req.body.address, req.body.city, req.body.state, req.body.zip, 0, new Date().toISOString()]);
  const accName = accountType === 'savings' ? 'Savings Account' : accountType === 'business' ? 'Business Checking' : 'Primary Checking';
  const accIcon = accountType === 'savings' ? '💰' : accountType === 'business' ? '🏢' : '🏦';
  await sqlRun(`INSERT INTO accounts (userId, name, type, number, balance, icon) VALUES (?,?,?,?,?,?)`,
    [result.lastID, accName, accountType, '****'+Math.floor(1000+Math.random()*9000), 0.00, accIcon]);
  res.redirect('/login?registered=true');
});
app.get('/forgot-password', (req, res) => res.render('forgot-password', { error: null, success: null, info: null }));
app.post('/forgot-password', async (req, res) => {
  const { username, email } = req.body;
  const user = await sqlGet(`SELECT * FROM users WHERE username = ? AND email = ?`, [username, email]);
  if (!user) return res.render('forgot-password', { error: 'No account found.', success: null, info: null });
  res.render('forgot-password', { error: null, success: 'Password reset link sent!', info: 'Demo password: Andre44225' });
});
app.get('/dashboard', requireLogin, async (req, res) => {
  const uid = req.session.user.id;
  const accounts = await sqlAll(`SELECT * FROM accounts WHERE userId = ?`, [uid]);
  const transactions = await sqlAll(`SELECT t.id, t.accountId, t.type, t.amount, t.description, t.date, a.name AS accountName FROM transactions t LEFT JOIN accounts a ON t.accountId = a.id WHERE t.userId = ? ORDER BY t.date DESC LIMIT 10`, [uid]);
  res.render('dashboard', { user: req.session.user, accounts, transactions, totalBalance: accounts.reduce((s,a)=>s+a.balance,0) });
});
app.get('/accounts', requireLogin, async (req, res) => {
  const uid = req.session.user.id;
  const accounts = await sqlAll(`SELECT * FROM accounts WHERE userId = ?`, [uid]);
  const transactions = await sqlAll(`SELECT t.id, t.accountId, t.type, t.amount, t.description, t.date, a.name AS accountName FROM transactions t LEFT JOIN accounts a ON t.accountId = a.id WHERE t.userId = ? ORDER BY t.date DESC LIMIT 15`, [uid]);
  res.render('accounts', { user: req.session.user, accounts, transactions });
});
app.get('/transactions', requireLogin, async (req, res) => {
  const uid = req.session.user.id;
  const accounts = await sqlAll(`SELECT * FROM accounts WHERE userId = ?`, [uid]);
  let selectedAccount = null, transactions = [];
  if (req.query.accountId) {
    selectedAccount = accounts.find(a=>a.id===parseInt(req.query.accountId));
    transactions = await sqlAll(`SELECT t.*, a.name AS accountName, a.number AS accountNumber FROM transactions t LEFT JOIN accounts a ON t.accountId = a.id WHERE t.userId = ? AND t.accountId = ? ORDER BY t.date DESC`, [uid, req.query.accountId]);
  } else {
    transactions = await sqlAll(`SELECT t.*, a.name AS accountName, a.number AS accountNumber FROM transactions t LEFT JOIN accounts a ON t.accountId = a.id WHERE t.userId = ? ORDER BY t.date DESC`, [uid]);
  }
  const fmt = transactions.map(t=>({...t, amountFormatted: t.amount>=0?`+$${Math.abs(t.amount).toFixed(2)}`:`-$${Math.abs(t.amount).toFixed(2)}`, date: t.date?new Date(t.date).toLocaleDateString():'N/A'}));
  res.render('transactions', { user: req.session.user, accounts, account: selectedAccount, transactions: fmt });
});
app.get('/transfer', requireLogin, async (req, res) => {
  res.render('transfer', { user: req.session.user, accounts: await sqlAll(`SELECT * FROM accounts WHERE userId = ?`, [req.session.user.id]), success: null, error: null, successAmount: null });
});
app.post('/transfer', requireLogin, async (req, res) => {
  const { transferType, fromAccount, toAccount, amount, memo, recipientName, bankName, country } = req.body;
  const uid = req.session.user.id;
  const fromAcc = await sqlGet(`SELECT * FROM accounts WHERE id = ? AND userId = ?`, [fromAccount, uid]);
  const toAcc = toAccount ? await sqlGet(`SELECT * FROM accounts WHERE id = ? AND userId = ?`, [toAccount, uid]) : null;
  const amt = parseFloat(amount);
  if (!fromAcc || isNaN(amt) || amt <= 0 || amt > fromAcc.balance) return res.render('transfer', { user: req.session.user, accounts: await sqlAll(`SELECT * FROM accounts WHERE userId = ?`, [uid]), success: null, error: 'Invalid or insufficient funds.', successAmount: null });
  
  let label, toName, desc, fee = 0;
  if (transferType === 'internal') {
    if (!toAcc) return res.render('transfer', { user: req.session.user, accounts: await sqlAll(`SELECT * FROM accounts WHERE userId = ?`, [uid]), success: null, error: 'Select destination.', successAmount: null });
    label = 'Internal Transfer'; toName = toAcc.name; desc = `Transfer to ${toAcc.name}`;
    await sqlRun(`UPDATE accounts SET balance = balance - ? WHERE id = ?`, [amt, fromAcc.id]);
    await sqlRun(`UPDATE accounts SET balance = balance + ? WHERE id = ?`, [amt, toAcc.id]);
    await sqlRun(`INSERT INTO transactions (userId, accountId, type, amount, description, date) VALUES (?,?,?,?,?,?)`, [uid, fromAcc.id, 'Transfer Out', -amt, desc, new Date().toISOString()]);
    await sqlRun(`INSERT INTO transactions (userId, accountId, type, amount, description, date) VALUES (?,?,?,?,?,?)`, [uid, toAcc.id, 'Transfer In', amt, `From ${fromAcc.name}`, new Date().toISOString()]);
  } else if (transferType === 'domestic') {
    fee = 25; label = 'Domestic Wire'; toName = recipientName; desc = `Wire to ${recipientName}`;
    await sqlRun(`UPDATE accounts SET balance = balance - ? WHERE id = ?`, [amt+fee, fromAcc.id]);
    await sqlRun(`INSERT INTO transactions (userId, accountId, type, amount, description, date) VALUES (?,?,?,?,?,?)`, [uid, fromAcc.id, 'Wire Out', -amt, desc, new Date().toISOString()]);
    await sqlRun(`INSERT INTO transactions (userId, accountId, type, amount, description, date) VALUES (?,?,?,?,?,?)`, [uid, fromAcc.id, 'Fee', -fee, 'Wire Fee', new Date().toISOString()]);
  } else {
    fee = 45; label = 'International Wire'; toName = `${recipientName} (${country||'Intl'})`; desc = `Intl Wire to ${recipientName}`;
    await sqlRun(`UPDATE accounts SET balance = balance - ? WHERE id = ?`, [amt+fee, fromAcc.id]);
    await sqlRun(`INSERT INTO transactions (userId, accountId, type, amount, description, date) VALUES (?,?,?,?,?,?)`, [uid, fromAcc.id, 'Wire Out', -amt, desc, new Date().toISOString()]);
    await sqlRun(`INSERT INTO transactions (userId, accountId, type, amount, description, date) VALUES (?,?,?,?,?,?)`, [uid, fromAcc.id, 'Fee', -fee, 'Intl Wire Fee', new Date().toISOString()]);
  }
  await sqlRun(`INSERT INTO transfers (userId, fromAccount, toAccount, amount, date, status) VALUES (?,?,?,?,?,?)`, [uid, fromAcc.id, toAcc?.id||null, amt, new Date().toISOString(), 'completed']);
  res.render('transfer-confirm', { user: req.session.user, amount: '$'+amt.toLocaleString('en-US',{minimumFractionDigits:2}), fromAccount: fromAcc.name, fromAccountNumber: fromAcc.number, toAccount: toName, transferType: label, arrivalDays: fee?'1-3 Days':'Instant', memo: memo||null, date: new Date().toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'}) });
});
app.get('/billpay', requireLogin, async (req, res) => res.render('billpay', { user: req.session.user, accounts: await sqlAll(`SELECT * FROM accounts WHERE userId = ?`, [req.session.user.id]), error: req.query.error, success: req.query.status==='success', successAmount: req.query.amount }));
app.post('/billpay', requireLogin, async (req, res) => {
  const { payeeName, accountNumber, amount, fromAccount } = req.body;
  const uid = req.session.user.id; const fromAcc = await sqlGet(`SELECT * FROM accounts WHERE id = ? AND userId = ?`, [fromAccount, uid]); const amt = parseFloat(amount);
  if (!fromAcc || isNaN(amt) || amt <= 0 || amt > fromAcc.balance) return res.redirect('/billpay?error=Invalid+payment');
  await sqlRun(`UPDATE accounts SET balance = balance - ? WHERE id = ?`, [amt, fromAcc.id]);
  await sqlRun(`INSERT INTO billpay_transactions (userId, fromAccount, amount, date, payeeName) VALUES (?,?,?,?,?)`, [uid, fromAcc.id, amt, new Date().toISOString(), payeeName]);
  await sqlRun(`INSERT INTO transactions (userId, accountId, type, amount, description, date) VALUES (?,?,?,?,?,?)`, [uid, fromAcc.id, 'Bill Pay', -amt, `Bill to ${payeeName}`, new Date().toISOString()]);
  res.render('billpay-confirm', { user: req.session.user, amount: '$'+amt.toLocaleString('en-US',{minimumFractionDigits:2}), fromAccount: fromAcc.name, fromAccountNumber: fromAcc.number, payeeName, payeeAccount: accountNumber||'N/A', arrivalDays: '1-3 Days', confirmationNumber: 'BP-'+Date.now().toString().slice(-8), date: new Date().toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'}) });
});
app.get('/billpay/history', requireLogin, async (req, res) => res.render('history', { user: req.session.user, transactions: await sqlAll(`SELECT * FROM billpay_transactions WHERE userId = ? ORDER BY date DESC`, [req.session.user.id]) }));
app.get('/profile', requireLogin, async (req, res) => res.render('profile', { user: req.session.user, accounts: await sqlAll(`SELECT * FROM accounts WHERE userId = ?`, [req.session.user.id]), success: null, error: null }));
app.post('/profile', requireLogin, async (req, res) => {
  const { email, address, city, state, zip } = req.body; const uid = req.session.user.id;
  await sqlRun(`UPDATE users SET email = ?, address = ?, city = ?, state = ?, zip = ? WHERE id = ?`, [email, address, city, state, zip, uid]);
  const user = await sqlGet(`SELECT * FROM users WHERE id = ?`, [uid]); req.session.user = user;
  res.render('profile', { user, accounts: await sqlAll(`SELECT * FROM accounts WHERE userId = ?`, [uid]), success: 'Profile updated!', error: null });
});
app.get('/admin', requireAdmin, async (req, res) => res.render('admin', { user: req.session.user, users: await sqlAll(`SELECT id, username, email, isAdmin, isLocked, created_at FROM users ORDER BY id`) }));
app.get('/admin/users', requireAdmin, async (req, res) => { const q = req.query.q||''; res.render('admin_users', { user: req.session.user, users: await sqlAll(`SELECT id, username, email, isAdmin, isLocked, created_at FROM users WHERE username LIKE ? OR email LIKE ? ORDER BY id`, [`%${q}%`,`%${q}%`]), query: q }); });
app.get('/admin/users/:id', requireAdmin, async (req, res) => {
  const uid = parseInt(req.params.id,10);
  res.render('admin_user', { user: req.session.user, viewedUser: await sqlGet(`SELECT * FROM users WHERE id = ?`, [uid]), accounts: await sqlAll(`SELECT * FROM accounts WHERE userId = ?`, [uid]), bills: await sqlAll(`SELECT * FROM billpay_transactions WHERE userId = ? ORDER BY date DESC`, [uid]), trans: await sqlAll(`SELECT t.*, a.name AS accountName FROM transactions t LEFT JOIN accounts a ON t.accountId = a.id WHERE t.userId = ? ORDER BY t.date DESC`, [uid]), transfers: await sqlAll(`SELECT * FROM transfers WHERE userId = ? ORDER BY date DESC`, [uid]) });
});
app.post('/admin/users/:id/toggleAdmin', requireAdmin, async (req, res) => { const u = await sqlGet(`SELECT isAdmin FROM users WHERE id = ?`, [req.params.id]); await sqlRun(`UPDATE users SET isAdmin = ? WHERE id = ?`, [u.isAdmin?0:1, req.params.id]); res.redirect(`/admin/users/${req.params.id}`); });
app.post('/admin/users/:id/lock', requireAdmin, async (req, res) => { const lock = new Date(Date.now() + (parseInt(req.body.minutes)||60)*60000).toISOString(); await sqlRun(`UPDATE users SET isLocked = 1, lockUntil = ? WHERE id = ?`, [lock, req.params.id]); res.redirect(`/admin/users/${req.params.id}`); });
app.post('/admin/users/:id/unlock', requireAdmin, async (req, res) => { await sqlRun(`UPDATE users SET isLocked = 0, lockUntil = NULL WHERE id = ?`, [req.params.id]); res.redirect(`/admin/users/${req.params.id}`); });
app.get('/health', (req, res) => res.json({ status: 'ok', port: PORT }));
app.use((err, req, res, next) => { console.error('❌ Express error:', err.message); res.status(500).json({ error: 'Internal server error', message: err.message }); });
process.on('unhandledRejection', r => console.error('❌ Unhandled Rejection:', r));

// ---------------------------------------------------------------
// Start Server
// ---------------------------------------------------------------
initDB().then(() => {
  const server = app.listen(PORT, HOST, () => console.log(`🚀 AgriBank Texas running on ${HOST}:${PORT}`));
  process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
}).catch(err => { console.error('❌ DB init failed:', err.message); process.exit(1); });