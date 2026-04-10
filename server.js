/********************************************************************
 *  AgriBank Texas – Production-Ready Banking Server
 *  ✅ Railway-compatible | ✅ Mobile-responsive | ✅ Secure sessions
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
// ✅ Railway Proxy Trust (Critical for HTTPS sessions)
// ---------------------------------------------------------------
app.set('trust proxy', 1);

// ---------------------------------------------------------------
// Express Configuration
// ---------------------------------------------------------------
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Body parsing
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));

// ✅ Static files with production caching
const publicPath = path.join(__dirname, 'public');
app.use(express.static(publicPath, {
  maxAge: process.env.NODE_ENV === 'production' ? '7d' : 0,
  setHeaders: (res, filepath) => {
    if (filepath.endsWith('.css')) {
      res.setHeader('Content-Type', 'text/css; charset=utf-8');
    } else if (filepath.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    }
  }
}));

// ---------------------------------------------------------------
// ✅ Secure Session Configuration (Railway HTTPS)
// ---------------------------------------------------------------
app.use(session({
  secret: process.env.SESSION_SECRET || 'agri-bank-texas-secure-secret-2024',
  name: 'agribank.sid',
  resave: false,
  saveUninitialized: false,
  proxy: true, // ✅ Trust Railway's reverse proxy
  cookie: {
    secure: process.env.NODE_ENV === 'production', // ✅ HTTPS only in production
    httpOnly: true, // ✅ Prevent XSS
    sameSite: 'lax', // ✅ Allow login redirects while blocking CSRF
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// ---------------------------------------------------------------
// Database Helpers (Async for @libsql/client)
// ---------------------------------------------------------------
async function sqlRun(sql, params = []) {
  const result = await db.run(sql, params);
  return { 
    lastID: result.lastID || result.lastInsertRowid, 
    changes: result.changes || result.rowsAffected 
  };
}

async function sqlGet(sql, params = []) {
  const result = await db.get(sql, params);
  return result || null;
}

async function sqlAll(sql, params = []) {
  const result = await db.all(sql, params);
  return result || [];
}

// ---------------------------------------------------------------
// Database Initialization & Migrations
// ---------------------------------------------------------------
async function initDB() {
  await sqlRun(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    firstName TEXT,
    lastName TEXT,
    email TEXT,
    memberSince TEXT,
    address TEXT,
    city TEXT,
    state TEXT,
    zip TEXT,
    isAdmin INTEGER DEFAULT 0,
    isLocked INTEGER DEFAULT 0,
    lockUntil TEXT,
    created_at TEXT
  )`);

  await sqlRun(`CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    number TEXT NOT NULL,
    balance REAL DEFAULT 0,
    icon TEXT,
    FOREIGN KEY (userId) REFERENCES users(id)
  )`);

  await sqlRun(`CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER NOT NULL,
    accountId INTEGER,
    type TEXT NOT NULL,
    amount REAL NOT NULL,
    description TEXT,
    date TEXT,
    FOREIGN KEY (userId) REFERENCES users(id),
    FOREIGN KEY (accountId) REFERENCES accounts(id)
  )`);

  await sqlRun(`CREATE TABLE IF NOT EXISTS billpay_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER NOT NULL,
    fromAccount INTEGER NOT NULL,
    amount REAL NOT NULL,
    date TEXT,
    payeeName TEXT,
    FOREIGN KEY (userId) REFERENCES users(id),
    FOREIGN KEY (fromAccount) REFERENCES accounts(id)
  )`);

  await sqlRun(`CREATE TABLE IF NOT EXISTS transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER NOT NULL,
    fromAccount INTEGER NOT NULL,
    toAccount INTEGER,
    amount REAL NOT NULL,
    date TEXT,
    status TEXT DEFAULT 'pending',
    FOREIGN KEY (userId) REFERENCES users(id),
    FOREIGN KEY (fromAccount) REFERENCES accounts(id),
    FOREIGN KEY (toAccount) REFERENCES accounts(id)
  )`);

  const userInfo = await sqlAll(`PRAGMA table_info(users)`);
  const colNames = userInfo.map(c => c.name);
  
  async function addColumnIfMissing(colDef) {
    const colName = colDef.split(' ')[0];
    if (!colNames.includes(colName)) {
      await sqlRun(`ALTER TABLE users ADD COLUMN ${colDef}`);
      console.log(`➕ Added column: ${colName}`);
    }
  }
  
  await addColumnIfMissing('isAdmin INTEGER DEFAULT 0');
  await addColumnIfMissing('isLocked INTEGER DEFAULT 0');
  await addColumnIfMissing('lockUntil TEXT');

  const userCnt = await sqlGet(`SELECT COUNT(*) AS c FROM users`);
  if (!userCnt || userCnt.c === 0) {
    console.log('🌱 Seeding default user and accounts...');
    const regularHash = bcrypt.hashSync('Andre44225', 10);
    await sqlRun(
      `INSERT INTO users (username, password, firstName, lastName, email, memberSince,
                          address, city, state, zip, isAdmin, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        'Alejandro$12', regularHash, 'Andrew', 'Alejandro',
        'andrew.alejandro@email.com', '2018',
        '742 Sycamore Lane', 'Indianapolis', 'IN', '46204',
        0, new Date().toISOString()
      ]
    );
    await sqlRun(`INSERT INTO accounts (userId, name, type, number, balance, icon)
                 VALUES (1,'Primary Checking','checking','****4521',42420.50,'🏦')`);
    await sqlRun(`INSERT INTO accounts (userId, name, type, number, balance, icon)
                 VALUES (1,'Savings Account','savings','****8934',325890.25,'💰')`);
    await sqlRun(`INSERT INTO accounts (userId, name, type, number, balance, icon)
                 VALUES (1,'Business Operating','checking','****2156',595697.25,'🏢')`);
  }

  const adminExists = await sqlGet(`SELECT id FROM users WHERE isAdmin = 1 LIMIT 1`);
  if (!adminExists) {
    console.log('🔐 Creating admin account...');
    const adminHash = bcrypt.hashSync('Admin!Secure1', 10);
    await sqlRun(
      `INSERT INTO users (username, password, firstName, lastName, email, memberSince,
                          address, city, state, zip, isAdmin, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        'admin', adminHash, 'Admin', 'User',
        'admin@bank.com', '2020',
        'HQ', 'Metropolis', 'TX', '00000',
        1, new Date().toISOString()
      ]
    );
  }
  console.log('✅ Database initialized');
}

// ---------------------------------------------------------------
// Middleware: Authentication Guards
// ---------------------------------------------------------------
function requireLogin(req, res, next) {
  if (req.session.user) return next();
  res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (req.session.user && req.session.user.isAdmin === 1) return next();
  res.redirect('/login');
}

// ---------------------------------------------------------------
// Public Routes
// ---------------------------------------------------------------
app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('landing');
});

app.get('/login', (req, res) => {
  const { error, registered } = req.query;
  const success = registered === 'true' ? 'Account created successfully! Please sign in.' : null;
  res.render('login', { error: error || null, success });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.render('login', { error: 'Please enter username and password.', success: null });
  }
  const user = await sqlGet(`SELECT * FROM users WHERE username = ?`, [username]);
  if (!user) {
    console.log(`🔐 Failed login attempt: ${username} (user not found)`);
    return res.render('login', { error: 'Invalid credentials.', success: null });
  }
  if (user.isLocked === 1) {
    const now = new Date();
    const lockUntil = user.lockUntil ? new Date(user.lockUntil) : null;
    if (lockUntil && now < lockUntil) {
      const mins = Math.ceil((lockUntil - now) / 60000);
      return res.render('login', { error: `Account locked. Try again in ${mins} minute(s).`, success: null });
    } else {
      await sqlRun(`UPDATE users SET isLocked = 0, lockUntil = NULL WHERE id = ?`, [user.id]);
    }
  }
  if (!bcrypt.compareSync(password, user.password)) {
    console.log(`🔐 Failed login attempt: ${username} (wrong password)`);
    return res.render('login', { error: 'Invalid credentials.', success: null });
  }
  const clean = { ...user };
  delete clean.password;
  req.session.user = clean;
  console.log(`✅ User logged in: ${clean.username}`);
  if (clean.isAdmin === 1) return res.redirect('/admin');
  res.redirect('/dashboard');
});

app.get('/logout', (req, res) => {
  const username = req.session.user?.username;
  req.session.destroy((err) => {
    if (err) console.error('Session destroy error:', err);
    console.log(`👋 User logged out: ${username}`);
  });
  res.redirect('/login');
});

app.get('/register', (req, res) => { res.render('register', { error: null }); });

app.post('/register', async (req, res) => {
  const { firstName, lastName, email, username, password, confirmPassword, accountType, address, city, state, zip } = req.body;
  if (!firstName || !lastName || !email || !username || !password) {
    return res.render('register', { error: 'All required fields must be filled.' });
  }
  if (password !== confirmPassword) {
    return res.render('register', { error: 'Passwords do not match.' });
  }
  if (password.length < 6) {
    return res.render('register', { error: 'Password must be at least 6 characters.' });
  }
  const existingUser = await sqlGet(`SELECT id FROM users WHERE username = ?`, [username]);
  if (existingUser) {
    return res.render('register', { error: 'Username already taken. Please choose another.' });
  }
  const hashedPassword = bcrypt.hashSync(password, 10);
  const result = await sqlRun(
    `INSERT INTO users (username, password, firstName, lastName, email, memberSince,
                        address, city, state, zip, isAdmin, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [username, hashedPassword, firstName, lastName, email, new Date().getFullYear().toString(), 
     address || '', city || '', state || '', zip || '', 0, new Date().toISOString()]
  );
  const newUserId = result.lastID;
  const accountNumber = '****' + Math.floor(1000 + Math.random() * 9000);
  const accountConfig = {
    savings: { name: 'Savings Account', icon: '💰' },
    business: { name: 'Business Checking', icon: '🏢' },
    checking: { name: 'Primary Checking', icon: '🏦' }
  };
  const { name: accountName, icon: accountIcon } = accountConfig[accountType] || accountConfig.checking;
  await sqlRun(
    `INSERT INTO accounts (userId, name, type, number, balance, icon) VALUES (?, ?, ?, ?, ?, ?)`,
    [newUserId, accountName, accountType || 'checking', accountNumber, 0.00, accountIcon]
  );
  console.log(`✅ New user registered: ${username}`);
  res.redirect('/login?registered=true');
});

app.get('/forgot-password', (req, res) => {
  res.render('forgot-password', { error: null, success: null, info: null });
});

app.post('/forgot-password', async (req, res) => {
  const { username, email } = req.body;
  if (!username || !email) {
    return res.render('forgot-password', { error: 'Please enter both username and email.', success: null, info: null });
  }
  const user = await sqlGet(`SELECT * FROM users WHERE username = ? AND email = ?`, [username, email]);
  if (!user) {
    return res.render('forgot-password', { error: 'No account found with that username and email combination.', success: null, info: null });
  }
  res.render('forgot-password', { error: null, success: 'Password reset link sent to your email!', info: 'Demo mode: Your current password is: Andre44225' });
});

// ---------------------------------------------------------------
// Protected Routes (Require Login)
// ---------------------------------------------------------------
app.get('/dashboard', requireLogin, async (req, res) => {
  const uid = req.session.user.id;
  try {
    const accounts = await sqlAll(`SELECT * FROM accounts WHERE userId = ?`, [uid]);
    const transactions = await sqlAll(
      `SELECT t.id, t.accountId, t.type, t.amount, t.description, t.date, a.name AS accountName
       FROM transactions t LEFT JOIN accounts a ON t.accountId = a.id
       WHERE t.userId = ? ORDER BY t.date DESC LIMIT 10`, [uid]);
    const totalBalance = accounts.reduce((sum, a) => sum + (a.balance || 0), 0);
    res.render('dashboard', { user: req.session.user, accounts, transactions, totalBalance });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).render('error', { message: 'Failed to load dashboard' });
  }
});

app.get('/accounts', requireLogin, async (req, res) => {
  const uid = req.session.user.id;
  try {
    const accounts = await sqlAll(`SELECT * FROM accounts WHERE userId = ?`, [uid]);
    const transactions = await sqlAll(
      `SELECT t.id, t.accountId, t.type, t.amount, t.description, t.date, a.name AS accountName
       FROM transactions t LEFT JOIN accounts a ON t.accountId = a.id
       WHERE t.userId = ? ORDER BY t.date DESC LIMIT 15`, [uid]);
    res.render('accounts', { user: req.session.user, accounts, transactions });
  } catch (error) {
    console.error('Accounts error:', error);
    res.status(500).render('error', { message: 'Failed to load accounts' });
  }
});

app.get('/transactions', requireLogin, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const accountId = req.query.accountId ? parseInt(req.query.accountId) : null;
    const accountNumber = req.query.account || null;
    const accounts = await sqlAll(`SELECT * FROM accounts WHERE userId = ?`, [uid]);
    let selectedAccount = null, transactions = [];
    if (accountId) {
      selectedAccount = accounts.find(acc => acc.id === accountId);
      transactions = await sqlAll(
        `SELECT t.*, a.name AS accountName, a.number AS accountNumber
         FROM transactions t LEFT JOIN accounts a ON t.accountId = a.id
         WHERE t.userId = ? AND t.accountId = ? ORDER BY t.date DESC`, [uid, accountId]);
    } else if (accountNumber) {
      selectedAccount = accounts.find(acc => acc.number === accountNumber);
      transactions = await sqlAll(
        `SELECT t.*, a.name AS accountName, a.number AS accountNumber
         FROM transactions t LEFT JOIN accounts a ON t.accountId = a.id
         WHERE t.userId = ? AND a.number = ? ORDER BY t.date DESC`, [uid, accountNumber]);
    } else {
      transactions = await sqlAll(
        `SELECT t.*, a.name AS accountName, a.number AS accountNumber
         FROM transactions t LEFT JOIN accounts a ON t.accountId = a.id
         WHERE t.userId = ? ORDER BY t.date DESC`, [uid]);
    }
    const formattedTransactions = transactions.map(tx => ({
      ...tx,
      date: tx.date ? new Date(tx.date).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : 'N/A',
      amountFormatted: tx.amount >= 0 ? `+$${Math.abs(tx.amount).toFixed(2)}` : `-$${Math.abs(tx.amount).toFixed(2)}`,
      amountClass: tx.amount >= 0 ? 'positive' : 'negative'
    }));
    res.render('transactions', { user: req.session.user, accounts, account: selectedAccount, transactions: formattedTransactions });
  } catch (error) {
    console.error('Transactions error:', error);
    res.status(500).render('error', { message: 'Failed to load transactions' });
  }
});

app.get('/transfer', requireLogin, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const accounts = await sqlAll(`SELECT * FROM accounts WHERE userId = ?`, [uid]);
    res.render('transfer', { user: req.session.user, accounts, success: null, error: null, successAmount: null });
  } catch (error) {
    console.error('Transfer page error:', error);
    res.status(500).render('error', { message: 'Failed to load transfer page' });
  }
});

app.post('/transfer', requireLogin, async (req, res) => {
  try {
    const { transferType, fromAccount, toAccount, amount, memo, recipientName, bankName, routingNumber, accountNumber, swiftCode, country, purpose } = req.body;
    const uid = req.session.user.id;
    const fromAcc = await sqlGet(`SELECT * FROM accounts WHERE id = ? AND userId = ?`, [fromAccount, uid]);
    const toAcc = toAccount ? await sqlGet(`SELECT * FROM accounts WHERE id = ? AND userId = ?`, [toAccount, uid]) : null;
    const amt = parseFloat(amount);
    if (!fromAcc || isNaN(amt) || amt <= 0) {
      return res.render('transfer', { user: req.session.user, accounts: await sqlAll(`SELECT * FROM accounts WHERE userId = ?`, [uid]), success: null, error: 'Invalid transfer details.', successAmount: null });
    }
    if (amt > fromAcc.balance) {
      return res.render('transfer', { user: req.session.user, accounts: await sqlAll(`SELECT * FROM accounts WHERE userId = ?`, [uid]), success: null, error: 'Insufficient funds.', successAmount: null });
    }
    let arrivalDays, transferLabel, toAccountName, txDescription, fee = 0;
    switch (transferType) {
      case 'internal':
        if (!toAcc) {
          return res.render('transfer', { user: req.session.user, accounts: await sqlAll(`SELECT * FROM accounts WHERE userId = ?`, [uid]), success: null, error: 'Please select a destination account.', successAmount: null });
        }
        arrivalDays = 'Instant'; transferLabel = 'Internal Transfer'; toAccountName = `${toAcc.name} (${toAcc.number})`; txDescription = `Transfer to ${toAcc.name}`;
        await sqlRun(`UPDATE accounts SET balance = balance - ? WHERE id = ?`, [amt, fromAcc.id]);
        await sqlRun(`UPDATE accounts SET balance = balance + ? WHERE id = ?`, [amt, toAcc.id]);
        await sqlRun(`INSERT INTO transactions (userId, accountId, type, amount, description, date) VALUES (?,?,?,?,?,?)`, [uid, fromAcc.id, 'Transfer Out', -amt, txDescription, new Date().toISOString()]);
        await sqlRun(`INSERT INTO transactions (userId, accountId, type, amount, description, date) VALUES (?,?,?,?,?,?)`, [uid, toAcc.id, 'Transfer In', amt, `From ${fromAcc.name}`, new Date().toISOString()]);
        break;
      case 'domestic':
        fee = 25; arrivalDays = 'Same Day'; transferLabel = 'Domestic Wire'; toAccountName = recipientName || 'External Account'; txDescription = `Domestic Wire to ${recipientName}`;
        await sqlRun(`UPDATE accounts SET balance = balance - ? WHERE id = ?`, [amt + fee, fromAcc.id]);
        await sqlRun(`INSERT INTO transactions (userId, accountId, type, amount, description, date) VALUES (?,?,?,?,?,?)`, [uid, fromAcc.id, 'Wire Out', -amt, txDescription, new Date().toISOString()]);
        await sqlRun(`INSERT INTO transactions (userId, accountId, type, amount, description, date) VALUES (?,?,?,?,?,?)`, [uid, fromAcc.id, 'Fee', -fee, 'Domestic Wire Fee', new Date().toISOString()]);
        break;
      case 'international':
        fee = 45; arrivalDays = '1-5 Business Days'; transferLabel = 'International Wire'; toAccountName = `${recipientName} (${country || 'Intl'})`; txDescription = `International Wire to ${recipientName}`;
        await sqlRun(`UPDATE accounts SET balance = balance - ? WHERE id = ?`, [amt + fee, fromAcc.id]);
        await sqlRun(`INSERT INTO transactions (userId, accountId, type, amount, description, date) VALUES (?,?,?,?,?,?)`, [uid, fromAcc.id, 'Wire Out', -amt, txDescription, new Date().toISOString()]);
        await sqlRun(`INSERT INTO transactions (userId, accountId, type, amount, description, date) VALUES (?,?,?,?,?,?)`, [uid, fromAcc.id, 'Fee', -fee, 'International Wire Fee', new Date().toISOString()]);
        break;
      default:
        arrivalDays = '1-3 Business Days'; transferLabel = 'External Transfer'; toAccountName = 'External Account'; txDescription = 'Transfer to External Account';
        await sqlRun(`UPDATE accounts SET balance = balance - ? WHERE id = ?`, [amt, fromAcc.id]);
        await sqlRun(`INSERT INTO transactions (userId, accountId, type, amount, description, date) VALUES (?,?,?,?,?,?)`, [uid, fromAcc.id, 'Transfer Out', -amt, txDescription, new Date().toISOString()]);
    }
    await sqlRun(`INSERT INTO transfers (userId, fromAccount, toAccount, amount, date, status) VALUES (?,?,?,?,?,?)`, [uid, fromAcc.id, toAcc?.id || null, amt, new Date().toISOString(), 'completed']);
    res.render('transfer-confirm', { user: req.session.user, amount: '$' + amt.toLocaleString('en-US', { minimumFractionDigits: 2 }), fromAccount: fromAcc.name, fromAccountNumber: fromAcc.number, toAccount: toAccountName, transferType: transferLabel, arrivalDays: arrivalDays, memo: memo || null, date: new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }), fee: fee > 0 ? '$' + fee : null });
  } catch (error) {
    console.error('Transfer processing error:', error);
    res.status(500).render('error', { message: 'Transfer failed. Please try again.' });
  }
});

app.get('/billpay', requireLogin, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const accounts = await sqlAll(`SELECT * FROM accounts WHERE userId = ?`, [uid]);
    res.render('billpay', { user: req.session.user, accounts, error: req.query.error ? decodeURIComponent(req.query.error) : null, success: req.query.status === 'success', successAmount: req.query.amount || null });
  } catch (error) {
    console.error('Bill pay page error:', error);
    res.status(500).render('error', { message: 'Failed to load bill pay' });
  }
});

app.post('/billpay', requireLogin, async (req, res) => {
  try {
    const { payeeName, accountNumber, amount, fromAccount } = req.body;
    const uid = req.session.user.id;
    const fromAcc = await sqlGet(`SELECT * FROM accounts WHERE id = ? AND userId = ?`, [fromAccount, uid]);
    const amt = parseFloat(amount);
    if (!fromAcc || isNaN(amt) || amt <= 0) { return res.redirect('/billpay?error=' + encodeURIComponent('Invalid payment details.')); }
    if (amt > fromAcc.balance) { return res.redirect('/billpay?error=' + encodeURIComponent('Insufficient funds.')); }
    await sqlRun(`UPDATE accounts SET balance = balance - ? WHERE id = ?`, [amt, fromAcc.id]);
    await sqlRun(`INSERT INTO billpay_transactions (userId, fromAccount, amount, date, payeeName) VALUES (?,?,?,?,?)`, [uid, fromAcc.id, amt, new Date().toISOString(), payeeName]);
    await sqlRun(`INSERT INTO transactions (userId, accountId, type, amount, description, date) VALUES (?,?,?,?,?,?)`, [uid, fromAcc.id, 'Bill Pay', -amt, `Bill Payment to ${payeeName}`, new Date().toISOString()]);
    res.render('billpay-confirm', { user: req.session.user, amount: '$' + amt.toLocaleString('en-US', { minimumFractionDigits: 2 }), fromAccount: fromAcc.name, fromAccountNumber: fromAcc.number, payeeName: payeeName || 'Payee', payeeAccount: accountNumber || 'N/A', arrivalDays: '1-3 Business Days', confirmationNumber: 'BP-' + Date.now().toString().slice(-8), date: new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) });
  } catch (error) {
    console.error('Bill pay processing error:', error);
    res.status(500).render('error', { message: 'Payment failed. Please try again.' });
  }
});

app.get('/billpay/history', requireLogin, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const transactions = await sqlAll(`SELECT * FROM billpay_transactions WHERE userId = ? ORDER BY date DESC`, [uid]);
    res.render('history', { user: req.session.user, transactions });
  } catch (error) {
    console.error('Bill pay history error:', error);
    res.status(500).render('error', { message: 'Failed to load history' });
  }
});

app.get('/billpay/history/export', requireLogin, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const rows = await sqlAll(`SELECT * FROM billpay_transactions WHERE userId = ? ORDER BY date DESC`, [uid]);
    const header = 'id,userId,fromAccount,amount,date,payeeName';
    const csv = [header, ...rows.map(r => [r.id, r.userId, r.fromAccount, r.amount, r.date, r.payeeName].join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="billpay-history.csv"');
    res.send(csv);
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).send('Export failed');
  }
});

app.get('/profile', requireLogin, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const accounts = await sqlAll(`SELECT * FROM accounts WHERE userId = ?`, [uid]);
    res.render('profile', { user: req.session.user, accounts, success: null, error: null });
  } catch (error) {
    console.error('Profile page error:', error);
    res.status(500).render('error', { message: 'Failed to load profile' });
  }
});

app.post('/profile', requireLogin, async (req, res) => {
  try {
    const { email, address, city, state, zip } = req.body;
    const uid = req.session.user.id;
    await sqlRun(`UPDATE users SET email = ?, address = ?, city = ?, state = ?, zip = ? WHERE id = ?`, [email, address, city, state, zip, uid]);
    const user = await sqlGet(`SELECT * FROM users WHERE id = ?`, [uid]);
    if (user) { const clean = { ...user }; delete clean.password; req.session.user = clean; }
    const accounts = await sqlAll(`SELECT * FROM accounts WHERE userId = ?`, [uid]);
    res.render('profile', { user: req.session.user, accounts, success: 'Profile updated successfully!', error: null });
  } catch (error) {
    console.error('Profile update error:', error);
    res.status(500).render('error', { message: 'Failed to update profile' });
  }
});

// ---------------------------------------------------------------
// Admin Routes (Require Admin Role)
// ---------------------------------------------------------------
app.get('/admin', requireAdmin, async (req, res) => {
  try {
    const users = await sqlAll(`SELECT id, username, email, isAdmin, isLocked, created_at FROM users ORDER BY id`);
    res.render('admin', { user: req.session.user, users });
  } catch (error) { console.error('Admin dashboard error:', error); res.status(500).render('error', { message: 'Failed to load admin panel' }); }
});

app.get('/admin/users', requireAdmin, async (req, res) => {
  try {
    const q = req.query.q || '';
    const users = await sqlAll(`SELECT id, username, email, isAdmin, isLocked, created_at FROM users WHERE username LIKE ? OR email LIKE ? ORDER BY id`, [`%${q}%`, `%${q}%`]);
    res.render('admin_users', { user: req.session.user, users, query: q });
  } catch (error) { console.error('Admin users error:', error); res.status(500).render('error', { message: 'Failed to load users' }); }
});

app.get('/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    const uid = parseInt(req.params.id, 10);
    if (isNaN(uid)) return res.redirect('/admin/users');
    const viewedUser = await sqlGet(`SELECT * FROM users WHERE id = ?`, [uid]);
    if (!viewedUser) return res.redirect('/admin/users');
    const accounts = await sqlAll(`SELECT * FROM accounts WHERE userId = ?`, [uid]);
    const bills = await sqlAll(`SELECT * FROM billpay_transactions WHERE userId = ? ORDER BY date DESC`, [uid]);
    const transactions = await sqlAll(`SELECT t.*, a.name AS accountName FROM transactions t LEFT JOIN accounts a ON t.accountId = a.id WHERE t.userId = ? ORDER BY t.date DESC`, [uid]);
    const transfers = await sqlAll(`SELECT * FROM transfers WHERE userId = ? ORDER BY date DESC`, [uid]);
    res.render('admin_user', { user: req.session.user, viewedUser, accounts, bills, transactions, transfers });
  } catch (error) { console.error('Admin user detail error:', error); res.status(500).render('error', { message: 'Failed to load user details' }); }
});

app.post('/admin/users/:id/toggleAdmin', requireAdmin, async (req, res) => {
  try {
    const uid = parseInt(req.params.id, 10);
    if (isNaN(uid)) return res.redirect('/admin/users');
    const target = await sqlGet(`SELECT isAdmin FROM users WHERE id = ?`, [uid]);
    if (!target) return res.redirect('/admin/users');
    const newVal = target.isAdmin === 1 ? 0 : 1;
    await sqlRun(`UPDATE users SET isAdmin = ? WHERE id = ?`, [newVal, uid]);
    console.log(`🔐 Admin status changed for user ${uid}: ${newVal === 1 ? 'GRANTED' : 'REVOKED'}`);
    res.redirect(`/admin/users/${uid}`);
  } catch (error) { console.error('Toggle admin error:', error); res.status(500).send('Failed to update admin status'); }
});

app.post('/admin/users/:id/lock', requireAdmin, async (req, res) => {
  try {
    const uid = parseInt(req.params.id, 10);
    if (isNaN(uid)) return res.redirect('/admin/users');
    const minutes = parseInt(req.body.minutes, 10) || 60;
    const lockUntil = new Date(Date.now() + minutes * 60 * 1000).toISOString();
    await sqlRun(`UPDATE users SET isLocked = 1, lockUntil = ? WHERE id = ?`, [lockUntil, uid]);
    console.log(`🔒 User ${uid} locked for ${minutes} minutes`);
    res.redirect(`/admin/users/${uid}`);
  } catch (error) { console.error('Lock user error:', error); res.status(500).send('Failed to lock user'); }
});

app.post('/admin/users/:id/unlock', requireAdmin, async (req, res) => {
  try {
    const uid = parseInt(req.params.id, 10);
    if (isNaN(uid)) return res.redirect('/admin/users');
    await sqlRun(`UPDATE users SET isLocked = 0, lockUntil = NULL WHERE id = ?`, [uid]);
    console.log(`🔓 User ${uid} unlocked`);
    res.redirect(`/admin/users/${uid}`);
  } catch (error) { console.error('Unlock user error:', error); res.status(500).send('Failed to unlock user'); }
});

app.get('/admin/export/users', requireAdmin, async (req, res) => {
  try {
    const rows = await sqlAll(`SELECT id, username, email, isAdmin, isLocked, created_at FROM users ORDER BY id`);
    const header = 'id,username,email,isAdmin,isLocked,created_at';
    const csv = [header, ...rows.map(r => [r.id, r.username, r.email, r.isAdmin, r.isLocked, r.created_at].join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="users.csv"');
    res.send(csv);
  } catch (error) { console.error('User export error:', error); res.status(500).send('Export failed'); }
});

app.get('/admin/users/:id/export/billpay', requireAdmin, async (req, res) => {
  try {
    const uid = parseInt(req.params.id, 10);
    if (isNaN(uid)) return res.status(400).send('Invalid user ID');
    const rows = await sqlAll(`SELECT * FROM billpay_transactions WHERE userId = ? ORDER BY date DESC`, [uid]);
    const header = 'id,userId,fromAccount,amount,date,payeeName';
    const csv = [header, ...rows.map(r => [r.id, r.userId, r.fromAccount, r.amount, r.date, r.payeeName].join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="user-${uid}-billpay.csv"`);
    res.send(csv);
  } catch (error) { console.error('Bill pay export error:', error); res.status(500).send('Export failed'); }
});

app.get('/admin/users/:id/export/transactions', requireAdmin, async (req, res) => {
  try {
    const uid = parseInt(req.params.id, 10);
    if (isNaN(uid)) return res.status(400).send('Invalid user ID');
    const rows = await sqlAll(`SELECT t.id, t.accountId, t.type, t.amount, t.description, t.date, a.name AS accountName FROM transactions t LEFT JOIN accounts a ON t.accountId = a.id WHERE t.userId = ? ORDER BY t.date DESC`, [uid]);
    const header = 'id,accountId,type,amount,description,date,accountName';
    const csv = [header, ...rows.map(r => [r.id, r.accountId, r.type, r.amount, r.description, r.date, r.accountName].join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="user-${uid}-transactions.csv"`);
    res.send(csv);
  } catch (error) { console.error('Transaction export error:', error); res.status(500).send('Export failed'); }
});

// ---------------------------------------------------------------
// ✅ Footer Placeholder Routes (Professional Banking UX)
// ---------------------------------------------------------------

// Account type pages
app.get('/checking', requireLogin, (req, res) => {
  res.render('account-detail', { 
    user: req.session.user, 
    accountType: 'checking',
    title: 'Primary Checking',
    features: ['Free online banking', 'No monthly fees', 'FDIC insured', 'Mobile check deposit']
  });
});

app.get('/savings', requireLogin, (req, res) => {
  res.render('account-detail', { 
    user: req.session.user, 
    accountType: 'savings',
    title: 'High-Yield Savings',
    features: ['4.25% APY', 'No minimum balance', 'Automatic transfers', 'FDIC insured']
  });
});

app.get('/loans', requireLogin, (req, res) => {
  res.render('account-detail', { 
    user: req.session.user, 
    accountType: 'loans',
    title: 'Agricultural Loans',
    features: ['Competitive rates', 'Flexible terms', 'Fast approval', 'Local decision-making']
  });
});

// Support pages
app.get('/help-center', (req, res) => {
  res.render('support', { 
    user: req.session.user,
    title: 'Help Center',
    articles: [
      { q: 'How do I reset my password?', a: 'Click "Forgot password" on the login page.' },
      { q: 'How do I transfer money?', a: 'Go to Transfer > select accounts > enter amount.' },
      { q: 'Is my money insured?', a: 'Yes, all deposits are FDIC insured up to $250,000.' }
    ]
  });
});

app.get('/contact-us', (req, res) => {
  res.render('support', { 
    user: req.session.user,
    title: 'Contact Us',
    contact: {
      phone: '1-800-AGRI-BANK',
      email: 'support@agribank.texas',
      hours: 'Mon-Fri 8AM-6PM CT',
      address: '123 Farm Road, Austin, TX 78701'
    }
  });
});

// Company pages
app.get('/about-us', (req, res) => {
  res.render('support', { 
    user: req.session.user,
    title: 'About AgriBank Texas',
    content: 'Serving Texas farmers and rural communities since 1923. We understand agriculture because we live it.'
  });
});

app.get('/careers', (req, res) => {
  res.render('support', { 
    user: req.session.user,
    title: 'Careers',
    content: 'Join our team. We\'re hiring loan officers, customer service reps, and tech talent.'
  });
});

// ---------------------------------------------------------------
// Utility Routes
// ---------------------------------------------------------------
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', port: PORT, env: process.env.NODE_ENV || 'development', timestamp: new Date().toISOString(), uptime: process.uptime() });
});

app.get('/seed', requireAdmin, async (req, res) => {
  try {
    const accounts = await sqlAll(`SELECT * FROM accounts WHERE userId = 1`);
    await sqlRun(`DELETE FROM transactions WHERE userId = 1`);
    await sqlRun(`DELETE FROM transfers WHERE userId = 1`);
    async function tx(acctId, type, amt, desc, date) {
      await sqlRun(`INSERT INTO transactions (userId, accountId, type, amount, description, date) VALUES (?, ?, ?, ?, ?, ?)`, [1, acctId, type, amt, desc, date]);
    }
    const c = accounts[0]?.id, s = accounts[1]?.id, b = accounts[2]?.id;
    if (c && s && b) {
      await tx(c, 'Deposit', 5200.00, 'Payroll - Direct Deposit', '2024-10-15');
      await tx(c, 'Deposit', 5200.00, 'Payroll - Direct Deposit', '2024-10-31');
      await tx(c, 'Withdrawal', -1850.00, 'Mortgage Payment', '2024-10-20');
      await tx(c, 'Deposit', 5200.00, 'Payroll - Direct Deposit', '2024-11-15');
      await tx(c, 'Deposit', 3420.50, 'Farm Equipment Sale', '2024-11-22');
      await tx(c, 'Withdrawal', -245.60, 'Insurance Premium', '2024-11-25');
      await tx(c, 'Deposit', 5200.00, 'Payroll - Direct Deposit', '2024-12-15');
      await tx(c, 'Withdrawal', -890.75, 'Utility Bills', '2024-12-18');
      await tx(c, 'Deposit', 5200.00, 'Payroll - Direct Deposit', '2025-01-15');
      await tx(c, 'Deposit', 4125.00, 'USDA Farm Subsidy', '2025-01-22');
      await tx(c, 'Withdrawal', -678.35, 'Equipment Loan Payment', '2025-01-28');
      await tx(c, 'Deposit', 2890.00, 'Tax Refund', '2025-02-10');
      await tx(c, 'Deposit', 5200.00, 'Payroll - Direct Deposit', '2025-02-15');
      await tx(c, 'Withdrawal', -2141.90, 'Transfer to Savings', '2025-02-20');
      await tx(s, 'Deposit', 48500.00, 'Fall Harvest - Corn', '2024-10-20');
      await tx(s, 'Deposit', 32000.00, 'Grain Elevator Sale - Wheat', '2024-11-05');
      await tx(s, 'Deposit', 28750.00, 'Livestock Sale - Cattle', '2024-11-18');
      await tx(s, 'Deposit', 15200.00, 'Equipment Sale - Old Combine', '2024-12-01');
      await tx(s, 'Withdrawal', -15000.00, 'Transfer to Checking', '2024-12-05');
      await tx(s, 'Deposit', 36500.00, 'Soybean Harvest Proceeds', '2024-12-15');
      await tx(s, 'Deposit', 22000.00, 'Land Rental Income', '2025-01-01');
      await tx(s, 'Deposit', 41250.00, 'Seed Corn Sales', '2025-01-10');
      await tx(s, 'Deposit', 19800.00, 'Crop Insurance Settlement', '2025-01-20');
      await tx(s, 'Deposit', 38750.00, 'Cattle Sale - Spring Herd', '2025-02-01');
      await tx(s, 'Deposit', 8920.25, 'Interest Accrual Q4 2024', '2025-02-05');
      await tx(s, 'Withdrawal', -48000.00, 'Transfer to Business', '2025-02-10');
      await tx(s, 'Deposit', 12340.00, 'Equipment Rental Income', '2025-02-15');
      await tx(s, 'Deposit', 37680.00, 'Annual Dividend - Farm Co-op', '2025-02-20');
      await tx(b, 'Deposit', 87500.00, 'Client Payment - Johnson Farms', '2024-10-10');
      await tx(b, 'Deposit', 65200.00, 'Client Payment - Miller Ranch', '2024-10-25');
      await tx(b, 'Withdrawal', -42000.00, 'Equipment Lease - John Deere 8R', '2024-10-30');
      await tx(b, 'Deposit', 72000.00, 'Client Payment - Henderson Ag', '2024-11-12');
      await tx(b, 'Deposit', 58350.00, 'Client Payment - Westfield Co-op', '2024-11-28');
      await tx(b, 'Withdrawal', -18750.00, 'Insurance Premium - Annual', '2024-12-01');
      await tx(b, 'Deposit', 95000.00, 'Client Payment - Lone Star Cattle', '2024-12-15');
      await tx(b, 'Withdrawal', -28400.00, 'Property Tax Payment', '2024-12-20');
      await tx(b, 'Deposit', 62800.00, 'Client Payment - Davis Family Farm', '2025-01-08');
      await tx(b, 'Deposit', 78500.00, 'Client Payment - Prairie Wind', '2025-01-22');
      await tx(b, 'Withdrawal', -8920.75, 'Operating Expenses', '2025-01-30');
      await tx(b, 'Deposit', 68000.00, 'Client Payment - Johnson Farms', '2025-02-08');
      await tx(b, 'Withdrawal', -15632.00, 'Equipment Maintenance - Tractors', '2025-02-15');
      await tx(b, 'Deposit', 80950.00, 'Client Payment - Continental Grain', '2025-02-22');
    }
    const count = await sqlGet(`SELECT COUNT(*) AS c FROM transactions WHERE userId = 1`);
    res.send(`<!DOCTYPE html><html><head><title>✅ Demo Data Seeded</title><meta name="viewport" content="width=device-width, initial-scale=1.0"><link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=DM+Mono&display=swap" rel="stylesheet"><style>body{font-family:'DM Mono',monospace;background:#0d1a0f;color:#e8efe9;max-width:700px;margin:50px auto;padding:20px}.box{background:#1a2b1e;border:1px solid #2a3d2e;border-radius:8px;padding:2rem}h1{font-family:'DM Serif Display',serif;color:#4ade80}.stats{background:#142017;border-radius:6px;padding:1rem;margin:1.5rem 0}.stats div{padding:0.4rem 0;font-size:0.85rem;border-bottom:1px solid #2a3d2e}.stats div:last-child{border:none}.total{color:#4ade80;font-weight:bold}a{display:inline-block;margin:0.5rem 0.5rem 0 0;padding:0.6rem 1.2rem;background:#4ade80;color:#0d1a0f;text-decoration:none;border-radius:4px;font-size:0.8rem;font-weight:500}a:hover{opacity:0.85}</style></head><body><div class="box"><h1>✅ Demo Data Seeded</h1><p>Added <strong>${count?.c || 0} transactions</strong> to Andrew's accounts.</p><div class="stats"><div><strong>Primary Checking (****4521):</strong> 14 txns → <span class="total">$42,420.50</span></div><div><strong>Savings Account (****8934):</strong> 14 txns → <span class="total">$325,890.25</span></div><div><strong>Business Operating (****2156):</strong> 14 txns → <span class="total">$595,697.25</span></div><div style="border:none;padding-top:0.8rem"><strong>Total Balance:</strong> <span class="total">$964,008.00</span></div></div><a href="/transactions">View Transactions</a><a href="/dashboard">Dashboard</a><a href="/admin">Admin Panel</a></div></body></html>`);
  } catch (error) { console.error('Seed error:', error); res.status(500).send('Failed to seed data'); }
});

// ---------------------------------------------------------------
// Error Handling
// ---------------------------------------------------------------
app.use((req, res) => {
  console.log(`⚠️ 404: ${req.method} ${req.path}`);
  res.status(404).render('error', { message: 'Page not found', code: 404 });
});

app.use((err, req, res, next) => {
  console.error('❌ Express error:', err.message);
  console.error(err.stack);
  const isProd = process.env.NODE_ENV === 'production';
  res.status(err.status || 500).render('error', { message: isProd ? 'Something went wrong' : err.message, code: err.status || 500, stack: isProd ? null : err.stack });
});

process.on('unhandledRejection', (reason, promise) => { console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason); });
process.on('uncaughtException', (err) => { console.error('💥 Uncaught Exception:', err.message); console.error(err.stack); process.exit(1); });

// ---------------------------------------------------------------
// Start Server
// ---------------------------------------------------------------
async function startServer() {
  try {
    await initDB();
    const server = app.listen(PORT, HOST, () => {
      console.log(`🚀 AgriBank Texas running on ${HOST}:${PORT}`);
      console.log(`🔗 Local: http://localhost:${PORT}`);
      if (process.env.RAILWAY_STATIC_URL) { console.log(`🌐 Public: ${process.env.RAILWAY_STATIC_URL}`); }
    });
    process.on('SIGTERM', () => { console.log('🔄 SIGTERM received, shutting down gracefully...'); server.close(() => { console.log('✅ Server closed'); process.exit(0); }); });
    process.on('SIGINT', () => { console.log('🔄 SIGINT received, shutting down gracefully...'); server.close(() => { console.log('✅ Server closed'); process.exit(0); }); });
  } catch (err) { console.error('❌ Failed to start server:', err.message); process.exit(1); }
}
startServer();