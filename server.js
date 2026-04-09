/********************************************************************
 *  AgriBank Texas – Full DB‑backed server with admin controls
 ********************************************************************/
require('dotenv').config();

const express = require('express');
const session = require('express-session');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

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
// Database helpers (updated for better-sqlite3)
// ---------------------------------------------------------------
function sqlRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    try {
      const result = db.run(sql, params);
      resolve({ lastID: result.lastInsertRowid, changes: result.changes });
    } catch (err) {
      reject(err);
    }
  });
}

function sqlGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    try {
      const row = db.get(sql, params);
      resolve(row);
    } catch (err) {
      reject(err);
    }
  });
}

function sqlAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    try {
      const rows = db.all(sql, params);
      resolve(rows);
    } catch (err) {
      reject(err);
    }
  });
}

// ---------------------------------------------------------------
// DB initialization & migrations
// ---------------------------------------------------------------
async function initDB() {
  await sqlRun(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    firstName TEXT,
    lastName TEXT,
    email TEXT,
    memberSince TEXT,
    address TEXT,
    city TEXT,
    state TEXT,
    zip TEXT,
    created_at TEXT
  )`);

  await sqlRun(`CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER,
    name TEXT,
    type TEXT,
    number TEXT,
    balance REAL,
    icon TEXT
  )`);

  await sqlRun(`CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER,
    accountId INTEGER,
    type TEXT,
    amount REAL,
    description TEXT,
    date TEXT
  )`);

  await sqlRun(`CREATE TABLE IF NOT EXISTS billpay_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER,
    fromAccount INTEGER,
    amount REAL,
    date TEXT,
    payeeName TEXT
  )`);

  await sqlRun(`CREATE TABLE IF NOT EXISTS transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER,
    fromAccount INTEGER,
    toAccount INTEGER,
    amount REAL,
    date TEXT,
    status TEXT
  )`);

  const userInfo = await sqlAll(`PRAGMA table_info(users)`);
  const colNames = userInfo.map(c => c.name);

  async function addColumnIfMissing(colDef) {
    const colName = colDef.split(' ')[0];
    if (!colNames.includes(colName)) {
      await sqlRun(`ALTER TABLE users ADD COLUMN ${colDef}`);
    }
  }

  await addColumnIfMissing('isAdmin INTEGER DEFAULT 0');
  await addColumnIfMissing('isLocked INTEGER DEFAULT 0');
  await addColumnIfMissing('lockUntil TEXT');

  const userCnt = await sqlGet(`SELECT COUNT(*) AS c FROM users`);
  if (!userCnt || userCnt.c === 0) {
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

  const adminExists = await sqlGet(`SELECT * FROM users WHERE isAdmin = 1 LIMIT 1`);
  if (!adminExists) {
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
}

initDB()
  .then(() => {
    app.listen(PORT, () => console.log(`AgriBank Texas running on port ${PORT}`));
  })
  .catch(err => {
    console.error('DB init failed', err);
    process.exit(1);
  });

function requireLogin(req, res, next) {
  if (req.session.user) return next();
  res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (req.session.user && req.session.user.isAdmin === 1) return next();
  res.redirect('/login');
}

app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('landing');
});

app.get('/login', (req, res) => {
  const { error, registered } = req.query;
  let success = null;
  if (registered === 'true') {
    success = 'Account created successfully! Please sign in.';
  }
  res.render('login', { error: error || null, success });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await sqlGet(`SELECT * FROM users WHERE username = ?`, [username]);

  if (!user) {
    return res.render('login', { error: 'Invalid credentials.', success: null });
  }
  if (user.isLocked === 1) {
    const now = new Date();
    const lockUntil = user.lockUntil ? new Date(user.lockUntil) : null;
    if (lockUntil && now < lockUntil) {
      const mins = Math.round((lockUntil - now) / 60000);
      return res.render('login', { error: `Account locked. Try again in ${mins} minute(s).`, success: null });
    } else {
      await sqlRun(`UPDATE users SET isLocked = 0, lockUntil = NULL WHERE id = ?`, [user.id]);
    }
  }

  if (!bcrypt.compareSync(password, user.password)) {
    return res.render('login', { error: 'Invalid credentials.', success: null });
  }

  const clean = { ...user };
  delete clean.password;
  req.session.user = clean;

  if (clean.isAdmin === 1) return res.redirect('/admin');
  res.redirect('/dashboard');
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

app.get('/register', (req, res) => {
  res.render('register', { error: null });
});

app.post('/register', async (req, res) => {
  const { firstName, lastName, email, dateOfBirth, ssn, address, city, state, zip, username, password, confirmPassword, accountType } = req.body;

  if (password !== confirmPassword) {
    return res.render('register', { error: 'Passwords do not match.' });
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
    [username, hashedPassword, firstName, lastName, email,
     new Date().getFullYear().toString(), address, city, state, zip, 0, new Date().toISOString()]
  );

  const newUserId = result.lastID;
  const accountNumber = '****' + Math.floor(1000 + Math.random() * 9000);

  let accountName, accountIcon;
  switch (accountType) {
    case 'savings': accountName = 'Savings Account'; accountIcon = '💰'; break;
    case 'business': accountName = 'Business Checking'; accountIcon = '🏢'; break;
    default: accountName = 'Primary Checking'; accountIcon = '🏦';
  }

  await sqlRun(
    `INSERT INTO accounts (userId, name, type, number, balance, icon) VALUES (?, ?, ?, ?, ?, ?)`,
    [newUserId, accountName, accountType, accountNumber, 0.00, accountIcon]
  );

  res.redirect('/login?registered=true');
});

app.get('/forgot-password', (req, res) => {
  res.render('forgot-password', { error: null, success: null, info: null });
});

app.post('/forgot-password', async (req, res) => {
  const { username, email } = req.body;
  const user = await sqlGet(`SELECT * FROM users WHERE username = ? AND email = ?`, [username, email]);

  if (!user) {
    return res.render('forgot-password', {
      error: 'No account found with that username and email combination.',
      success: null,
      info: null
    });
  }

  res.render('forgot-password', {
    error: null,
    success: 'Password reset link sent to your email!',
    info: 'For demo purposes, your current password is: Andre44225'
  });
});

app.get('/dashboard', requireLogin, async (req, res) => {
  const uid = req.session.user.id;
  const accounts = await sqlAll(`SELECT * FROM accounts WHERE userId = ?`, [uid]);
  const transactions = await sqlAll(
    `SELECT t.id, t.accountId, t.type, t.amount, t.description, t.date,
            a.name AS accountName
     FROM transactions t LEFT JOIN accounts a ON t.accountId = a.id
     WHERE t.userId = ? ORDER BY t.date DESC LIMIT 10`,
    [uid]
  );
  const totalBalance = accounts.reduce((sum, a) => sum + a.balance, 0);
  res.render('dashboard', { user: req.session.user, accounts, transactions, totalBalance });
});

app.get('/accounts', requireLogin, async (req, res) => {
  const uid = req.session.user.id;
  const accounts = await sqlAll(`SELECT * FROM accounts WHERE userId = ?`, [uid]);
  const transactions = await sqlAll(
    `SELECT t.id, t.accountId, t.type, t.amount, t.description, t.date,
            a.name AS accountName
     FROM transactions t LEFT JOIN accounts a ON t.accountId = a.id
     WHERE t.userId = ? ORDER BY t.date DESC LIMIT 15`, [uid]
  );
  res.render('accounts', { user: req.session.user, accounts, transactions });
});

app.get('/transactions', requireLogin, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const accountId = req.query.accountId || null;
    const accountNumber = req.query.account || null;
    const accounts = await sqlAll(`SELECT * FROM accounts WHERE userId = ?`, [uid]);

    let selectedAccount = null;
    let transactions = [];

    if (accountId) {
      selectedAccount = accounts.find(acc => acc.id === parseInt(accountId));
      transactions = await sqlAll(
        `SELECT t.id, t.accountId, t.type, t.amount, t.description, t.date,
                a.name AS accountName, a.number AS accountNumber
         FROM transactions t LEFT JOIN accounts a ON t.accountId = a.id
         WHERE t.userId = ? AND t.accountId = ? ORDER BY t.date DESC`,
        [uid, accountId]
      );
    } else if (accountNumber) {
      selectedAccount = accounts.find(acc => acc.number === accountNumber);
      transactions = await sqlAll(
        `SELECT t.id, t.accountId, t.type, t.amount, t.description, t.date,
                a.name AS accountName, a.number AS accountNumber
         FROM transactions t LEFT JOIN accounts a ON t.accountId = a.id
         WHERE t.userId = ? AND a.number = ? ORDER BY t.date DESC`,
        [uid, accountNumber]
      );
    } else {
      transactions = await sqlAll(
        `SELECT t.id, t.accountId, t.type, t.amount, t.description, t.date,
                a.name AS accountName, a.number AS accountNumber
         FROM transactions t LEFT JOIN accounts a ON t.accountId = a.id
         WHERE t.userId = ? ORDER BY t.date DESC`,
        [uid]
      );
    }

    const formattedTransactions = transactions.map(tx => ({
      description: tx.description || 'Transaction',
      type: tx.type || 'Transfer',
      date: tx.date ? new Date(tx.date).toLocaleDateString('en-US') : 'N/A',
      amount: tx.amount,
      amountFormatted: tx.amount >= 0
        ? `+$${Math.abs(tx.amount).toFixed(2)}`
        : `-$${Math.abs(tx.amount).toFixed(2)}`,
      accountName: tx.accountName,
      accountNumber: tx.accountNumber
    }));

    res.render('transactions', {
      user: req.session.user,
      accounts,
      account: selectedAccount,
      transactions: formattedTransactions
    });

  } catch (error) {
    console.error('Error in transactions route:', error);
    res.render('transactions', {
      user: req.session.user,
      accounts: [],
      account: null,
      transactions: [],
      error: error.message
    });
  }
});

app.get('/transfer', requireLogin, async (req, res) => {
  const uid = req.session.user.id;
  const accounts = await sqlAll(`SELECT * FROM accounts WHERE userId = ?`, [uid]);
  res.render('transfer', { user: req.session.user, accounts, success: null, error: null, successAmount: null });
});

app.post('/transfer', requireLogin, async (req, res) => {
  const { transferType, fromAccount, toAccount, amount, memo, recipientName, bankName, routingNumber, accountNumber, swiftCode, country, purpose } = req.body;
  const uid = req.session.user.id;
  const fromAcc = await sqlGet(`SELECT * FROM accounts WHERE id = ? AND userId = ?`, [fromAccount, uid]);
  const toAcc = toAccount ? await sqlGet(`SELECT * FROM accounts WHERE id = ? AND userId = ?`, [toAccount, uid]) : null;
  const amt = parseFloat(amount);

  if (!fromAcc || isNaN(amt) || amt <= 0) {
    return res.render('transfer', {
      user: req.session.user,
      accounts: await sqlAll(`SELECT * FROM accounts WHERE userId = ?`, [uid]),
      success: null, error: 'Invalid transfer.', successAmount: null
    });
  }
  if (amt > fromAcc.balance) {
    return res.render('transfer', {
      user: req.session.user,
      accounts: await sqlAll(`SELECT * FROM accounts WHERE userId = ?`, [uid]),
      success: null, error: 'Insufficient funds.', successAmount: null
    });
  }

  let arrivalDays, transferLabel, toAccountName, txDescription;

  switch (transferType) {
    case 'internal':
      if (!toAcc) {
        return res.render('transfer', {
          user: req.session.user,
          accounts: await sqlAll(`SELECT * FROM accounts WHERE userId = ?`, [uid]),
          success: null, error: 'Please select a destination account.', successAmount: null
        });
      }
      arrivalDays = 'Instant';
      transferLabel = 'Internal Transfer';
      toAccountName = toAcc.name + ' (' + toAcc.number + ')';
      txDescription = 'Transfer to ' + toAcc.name;
      await sqlRun(`UPDATE accounts SET balance = balance - ? WHERE id = ?`, [amt, fromAcc.id]);
      await sqlRun(`UPDATE accounts SET balance = balance + ? WHERE id = ?`, [amt, toAcc.id]);
      await sqlRun(`INSERT INTO transactions (userId, accountId, type, amount, description, date) VALUES (?, ?, ?, ?, ?, ?)`,
        [uid, fromAcc.id, 'Transfer Out', -amt, txDescription, new Date().toISOString()]);
      await sqlRun(`INSERT INTO transactions (userId, accountId, type, amount, description, date) VALUES (?, ?, ?, ?, ?, ?)`,
        [uid, toAcc.id, 'Transfer In', amt, 'Transfer from ' + fromAcc.name, new Date().toISOString()]);
      break;

    case 'domestic':
      arrivalDays = 'Same Day';
      transferLabel = 'Domestic Wire';
      toAccountName = recipientName + ' at ' + bankName;
      txDescription = 'Domestic Wire to ' + recipientName;
      await sqlRun(`UPDATE accounts SET balance = balance - ? WHERE id = ?`, [amt + 25, fromAcc.id]);
      await sqlRun(`INSERT INTO transactions (userId, accountId, type, amount, description, date) VALUES (?, ?, ?, ?, ?, ?)`,
        [uid, fromAcc.id, 'Wire Out', -amt, txDescription, new Date().toISOString()]);
      await sqlRun(`INSERT INTO transactions (userId, accountId, type, amount, description, date) VALUES (?, ?, ?, ?, ?, ?)`,
        [uid, fromAcc.id, 'Fee', -25, 'Domestic Wire Fee', new Date().toISOString()]);
      break;

    case 'international':
      arrivalDays = '1-5 Business Days';
      transferLabel = 'International Wire';
      toAccountName = recipientName + ' at ' + bankName + ' (' + country + ')';
      txDescription = 'International Wire to ' + recipientName;
      await sqlRun(`UPDATE accounts SET balance = balance - ? WHERE id = ?`, [amt + 45, fromAcc.id]);
      await sqlRun(`INSERT INTO transactions (userId, accountId, type, amount, description, date) VALUES (?, ?, ?, ?, ?, ?)`,
        [uid, fromAcc.id, 'Wire Out', -amt, txDescription, new Date().toISOString()]);
      await sqlRun(`INSERT INTO transactions (userId, accountId, type, amount, description, date) VALUES (?, ?, ?, ?, ?, ?)`,
        [uid, fromAcc.id, 'Fee', -45, 'International Wire Fee', new Date().toISOString()]);
      break;

    default:
      arrivalDays = '1-3 Business Days';
      transferLabel = 'Transfer';
      toAccountName = 'External Account';
      txDescription = 'Transfer to External Account';
      await sqlRun(`UPDATE accounts SET balance = balance - ? WHERE id = ?`, [amt, fromAcc.id]);
      await sqlRun(`INSERT INTO transactions (userId, accountId, type, amount, description, date) VALUES (?, ?, ?, ?, ?, ?)`,
        [uid, fromAcc.id, 'Transfer Out', -amt, txDescription, new Date().toISOString()]);
  }

  await sqlRun(`INSERT INTO transfers (userId, fromAccount, toAccount, amount, date, status) VALUES (?, ?, ?, ?, ?, ?)`,
    [uid, fromAcc.id, toAcc ? toAcc.id : null, amt, new Date().toISOString(), 'completed']);

  res.render('transfer-confirm', {
    user: req.session.user,
    amount: '$' + amt.toLocaleString('en-US', { minimumFractionDigits: 2 }),
    fromAccount: fromAcc.name,
    fromAccountNumber: fromAcc.number,
    toAccount: toAccountName,
    transferType: transferLabel,
    arrivalDays: arrivalDays,
    memo: memo || null,
    date: new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
  });
});

app.get('/billpay', requireLogin, async (req, res) => {
  const uid = req.session.user.id;
  const accounts = await sqlAll(`SELECT * FROM accounts WHERE userId = ?`, [uid]);
  res.render('billpay', {
    user: req.session.user, accounts,
    error: req.query.error ? decodeURIComponent(req.query.error) : null,
    success: req.query.status === 'success',
    successAmount: req.query.amount || null
  });
});

app.post('/billpay', requireLogin, async (req, res) => {
  const { payeeName, accountNumber, amount, fromAccount } = req.body;
  const uid = req.session.user.id;
  const fromAcc = await sqlGet(`SELECT * FROM accounts WHERE id = ? AND userId = ?`, [fromAccount, uid]);
  const amt = parseFloat(amount);

  if (!fromAcc || isNaN(amt) || amt <= 0) {
    return res.redirect('/billpay?error=' + encodeURIComponent('Invalid payment amount or account.'));
  }
  if (amt > fromAcc.balance) {
    return res.redirect('/billpay?error=' + encodeURIComponent('Insufficient funds.'));
  }

  await sqlRun(`UPDATE accounts SET balance = balance - ? WHERE id = ?`, [amt, fromAcc.id]);
  await sqlRun(`INSERT INTO billpay_transactions (userId, fromAccount, amount, date, payeeName) VALUES (?, ?, ?, ?, ?)`,
    [uid, fromAcc.id, amt, new Date().toISOString(), payeeName]);
  await sqlRun(`INSERT INTO transactions (userId, accountId, type, amount, description, date) VALUES (?, ?, ?, ?, ?, ?)`,
    [uid, fromAcc.id, 'Bill Pay', -amt, 'Bill Payment to ' + payeeName, new Date().toISOString()]);

  res.render('billpay-confirm', {
    user: req.session.user,
    amount: '$' + amt.toLocaleString('en-US', { minimumFractionDigits: 2 }),
    fromAccount: fromAcc.name,
    fromAccountNumber: fromAcc.number,
    payeeName: payeeName || 'Payee',
    payeeAccount: accountNumber || 'N/A',
    arrivalDays: '1-3 Business Days',
    confirmationNumber: 'BP-' + Date.now().toString().slice(-8),
    date: new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
  });
});

app.get('/billpay/history', requireLogin, async (req, res) => {
  const uid = req.session.user.id;
  const rows = await sqlAll(`SELECT * FROM billpay_transactions WHERE userId = ? ORDER BY date DESC`, [uid]);
  res.render('history', { user: req.session.user, transactions: rows });
});

app.get('/billpay/history/export', requireLogin, async (req, res) => {
  const uid = req.session.user.id;
  const rows = await sqlAll(`SELECT * FROM billpay_transactions WHERE userId = ? ORDER BY date DESC`, [uid]);
  const header = 'id,userId,fromAccount,amount,date,payeeName';
  const csv = [header, ...rows.map(r => [r.id, r.userId, r.fromAccount, r.amount, r.date, r.payeeName].join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="billpay-history.csv"');
  res.send(csv);
});

app.get('/profile', requireLogin, async (req, res) => {
  const uid = req.session.user.id;
  const accounts = await sqlAll(`SELECT * FROM accounts WHERE userId = ?`, [uid]);
  res.render('profile', { user: req.session.user, accounts, success: null, error: null });
});

app.post('/profile', requireLogin, async (req, res) => {
  const { email, address, city, state, zip } = req.body;
  const uid = req.session.user.id;
  await sqlRun(`UPDATE users SET email = ?, address = ?, city = ?, state = ?, zip = ? WHERE id = ?`,
    [email, address, city, state, zip, uid]);
  const user = await sqlGet(`SELECT * FROM users WHERE id = ?`, [uid]);
  req.session.user = user;
  const accounts = await sqlAll(`SELECT * FROM accounts WHERE userId = ?`, [uid]);
  res.render('profile', { user, accounts, success: 'Profile updated!', error: null });
});

app.get('/admin', requireAdmin, async (req, res) => {
  const users = await sqlAll(`SELECT id, username, email, isAdmin, isLocked, created_at FROM users ORDER BY id`);
  res.render('admin', { user: req.session.user, users });
});

app.get('/admin/users', requireAdmin, async (req, res) => {
  const q = req.query.q || '';
  const rows = await sqlAll(
    `SELECT id, username, email, isAdmin, isLocked, created_at FROM users
     WHERE username LIKE ? OR email LIKE ? ORDER BY id`,
    [`%${q}%`, `%${q}%`]
  );
  res.render('admin_users', { user: req.session.user, users: rows, query: q });
});

app.get('/admin/users/:id', requireAdmin, async (req, res) => {
  const uid = parseInt(req.params.id, 10);
  const viewedUser = await sqlGet(`SELECT * FROM users WHERE id = ?`, [uid]);
  const accounts = await sqlAll(`SELECT * FROM accounts WHERE userId = ?`, [uid]);
  const bills = await sqlAll(`SELECT * FROM billpay_transactions WHERE userId = ? ORDER BY date DESC`, [uid]);
  const trans = await sqlAll(
    `SELECT t.id, t.accountId, t.type, t.amount, t.description, t.date, a.name AS accountName
     FROM transactions t LEFT JOIN accounts a ON t.accountId = a.id
     WHERE t.userId = ? ORDER BY t.date DESC`, [uid]);
  const transfers = await sqlAll(`SELECT * FROM transfers WHERE userId = ? ORDER BY date DESC`, [uid]);

  res.render('admin_user', { user: req.session.user, viewedUser, accounts, bills, trans, transfers });
});

app.post('/admin/users/:id/toggleAdmin', requireAdmin, async (req, res) => {
  const uid = parseInt(req.params.id, 10);
  const target = await sqlGet(`SELECT isAdmin FROM users WHERE id = ?`, [uid]);
  if (!target) return res.redirect('/admin/users');
  const newVal = target.isAdmin === 1 ? 0 : 1;
  await sqlRun(`UPDATE users SET isAdmin = ? WHERE id = ?`, [newVal, uid]);
  res.redirect(`/admin/users/${uid}`);
});

app.post('/admin/users/:id/lock', requireAdmin, async (req, res) => {
  const uid = parseInt(req.params.id, 10);
  const minutes = parseInt(req.body.minutes, 10) || 60;
  const lockUntil = new Date(Date.now() + minutes * 60 * 1000).toISOString();
  await sqlRun(`UPDATE users SET isLocked = 1, lockUntil = ? WHERE id = ?`, [lockUntil, uid]);
  res.redirect(`/admin/users/${uid}`);
});

app.post('/admin/users/:id/unlock', requireAdmin, async (req, res) => {
  const uid = parseInt(req.params.id, 10);
  await sqlRun(`UPDATE users SET isLocked = 0, lockUntil = NULL WHERE id = ?`, [uid]);
  res.redirect(`/admin/users/${uid}`);
});

app.get('/admin/export/users', requireAdmin, async (req, res) => {
  const rows = await sqlAll(`SELECT id, username, email, isAdmin, isLocked, created_at FROM users ORDER BY id`);
  const header = 'id,username,email,isAdmin,isLocked,created_at';
  const csv = [header, ...rows.map(r => [r.id, r.username, r.email, r.isAdmin, r.isLocked, r.created_at].join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="users.csv"');
  res.send(csv);
});

app.get('/admin/users/:id/export/billpay', requireAdmin, async (req, res) => {
  const uid = parseInt(req.params.id, 10);
  const rows = await sqlAll(`SELECT * FROM billpay_transactions WHERE userId = ? ORDER BY date DESC`, [uid]);
  const header = 'id,userId,fromAccount,amount,date,payeeName';
  const csv = [header, ...rows.map(r => [r.id, r.userId, r.fromAccount, r.amount, r.date, r.payeeName].join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="user-${uid}-billpay.csv"`);
  res.send(csv);
});

