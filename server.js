 require('dotenv').config();

const express = require('express');
const session = require('express-session');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'replace-this-in-production',
  name: 'agribank.sid',
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.currentPath = req.path;
  next();
});

const sqlRun = (sql, params = []) => db.run(sql, params);
const sqlGet = (sql, params = []) => db.get(sql, params);
const sqlAll = (sql, params = []) => db.all(sql, params);

function formatMoney(value) {
  return `$${Number(value || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}

function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.isAdmin !== 1) return res.redirect('/login');
  next();
}

function cleanUser(user) {
  if (!user) return null;
  const clone = { ...user };
  delete clone.password;
  return clone;
}

function buildMonthlyBars(transactions = []) {
  const months = [];
  const now = new Date();

  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({
      key: `${d.getFullYear()}-${d.getMonth()}`,
      label: d.toLocaleDateString('en-US', { month: 'short' }),
      total: 0
    });
  }

  transactions.forEach(tx => {
    const d = new Date(tx.date);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    const month = months.find(m => m.key === key);
    if (month) month.total += Math.abs(Number(tx.amount || 0));
  });

  const max = Math.max(...months.map(m => m.total), 1);

  return months.map(m => ({
    label: m.label,
    value: m.total,
    height: Math.max(12, Math.round((m.total / max) * 100))
  }));
}

function ensureDefaultNotifications(userId) {
  const existing = sqlGet(`SELECT COUNT(*) AS count FROM notifications WHERE userId = ?`, [userId]);
  if (existing && existing.count > 0) return;

  const items = [
    ['Security Notice', 'Review your recent sign-in activity and enable strong password habits.', 'security'],
    ['Statement Ready', 'Your latest account statement is available for export.', 'statement'],
    ['Loan Offers', 'Explore flexible equipment and operating loans for your farm business.', 'loan']
  ];

  items.forEach(([title, message, type]) => {
    sqlRun(
      `INSERT INTO notifications (userId, title, message, type, isRead, created_at)
       VALUES (?, ?, ?, ?, 0, ?)`,
      [userId, title, message, type, new Date().toISOString()]
    );
  });
}

function initDB() {
  // 1. NUKE THE OLD CORRUPTED DATABASE TABLES
  sqlRun(`DROP TABLE IF EXISTS login_history`);
  sqlRun(`DROP TABLE IF EXISTS notifications`);
  sqlRun(`DROP TABLE IF EXISTS transfers`);
  sqlRun(`DROP TABLE IF EXISTS billpay_transactions`);
  sqlRun(`DROP TABLE IF EXISTS transactions`);
  sqlRun(`DROP TABLE IF EXISTS accounts`);
  sqlRun(`DROP TABLE IF EXISTS users`);

  // 2. REBUILD EVERYTHING PERFECTLY
  sqlRun(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    firstName TEXT NOT NULL,
    lastName TEXT NOT NULL,
    email TEXT NOT NULL,
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

  sqlRun(`CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    number TEXT NOT NULL,
    balance REAL DEFAULT 0,
    icon TEXT,
    FOREIGN KEY (userId) REFERENCES users(id)
  )`);

  sqlRun(`CREATE TABLE IF NOT EXISTS transactions (
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

  sqlRun(`CREATE TABLE IF NOT EXISTS billpay_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER NOT NULL,
    fromAccount INTEGER NOT NULL,
    amount REAL NOT NULL,
    date TEXT,
    payeeName TEXT,
    accountNumber TEXT,
    FOREIGN KEY (userId) REFERENCES users(id),
    FOREIGN KEY (fromAccount) REFERENCES accounts(id)
  )`);

  sqlRun(`CREATE TABLE IF NOT EXISTS transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER NOT NULL,
    fromAccount INTEGER NOT NULL,
    toAccount INTEGER,
    amount REAL NOT NULL,
    date TEXT,
    status TEXT DEFAULT 'completed',
    transferType TEXT,
    memo TEXT,
    FOREIGN KEY (userId) REFERENCES users(id),
    FOREIGN KEY (fromAccount) REFERENCES accounts(id),
    FOREIGN KEY (toAccount) REFERENCES accounts(id)
  )`);

  sqlRun(`CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    type TEXT DEFAULT 'general',
    isRead INTEGER DEFAULT 0,
    created_at TEXT,
    FOREIGN KEY (userId) REFERENCES users(id)
  )`);

  // --- NEW: LOGIN HISTORY TABLE ---
  sqlRun(`CREATE TABLE IF NOT EXISTS login_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER NOT NULL,
    ipAddress TEXT,
    device TEXT,
    status TEXT,
    timestamp TEXT,
    FOREIGN KEY (userId) REFERENCES users(id)
  )`);

  const demoHash = bcrypt.hashSync('Demo@123', 10);
  const adminHash = bcrypt.hashSync('Admin@123', 10);
  const andrewHash = bcrypt.hashSync('Andrew2026', 10);

  // 1. STANDARD DEMO USER
  const customer = sqlRun(
    `INSERT INTO users (username, password, firstName, lastName, email, memberSince, address, city, state, zip, isAdmin, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ['farmerdemo', demoHash, 'Carter', 'Fields', 'carter.fields@example.com', '2019', '218 County Road 14', 'Lubbock', 'TX', '79401', new Date().toISOString()]
  );

  // 2. ADMIN USER
  sqlRun(
    `INSERT INTO users (username, password, firstName, lastName, email, memberSince, address, city, state, zip, isAdmin, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    ['admin', adminHash, 'Admin', 'Manager', 'admin@agribank.local', '2021', '100 Market Street', 'Austin', 'TX', '78701', new Date().toISOString()]
  );

  // 3. ANDREW ALEJANDRO DEMO USER
  const andrew = sqlRun(
    `INSERT INTO users (username, password, firstName, lastName, email, memberSince, address, city, state, zip, isAdmin, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ['Andrew2017', andrewHash, 'Andrew Diego', 'Alejandro', 'andrew.alejandro@example.com', '2017', '4592 Longhorn Drive', 'Dallas', 'TX', '75201', new Date().toISOString()]
  );

  // --- SETUP ACCOUNTS FOR CARTER ---
  const checking = sqlRun(`INSERT INTO accounts (userId, name, type, number, balance, icon) VALUES (?, 'Primary Checking', 'checking', '****4521', 42420.50, '🏦')`, [customer.lastID]);
  const savings = sqlRun(`INSERT INTO accounts (userId, name, type, number, balance, icon) VALUES (?, 'Harvest Savings', 'savings', '****8934', 325890.25, '💰')`, [customer.lastID]);
  const business = sqlRun(`INSERT INTO accounts (userId, name, type, number, balance, icon) VALUES (?, 'Business Operating', 'business', '****2156', 595697.25, '🏢')`, [customer.lastID]);

  const seedTransactions = [
    [checking.lastID, 'Deposit', 5200.00, 'Payroll - Direct Deposit', '2026-01-15'],
    [checking.lastID, 'Withdrawal', -845.32, 'Fuel & Transport', '2026-01-21'],
    [checking.lastID, 'Deposit', 3890.00, 'Tax Refund', '2026-02-02'],
    [savings.lastID, 'Deposit', 24850.00, 'Corn Harvest Proceeds', '2026-02-10'],
    [savings.lastID, 'Deposit', 12800.00, 'Crop Insurance Settlement', '2026-03-05'],
    [business.lastID, 'Deposit', 68000.00, 'Johnson Farms Invoice', '2026-03-12'],
    [business.lastID, 'Withdrawal', -15632.00, 'Equipment Maintenance', '2026-03-18'],
    [checking.lastID, 'Withdrawal', -2141.90, 'Transfer to Savings', '2026-03-21'],
    [checking.lastID, 'Deposit', 5200.00, 'Payroll - Direct Deposit', '2026-04-02'],
    [business.lastID, 'Deposit', 80950.00, 'Continental Grain Payment', '2026-04-06']
  ];

  seedTransactions.forEach(([accountId, type, amount, description, date]) => {
    sqlRun(`INSERT INTO transactions (userId, accountId, type, amount, description, date) VALUES (?, ?, ?, ?, ?, ?)`, [customer.lastID, accountId, type, amount, description, date]);
  });

  // --- SETUP ACCOUNTS FOR ANDREW (Total: 863,945.89) ---
  const andrewChecking = sqlRun(`INSERT INTO accounts (userId, name, type, number, balance, icon) VALUES (?, 'Personal Checking', 'checking', '****7721', 88945.89, '🏦')`, [andrew.lastID]);
  const andrewSavings = sqlRun(`INSERT INTO accounts (userId, name, type, number, balance, icon) VALUES (?, 'High-Yield Reserve', 'savings', '****4492', 275000.00, '💰')`, [andrew.lastID]);
  const andrewBusiness = sqlRun(`INSERT INTO accounts (userId, name, type, number, balance, icon) VALUES (?, 'Commercial Operating', 'business', '****9933', 500000.00, '🏢')`, [andrew.lastID]);

  // EXACTLY 26 TRANSACTIONS FOR ANDREW
  const andrewTransactions = [
    [andrewChecking.lastID, 'Deposit', 12500.00, 'Direct Deposit - Salary', '2026-01-05'],
    [andrewChecking.lastID, 'Withdrawal', -450.00, 'Whole Foods Market', '2026-01-08'],
    [andrewBusiness.lastID, 'Deposit', 45000.00, 'Client Invoice - TX Energy', '2026-01-12'],
    [andrewChecking.lastID, 'Withdrawal', -2100.00, 'Mortgage Payment', '2026-01-15'],
    [andrewSavings.lastID, 'Deposit', 5000.00, 'Transfer from Checking', '2026-01-18'],
    [andrewBusiness.lastID, 'Withdrawal', -3200.50, 'Equipment Lease', '2026-01-22'],
    [andrewChecking.lastID, 'Withdrawal', -150.75, 'Shell Gas Station', '2026-01-25'],
    [andrewChecking.lastID, 'Deposit', 12500.00, 'Direct Deposit - Salary', '2026-02-05'],
    [andrewBusiness.lastID, 'Deposit', 85000.00, 'Contract Settlement - Ranch', '2026-02-08'],
    [andrewChecking.lastID, 'Withdrawal', -2100.00, 'Mortgage Payment', '2026-02-15'],
    [andrewBusiness.lastID, 'Withdrawal', -12450.00, 'Q1 Tax Payment', '2026-02-18'],
    [andrewChecking.lastID, 'Withdrawal', -85.20, 'Dallas Steakhouse', '2026-02-22'],
    [andrewSavings.lastID, 'Deposit', 10000.00, 'Transfer from Checking', '2026-02-28'],
    [andrewChecking.lastID, 'Deposit', 12500.00, 'Direct Deposit - Salary', '2026-03-05'],
    [andrewChecking.lastID, 'Withdrawal', -650.00, 'Auto Insurance', '2026-03-10'],
    [andrewBusiness.lastID, 'Deposit', 115000.00, 'Livestock Auction Proceeds', '2026-03-14'],
    [andrewChecking.lastID, 'Withdrawal', -2100.00, 'Mortgage Payment', '2026-03-15'],
    [andrewBusiness.lastID, 'Withdrawal', -8900.00, 'Barn Repairs & Maintenance', '2026-03-20'],
    [andrewChecking.lastID, 'Withdrawal', -320.00, 'Home Depot', '2026-03-24'],
    [andrewSavings.lastID, 'Deposit', 12000.00, 'Transfer from Checking', '2026-03-30'],
    [andrewChecking.lastID, 'Deposit', 12500.00, 'Direct Deposit - Salary', '2026-04-05'],
    [andrewBusiness.lastID, 'Deposit', 62000.00, 'Wholesale Feed Corp', '2026-04-12'],
    [andrewChecking.lastID, 'Withdrawal', -2100.00, 'Mortgage Payment', '2026-04-15'],
    [andrewChecking.lastID, 'Withdrawal', -120.00, 'AT&T Internet', '2026-04-20'],
    [andrewBusiness.lastID, 'Withdrawal', -4500.00, 'Commercial Insurance Premium', '2026-04-25'],
    [andrewChecking.lastID, 'Deposit', 12500.00, 'Direct Deposit - Salary', '2026-05-02']
  ];

  andrewTransactions.forEach(([accountId, type, amount, description, date]) => {
    sqlRun(`INSERT INTO transactions (userId, accountId, type, amount, description, date) VALUES (?, ?, ?, ?, ?, ?)`, [andrew.lastID, accountId, type, amount, description, date]);
  });

  ensureDefaultNotifications(customer.lastID);
  ensureDefaultNotifications(andrew.lastID);

  const users = sqlAll(`SELECT id FROM users`);
  users.forEach(u => ensureDefaultNotifications(u.id));
}

function getUserAccounts(userId) {
  return sqlAll(`SELECT * FROM accounts WHERE userId = ? ORDER BY id`, [userId]);
}

function getUserTransactions(userId) {
  return sqlAll(
    `SELECT t.*, a.name AS accountName, a.number AS accountNumber
     FROM transactions t
     LEFT JOIN accounts a ON a.id = t.accountId
     WHERE t.userId = ?
     ORDER BY datetime(t.date) DESC, t.id DESC`,
    [userId]
  );
}

function decorateTransactions(rows) {
  return rows.map(tx => ({
    ...tx,
    dateFormatted: formatDate(tx.date),
    amountFormatted: formatMoney(Math.abs(tx.amount)),
    amountClass: Number(tx.amount) >= 0 ? 'positive' : 'negative'
  }));
}

// ==========================================
// PUBLIC ROUTES
// ==========================================

app.get('/', (req, res) => {
  if (req.session.user) {
    return res.redirect(req.session.user.isAdmin === 1 ? '/admin' : '/dashboard');
  }

  res.render('landing', {
    user: null,
    demoCredentials: {
      customer: { username: 'farmerdemo', password: 'Demo@123' },
      admin: { username: 'admin', password: 'Admin@123' }
    }
  });
});

app.get('/login', (req, res) => {
  res.render('login', {
    error: req.query.error || null,
    success: req.query.registered ? 'Account created. Please sign in.' : null,
    demoCredentials: {
      customer: { username: 'farmerdemo', password: 'Demo@123' },
      admin: { username: 'admin', password: 'Admin@123' }
    }
  });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  
  const ipAddress = req.ip || req.connection.remoteAddress || 'Unknown IP';
  const device = req.get('User-Agent') || 'Unknown Device';

  if (!username || !password) {
    return res.render('login', { error: 'Please enter your username and password.', success: null });
  }

  const user = sqlGet(`SELECT * FROM users WHERE username = ?`, [username]);

  if (!user || !bcrypt.compareSync(password, user.password)) {
    if (user) {
      sqlRun(`INSERT INTO login_history (userId, ipAddress, device, status, timestamp) VALUES (?, ?, ?, 'FAILED', ?)`, 
      [user.id, ipAddress, device, new Date().toISOString()]);
    }
    return res.render('login', { error: 'Invalid credentials.', success: null });
  }

  if (user.isLocked === 1) {
    sqlRun(`INSERT INTO login_history (userId, ipAddress, device, status, timestamp) VALUES (?, ?, ?, 'LOCKED', ?)`, 
    [user.id, ipAddress, device, new Date().toISOString()]);
    return res.render('login', { error: 'This account is currently locked. Contact an administrator.', success: null });
  }

  sqlRun(`INSERT INTO login_history (userId, ipAddress, device, status, timestamp) VALUES (?, ?, ?, 'SUCCESS', ?)`, 
  [user.id, ipAddress, device, new Date().toISOString()]);

  req.session.user = cleanUser(user);
  return res.redirect(user.isAdmin === 1 ? '/admin' : '/dashboard');
});

app.get('/register', (req, res) => {
  res.render('register', { error: null });
});

app.post('/register', (req, res) => {
  const {
    firstName, lastName, email, address, city, state, zip,
    accountType, username, password, confirmPassword
  } = req.body;

  if (!firstName || !lastName || !email || !username || !password || !confirmPassword) {
    return res.render('register', { error: 'Please complete all required fields.' });
  }

  if (password !== confirmPassword) {
    return res.render('register', { error: 'Passwords do not match.' });
  }

  if (password.length < 6) {
    return res.render('register', { error: 'Password must be at least 6 characters.' });
  }

  const exists = sqlGet(`SELECT id FROM users WHERE username = ?`, [username]);
  if (exists) {
    return res.render('register', { error: 'That username is already in use.' });
  }

  const hash = bcrypt.hashSync(password, 10);
  const result = sqlRun(
    `INSERT INTO users (username, password, firstName, lastName, email, memberSince, address, city, state, zip, isAdmin, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    [
      username, hash, firstName, lastName, email,
      String(new Date().getFullYear()),
      address || '', city || '', state || '', zip || '',
      new Date().toISOString()
    ]
  );

  const accountMap = {
    checking: ['Primary Checking', '🏦'],
    savings: ['Savings Account', '💰'],
    business: ['Business Operating', '🏢']
  };
  const selected = accountMap[accountType] || accountMap.checking;

  sqlRun(
    `INSERT INTO accounts (userId, name, type, number, balance, icon)
     VALUES (?, ?, ?, ?, 0, ?)`,
    [result.lastID, selected[0], accountType || 'checking', `****${Math.floor(1000 + Math.random() * 9000)}`, selected[1]]
  );

  sqlRun(
    `INSERT INTO notifications (userId, title, message, type, isRead, created_at)
     VALUES (?, 'Welcome to AgriBank Texas', 'Your new online banking profile is ready.', 'general', 0, ?)`,
    [result.lastID, new Date().toISOString()]
  );

  res.redirect('/login?registered=1');
});

app.get('/forgot-password', (req, res) => {
  res.render('forgot-password', { error: null, success: null, info: null });
});

app.post('/forgot-password', (req, res) => {
  const { username, email } = req.body;

  if (!username || !email) {
    return res.render('forgot-password', {
      error: 'Please enter both username and email.',
      success: null,
      info: null
    });
  }

  return res.render('forgot-password', {
    error: null,
    success: 'Instructions have been sent to your email.',
    info: 'Demo mode: In a live system, a secure token would be generated now.'
  });
});

// ==========================================
// MORE PUBLIC ROUTES (FIXED — All link to correct files)
// ==========================================

app.get('/promo-checking', (req, res) => res.render('promo-checking'));
app.get('/small-business', (req, res) => res.render('small-business'));
app.get('/commercial-farming', (req, res) => res.render('commercial-farming'));
app.get('/credit-cards', (req, res) => res.render('credit-cards', { user: req.session.user || null }));

// ✅ NEW PUBLIC PAGES (linked to their .ejs files)
app.get('/about', (req, res) => res.render('about'));
app.get('/privacy', (req, res) => res.render('privacy'));
app.get('/terms', (req, res) => res.render('terms'));
app.get('/security', (req, res) => res.render('security'));
app.get('/help', (req, res) => res.render('help'));

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ==========================================
// PRIVATE ROUTES
// ==========================================

app.get('/dashboard', requireLogin, (req, res) => {
  const user = req.session.user;
  const accounts = getUserAccounts(user.id);
  const transactions = getUserTransactions(user.id);
  const recentTransactions = decorateTransactions(transactions.slice(0, 8));
  const notifications = sqlAll(
    `SELECT * FROM notifications WHERE userId = ? ORDER BY datetime(created_at) DESC LIMIT 3`,
    [user.id]
  );

  const totalBalance = accounts.reduce((sum, acc) => sum + Number(acc.balance || 0), 0);
  const deposits = transactions.filter(t => Number(t.amount) > 0).reduce((sum, t) => sum + Number(t.amount), 0);
  const withdrawals = transactions.filter(t => Number(t.amount) < 0).reduce((sum, t) => sum + Math.abs(Number(t.amount)), 0);

  res.render('dashboard', {
    user, accounts, transactions: recentTransactions, notifications,
    totalBalance, deposits, withdrawals,
    monthlyBars: buildMonthlyBars(transactions)
  });
});

app.get('/accounts', requireLogin, (req, res) => {
  const accounts = getUserAccounts(req.session.user.id);
  const totalBalance = accounts.reduce((sum, acc) => sum + Number(acc.balance || 0), 0);
  res.render('accounts', { user: req.session.user, accounts, totalBalance });
});

app.get('/transactions', requireLogin, (req, res) => {
  const user = req.session.user;
  const accounts = getUserAccounts(user.id);
  const { accountId = '', type = '', q = '' } = req.query;
  let transactions = getUserTransactions(user.id);
  if (accountId) transactions = transactions.filter(t => String(t.accountId) === String(accountId));
  if (type) transactions = transactions.filter(t => t.type.toLowerCase().includes(type.toLowerCase()));
  if (q) transactions = transactions.filter(t => String(t.description || '').toLowerCase().includes(q.toLowerCase()) || String(t.accountName || '').toLowerCase().includes(q.toLowerCase()));
  res.render('transactions', { user, accounts, transactions: decorateTransactions(transactions), filters: { accountId, type, q } });
});

app.get('/transactions/export', requireLogin, (req, res) => {
  const rows = getUserTransactions(req.session.user.id);
  const header = 'date,accountName,accountNumber,type,description,amount';
  const body = rows.map(r => [r.date, `"${r.accountName || ''}"`, `"${r.accountNumber || ''}"`, `"${r.type || ''}"`, `"${(r.description || '').replace(/"/g, '""')}"`, r.amount].join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="transactions.csv"');
  res.send([header, ...body].join('\n'));
});

// ✅ BULLET-proof Transfer Route
app.get('/transfer', requireLogin, (req, res) => {
  try {
    const user = req.session.user;
    const accounts = getUserAccounts(user.id) || [];
    res.render('transfer', { user, accounts, error: null });
  } catch (err) {
    console.error("Transfer Route Error:", err);
    res.status(500).send("Server Error: " + err.message);
  }
});

app.post('/transfer', requireLogin, (req, res) => {
  const user = req.session.user;
  const accounts = getUserAccounts(user.id);
  const { transferType, fromAccount, toAccount, amount, memo, recipientName, bankName, accountNumber } = req.body;
  const source = sqlGet(`SELECT * FROM accounts WHERE id = ? AND userId = ?`, [fromAccount, user.id]);
  const target = toAccount ? sqlGet(`SELECT * FROM accounts WHERE id = ? AND userId = ?`, [toAccount, user.id]) : null;
  const amt = Number(amount);

  if (!source || !amt || amt <= 0) {
    return res.render('transfer', { user, accounts, error: 'Enter a valid transfer amount and source account.' });
  }
  const fee = transferType === 'international' ? 45 : transferType === 'domestic' ? 25 : 0;
  if (amt + fee > Number(source.balance)) {
    return res.render('transfer', { user, accounts, error: 'Insufficient funds for this transfer.' });
  }

  let destinationLabel = 'External account';
  let transferLabel = 'External Transfer';

  if (transferType === 'internal') {
    if (!target || target.id === source.id) {
      return res.render('transfer', { user, accounts, error: 'Choose a different destination account.' });
    }
    sqlRun(`UPDATE accounts SET balance = balance - ? WHERE id = ?`, [amt, source.id]);
    sqlRun(`UPDATE accounts SET balance = balance + ? WHERE id = ?`, [amt, target.id]);
    sqlRun(`INSERT INTO transactions (userId, accountId, type, amount, description, date) VALUES (?, ?, 'Transfer Out', ?, ?, ?)`, [user.id, source.id, -amt, `Transfer to ${target.name}`, new Date().toISOString()]);
    sqlRun(`INSERT INTO transactions (userId, accountId, type, amount, description, date) VALUES (?, ?, 'Transfer In', ?, ?, ?)`, [user.id, target.id, amt, `Transfer from ${source.name}`, new Date().toISOString()]);
    destinationLabel = `${target.name} (${target.number})`;
    transferLabel = 'Internal Transfer';
  } else {
    sqlRun(`UPDATE accounts SET balance = balance - ? WHERE id = ?`, [amt + fee, source.id]);
    sqlRun(`INSERT INTO transactions (userId, accountId, type, amount, description, date) VALUES (?, ?, 'Transfer Out', ?, ?, ?)`, [user.id, source.id, -amt, `Transfer to ${recipientName || 'external recipient'}`, new Date().toISOString()]);
    if (fee > 0) {
      sqlRun(`INSERT INTO transactions (userId, accountId, type, amount, description, date) VALUES (?, ?, 'Fee', ?, ?, ?)`, [user.id, source.id, -fee, `${transferType === 'international' ? 'International' : 'Domestic'} wire fee`, new Date().toISOString()]);
    }
    destinationLabel = `${recipientName || 'Recipient'}${bankName ? ` • ${bankName}` : ''}${accountNumber ? ` • ${accountNumber}` : ''}`;
    transferLabel = transferType === 'international' ? 'International Wire' : transferType === 'domestic' ? 'Domestic Wire' : 'External Transfer';
  }

  sqlRun(`INSERT INTO transfers (userId, fromAccount, toAccount, amount, date, status, transferType, memo) VALUES (?, ?, ?, ?, ?, 'completed', ?, ?)`, [user.id, source.id, target ? target.id : null, amt, new Date().toISOString(), transferType || 'external', memo || '']);
  sqlRun(`INSERT INTO notifications (userId, title, message, type, isRead, created_at) VALUES (?, 'Transfer Completed', ?, 'transfer', 0, ?)`, [user.id, `${transferLabel} of ${formatMoney(amt)} has been completed.`, new Date().toISOString()]);

  res.render('transfer-confirm', {
    user, summary: {
      amount: formatMoney(amt),
      fee: fee ? formatMoney(fee) : null,
      fromAccount: `${source.name} (${source.number})`,
      toAccount: destinationLabel,
      transferType: transferLabel,
      memo: memo || null,
      date: new Date().toLocaleString()
    }
  });
});

app.get('/billpay', requireLogin, (req, res) => {
  res.render('billpay', { user: req.session.user, accounts: getUserAccounts(req.session.user.id), error: null });
});

app.post('/billpay', requireLogin, (req, res) => {
  const user = req.session.user;
  const { payeeName, accountNumber, amount, fromAccount } = req.body;
  const account = sqlGet(`SELECT * FROM accounts WHERE id = ? AND userId = ?`, [fromAccount, user.id]);
  const amt = Number(amount);
  if (!account || !amt || amt <= 0) {
    return res.render('billpay', { user, accounts: getUserAccounts(user.id), error: 'Enter a valid payee, amount, and source account.' });
  }
  if (amt > Number(account.balance)) {
    return res.render('billpay', { user, accounts: getUserAccounts(user.id), error: 'Insufficient funds for this bill payment.' });
  }
  sqlRun(`UPDATE accounts SET balance = balance - ? WHERE id = ?`, [amt, account.id]);
  sqlRun(`INSERT INTO billpay_transactions (userId, fromAccount, amount, date, payeeName, accountNumber) VALUES (?, ?, ?, ?, ?, ?)`, [user.id, account.id, amt, new Date().toISOString(), payeeName, accountNumber || '']);
  sqlRun(`INSERT INTO transactions (userId, accountId, type, amount, description, date) VALUES (?, ?, 'Bill Pay', ?, ?, ?)`, [user.id, account.id, -amt, `Bill payment to ${payeeName}`, new Date().toISOString()]);
  sqlRun(`INSERT INTO notifications (userId, title, message, type, isRead, created_at) VALUES (?, 'Bill Payment Sent', ?, 'billpay', 0, ?)`, [user.id, `${formatMoney(amt)} was scheduled to ${payeeName}.`, new Date().toISOString()]);

  res.render('billpay-confirm', {
    user, summary: {
      amount: formatMoney(amt),
      fromAccount: `${account.name} (${account.number})`,
      payeeName,
      payeeAccount: accountNumber || 'N/A',
      confirmation: `BP-${Date.now().toString().slice(-8)}`,
      date: new Date().toLocaleString()
    }
  });
});

app.get('/billpay/history', requireLogin, (req, res) => {
  const rows = sqlAll(`SELECT b.*, a.name AS accountName, a.number AS accountNumber FROM billpay_transactions b LEFT JOIN accounts a ON a.id = b.fromAccount WHERE b.userId = ? ORDER BY datetime(b.date) DESC`, [req.session.user.id]);
  res.render('history', { user: req.session.user, transactions: rows });
});

app.get('/billpay/history/export', requireLogin, (req, res) => {
  const rows = sqlAll(`SELECT b.*, a.name AS accountName FROM billpay_transactions b LEFT JOIN accounts a ON a.id = b.fromAccount WHERE b.userId = ? ORDER BY datetime(b.date) DESC`, [req.session.user.id]);
  const header = 'date,payee,fromAccount,amount,accountNumber';
  const body = rows.map(r => [r.date, `"${r.payeeName}"`, `"${r.accountName}"`, r.amount, `"${r.accountNumber || ''}"`].join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="billpay-history.csv"');
  res.send([header, ...body].join('\n'));
});

// ✅ Deposits Route (linked to views/deposits.ejs)
app.get('/deposits', requireLogin, (req, res) => {
  res.render('deposits', { user: req.session.user, accounts: getUserAccounts(req.session.user.id) });
});

app.get('/loans', requireLogin, (req, res) => {
  res.render('loans', {
    user: req.session.user,
    products: [
      { title: 'Operating Loan', rate: '6.25% APR', desc: 'Flexible financing for seed, feed, labor, and seasonal cash flow.' },
      { title: 'Equipment Loan', rate: '5.90% APR', desc: 'Finance tractors, combines, irrigation systems, and processing equipment.' },
      { title: 'Land Improvement Loan', rate: '6.75% APR', desc: 'Support fencing, barns, drainage, and infrastructure upgrades.' }
    ]
  });
});

app.get('/notifications', requireLogin, (req, res) => {
  const notifications = sqlAll(`SELECT * FROM notifications WHERE userId = ? ORDER BY datetime(created_at) DESC`, [req.session.user.id]);
  res.render('notifications', { user: req.session.user, notifications });
});

app.post('/notifications/read-all', requireLogin, (req, res) => {
  sqlRun(`UPDATE notifications SET isRead = 1 WHERE userId = ?`, [req.session.user.id]);
  res.redirect('/notifications');
});

app.get('/profile', requireLogin, (req, res) => {
  const loginHistory = sqlAll(`SELECT * FROM login_history WHERE userId = ? ORDER BY datetime(timestamp) DESC LIMIT 10`, [req.session.user.id]);
  res.render('profile', {
    user: req.session.user, loginHistory, success: null, error: null,
    accounts: getUserAccounts(req.session.user.id)
  });
});

app.post('/profile', requireLogin, (req, res) => {
  const { email, address, city, state, zip } = req.body;
  const userId = req.session.user.id;
  sqlRun(`UPDATE users SET email = ?, address = ?, city = ?, state = ?, zip = ? WHERE id = ?`, [email, address, city, state, zip, userId]);
  const fresh = sqlGet(`SELECT * FROM users WHERE id = ?`, [userId]);
  req.session.user = cleanUser(fresh);
  const loginHistory = sqlAll(`SELECT * FROM login_history WHERE userId = ? ORDER BY datetime(timestamp) DESC LIMIT 10`, [userId]);
  res.render('profile', {
    user: req.session.user, loginHistory, success: 'Profile updated successfully.', error: null,
    accounts: getUserAccounts(userId)
  });
});

// ==========================================
// ADMIN ROUTES
// ==========================================

app.get('/admin', requireAdmin, (req, res) => {
  const users = sqlAll(`SELECT * FROM users ORDER BY id DESC`);
  const accounts = sqlAll(`SELECT * FROM accounts`);
  const transactions = sqlAll(`SELECT * FROM transactions ORDER BY datetime(date) DESC LIMIT 10`);
  res.render('admin', {
    user: req.session.user,
    stats: {
      users: users.length,
      admins: users.filter(u => u.isAdmin === 1).length,
      locked: users.filter(u => u.isLocked === 1).length,
      deposits: accounts.reduce((sum, a) => sum + Number(a.balance || 0), 0)
    },
    users: users.slice(0, 6),
    transactions: decorateTransactions(transactions)
  });
});

app.get('/admin/users', requireAdmin, (req, res) => {
  const q = req.query.q || '';
  let users = sqlAll(`SELECT * FROM users ORDER BY id DESC`);
  if (q) {
    users = users.filter(u =>
      u.username.toLowerCase().includes(q.toLowerCase()) ||
      u.email.toLowerCase().includes(q.toLowerCase()) ||
      `${u.firstName} ${u.lastName}`.toLowerCase().includes(q.toLowerCase())
    );
  }
  res.render('admin_users', { user: req.session.user, users, query: q });
});

app.get('/admin/users/:id', requireAdmin, (req, res) => {
  const userId = Number(req.params.id);
  const viewedUser = sqlGet(`SELECT * FROM users WHERE id = ?`, [userId]);
  if (!viewedUser) return res.status(404).render('error', { code: 404, message: 'User not found.' });
  const accounts = getUserAccounts(userId);
  const transactions = decorateTransactions(getUserTransactions(userId).slice(0, 12));
  const notifications = sqlAll(`SELECT * FROM notifications WHERE userId = ? ORDER BY datetime(created_at) DESC LIMIT 8`, [userId]);
  res.render('admin_user', { user: req.session.user, viewedUser, accounts, transactions, notifications });
});

app.post('/admin/users/:id/toggleAdmin', requireAdmin, (req, res) => {
  const userId = Number(req.params.id);
  const target = sqlGet(`SELECT isAdmin FROM users WHERE id = ?`, [userId]);
  if (!target) return res.redirect('/admin/users');
  sqlRun(`UPDATE users SET isAdmin = ? WHERE id = ?`, [target.isAdmin === 1 ? 0 : 1, userId]);
  res.redirect(`/admin/users/${userId}`);
});

app.post('/admin/users/:id/lock', requireAdmin, (req, res) => {
  const userId = Number(req.params.id);
  sqlRun(`UPDATE users SET isLocked = 1 WHERE id = ?`, [userId]);
  res.redirect(`/admin/users/${userId}`);
});

app.post('/admin/users/:id/unlock', requireAdmin, (req, res) => {
  const userId = Number(req.params.id);
  sqlRun(`UPDATE users SET isLocked = 0 WHERE id = ?`, [userId]);
  res.redirect(`/admin/users/${userId}`);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', env: process.env.NODE_ENV || 'development', uptime: process.uptime() });
});

// ==========================================
// ERROR HANDLERS
// ==========================================

app.use((req, res) => {
  res.status(404).render('error', { code: 404, message: 'Page not found.' });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { code: 500, message: 'Something went wrong.' });
});

initDB();

app.listen(PORT, HOST, () => {
  console.log(`AgriBank Texas running on http://${HOST}:${PORT}`);
});


                    