app.get('/admin/users/:id/export/transactions', requireAdmin, async (req, res) => {
  const uid = parseInt(req.params.id, 10);
  const rows = await sqlAll(
    `SELECT t.id, t.accountId, t.type, t.amount, t.description, t.date, a.name AS accountName
     FROM transactions t LEFT JOIN accounts a ON t.accountId = a.id
     WHERE t.userId = ? ORDER BY t.date DESC`, [uid]);
  const header = 'id,accountId,type,amount,description,date,accountName';
  const csv = [header, ...rows.map(r => [r.id, r.accountId, r.type, r.amount, r.description, r.date, r.accountName].join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="user-${uid}-transactions.csv"`);
  res.send(csv);
});

app.get('/seed', requireAdmin, async (req, res) => {
  const accounts = await sqlAll(`SELECT * FROM accounts WHERE userId = 1`);

  await sqlRun(`DELETE FROM transactions WHERE userId = 1`);
  await sqlRun(`DELETE FROM transfers WHERE userId = 1`);

  async function tx(acctId, type, amt, desc, date) {
    await sqlRun(
      `INSERT INTO transactions (userId, accountId, type, amount, description, date) VALUES (?, ?, ?, ?, ?, ?)`,
      [1, acctId, type, amt, desc, date]
    );
  }

  const c = accounts[0].id;
  const s = accounts[1].id;
  const b = accounts[2].id;

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

  const count = await sqlGet(`SELECT COUNT(*) AS c FROM transactions WHERE userId = 1`);

  res.send(`<!DOCTYPE html>
<html><head><title>42 Transactions Seeded</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=DM+Mono&display=swap" rel="stylesheet">
<style>
  body { font-family:'DM Mono',monospace; background:#0d1a0f; color:#e8efe9; max-width:700px; margin:50px auto; padding:20px; }
  .box { background:#1a2b1e; border:1px solid #2a3d2e; border-radius:8px; padding:2rem; }
  h1 { font-family:'DM Serif Display',serif; color:#4ade80; }
  .stats { background:#142017; border-radius:6px; padding:1rem; margin:1.5rem 0; }
  .stats div { padding:0.4rem 0; font-size:0.85rem; border-bottom:1px solid #2a3d2e; }
  .stats div:last-child { border:none; }
  .total { color:#4ade80; font-weight:bold; }
  a { display:inline-block; margin:0.5rem 0.5rem 0 0; padding:0.6rem 1.2rem; background:#4ade80; color:#0d1a0f; text-decoration:none; border-radius:4px; font-size:0.8rem; font-weight:500; }
  a:hover { opacity:0.85; }
</style></head><body>
  <div class="box">
    <h1>42 Transactions Seeded</h1>
    <p>Added <strong>${count.c} transactions</strong> to Andrew's accounts.</p>
    <div class="stats">
      <div><strong>Primary Checking (****4521):</strong> 14 txns &rarr; <span class="total">$42,420.50</span></div>
      <div><strong>Savings Account (****8934):</strong> 14 txns &rarr; <span class="total">$325,890.25</span></div>
      <div><strong>Business Operating (****2156):</strong> 14 txns &rarr; <span class="total">$595,697.25</span></div>
      <div style="border:none;padding-top:0.8rem"><strong>Total Balance:</strong> <span class="total">$964,008.00</span></div>
    </div>
    <a href="/transactions">View All Transactions</a>
    <a href="/transactions?accountId=${c}">Checking Only</a>
    <a href="/transactions?accountId=${s}">Savings Only</a>
    <a href="/transactions?accountId=${b}">Business Only</a>
    <a href="/dashboard">Dashboard</a>
  </div>
</body></html>`);
});