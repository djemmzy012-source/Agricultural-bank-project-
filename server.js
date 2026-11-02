require('dotenv').config();

const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const db = require('./db');
const PDFDocument = require('pdfkit');

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
// ==========================================
// PRIVATE MOBILE DEPOSIT IMAGE STORAGE
// ==========================================

const depositUploadDir = path.join(__dirname, 'private_uploads', 'deposits');

fs.mkdirSync(depositUploadDir, { recursive: true });

const depositStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, depositUploadDir);
  },

  filename: (req, file, cb) => {
    crypto.randomBytes(20, (err, buffer) => {
      if (err) return cb(err);

      cb(null, `${file.fieldname}-${buffer.toString('hex')}`);
    });
  }
});

const depositUpload = multer({
  storage: depositStorage,

  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 2,
    fields: 10,
    parts: 12
  },

  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'image/jpeg',
      'image/png',
      'image/webp'
    ];

    if (!allowedTypes.includes(file.mimetype)) {
      return cb(new Error('Please upload a JPEG, PNG, or WebP image.'));
    }

    cb(null, true);
  }
});
// Verify the actual image file signature.
async function isValidDepositImage(filePath) {
  let handle;

  try {
    handle = await fs.promises.open(filePath, 'r');

    const buffer = Buffer.alloc(12);
    const { bytesRead } = await handle.read(buffer, 0, 12, 0);

    if (bytesRead < 12) return false;

    // JPEG
    const isJpeg =
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff;

    // PNG
    const isPng =
      buffer.subarray(0, 8).equals(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
      );

    // WebP
    const isWebp =
      buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP';

    return isJpeg || isPng || isWebp;
  } catch (error) {
    return false;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}
// ==========================================
// EMAIL NOTIFICATIONS â€” NODEMAILER / GMAIL
// ==========================================


/* ==========================================
   EMAIL NOTIFICATIONS â€” NODEMAILER / BREVO
========================================== */

const smtpPort = Number(process.env.SMTP_PORT || 587);

const notificationTransporter =
  process.env.SMTP_HOST &&
  process.env.SMTP_USER &&
  process.env.SMTP_PASS
    ? nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: smtpPort,
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        }
      })
    : null;

const notificationFrom =
  process.env.EMAIL_FROM || 'AgriBank Texas Notifications';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

async function sendAccountEmail(userId, subject, message) {
  try {
    if (!notificationTransporter) {
      console.warn(
        'Email notification skipped: SMTP settings are incomplete.'
      );
      return false;
    }

    const user = sqlGet(
      `SELECT id, username, firstName, lastName, email
       FROM users
       WHERE id = ?`,
      [userId]
    );

    if (!user) {
      console.warn(
        `Email notification skipped: user ${userId} was not found.`
      );
      return false;
    }

    // Send the notification to the email saved on the user's profile.
    const recipient = String(user.email || '').trim();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
      console.warn(
        `Email notification skipped: user ${userId} has no valid email address.`
      );
      return false;
    }

    // Choose the appropriate heading and explanation for this event.
    const subjectLower = String(subject || '').toLowerCase();

    let panelHeading = 'Account Activity';
    let panelMessage =
      'An activity was recorded on your AgriBank Texas account. ' +
      'Review the details above and contact the application administrator ' +
      'if you do not recognize it.';

    let footerMessage = 'Application-generated account notification.';

    if (
      subjectLower.includes('sign-in') ||
      subjectLower.includes('sign in') ||
      subjectLower.includes('login')
    ) {
      panelHeading = 'Security Alert';
      panelMessage =
        'A successful sign-in to your AgriBank Texas account was recorded. ' +
        'If this was you, no action is needed. If you do not recognize this ' +
        'activity, review your account security and contact the application ' +
        'administrator.';
    } else if (subjectLower.includes('transfer')) {
      panelHeading = 'Transfer Activity';
      panelMessage =
        'Your transfer activity has been recorded in your AgriBank Texas ' +
        'account activity. This notification confirm that funds ' +
        'were sent to an external account or that settlement occurred.';

      footerMessage =
        'AgriBank Texas notification. External transfer and settlement ' +
        'are  confirmed by this email.';
    } else if (
      subjectLower.includes('bill payment') ||
      subjectLower.includes('billpay') ||
      subjectLower.includes('bill pay')
    ) {
      panelHeading = 'Bill Payment Activity';
      panelMessage =
        'Your bill payment activity has been recorded. This notification ' +
        ' shows that a payment was delivered to the payee or that ' +
        'external settlement occurred.';

      footerMessage =
        'AgriBank Texas notification. Payment delivery and external ' +
        'settlement are  confirmed by this email.';
    } else if (
      subjectLower.includes('welcome') ||
      subjectLower.includes('registration')
    ) {
      panelHeading = 'Welcome to AgriBank Texas';
      panelMessage =
        'Your account profile has been created. You can now sign in using ' +
        'your registered credentials.';
    }

    const greeting = user.firstName || user.username || 'Customer';

    const safeGreeting = escapeHtml(greeting);
    const safeSubject = escapeHtml(subject);
    const safeMessage = escapeHtml(message);
    const safePanelHeading = escapeHtml(panelHeading);
    const safePanelMessage = escapeHtml(panelMessage);
    const safeFooterMessage = escapeHtml(footerMessage);

    const plainText = [
      `Hello ${greeting},`,
      '',
      message,
      '',
      panelHeading,
      panelMessage,
      '',
      footerMessage,
      '',
      'AgriBank Texas Notifications'
    ].join('\n');

    await notificationTransporter.sendMail({
      from: notificationFrom,
      to: recipient,
      subject,
      text: plainText,

      html: `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>${safeSubject}</title>
        </head>

        <body style="margin:0;padding:0;background:#f3f6f3;
                     font-family:Arial,Helvetica,sans-serif;color:#26352d;">

          <div style="padding:28px 12px;background:#f3f6f3;">
            <div style="max-width:600px;margin:0 auto;background:#ffffff;
                        border:1px solid #e0e7e1;border-radius:12px;
                        overflow:hidden;">

              <!-- Header -->
              <div style="background:#174b35;padding:26px 20px;text-align:center;">
                <img src="cid:agribanklogo"
                     alt="AgriBank Texas"
                     width="150"
                     style="display:block;width:150px;max-width:100%;
                            height:auto;margin:0 auto 14px;border:0;">

                <div style="color:#ffffff;font-size:22px;font-weight:bold;">
                  AgriBank Texas
                </div>

                <div style="color:#e4d29a;font-size:12px;margin-top:6px;
                            letter-spacing:1px;">
                  ACCOUNT NOTIFICATION
                </div>
              </div>

              <div style="height:4px;background:#c6a64b;"></div>

              <!-- Main message -->
              <div style="padding:28px 24px;">

                <h1 style="font-size:21px;line-height:1.4;color:#174b35;
                           margin:0 0 22px;">
                  ${safeSubject}
                </h1>

                <p style="font-size:15px;margin:0 0 16px;">
                  Hello ${safeGreeting},
                </p>

                <div style="font-size:14px;line-height:1.8;
                            overflow-wrap:anywhere;white-space:pre-line;
                            margin:0 0 24px;">
                  ${safeMessage}
                </div>

                <!-- Event-specific information -->
                <div style="background:#fff9e9;border:1px solid #e7d59b;
                            border-radius:8px;padding:16px;margin:20px 0;">

                  <p style="margin:0 0 8px;color:#174b35;font-size:14px;
                            font-weight:bold;">
                    ${safePanelHeading}
                  </p>

                  <p style="margin:0;font-size:12px;line-height:1.8;
                            color:#574d32;">
                    ${safePanelMessage}
                  </p>

                </div>

                <p style="font-size:12px;line-height:1.7;color:#64736a;
                          margin:24px 0 0;">
                  ${safeFooterMessage}
                </p>

              </div>

              <!-- Footer -->
              <div style="background:#f7f9f7;border-top:1px solid #e0e7e1;
                          padding:18px 24px;text-align:center;">

                <p style="margin:0;color:#174b35;font-size:13px;
                          font-weight:bold;">
                  AgriBank Texas
                </p>

                <p style="margin:6px 0 0;color:#7b867e;font-size:11px;
                          line-height:1.6;">
                  This is an automated notification. Please do not reply
                  directly to this email.
                </p>

              </div>

            </div>
          </div>

        </body>
        </html>
      `,

      attachments: [
        {
          filename: 'agribank-logo.png',
          path: path.join(
            __dirname,
            'public',
            'images',
            'agribank-logo.png'
          ),
          cid: 'agribanklogo'
        }
      ]
    });

    console.log(
      `Email notification sent for user ${userId}: ${subject}`
    );

    return true;
  } catch (error) {
    // Email failure must not crash or undo an application action.
    console.error('Email notification failed:', error.message);
    return false;
  }
}


function formatMoney(value) {
  return `$${Number(value || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function formatDate(value) {
  if (!value) return 'â€”';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'â€”';

  return date.toLocaleDateString('en-US', {
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
  if (!req.session.user || Number(req.session.user.isAdmin) !== 1) {
    return res.redirect('/login');
  }
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
    if (Number.isNaN(d.getTime())) return;

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
  const existing = sqlGet(
    `SELECT COUNT(*) AS count FROM notifications WHERE userId = ?`,
    [userId]
  );

  if (existing && existing.count > 0) return;

  const items = [
    [
      'Security Notice',
      'Review your recent sign-in activity and use strong password habits.',
      'security'
    ],
    [
      'Statement Ready',
      'Your latest account transaction summary is available for export.',
      'statement'
    ],
    [
      'Loan Offers',
      'Explore  equipment and operating loan options.',
      'loan'
    ]
  ];

  items.forEach(([title, message, type]) => {
    sqlRun(
      `INSERT INTO notifications
       (userId, title, message, type, isRead, created_at)
       VALUES (?, ?, ?, ?, 0, ?)`,
      [userId, title, message, type, new Date().toISOString()]
    );
  });
}// ==========================================
// DATABASE INITIALIZATION â€” NON-DESTRUCTIVE
// ==========================================

function initDB() {
  sqlRun(`CREATE TABLE IF NOT EXISTS loan_applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER NOT NULL,
    productType TEXT NOT NULL,
    amount REAL NOT NULL,
    termMonths INTEGER,
    purpose TEXT,
    employmentStatus TEXT,
    annualIncome REAL,
    firstName TEXT,
    lastName TEXT,
    email TEXT,
    phone TEXT,
    address TEXT,
    city TEXT,
    state TEXT,
    zip TEXT,
    notes TEXT,
    applicationData TEXT,
    status TEXT DEFAULT 'pending',
    adminNote TEXT,
    created_at TEXT,
    reviewed_at TEXT,
    reviewedBy INTEGER,
    FOREIGN KEY (userId) REFERENCES users(id)
  )`);

  // Safely add applicationData to existing databases.
  const loanCols = sqlAll(`PRAGMA table_info(loan_applications)`);

  if (
    loanCols &&
    loanCols.length &&
    !loanCols.some(column => column.name === 'applicationData')
  ) {
    sqlRun(`ALTER TABLE loan_applications ADD COLUMN applicationData TEXT`);
  }

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
    created_at TEXT,
    transferPinHash TEXT
  )`);

  // Safely add the PIN-hash column to existing databases.
  const userColumns = sqlAll(`PRAGMA table_info(users)`);

  if (!userColumns.some(column => column.name === 'transferPinHash')) {
    sqlRun(`ALTER TABLE users ADD COLUMN transferPinHash TEXT`);
  }

  sqlRun(`CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    number TEXT NOT NULL UNIQUE,
    routingNumber TEXT,
    balance REAL DEFAULT 0,
    icon TEXT,
    FOREIGN KEY (userId) REFERENCES users(id)
  )`);

  // Add routingNumber to existing databases when needed.
  const accountColumns = sqlAll(`PRAGMA table_info(accounts)`);

  if (!accountColumns.some(column => column.name === 'routingNumber')) {
    sqlRun(`ALTER TABLE accounts ADD COLUMN routingNumber TEXT`);
  }

  // Create the unique index only after the column exists.
  sqlRun(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_routing_number
    ON accounts(routingNumber)
    WHERE routingNumber IS NOT NULL
  `);

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

  sqlRun(`CREATE TABLE IF NOT EXISTS login_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER NOT NULL,
    ipAddress TEXT,
    device TEXT,
    status TEXT,
    timestamp TEXT,
    FOREIGN KEY (userId) REFERENCES users(id)
  )`);

  sqlRun(`CREATE TABLE IF NOT EXISTS trusted_devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER NOT NULL,
    tokenHash TEXT NOT NULL UNIQUE,
    device TEXT,
    ipAddress TEXT,
    firstSeenAt TEXT,
    lastSeenAt TEXT,
    FOREIGN KEY (userId) REFERENCES users(id)
  )`);

  // Records simulated loan credits and prevents duplicate disbursements.
  sqlRun(`CREATE TABLE IF NOT EXISTS loan_disbursements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    applicationId INTEGER NOT NULL UNIQUE,
    userId INTEGER NOT NULL,
    accountId INTEGER NOT NULL,
    amount REAL NOT NULL CHECK (amount > 0),
    disbursedAt TEXT NOT NULL,
    disbursedBy INTEGER NOT NULL,
    FOREIGN KEY (applicationId) REFERENCES loan_applications(id),
    FOREIGN KEY (userId) REFERENCES users(id),
    FOREIGN KEY (accountId) REFERENCES accounts(id),
    FOREIGN KEY (disbursedBy) REFERENCES users(id)
  )`);

  // ==========================================
  // MOBILE CHEQUE DEPOSITS
  // ==========================================

  // Stores customer deposit requests.
  // Cheque images must be stored privately outside the public folder.
  sqlRun(`CREATE TABLE IF NOT EXISTS mobile_deposits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reference TEXT NOT NULL UNIQUE,
    userId INTEGER NOT NULL,
    accountId INTEGER NOT NULL,
    amount REAL NOT NULL CHECK (amount > 0),
    checkNumber TEXT,
    memo TEXT,
    frontImage TEXT NOT NULL,
    backImage TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'approved', 'rejected')),
    adminNote TEXT,
    created_at TEXT NOT NULL,
    reviewed_at TEXT,
    reviewedBy INTEGER,
    FOREIGN KEY (userId) REFERENCES users(id),
    FOREIGN KEY (accountId) REFERENCES accounts(id),
    FOREIGN KEY (reviewedBy) REFERENCES users(id)
  )`);

  sqlRun(`
    CREATE INDEX IF NOT EXISTS idx_mobile_deposits_user
    ON mobile_deposits(userId, created_at)
  `);

  sqlRun(`
    CREATE INDEX IF NOT EXISTS idx_mobile_deposits_status
    ON mobile_deposits(status, created_at)
  `);

  // ==========================================
  // EXISTING USER CHECK
  // ==========================================

  const existingUsers = sqlGet(`SELECT COUNT(*) AS count FROM users`);

  if (existingUsers && existingUsers.count > 0) {
    const users = sqlAll(`SELECT id FROM users`);
    users.forEach(user => ensureDefaultNotifications(user.id));

    console.log('Database initialized. Existing users and records preserved.');
    return;
  }

  // ==========================================
  // INITIAL SEED DATA
  // ==========================================

  const demoHash = bcrypt.hashSync('Demo@123', 10);
  const adminHash = bcrypt.hashSync('Admin@123', 10);
  const andrewHash = bcrypt.hashSync('Andrew2026', 10);
  const now = new Date().toISOString();

  const customer = sqlRun(
    `INSERT INTO users
     (username, password, firstName, lastName, email, memberSince,
      address, city, state, zip, isAdmin, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    [
      'farmerdemo', demoHash, 'Carter', 'Fields',
      'carter.fields@example.com', '2019',
      '218 County Road 14', 'Lubbock', 'TX', '79401', now
    ]
  );

  sqlRun(
    `INSERT INTO users
     (username, password, firstName, lastName, email, memberSince,
      address, city, state, zip, isAdmin, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    [
      'admin', adminHash, 'Admin', 'Manager',
      'admin@agribank.local', '2021',
      '100 Market Street', 'Austin', 'TX', '78701', now
    ]
  );

  const andrew = sqlRun(
    `INSERT INTO users
     (username, password, firstName, lastName, email, memberSince,
      address, city, state, zip, isAdmin, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    [
      'Andrew2017', andrewHash, 'Andrew Diego', 'Alejandro',
      'andrew.alejandro@gmail.com', '2017',
      '4592 Longhorn Drive', 'Dallas', 'TX', '75201', now
    ]
  );

  const checking = sqlRun(
    `INSERT INTO accounts (userId, name, type, number, balance, icon)
     VALUES (?, 'Primary Checking', 'checking', '****4521', 42420.50, 'ðŸ¦')`,
    [customer.lastID]
  );

  const savings = sqlRun(
    `INSERT INTO accounts (userId, name, type, number, balance, icon)
     VALUES (?, 'Harvest Savings', 'savings', '****8934', 325890.25, 'ðŸ’°')`,
    [customer.lastID]
  );

  const business = sqlRun(
    `INSERT INTO accounts (userId, name, type, number, balance, icon)
     VALUES (?, 'Business Operating', 'business', '****2156', 595697.25, 'ðŸ¢')`,
    [customer.lastID]
  );

  const seedTransactions = [
    [checking.lastID, 'Deposit', 5200, 'Payroll - Direct Deposit', '2026-01-15'],
    [checking.lastID, 'Withdrawal', -845.32, 'Fuel & Transport', '2026-01-21'],
    [checking.lastID, 'Deposit', 3890, 'Tax Refund', '2026-02-02'],
    [savings.lastID, 'Deposit', 24850, 'Corn Harvest Proceeds', '2026-02-10'],
    [savings.lastID, 'Deposit', 12800, 'Crop Insurance Settlement', '2026-03-05'],
    [business.lastID, 'Deposit', 68000, 'Johnson Farms Invoice', '2026-03-12'],
    [business.lastID, 'Withdrawal', -15632, 'Equipment Maintenance', '2026-03-18'],
    [checking.lastID, 'Withdrawal', -2141.90, 'Transfer to Savings', '2026-03-21'],
    [checking.lastID, 'Deposit', 5200, 'Payroll - Direct Deposit', '2026-04-02'],
    [business.lastID, 'Deposit', 80950, 'Continental Grain Payment', '2026-04-06']
  ];

  seedTransactions.forEach(([accountId, type, amount, description, date]) => {
    sqlRun(
      `INSERT INTO transactions
       (userId, accountId, type, amount, description, date)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [customer.lastID, accountId, type, amount, description, date]
    );
  });

  const andrewChecking = sqlRun(
    `INSERT INTO accounts (userId, name, type, number, balance, icon)
     VALUES (?, 'Personal Checking', 'checking', '****7721', 88945.89, 'ðŸ¦')`,
    [andrew.lastID]
  );

  const andrewSavings = sqlRun(
    `INSERT INTO accounts (userId, name, type, number, balance, icon)
     VALUES (?, 'High-Yield Reserve', 'savings', '****4492', 275000, 'ðŸ’°')`,
    [andrew.lastID]
  );

  const andrewBusiness = sqlRun(
    `INSERT INTO accounts (userId, name, type, number, balance, icon)
     VALUES (?, 'Commercial Operating', 'business', '****9933', 500000, 'ðŸ¢')`,
    [andrew.lastID]
  );

  const andrewTransactions = [
    [andrewChecking.lastID, 'Deposit', 12500, 'Direct Deposit - Salary', '2026-01-05'],
    [andrewChecking.lastID, 'Withdrawal', -450, 'Whole Foods Market', '2026-01-08'],
    [andrewBusiness.lastID, 'Deposit', 45000, 'Client Invoice - TX Energy', '2026-01-12'],
    [andrewChecking.lastID, 'Withdrawal', -2100, 'Mortgage Payment', '2026-01-15'],
    [andrewSavings.lastID, 'Deposit', 5000, 'Transfer from Checking', '2026-01-18'],
    [andrewBusiness.lastID, 'Withdrawal', -3200.50, 'Equipment Lease', '2026-01-22'],
    [andrewChecking.lastID, 'Withdrawal', -150.75, 'Shell Gas Station', '2026-01-25'],
    [andrewChecking.lastID, 'Deposit', 12500, 'Direct Deposit - Salary', '2026-02-05'],
    [andrewBusiness.lastID, 'Deposit', 85000, 'Contract Settlement - Ranch', '2026-02-08'],
    [andrewChecking.lastID, 'Withdrawal', -2100, 'Mortgage Payment', '2026-02-15'],
    [andrewBusiness.lastID, 'Withdrawal', -12450, 'Q1 Tax Payment', '2026-02-18'],
    [andrewChecking.lastID, 'Withdrawal', -85.20, 'Dallas Steakhouse', '2026-02-22'],
    [andrewSavings.lastID, 'Deposit', 10000, 'Transfer from Checking', '2026-02-28'],
    [andrewChecking.lastID, 'Deposit', 12500, 'Direct Deposit - Salary', '2026-03-05'],
    [andrewChecking.lastID, 'Withdrawal', -650, 'Auto Insurance', '2026-03-10'],
    [andrewBusiness.lastID, 'Deposit', 115000, 'Livestock Auction Proceeds', '2026-03-14'],
    [andrewChecking.lastID, 'Withdrawal', -2100, 'Mortgage Payment', '2026-03-15'],
    [andrewBusiness.lastID, 'Withdrawal', -8900, 'Barn Repairs & Maintenance', '2026-03-20'],
    [andrewChecking.lastID, 'Withdrawal', -320, 'Home Depot', '2026-03-24'],
    [andrewSavings.lastID, 'Deposit', 12000, 'Transfer from Checking', '2026-03-30'],
    [andrewChecking.lastID, 'Deposit', 12500, 'Direct Deposit - Salary', '2026-04-05'],
    [andrewBusiness.lastID, 'Deposit', 62000, 'Wholesale Feed Corp', '2026-04-12'],
    [andrewChecking.lastID, 'Withdrawal', -2100, 'Mortgage Payment', '2026-04-15'],
    [andrewChecking.lastID, 'Withdrawal', -120, 'AT&T Internet', '2026-04-20'],
    [andrewBusiness.lastID, 'Withdrawal', -4500, 'Commercial Insurance Premium', '2026-04-25'],
    [andrewChecking.lastID, 'Deposit', 12500, 'Direct Deposit - Salary', '2026-05-02']
  ];

  andrewTransactions.forEach(([accountId, type, amount, description, date]) => {
    sqlRun(
      `INSERT INTO transactions
       (userId, accountId, type, amount, description, date)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [andrew.lastID, accountId, type, amount, description, date]
    );
  });

  const users = sqlAll(`SELECT id FROM users`);
  users.forEach(user => ensureDefaultNotifications(user.id));

  console.log('Database initialized with demo data.');
}

function getUserAccounts(userId) {
  return sqlAll(
    `SELECT
       id,
       userId,
       name,
       type,
       'â€¢â€¢â€¢â€¢ ' || substr(number, -4) AS number,
       balance,
       icon
     FROM accounts
     WHERE userId = ?
     ORDER BY id`,
    [userId]
  );
}

function getUserTransactions(userId) {
  return sqlAll(
    `SELECT
       t.*,
       a.name AS accountName,
       ('â€¢â€¢â€¢â€¢ ' || substr(a.number, -4)) AS accountNumber
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
    amountFormatted: formatMoney(Math.abs(Number(tx.amount || 0))),
    amountClass: Number(tx.amount) >= 0 ? 'positive' : 'negative'
  }));
}


function csvCell(value, isNumeric = false) {
  if (isNumeric) {
    const number = Number(value);

    if (value !== null && value !== '' && Number.isFinite(number)) {
      return String(number);
    }
  }

  let text = String(value ?? '');

  if (/^[\s]*[=+\-@]/.test(text)) {
    text = `'${text}`;
  }

  return `"${text.replace(/"/g, '""')}"`;
}

function sendCsv(res, filename, headers, rows) {
  const csv = [
    headers.map(header => csvCell(header)).join(','),
    ...rows.map(row =>
      row.map((value, index) => csvCell(value, index === 5)).join(',')
    )
  ].join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${filename}"`
  );
  res.send('\uFEFF' + csv);
}

function isValidStatementDate(value) {
  if (!value) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value;
}

function getStatementData(userId, query = {}) {
  const accounts = getUserAccounts(userId);
  const accountId = String(query.accountId || '');
  const from = String(query.from || '');
  const to = String(query.to || '');

  const selectedAccount = accountId
    ? accounts.find(account => String(account.id) === accountId)
    : null;

  const validAccountFilter = !accountId || Boolean(selectedAccount);
  let transactions = validAccountFilter ? getUserTransactions(userId) : [];

  if (selectedAccount) {
    transactions = transactions.filter(
      tx => Number(tx.accountId) === Number(selectedAccount.id)
    );
  }

  if (from) {
    transactions = transactions.filter(
      tx => String(tx.date || '').slice(0, 10) >= from
    );
  }

  if (to) {
    transactions = transactions.filter(
      tx => String(tx.date || '').slice(0, 10) <= to
    );
  }

  const deposits = transactions
    .filter(tx => Number(tx.amount) > 0)
    .reduce((sum, tx) => sum + Number(tx.amount), 0);

  const withdrawals = transactions
    .filter(tx => Number(tx.amount) < 0)
    .reduce((sum, tx) => sum + Math.abs(Number(tx.amount)), 0);

  return {
    accounts,
    selectedAccount,
    filters: { accountId, from, to },
    transactions: decorateTransactions(transactions),
    deposits,
    withdrawals,
    netActivity: deposits - withdrawals,
    validAccountFilter
  };
}

// ==========================================
// PUBLIC ROUTES
// ==========================================

app.get('/', (req, res) => {
  if (req.session.user) {
    return res.redirect(
      Number(req.session.user.isAdmin) === 1 ? '/admin' : '/dashboard'
    );
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

  const ipAddress = req.ip || req.socket.remoteAddress || 'Unknown IP';
  const device = req.get('User-Agent') || 'Unknown Device';

  if (!username || !password) {
    return res.status(400).render('login', {
      error: 'Please enter your username and password.',
      success: null
    });
  }

  const user = sqlGet(
    `SELECT * FROM users WHERE username = ?`,
    [username]
  );

  if (!user || !bcrypt.compareSync(password, user.password)) {
    if (user) {
      sqlRun(
        `INSERT INTO login_history
         (userId, ipAddress, device, status, timestamp)
         VALUES (?, ?, ?, 'FAILED', ?)`,
        [user.id, ipAddress, device, new Date().toISOString()]
      );
    }

    return res.status(401).render('login', {
      error: 'Invalid credentials.',
      success: null
    });
  }

  if (Number(user.isLocked) === 1) {
    sqlRun(
      `INSERT INTO login_history
       (userId, ipAddress, device, status, timestamp)
       VALUES (?, ?, ?, 'LOCKED', ?)`,
      [user.id, ipAddress, device, new Date().toISOString()]
    );

    return res.status(403).render('login', {
      error: 'This account is currently locked. Contact an administrator.',
      success: null
    });
  }

  const loginTime = new Date().toISOString();

  // Recognise this browser separately for each user.
  const deviceCookieName = `agribank.device.${user.id}`;
  const escapedCookieName = deviceCookieName.replace(/[.*+?^${}()|[\]\\]/g, '\\  const loginTime = new Date().toISOString();');
  const cookieHeader = String(req.headers.cookie || '');
  const cookieMatch = cookieHeader.match(
    new RegExp(`(?:^|;\\s*)${escapedCookieName}=([^;]*)`)
  );

  let deviceToken = null;

  if (cookieMatch) {
    try {
      deviceToken = decodeURIComponent(cookieMatch[1]);
    } catch (_) {
      deviceToken = null;
    }
  }

  let recognizedDevice = null;

  if (deviceToken && /^[a-f0-9]{64}$/i.test(deviceToken)) {
    const existingTokenHash = crypto
      .createHash('sha256')
      .update(deviceToken)
      .digest('hex');

    recognizedDevice = sqlGet(
      `SELECT id FROM trusted_devices
       WHERE userId = ? AND tokenHash = ?`,
      [user.id, existingTokenHash]
    );
  }

  const isNewDevice = !recognizedDevice;

  if (isNewDevice) {
    deviceToken = crypto.randomBytes(32).toString('hex');

    const tokenHash = crypto
      .createHash('sha256')
      .update(deviceToken)
      .digest('hex');

    sqlRun(
      `INSERT INTO trusted_devices
       (userId, tokenHash, device, ipAddress, firstSeenAt, lastSeenAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [user.id, tokenHash, device, ipAddress, loginTime, loginTime]
    );
  } else {
    const tokenHash = crypto
      .createHash('sha256')
      .update(deviceToken)
      .digest('hex');

    sqlRun(
      `UPDATE trusted_devices
       SET device = ?, ipAddress = ?, lastSeenAt = ?
       WHERE userId = ? AND tokenHash = ?`,
      [device, ipAddress, loginTime, user.id, tokenHash]
    );
  }

  res.cookie(deviceCookieName, deviceToken, {
    maxAge: 365 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/'
  });

  sqlRun(
    `INSERT INTO login_history
     (userId, ipAddress, device, status, timestamp)
     VALUES (?, ?, ?, 'SUCCESS', ?)`,
    [user.id, ipAddress, device, loginTime]
  );

  sqlRun(
    `INSERT INTO notifications
     (userId, title, message, type, isRead, created_at)
     VALUES (?, ?, ?, 'security', 0, ?)`,
    [
      user.id,
      'Successful Sign-In',
      `Your account was successfully signed in on ${new Date(loginTime).toLocaleString('en-US')} using ${device}.`,
      loginTime
    ]
  );

  if (isNewDevice) {
    sqlRun(
      `INSERT INTO notifications
       (userId, title, message, type, isRead, created_at)
       VALUES (?, ?, ?, 'security', 0, ?)`,
      [
        user.id,
        'New Device Sign-In',
        `A sign-in was recorded from a browser or device not previously recognised on ${new Date(loginTime).toLocaleString('en-US')}.`,
        loginTime
      ]
    );
  }



  req.session.user = cleanUser(user);

  void sendAccountEmail(
    user.id,
    'AgriBank Texas - Successful Sign-In',
    [
      'A successful sign-in was recorded for your AgriBank Texas  account.',
      '',
      `Username: ${user.username}`,
      `Date and time: ${new Date(loginTime).toLocaleString('en-US')}`,
      `IP address: ${ipAddress}`,
      `Device/browser: ${device}`
    ].join('\n')
  );

  if (Number(user.isAdmin) === 1) {
    return res.redirect('/admin');
  }

  req.session.showWelcome = true;
  return res.redirect('/welcome');
});

app.get('/register', (req, res) => {
  res.render('register', { error: null });
});

app.post('/register', (req, res) => {
  const {
    firstName, lastName, email, address, city, state, zip,
    accountType, username, password, confirmPassword
  } = req.body;

  if (!firstName || !lastName || !email || !username ||
      !password || !confirmPassword) {
    return res.status(400).render('register', {
      error: 'Please complete all required fields.'
    });
  }

  if (password !== confirmPassword) {
    return res.status(400).render('register', {
      error: 'Passwords do not match.'
    });
  }

  if (password.length < 6) {
    return res.status(400).render('register', {
      error: 'Password must be at least 6 characters.'
    });
  }

  const exists = sqlGet(
    `SELECT id FROM users WHERE username = ?`,
    [username]
  );

  if (exists) {
    return res.status(409).render('register', {
      error: 'That username is already in use.'
    });
  }

  const hash = bcrypt.hashSync(password, 10);

  const result = sqlRun(
    `INSERT INTO users
     (username, password, firstName, lastName, email, memberSince,
      address, city, state, zip, isAdmin, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    [
      username, hash, firstName, lastName, email,
      String(new Date().getFullYear()),
      address || '', city || '', state || '', zip || '',
      new Date().toISOString()
    ]
  );

  const accountMap = {
    checking: ['Primary Checking', 'ðŸ¦'],
    savings: ['Savings Account', 'ðŸ’°'],
    business: ['Business Operating', 'ðŸ¢']
  };

  const selected = accountMap[accountType] || accountMap.checking;
  const safeAccountType = accountMap[accountType] ? accountType : 'checking';



function generateUniqueNumber(length, column) {
  if (!['number', 'routingNumber'].includes(column)) {
    throw new Error('Invalid account number column.');
  }

  const digits = '0123456789';

  for (let attempt = 0; attempt < 100; attempt++) {
    let number = String(Math.floor(Math.random() * 9) + 1);

    for (let i = 1; i < length; i++) {
      number += digits[Math.floor(Math.random() * digits.length)];
    }

    const existing = sqlGet(
      `SELECT 1 FROM accounts WHERE ${column} = ? LIMIT 1`,
      [number]
    );

    if (!existing) return number;
  }

  throw new Error(`Could not generate a unique ${column}. Please retry.`);
}


const accountNumber = generateUniqueNumber(10, 'number');
const routingNumber = generateUniqueNumber(9, 'routingNumber');

sqlRun(
  `INSERT INTO accounts
   (userId, name, type, number, routingNumber, balance, icon)
   VALUES (?, ?, ?, ?, ?, 0, ?)`,
  [
    result.lastID,
    selected[0],
    safeAccountType,
    accountNumber,
    routingNumber,
    selected[1]
  ]
);

  res.redirect('/login?registered=1');
});

app.get('/forgot-password', (req, res) => {
  res.render('forgot-password', {
    error: null,
    success: null,
    info: null
  });
});

app.post('/forgot-password', (req, res) => {
  const { username, email } = req.body;

  if (!username || !email) {
    return res.status(400).render('forgot-password', {
      error: 'Please enter both username and email.',
      success: null,
      info: null
    });
  }

return res.render('forgot-password', {
  error: null,
  success: null,
  info: 'Password recovery is currently unavailable. Please contact the application administrator for assistance.'
});
});


app.get('/promo-checking', (req, res) => res.render('promo-checking'));
app.get('/small-business', (req, res) => res.render('small-business'));
app.get('/commercial-farming', (req, res) => res.render('commercial-farming'));
app.get('/credit-cards', (req, res) =>
  res.render('credit-cards', { user: req.session.user || null })
);

app.get('/about', (req, res) => res.render('about'));
app.get('/privacy', (req, res) => res.render('privacy'));
app.get('/terms', (req, res) => res.render('terms'));
app.get('/security', (req, res) => res.render('security'));
app.get('/help', (req, res) => res.render('help'));

app.get('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error('Session destruction error:', err);
      return res.status(500).send('Could not log out. Please try again.');
    }

    res.clearCookie('agribank.sid');
    res.redirect('/login');
  });
});

// ==========================================
// PRIVATE ROUTES
// ==========================================

app.get('/welcome', requireLogin, (req, res) => {
  if (Number(req.session.user.isAdmin) === 1) {
    return res.redirect('/admin');
  }

  if (!req.session.showWelcome) {
    return res.redirect('/dashboard');
  }

  delete req.session.showWelcome;

  const currentUser = req.session.user || {};
  const firstName = String(
    currentUser.firstName ||
    currentUser.first_name ||
    currentUser.username ||
    'there'
  );

  res.render('welcome', { firstName });
});

app.get('/dashboard', requireLogin, (req, res) => {
  const user = req.session.user;
  const accounts = getUserAccounts(user.id);
  const transactions = getUserTransactions(user.id);
  const recentTransactions = decorateTransactions(transactions.slice(0, 8));

  const notifications = sqlAll(
    `SELECT * FROM notifications
     WHERE userId = ?
     ORDER BY datetime(created_at) DESC LIMIT 3`,
    [user.id]
  );

  const totalBalance = accounts.reduce(
    (sum, acc) => sum + Number(acc.balance || 0), 0
  );

  const deposits = transactions
    .filter(tx => Number(tx.amount) > 0)
    .reduce((sum, tx) => sum + Number(tx.amount), 0);

  const withdrawals = transactions
    .filter(tx => Number(tx.amount) < 0)
    .reduce((sum, tx) => sum + Math.abs(Number(tx.amount)), 0);

  res.render('dashboard', {
    user,
    accounts,
    transactions: recentTransactions,
    notifications,
    totalBalance,
    deposits,
    withdrawals,
    monthlyBars: buildMonthlyBars(transactions)
  });
});

/* ==========================================
   ACCOUNT DETAILS â€” PROTECTED ACCESS
   Add above app.get('/accounts', ...)
   ========================================== */

// Reveal an account number only for an account
// owned by the signed-in user.
app.post('/accounts/reveal-number', requireLogin, (req, res) => {
  const userId = req.session.user.id;
  const accountId = String(req.body.accountId || '').trim();

  if (!accountId || !/^\d+$/.test(accountId)) {
    return res.status(400).json({
      message: 'Select a valid account.'
    });
  }

  const account = sqlGet(
    `SELECT id, number
     FROM accounts
     WHERE id = ? AND userId = ?`,
    [accountId, userId]
  );

  if (!account) {
    return res.status(404).json({
      message: 'Account not found.'
    });
  }

  // The full number is returned only to this authenticated request.
  return res.json({
    accountNumber: String(account.number || '')
  });
});


app.post('/accounts/reveal-number', requireLogin, (req, res) => {
  const accountId = String(req.body.accountId || '').trim();

  if (!/^\d+$/.test(accountId)) {
    return res.status(400).json({
      message: 'Invalid account selection.'
    });
  }

  const account = sqlGet(
    'SELECT id, number FROM accounts WHERE id = ? AND userId = ?',
    [Number(accountId), req.session.user.id]
  );

  if (!account || !account.number) {
    return res.status(404).json({
      message: 'Account not found or account number unavailable.'
    });
  }

  return res.json({
    accountNumber: String(account.number)
  });
});

// Request a separate email code to authorize routing-number access.
app.post('/accounts/send-routing-code', requireLogin, async (req, res) => {
  const userId = req.session.user.id;
  const respond = (status, message) =>
    res.status(status).json({ message });

  try {
    const userRecord = sqlGet(
      'SELECT id, email FROM users WHERE id = ?',
      [userId]
    );

    if (!userRecord || !userRecord.email) {
      return respond(
        400,
        'No registered email address was found for your account.'
      );
    }

    if (!notificationTransporter) {
      return respond(503, 'Email delivery is not configured.');
    }

    const now = Date.now();
    const lastRequestedAt = Number(
      req.session.routingCodeLastRequestedAt || 0
    );

    if (now - lastRequestedAt < 60 * 1000) {
      return respond(
        429,
        'Please wait one minute before requesting another code.'
      );
    }

    const crypto = require('crypto');
    const code = crypto.randomInt(100000, 1000000).toString();

    delete req.session.pendingRoutingAuthorization;

    req.session.pendingRoutingAuthorization = {
      userId,
      codeHash: await bcrypt.hash(code, 10),
      expiresAt: now + 10 * 60 * 1000,
      attempts: 0
    };

    req.session.routingCodeLastRequestedAt = now;

    const emailSent = await sendAccountEmail(
      userId,
      'Routing Number Verification Code',
      [
        'Your AgriBank Texas routing-number verification code is:',
        '',
        code,
        '',
        'This code expires in 10 minutes.',
        'You have a maximum of five verification attempts.',
        'If you did not request this code, do not use it.'
      ].join('\n')
    );

    if (!emailSent) {
      delete req.session.pendingRoutingAuthorization;

      return respond(
        502,
        'The verification email could not be sent. Please try again later.'
      );
    }

    return respond(
      200,
      'A verification code has been sent to your registered email address.'
    );
  } catch (error) {
    console.error(
      'Routing-number code request failed:',
      error.message
    );

    delete req.session.pendingRoutingAuthorization;

    return respond(
      500,
      'Unable to send the verification code. Please try again.'
    );
  }
});


// Verify the email code, then return the user's routing number.
app.post('/accounts/verify-routing-code', requireLogin, async (req, res) => {
  const userId = req.session.user.id;
  const code = String(req.body.code || '').trim();

  const respond = (status, message) =>
    res.status(status).json({ message });

  const pending = req.session.pendingRoutingAuthorization;

  if (!pending || Number(pending.userId) !== Number(userId)) {
    return respond(
      400,
      'Request a new verification code before continuing.'
    );
  }

  if (Number(pending.expiresAt) <= Date.now()) {
    delete req.session.pendingRoutingAuthorization;

    return respond(
      400,
      'Your verification code has expired. Request a new one.'
    );
  }

  if (Number(pending.attempts || 0) >= 5) {
    delete req.session.pendingRoutingAuthorization;

    return respond(
      429,
      'Too many attempts. Request a new verification code.'
    );
  }

  if (!/^\d{6}$/.test(code)) {
    pending.attempts = Number(pending.attempts || 0) + 1;

    return respond(400, 'Enter the six-digit verification code.');
  }

  let valid = false;

  try {
    valid = await bcrypt.compare(code, pending.codeHash);
  } catch (error) {
    valid = false;
  }

  if (!valid) {
    pending.attempts = Number(pending.attempts || 0) + 1;

    if (pending.attempts >= 5) {
      delete req.session.pendingRoutingAuthorization;

      return respond(
        429,
        'Too many incorrect attempts. Request a new code.'
      );
    }

    return respond(
      400,
      'The verification code is incorrect. Please try again.'
    );
  }

  // Consume the code before returning any protected information.
  delete req.session.pendingRoutingAuthorization;

  const account = sqlGet(
    `SELECT routingNumber
     FROM accounts
     WHERE userId = ?
       AND routingNumber IS NOT NULL
       AND TRIM(routingNumber) <> ''
     ORDER BY id
     LIMIT 1`,
    [userId]
  );

  if (!account || !account.routingNumber) {
    return respond(
      404,
      'No routing number is available for your account.'
    );
  }

  return res.json({
    message: 'Verification successful.',
    routingNumber: String(account.routingNumber)
  });
});

app.get('/accounts', requireLogin, (req, res) => {
  const accounts = getUserAccounts(req.session.user.id);
  const totalBalance = accounts.reduce(
    (sum, acc) => sum + Number(acc.balance || 0), 0
  );

  res.render('accounts', {
    user: req.session.user,
    accounts,
    totalBalance
  });
});

app.get('/transactions', requireLogin, (req, res) => {
  const user = req.session.user;
  const accounts = getUserAccounts(user.id);
  const { accountId = '', type = '', q = '' } = req.query;

  let transactions = getUserTransactions(user.id);

  const rejectedDeposits = sqlAll(
    `SELECT
       d.id,
       d.reference,
       d.amount,
       d.accountId,
       d.created_at AS date,
       a.name AS accountName,
       a.number AS rawAccountNumber
     FROM mobile_deposits d
     JOIN accounts a ON a.id = d.accountId
     WHERE d.userId = ? AND d.status = 'rejected'`,
    [user.id]
  ).map(d => ({
    ...d,
    type: 'Mobile Deposit Request',
    description: 'Mobile cheque deposit request',
    status: 'rejected',
    reference: d.reference,
    accountNumber: '???? ' + String(d.rawAccountNumber || '').slice(-4),
    isDepositRequest: true
  }));

  transactions = [...transactions, ...rejectedDeposits]
    .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

  if (accountId) {
    transactions = transactions.filter(
      tx => String(tx.accountId) === String(accountId)
    );
  }

  if (type) {
    transactions = transactions.filter(
      tx => String(tx.type || '').toLowerCase().includes(type.toLowerCase())
    );
  }

  if (q) {
    const search = q.toLowerCase();

    transactions = transactions.filter(tx =>
      String(tx.description || '').toLowerCase().includes(search) ||
      String(tx.accountName || '').toLowerCase().includes(search)
    );
  }

  res.render('transactions', {
    user,
    accounts,
    transactions: decorateTransactions(transactions),
    filters: { accountId, type, q }
  });
});

app.get('/transactions/export', requireLogin, (req, res) => {
  const rows = getUserTransactions(req.session.user.id);

  sendCsv(
    res,
    'transactions.csv',
    ['date', 'accountName', 'accountNumber', 'type', 'description', 'amount'],
    rows.map(row => [
      row.date,
      row.accountName,
      row.accountNumber,
      row.type,
      row.description,
      row.amount
    ])
  );
});

// ==========================================
// STATEMENTS
// ==========================================

app.get('/statements', requireLogin, (req, res) => {
  const user = req.session.user;
  const { from = '', to = '' } = req.query;

  if (!isValidStatementDate(from) || !isValidStatementDate(to)) {
    return res.status(400).send('Invalid date. Please use YYYY-MM-DD.');
  }

  if (from && to && from > to) {
    return res.status(400).send(
      'The start date must be before the end date.'
    );
  }

  const statement = getStatementData(user.id, req.query);

  if (!statement.validAccountFilter) {
    return res.status(400).send(
      'The selected account is not available.'
    );
  }

  res.render('statements', {
    user,
    ...statement,
    moneyIn: statement.deposits,
    moneyOut: statement.withdrawals,
    startDate: statement.filters.from,
    endDate: statement.filters.to,
    formatMoney,
    isDemoData: false
  });
});

app.get('/statements/export', requireLogin, (req, res) => {
  const user = req.session.user;
  const { from = '', to = '' } = req.query;

  if (!isValidStatementDate(from) || !isValidStatementDate(to)) {
    return res.status(400).send('Invalid date. Please use YYYY-MM-DD.');
  }

  if (from && to && from > to) {
    return res.status(400).send(
      'The start date must be before the end date.'
    );
  }

  const statement = getStatementData(user.id, req.query);

  if (!statement.validAccountFilter) {
    return res.status(400).send(
      'The selected account is not available.'
    );
  }

  sendCsv(
    res,
    'account-transaction-summary.csv',
    [
      'date',
      'accountName',
      'accountNumber',
      'type',
      'description',
      'amount'
    ],
    statement.transactions.map(tx => [
      tx.date,
      tx.accountName,
      tx.accountNumber,
      tx.type,
      tx.description,
      tx.amount
    ])
  );
});

// ==========================================
// PDF STATEMENT DOWNLOAD
// ==========================================

app.get('/statements/pdf', requireLogin, (req, res) => {
  const user = req.session.user;
  const { from = '', to = '' } = req.query;

  if (!isValidStatementDate(from) || !isValidStatementDate(to)) {
    return res.status(400).send('Invalid date. Please use YYYY-MM-DD.');
  }

  if (from && to && from > to) {
    return res.status(400).send(
      'The start date must be before the end date.'
    );
  }

  const statement = getStatementData(user.id, req.query);

  if (!statement.validAccountFilter) {
    return res.status(400).send('The selected account is not available.');
  }

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 45, bottom: 55, left: 42, right: 42 },
    bufferPages: true
  });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    'attachment; filename="AgriBank-Texas-Account-Statement.pdf"'
  );

  doc.pipe(res);

  const green = '#174C35';
  const gold = '#D8B86A';
  const muted = '#68756D';
  const pale = '#EDF4EF';
  const left = 42;
  const right = doc.page.width - 42;
  const width = right - left;

  const money = value => Number(value || 0).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD'
  });

  function drawBrandHeader() {
    doc.rect(0, 0, doc.page.width, 112).fill(green);
    doc.rect(0, 108, doc.page.width, 4).fill(gold);

    // Original vector leaf logo
    doc.circle(68, 52, 24).fill(gold);
    doc.save();
    doc.fillColor(green);
    doc.ellipse(62, 51, 6, 13).fill();
    doc.ellipse(73, 44, 5, 10).fill();
    doc.moveTo(59, 64).lineTo(77, 39)
      .lineWidth(2).stroke(green);
    doc.restore();

    doc.fillColor('#FFFFFF')
      .font('Helvetica-Bold')
      .fontSize(22)
      .text('AgriBank Texas', 105, 31);

    doc.fillColor('#E8EFEA')
      .font('Helvetica')
      .fontSize(9)
      .text('ACCOUNT SERVICES', 106, 59);

    doc.fillColor('#F2DDA5')
      .font('Helvetica-Bold')
      .fontSize(8)
      .text('OFFICIAL ACCOUNT STATEMENT', 106, 77);
  }

  function drawFooter() {
    const range = doc.bufferedPageRange();

    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);

      const y = doc.page.height - 42;

      doc.moveTo(left, y - 9)
        .lineTo(right, y - 9)
        .lineWidth(0.7)
        .strokeColor(gold)
        .stroke();

      doc.fillColor(muted)
        .font('Helvetica')
        .fontSize(7)
        .text(
              'Electronically generated official statement Â· AgriBank Texas Â· Retain for your records.',
          left, y, { width: width - 65 }
        );

      doc.text(
        `Page ${i + 1} of ${range.count}`,
        right - 55, y, { width: 55, align: 'right' }
      );
    }
  }

  drawBrandHeader();
  doc.y = 137;

  doc.fillColor(green)
    .font('Helvetica-Bold')
    .fontSize(19)
    .text('Account Statement', left, doc.y);

  doc.moveDown(0.45);

  doc.fillColor(muted)
    .font('Helvetica')
    .fontSize(9)
    .text(`Statement period: ${from || 'All available dates'} to ${to || 'All available dates'}`);

  doc.moveDown(1);

  if (statement.selectedAccount) {
    doc.fillColor(green)
      .font('Helvetica-Bold')
      .fontSize(11)
      .text(statement.selectedAccount.name);

    doc.fillColor(muted)
      .font('Helvetica')
      .fontSize(9)
      .text(
        `Account: ${statement.selectedAccount.number}   |   Type: ${statement.selectedAccount.type}`
      );
  } else {
    doc.fillColor(green)
      .font('Helvetica-Bold')
      .fontSize(11)
      .text('All Accounts');

    doc.fillColor(muted)
      .font('Helvetica')
      .fontSize(9)
      .text('Transactions from accounts associated with this profile');
  }

  // Customer details
  const customerName = [
    user.firstName,
    user.lastName
  ].filter(Boolean).join(' ') || user.username || 'Customer';

  const customerAddress = [
    user.address,
    user.city,
    user.state,
    user.zip
  ].filter(Boolean).join(', ');

  const detailsY = doc.y + 12;
  const stampX = right - 68;
  const stampY = detailsY + 49;

  doc.fillColor(green)
    .font('Helvetica-Bold')
    .fontSize(8)
    .text('STATEMENT PREPARED FOR', left, detailsY);

  doc.fillColor('#26362C')
    .font('Helvetica-Bold')
    .fontSize(11)
    .text(customerName, left, detailsY + 17, {
      width: width - 135
    });

  doc.fillColor(muted)
    .font('Helvetica')
    .fontSize(8)
    .text(
      customerAddress || 'Address not provided in profile',
      left,
      detailsY + 35,
      { width: width - 135 }
    );

    // Official AgriBank Texas ink stamp
  doc.save();

  const stampAngle = -14 * Math.PI / 180;
  doc.translate(stampX, stampY);
  doc.rotate(stampAngle);

  // Classic bank ink color
 const ink = '#0F3D28';

  // Single oval outline (no overlapping circles)
  doc.ellipse(0, 0, 52, 28)
    .lineWidth(2.2)
    .strokeColor(ink)
    .opacity(0.92)
    .stroke();

  // Inner oval for a double-stamp look (not circles)
  doc.ellipse(0, 0, 46, 23)
    .lineWidth(0.9)
    .strokeColor(ink)
    .opacity(0.75)
    .stroke();

  // Bank name
  doc.fillColor(ink)
    .opacity(0.95)
    .font('Helvetica-Bold')
    .fontSize(7)
    .text('AGRIBANK TEXAS', -48, -14, {
      width: 96,
      align: 'center'
    });

  // Center status
  doc.fillColor(ink)
    .opacity(0.98)
    .font('Helvetica-Bold')
    .fontSize(10)
    .text('VERIFIED', -40, -2, {
      width: 80,
      align: 'center'
    });

  // Date + customer copy
  const stampDate = new Date().toLocaleDateString('en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric'
  });

  doc.fillColor(ink)
    .opacity(0.85)
    .font('Helvetica')
    .fontSize(6)
    .text(`${stampDate}  Â·  CUSTOMER COPY`, -50, 11, {
      width: 100,
      align: 'center'
    });

  doc.restore();

  // Summary cards
  doc.y = detailsY + 105;

  const cardGap = 12;
  const cardWidth = (width - cardGap) / 2;
  const cardY = doc.y;

  function summaryCard(x, label, amount, color) {
    doc.roundedRect(x, cardY, cardWidth, 59, 6).fill(pale);

    doc.fillColor(muted)
      .font('Helvetica')
      .fontSize(8)
      .text(label, x + 12, cardY + 11);

    doc.fillColor(color)
      .font('Helvetica-Bold')
      .fontSize(15)
      .text(money(amount), x + 12, cardY + 29, {
        width: cardWidth - 24
      });
  }

  summaryCard(left, 'TOTAL MONEY IN', statement.deposits, green);
  summaryCard(
    left + cardWidth + cardGap,
    'TOTAL MONEY OUT',
    statement.withdrawals,
    '#8B3A3A'
  );

  summaryCard(left, 'TOTAL MONEY IN', statement.deposits, green);

  summaryCard(
    left + cardWidth + cardGap,
    'TOTAL MONEY OUT',
    statement.withdrawals,
    '#9B4A36'
  );

  doc.y = cardY + 79;

  doc.fillColor(green)
    .font('Helvetica-Bold')
    .fontSize(12)
    .text('Transaction History', left, doc.y);

  doc.moveDown(0.7);

  // Transaction table columns
  const col = {
    date: left + 7,
    account: left + 73,
    description: left + 168,
    type: left + 365,
    amount: right - 87
  };

  function tableHeader() {
    const y = doc.y;

    doc.rect(left, y, width, 25).fill(green);

    doc.fillColor('#FFFFFF')
      .font('Helvetica-Bold')
      .fontSize(7.5)
      .text('DATE', col.date, y + 8)
      .text('ACCOUNT', col.account, y + 8)
      .text('DESCRIPTION', col.description, y + 8)
      .text('TYPE', col.type, y + 8)
      .text('AMOUNT', col.amount, y + 8, {
        width: 80,
        align: 'right'
      });

    doc.y = y + 25;
  }

  tableHeader();

  if (!statement.transactions.length) {
    doc.fillColor(muted)
      .font('Helvetica')
      .fontSize(9)
      .text(
        'No transactions found for the selected filters.',
        left + 8,
        doc.y + 14
      );

    doc.y += 38;
  } else {
    statement.transactions.forEach((tx, index) => {
      const description = String(tx.description || 'Transaction');
      const account = String(tx.accountName || 'Account');
      const type = String(tx.type || 'Transaction');
      const amount = Number(tx.amount || 0);

      const descriptionHeight = doc.heightOfString(description, {
        width: 190,
        font: 'Helvetica',
        fontSize: 7.5
      });

      const rowHeight = Math.max(31, descriptionHeight + 14);

      if (doc.y + rowHeight > doc.page.height - 75) {
        doc.addPage();
        doc.y = 45;
        tableHeader();
      }

      const y = doc.y;

      if (index % 2 === 0) {
        doc.rect(left, y, width, rowHeight).fill('#F5F8F5');
      }

      doc.fillColor('#26362C')
        .font('Helvetica')
        .fontSize(7.5)
        .text(String(tx.date || '').slice(0, 10), col.date, y + 10, {
          width: 62
        })
        .text(account, col.account, y + 10, {
          width: 90,
          ellipsis: true
        })
        .text(description, col.description, y + 8, {
          width: 190
        })
        .text(type, col.type, y + 10, {
          width: 58,
          ellipsis: true
        });

      doc.fillColor(amount < 0 ? '#9B4A36' : green)
        .font('Helvetica-Bold')
        .fontSize(7.5)
        .text(
          `${amount < 0 ? '-' : '+'}${money(Math.abs(amount))}`,
          col.amount,
          y + 10,
          { width: 80, align: 'right' }
        );

      doc.y = y + rowHeight;
    });
  }

  drawFooter();
  doc.end();
});


// ==========================================
// ACCOUNT DOCUMENTS
// ==========================================

app.get('/statements/documents', requireLogin, (req, res) => {
  const accounts = getUserAccounts(req.session.user.id);

  const bankDetails = {
    name: 'AgriBank Texas',
    routingNumber: '',
    mailingAddress: ''
  };

  res.render('statement-documents', {
    user: req.session.user,
    accounts: accounts || [],
    bankDetails
  });
});

// ==========================================
// TRANSFERS
// ==========================================

app.get('/transfer', requireLogin, (req, res) => {
  try {
    res.render('transfer', {
      user: req.session.user,
      accounts: getUserAccounts(req.session.user.id),
      error: null
    });
  } catch (err) {
    console.error('Transfer route error:', err);
    res.status(500).send('Could not load the transfer page.');
  }
});
// Request an email authorization code for a transfer.
app.post('/transfer/request-code', requireLogin, async (req, res) => {
  const user = req.session.user;

  try {
    const {
      transferType,
      fromAccount,
      toAccount,
      amount,
      memo,
      recipientName,
      bankName,
      accountNumber
    } = req.body;

    const respond = (status, message) => {
      return res.status(status).json({ message });
    };

    const allowedTransferTypes = [
      'internal',
      'domestic',
      'international'
    ];

    const amt = Number(amount);

    if (
      !allowedTransferTypes.includes(transferType) ||
      !fromAccount ||
      !Number.isFinite(amt) ||
      amt <= 0
    ) {
      return respond(400, 'Enter valid transfer details before requesting a code.');
    }

    const source = sqlGet(
      'SELECT * FROM accounts WHERE id = ? AND userId = ?',
      [fromAccount, user.id]
    );

    if (!source) {
      return respond(400, 'The selected source account is unavailable.');
    }

    let target = null;

    if (transferType === 'internal') {
      target = sqlGet(
        'SELECT * FROM accounts WHERE id = ? AND userId = ?',
        [toAccount, user.id]
      );

      if (!target || Number(target.id) === Number(source.id)) {
        return respond(400, 'Choose a different destination account.');
      }
    }

    const fee =
      transferType === 'international' ? 45 :
      transferType === 'domestic' ? 25 : 0;

    if (amt + fee > Number(source.balance)) {
      return respond(400, 'Insufficient funds for this transfer.');
    }

    const userRecord = sqlGet(
      'SELECT id, email FROM users WHERE id = ?',
      [user.id]
    );

    if (!userRecord || !userRecord.email) {
      return respond(400, 'No registered email address was found for your account.');
    }

    if (!notificationTransporter) {
      return respond(503, 'Email delivery is not configured.');
    }

    // Limit repeated requests within this session.
    const now = Date.now();
    const previousRequest = Number(
      req.session.transferCodeLastRequestedAt || 0
    );

    if (now - previousRequest < 60 * 1000) {
      return respond(429, 'Please wait one minute before requesting another code.');
    }

    const crypto = require('crypto');
    const code = crypto.randomInt(100000, 1000000).toString();

    const pendingAuthorization = {
      userId: user.id,
      fromAccount: String(fromAccount),
      toAccount: String(toAccount || ''),
      amount: amt,
      transferType: String(transferType),
      memo: String(memo || ''),
      recipientName: String(recipientName || ''),
      bankName: String(bankName || ''),
      accountNumber: String(accountNumber || ''),
      codeHash: await bcrypt.hash(code, 10),
      expiresAt: now + 10 * 60 * 1000,
      attempts: 0
    };

    // Replace any older code so only the newest code remains valid.
    delete req.session.pendingTransferAuthorization;
    req.session.pendingTransferAuthorization = pendingAuthorization;
    req.session.transferCodeLastRequestedAt = now;

    const emailSent = await sendAccountEmail(
      user.id,
      'Transfer Authorization Code',
      [
        'Your transfer authorization code is:',
        '',
        code,
        '',
        'This code expires in 10 minutes.',
        'If you did not request this code, do not use it.'
      ].join('\n')
    );

    if (!emailSent) {
      delete req.session.pendingTransferAuthorization;
      return respond(502, 'The authorization email could not be sent. Please try again later.');
    }

    return respond(
      200,
      'The authorization code has been sent to your registered email address.'
    );
  } catch (error) {
    console.error('Transfer authorization request failed:', error.message);
    delete req.session.pendingTransferAuthorization;

    return res.status(500).json({
      message: 'Unable to process the authorization request. Please try again.'
    });
  }
});
app.post('/transfer', requireLogin, (req, res) => {
  const user = req.session.user;
  const accounts = getUserAccounts(user.id);

  const {
    transferType, fromAccount, toAccount, amount, memo,
    recipientName, bankName, accountNumber, authCode
  } = req.body;

  const renderTransferError = (message, status = 400) => {
    return res.status(status).render('transfer', {
      user,
      accounts,
      error: message
    });
  };

  // --------------------------------------------------
  // 1. VERIFY AUTHORIZATION BEFORE CHANGING ANY BALANCE
  // --------------------------------------------------

  const code = String(authCode || '').trim();

  if (!/^\d{6}$/.test(code)) {
    return renderTransferError(
      'Enter your valid 6-digit email authorization code or security PIN.'
    );
  }

  const userRecord = sqlGet(
    `SELECT id, transferPinHash FROM users WHERE id = ?`,
    [user.id]
  );

  const pendingAuth = req.session.pendingTransferAuthorization;
  let authorized = false;
  let authorizationMethod = null;

  // Check a previously issued email code.
  // The code hash must have been created by the email-code endpoint.
  if (
    pendingAuth &&
    Number(pendingAuth.userId) === Number(user.id) &&
    Number(pendingAuth.expiresAt) > Date.now() &&
    Number(pendingAuth.attempts || 0) < 5 &&
    typeof pendingAuth.codeHash === 'string'
  ) {
    const matchesPendingTransfer =
      String(pendingAuth.fromAccount) === String(fromAccount) &&
      String(pendingAuth.toAccount || '') === String(toAccount || '') &&
      Number(pendingAuth.amount) === Number(amount) &&
      String(pendingAuth.transferType) === String(transferType) &&
      String(pendingAuth.memo || '') === String(memo || '') &&
      String(pendingAuth.recipientName || '') === String(recipientName || '') &&
      String(pendingAuth.bankName || '') === String(bankName || '') &&
      String(pendingAuth.accountNumber || '') === String(accountNumber || '');

    if (matchesPendingTransfer) {
      try {
        authorized = bcrypt.compareSync(code, pendingAuth.codeHash);
        if (authorized) authorizationMethod = 'email';
      } catch (err) {
        authorized = false;
      }

      if (!authorized) {
        pendingAuth.attempts = Number(pendingAuth.attempts || 0) + 1;

        if (pendingAuth.attempts >= 5) {
          delete req.session.pendingTransferAuthorization;
        }

        return renderTransferError(
          'The authorization code is invalid or expired. Request a new code and try again.'
        );
      }
    }
  }

  // Alternatively, verify the user's previously configured security PIN.
  if (!authorized && userRecord && userRecord.transferPinHash) {
    try {
      authorized = bcrypt.compareSync(code, userRecord.transferPinHash);
      if (authorized) authorizationMethod = 'pin';
    } catch (err) {
      authorized = false;
    }
  }

  if (!authorized) {
    return renderTransferError(
      'Transfer authorization failed. Verify your code or PIN before continuing.',
      403
    );
  }

  // Consume the email authorization so it cannot be reused.
  if (authorizationMethod === 'email') {
    delete req.session.pendingTransferAuthorization;
  }

  // --------------------------------------------------
  // 2. VALIDATE TRANSFER DETAILS
  // --------------------------------------------------

  const source = sqlGet(
    `SELECT * FROM accounts WHERE id = ? AND userId = ?`,
    [fromAccount, user.id]
  );

  const target = toAccount
    ? sqlGet(
        `SELECT * FROM accounts WHERE id = ? AND userId = ?`,
        [toAccount, user.id]
      )
    : null;

  const amt = Number(amount);

  if (!source || !Number.isFinite(amt) || amt <= 0) {
    return renderTransferError(
      'Enter a valid transfer amount and source account.'
    );
  }

  const allowedTransferTypes = ['internal', 'domestic', 'international'];

  if (!allowedTransferTypes.includes(transferType)) {
    return renderTransferError('Choose a valid transfer type.');
  }

  if (
    transferType === 'internal' &&
    (!target || Number(target.id) === Number(source.id))
  ) {
    return renderTransferError(
      'Choose a different destination account.'
    );
  }

  const fee =
    transferType === 'international' ? 45 :
    transferType === 'domestic' ? 25 : 0;

  if (amt + fee > Number(source.balance)) {
    return renderTransferError(
      'Insufficient funds for this transfer.'
    );
  }

  // --------------------------------------------------
  // 3. PROCESS THE AUTHORIZED TRANSFER
  // --------------------------------------------------

    let destinationLabel = 'External account';
  let transferLabel = 'External Transfer';
  const now = new Date().toISOString();

  db.transaction(() => {
    if (transferType === 'internal') {
      const debit = sqlRun(
        `UPDATE accounts SET balance = balance - ?
         WHERE id = ? AND userId = ? AND balance >= ?`,
        [amt, source.id, user.id, amt]
      );

      if (debit.changes !== 1) {
        throw new Error('Insufficient funds or source account unavailable.');
      }

      const credit = sqlRun(
        `UPDATE accounts SET balance = balance + ?
         WHERE id = ? AND userId = ?`,
        [amt, target.id, user.id]
      );

      if (credit.changes !== 1) {
        throw new Error('Destination account unavailable.');
      }

      sqlRun(
        `INSERT INTO transactions
         (userId, accountId, type, amount, description, date)
         VALUES (?, ?, 'Transfer Out', ?, ?, ?)`,
        [user.id, source.id, -amt, `Transfer to ${target.name}`, now]
      );

      sqlRun(
        `INSERT INTO transactions
         (userId, accountId, type, amount, description, date)
         VALUES (?, ?, 'Transfer In', ?, ?, ?)`,
        [user.id, target.id, amt, `Transfer from ${source.name}`, now]
      );

      destinationLabel = `${target.name} (${target.number})`;
      transferLabel = 'Internal Transfer';
    } else {
      const totalDebit = amt + fee;

      const debit = sqlRun(
        `UPDATE accounts SET balance = balance - ?
         WHERE id = ? AND userId = ? AND balance >= ?`,
        [totalDebit, source.id, user.id, totalDebit]
      );

      if (debit.changes !== 1) {
        throw new Error('Insufficient funds or source account unavailable.');
      }

      sqlRun(
        `INSERT INTO transactions
         (userId, accountId, type, amount, description, date)
         VALUES (?, ?, 'Transfer Out', ?, ?, ?)`,
        [
          user.id,
          source.id,
          -amt,
          `Transfer to ${recipientName || 'external recipient'}`,
          now
        ]
      );

      if (fee > 0) {
        sqlRun(
          `INSERT INTO transactions
           (userId, accountId, type, amount, description, date)
           VALUES (?, ?, 'Fee', ?, ?, ?)`,
          [
            user.id,
            source.id,
            -fee,
            `${transferType === 'international' ? 'International' : 'Domestic'} wire fee`,
            now
          ]
        );
      }

      destinationLabel =
        `${recipientName || 'Recipient'}` +
        `${bankName ? ` â€¢ ${bankName}` : ''}` +
        `${accountNumber ? ` â€¢ ${accountNumber}` : ''}`;

      transferLabel =
        transferType === 'international' ? 'International Wire' :
        transferType === 'domestic' ? 'Domestic Wire' :
        'External Transfer';
    }

    sqlRun(
      `INSERT INTO transfers
       (userId, fromAccount, toAccount, amount, date, status, transferType, memo)
       VALUES (?, ?, ?, ?, ?, 'completed', ?, ?)`,
      [
        user.id,
        source.id,
        target ? target.id : null,
        amt,
        now,
        transferType || 'external',
        memo || ''
      ]
    );

    sqlRun(
      `INSERT INTO notifications
       (userId, title, message, type, isRead, created_at)
       VALUES (?, 'Transfer Completed', ?, 'transfer', 0, ?)`,
      [
        user.id,
        `${transferLabel} of ${formatMoney(amt)} has been completed.`,
        now
      ]
    );
  });


void sendAccountEmail(
  user.id,
  'AgriBank Texas â€” Transfer Request Submitted',
  [
    'Your transfer request has been submitted successfully.',
    'Please allow 3â€“5 business days for processing and delivery, where applicable.',
    '',
    `Transfer type: ${transferLabel}`,
    `Amount: ${formatMoney(amt)}`,
    `Fee: ${fee ? formatMoney(fee) : formatMoney(0)}`,
    `From account: ${source.name} (${source.number})`,
    `Destination: ${destinationLabel}`,
    `Memo: ${memo || 'None'}`,
    `Authorization method: ${authorizationMethod}`,
    `Date and time: ${new Date(now).toLocaleString('en-US')}`
  ].join('\n')
);


  return res.render('transfer-confirm', {
    user,
    summary: {
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


 // ==========================================
 // BILL PAY
 // ==========================================

app.get('/billpay', requireLogin, (req, res) => {
  res.render('billpay', {
    user: req.session.user,
    accounts: getUserAccounts(req.session.user.id),
    error: null
  });
});

app.post('/billpay', requireLogin, async (req, res) => {
  const user = req.session.user;

  const payeeName = String(req.body.payeeName || '').trim();
  const accountNumber = String(req.body.accountNumber || '').trim();
  const fromAccount = req.body.fromAccount;
  const amt = Number(req.body.amount);

  // ------------------------------------------
  // VALIDATE PAYMENT DETAILS
  // ------------------------------------------

  const account = sqlGet(
    `SELECT *
     FROM accounts
     WHERE id = ? AND userId = ?`,
    [fromAccount, user.id]
  );

  if (
    !account ||
    !payeeName ||
    !Number.isFinite(amt) ||
    amt <= 0 ||
    !Number.isFinite(Number(account.balance))
  ) {
    return res.status(400).render('billpay', {
      user,
      accounts: getUserAccounts(user.id),
      error: 'Enter a valid payee, amount, and source account.'
    });
  }

  if (amt > Number(account.balance)) {
    return res.status(400).render('billpay', {
      user,
      accounts: getUserAccounts(user.id),
      error: 'Insufficient funds for this bill payment.'
    });
  }

  // ------------------------------------------
  // PREPARE PAYMENT RECORD
  // ------------------------------------------

  const now = new Date().toISOString();
  const billPaymentReference =
    `BP-${Date.now().toString().slice(-8)}`;


  // ------------------------------------------
  // RECORD PAYMENT ATOMICALLY
  // ------------------------------------------

  try {
    db.transaction(() => {
      // Deduct funds only if the account belongs to
      // the signed-in user and has sufficient funds.
      const debitResult = sqlRun(
        `UPDATE accounts
         SET balance = balance - ?
         WHERE id = ?
           AND userId = ?
           AND balance >= ?`,
        [amt, account.id, user.id, amt]
      );

      // Roll back every database change if the debit fails.
      if (!debitResult || debitResult.changes !== 1) {
        const error = new Error('INSUFFICIENT_FUNDS');
        error.code = 'INSUFFICIENT_FUNDS';
        throw error;
      }

      // Save the bill payment.
      sqlRun(
        `INSERT INTO billpay_transactions
         (userId, fromAccount, amount, date, payeeName, accountNumber)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          user.id,
          account.id,
          amt,
          now,
          payeeName,
          accountNumber
        ]
      );

      // Add the payment to transaction history.
      sqlRun(
        `INSERT INTO transactions
         (userId, accountId, type, amount, description, date)
         VALUES (?, ?, 'Bill Pay', ?, ?, ?)`,
        [
          user.id,
          account.id,
          -amt,
          `Bill payment to ${payeeName}`,
          now
        ]
      );

      // Add the in-app notification.
      sqlRun(
        `INSERT INTO notifications
         (userId, title, message, type, isRead, created_at)
         VALUES (?, 'Bill Payment Recorded', ?, 'billpay', 0, ?)`,
        [
          user.id,
          `${formatMoney(amt)} was recorded for ${payeeName}.`,
          now
        ]
      );
    });
  } catch (err) {
    console.error('Bill payment database transaction failed:', err);

    if (err.code === 'INSUFFICIENT_FUNDS') {
      return res.status(400).render('billpay', {
        user,
        accounts: getUserAccounts(user.id),
        error: 'Insufficient funds or the account could not be debited. Please check your balance.'
      });
    }

    return res.status(500).render('billpay', {
      user,
      accounts: getUserAccounts(user.id),
      error: 'The bill payment could not be recorded. Check your account activity before trying again.'
    });
  }

  // ------------------------------------------
  // SEND EMAIL NOTIFICATION
  // ------------------------------------------

  let emailNotificationSent = false;

  try {
    emailNotificationSent = Boolean(
      await sendAccountEmail(
        user.id,
        'AgriBank Texas â€” Bill Payment Activity Recorded',
        [
          'A bill payment activity was recorded in your AgriBank Texas account.',
          '',
          `Confirmation reference: ${billPaymentReference}`,
          `Payee: ${payeeName}`,
          `Amount: ${formatMoney(amt)}`,
          `From account: ${account.name} (${account.number})`,
          `Payee account: ${accountNumber || 'Not provided'}`,
          `Date and time: ${new Date(now).toLocaleString('en-US')}`,
          '',
          'Your bill payment request has been recorded.',
          'Please allow 3â€“5 business days for processing and delivery.'
        ].join('\n')
      )
    );

    if (!emailNotificationSent) {
      console.error(
        `Bill payment email notification was not confirmed for ${billPaymentReference}.`
      );
    }
  } catch (emailError) {
    // Email failure must not cause the user to submit the payment again.
    console.error(
      'Bill payment email notification error:',
      emailError
    );
  }

  // ------------------------------------------
  // SHOW PAYMENT CONFIRMATION
  // ------------------------------------------

  return res.render('billpay-confirm', {
    user,
    summary: {
      amount: formatMoney(amt),
      fromAccount: `${account.name} (${account.number})`,
      payeeName,
      payeeAccount: accountNumber || 'N/A',
      confirmation: billPaymentReference,
      date: new Date(now).toLocaleString('en-US')
    },
    emailNotificationSent
  });
});

// ==========================================
// BILL PAY HISTORY
// ==========================================

app.get('/billpay/history', requireLogin, (req, res) => {
  const rows = sqlAll(
    `SELECT b.*, a.name AS accountName, a.number AS accountNumber
     FROM billpay_transactions b
     LEFT JOIN accounts a ON a.id = b.fromAccount
     WHERE b.userId = ?
     ORDER BY datetime(b.date) DESC`,
    [req.session.user.id]
  );

  res.render('history', {
    user: req.session.user,
    transactions: rows
  });
});

// ==========================================
// EXPORT BILL PAY HISTORY
// ==========================================

app.get('/billpay/history/export', requireLogin, (req, res) => {
  const rows = sqlAll(
    `SELECT b.*, a.name AS accountName
     FROM billpay_transactions b
     LEFT JOIN accounts a ON a.id = b.fromAccount
     WHERE b.userId = ?
     ORDER BY datetime(b.date) DESC`,
    [req.session.user.id]
  );

  sendCsv(
    res,
    'billpay-history.csv',
    ['date', 'payee', 'fromAccount', 'amount', 'accountNumber'],
    rows.map(row => [
      row.date,
      row.payeeName,
      row.accountName,
      row.amount,
      row.accountNumber
    ])
  );
});



 // ==========================================
// DEPOSITS AND LOANS
// ==========================================

// ------------------------------------------
// DEPOSITS PAGE
// ------------------------------------------

app.get('/deposits', requireLogin, (req, res) => {
  const user = req.session.user;

  res.render('deposits', {
    user,
    accounts: getUserAccounts(user.id),
    error: null,
    success: null,
    emailNotificationSent: null
  });
});
// ------------------------------------------

app.get('/deposits/confirmation/:reference', requireLogin, (req, res) => {
  const reference = String(req.params.reference || '').trim();

  const deposit = sqlGet(
    `SELECT d.reference, d.amount, d.status, d.created_at,
            d.checkNumber, a.name AS accountName, a.number AS accountNumber
     FROM mobile_deposits d
     JOIN accounts a ON a.id = d.accountId
     WHERE d.reference = ? AND d.userId = ?`,
    [reference, req.session.user.id]
  );

  if (!deposit) {
    return res.status(404).send('Deposit confirmation not found.');
  }

  res.render('deposit-confirmation', {
    user: req.session.user,
    deposit
  });
});

// CUSTOMER MOBILE DEPOSIT SUBMISSION
// ------------------------------------------

app.post(
  '/deposits',
  requireLogin,
  (req, res, next) => {
    depositUpload.fields([
      { name: 'frontImage', maxCount: 1 },
      { name: 'backImage', maxCount: 1 }
    ])(req, res, err => {
      if (err) {
        return res.status(400).render('deposits', {
          user: req.session.user,
          accounts: getUserAccounts(req.session.user.id),
          error: err.message || 'Cheque images could not be uploaded.',
          success: null,
          emailNotificationSent: null
        });
      }

      next();
    });
  },
  async (req, res) => {
    const user = req.session.user;
    const uploadedFiles = [
      ...(req.files?.frontImage || []),
      ...(req.files?.backImage || [])
    ];

    const cleanupUploads = async () => {
      await Promise.all(
        uploadedFiles.map(file =>
          fs.promises.unlink(file.path).catch(() => {})
        )
      );
    };

    const showError = async (message, status = 400) => {
      await cleanupUploads();

      return res.status(status).render('deposits', {
        user,
        accounts: getUserAccounts(user.id),
        error: message,
        success: null,
        emailNotificationSent: null
      });
    };

    try {
      const accountId = Number(req.body.accountId);
      const amount = Number(req.body.amount);
      const checkNumber = String(req.body.checkNumber || '').trim();
      const memo = String(req.body.memo || '').trim();

      const frontImage = req.files?.frontImage?.[0];
      const backImage = req.files?.backImage?.[0];

      if (
        !Number.isSafeInteger(accountId) ||
        !Number.isFinite(amount) ||
        amount <= 0 ||
        amount > 100000000
      ) {
        return await showError('Enter a valid account and deposit amount.');
      }

      if (!frontImage || !backImage) {
        return await showError('Both sides of the cheque are required.');
      }

      if (
        checkNumber.length > 40 ||
        memo.length > 250
      ) {
        return await showError('Please check the cheque number and memo lengths.');
      }

      const [validFront, validBack] = await Promise.all([
        isValidDepositImage(frontImage.path),
        isValidDepositImage(backImage.path)
      ]);

      if (!validFront || !validBack) {
        return await showError(
          'Both uploads must be valid JPEG, PNG, or WebP images.'
        );
      }

      const account = sqlGet(
        `SELECT id, name, number
         FROM accounts
         WHERE id = ? AND userId = ?`,
        [accountId, user.id]
      );

      if (!account) {
        return await showError('The selected account is unavailable.');
      }

      const now = new Date().toISOString();
      const reference =
        `MD-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

      db.transaction(() => {
        sqlRun(
          `INSERT INTO mobile_deposits
           (reference, userId, accountId, amount, checkNumber,
            memo, frontImage, backImage, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
          [
            reference,
            user.id,
            account.id,
            amount,
            checkNumber,
            memo,
            frontImage.filename,
            backImage.filename,
            now
          ]
        );

        sqlRun(
          `INSERT INTO notifications
           (userId, title, message, type, isRead, created_at)
           VALUES (?, ?, ?, 'deposit', 0, ?)`,
          [
            user.id,
            'Mobile Deposit Submitted',
            `Your mobile cheque deposit request ${reference} for ${formatMoney(amount)} has been submitted for review.`,
            now
          ]
        );
      });

      void sendAccountEmail(
        user.id,
        'AgriBank Texas â€” Mobile Deposit Submitted',
        [
          'Your mobile cheque deposit request has been received.',
          `Reference: ${reference}`,
          `Amount: ${formatMoney(amount)}`,
          `Account: ${account.name}`,
          'Status: Pending review',
          '',
          'The account balance will only be updated if the request is approved.'
        ].join('\n')
      );

      return res.redirect('/deposits/confirmation/' + encodeURIComponent(reference));

    } catch (error) {
      console.error('Mobile deposit submission error:', error);
      return await showError(
        'Your deposit request could not be submitted. Please try again.',
        500
      );
    }
  }
);

// ------------------------------------------
// LOANS PAGE
// ------------------------------------------

app.get('/loans', requireLogin, (req, res) => {
  res.render('loans', {
    user: req.session.user,
    products: [
      {
        title: 'Personal Loan',
        rate: '7.49% APR',
        desc: 'Unsecured personal financing for qualified members for eligible personal expenses.'
      },
      {
        title: 'Operating Loan',
        rate: '6.25% APR',
        desc: 'Flexible financing for seed, feed, labor, and seasonal cash flow.'
      },
      {
        title: 'Equipment Loan',
        rate: '5.90% APR',
        desc: 'Financing for tractors, combines, irrigation systems, and equipment.'
      },
      {
        title: 'Land Improvement Loan',
        rate: '6.75% APR',
        desc: 'Financing for fencing, barns, drainage, and infrastructure.'
      }
    ]
  });
});

// ------------------------------------------
// LOAN APPLICATION FORM
// ------------------------------------------

app.get('/loans/apply', requireLogin, (req, res) => {
  const user = req.session.user;
  const product = String(req.query.product || 'Personal Loan').trim();

  res.render('loan-apply', {
    user,
    product,
    error: null,
    success: null
  });
});

// ------------------------------------------
// LOAN APPLICATION SUBMISSION
// ------------------------------------------

app.post('/loans/apply', requireLogin, (req, res) => {
  const user = req.session.user;
  const b = req.body;

  const productType = String(b.productType || '').trim();
  const amount = Number(b.amount);
  const termMonths = Number(b.termMonths || 0);
  const purpose = String(b.purpose || '').trim();
  const employmentStatus = String(b.employmentStatus || '').trim();
  const annualIncome = Number(b.annualIncome || 0);
  const firstName = String(b.firstName || '').trim();
  const lastName = String(b.lastName || '').trim();
  const email = String(b.email || '').trim();
  const phone = String(b.phone || '').trim();
  const address = String(b.address || '').trim();
  const city = String(b.city || '').trim();
  const state = String(b.state || '').trim();
  const zip = String(b.zip || '').trim();

  // Validate required fields.
  if (!productType || !firstName || !lastName || !email || !purpose || !phone || !address) {
    return res.status(400).render('loan-apply', {
      user,
      product: productType || 'Personal Loan',
      error: 'Please complete all required fields marked on the application.',
      success: null
    });
  }

  // Validate requested amount.
  if (!Number.isFinite(amount) || amount < 1000) {
    return res.status(400).render('loan-apply', {
      user,
      product: productType,
      error: 'Enter a valid requested amount (minimum $1,000).',
      success: null
    });
  }

  // Validate required certifications.
  if (
    b.certifyAccuracy !== 'yes' ||
    b.certifyAuthorize !== 'yes' ||
    b.certifyNotGuarantee !== 'yes'
  ) {
    return res.status(400).render('loan-apply', {
      user,
      product: productType,
      error: 'You must accept all certifications before submitting.',
      success: null
    });
  }

  // Collect additional application information.
  const applicationData = {
    dateOfBirth: b.dateOfBirth || '',
    ssnLast4: b.ssnLast4 || '',
    citizenship: b.citizenship || '',
    housingStatus: b.housingStatus || '',
    yearsAtAddress: b.yearsAtAddress || '',
    employerName: b.employerName || '',
    jobTitle: b.jobTitle || '',
    yearsEmployed: b.yearsEmployed || '',
    otherIncome: b.otherIncome || '',
    monthlyHousing: b.monthlyHousing || '',
    monthlyDebts: b.monthlyDebts || '',
    existingLoans: b.existingLoans || '',
    creditScoreRange: b.creditScoreRange || '',
    bankruptcyHistory: b.bankruptcyHistory || '',
    collateralType: b.collateralType || '',
    collateralValue: b.collateralValue || '',
    collateralDescription: b.collateralDescription || '',
    farmAcres: b.farmAcres || '',
    farmType: b.farmType || '',
    primaryCrop: b.primaryCrop || '',
    agribankCustomerYears: b.agribankCustomerYears || '',
    hasAgribankAccounts: b.hasAgribankAccounts || '',
    preferredContact: b.preferredContact || '',
    additionalNotes: b.additionalNotes || ''
  };

  const now = new Date().toISOString();

  // Save the loan application.
  sqlRun(
    `INSERT INTO loan_applications
     (userId, productType, amount, termMonths, purpose, employmentStatus,
      annualIncome, firstName, lastName, email, phone, address, city, state, zip,
      notes, applicationData, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [
      user.id,
      productType,
      amount,
      termMonths || null,
      purpose,
      employmentStatus || null,
      annualIncome || null,
      firstName,
      lastName,
      email,
      phone || null,
      address || null,
      city || null,
      state || null,
      zip || null,
      String(b.additionalNotes || ''),
      JSON.stringify(applicationData),
      now
    ]
  );

  // Create an in-app notification.
  sqlRun(
    `INSERT INTO notifications
     (userId, title, message, type, isRead, created_at)
     VALUES (?, 'Loan Application Received', ?, 'loan', 0, ?)`,
    [
      user.id,
      `Your ${productType} application for ${formatMoney(amount)} was submitted and is pending administrator review.`,
      now
    ]
  );

  // Generate an application reference for this confirmation.
  const reference = 'LN-' + Date.now().toString().slice(-8);

  // Send the application-under-review email.
  void sendAccountEmail(
    user.id,
    'AgriBank Texas â€” Loan Application Under Review',
    [
      `Hello ${firstName},`,
      '',
      `We received your ${productType} application.`,
      `Reference: ${reference}`,
      `Requested amount: ${formatMoney(amount)}`,
      '',
      'Status: Under review',
      '',
      'An authorized administrator will review your application.',
      'You will receive another message when a decision is made.',
      '',
      'If approved, funding instructions will follow.',
      'No funds are deposited until approval is completed.',
      '',
      'Thank you for applying with AgriBank Texas.',
      '',
      'Your file is currently under review by our underwriting department.'
    ].join('\n')
  );

  // Redirect to the separate confirmation page.
  return res.redirect(
    '/loans/confirm' +
    '?product=' + encodeURIComponent(productType) +
    '&amount=' + encodeURIComponent(String(amount)) +
    '&reference=' + encodeURIComponent(reference)
  );
});


// ------------------------------------------
// LOAN APPLICATION CONFIRMATION PAGE
// ------------------------------------------

// ------------------------------------------
// CUSTOMER: LOAN CONFIRMATION
// ------------------------------------------

app.get('/loans/confirm', requireLogin, (req, res) => {
  const amount = Number(req.query.amount || 0);

  res.render('loan-confirm', {
    user: req.session.user,
    product: String(req.query.product || 'Personal Loan'),
    amount: Number.isFinite(amount) && amount >= 0 ? amount : 0,
    reference: String(req.query.reference || '')
  });
});

// ------------------------------------------
// ADMIN: REVIEW LOAN APPLICATIONS
// ------------------------------------------

app.get('/admin/loans', requireAdmin, (req, res) => {
  const rows = sqlAll(
    `SELECT la.*, u.username
     FROM loan_applications la
     LEFT JOIN users u ON u.id = la.userId
     ORDER BY datetime(la.created_at) DESC`
  );

  const applications = rows.map(application => {
    const accounts = sqlAll(
      `SELECT id, name, type,
              'â€¢â€¢â€¢â€¢ ' || substr(number, -4) AS maskedNumber
       FROM accounts
       WHERE userId = ?
       ORDER BY id ASC`,
      [application.userId]
    );

    const disbursement = sqlGet(
      `SELECT id, accountId, amount, disbursedAt
       FROM loan_disbursements
       WHERE applicationId = ?`,
      [application.id]
    );

    return {
      ...application,
      accounts,
      disbursement: disbursement || null
    };
  });

  // TEMPORARY DIAGNOSTIC: Check accounts loaded for each application.
  console.log('LOAN ACCOUNT CHECK:', applications.map(a => ({
    applicationId: a.id,
    userId: a.userId,
    username: a.username,
    accountsFound: a.accounts.length
  })));

  res.render('admin-loans', {
    user: req.session.user,
    applications
  });
});

app.post('/admin/loans/:id/approve', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const adminNote = String(req.body.adminNote || '').trim();
  const now = new Date().toISOString();

  const appRow = sqlGet(
    `SELECT * FROM loan_applications WHERE id = ?`,
    [id]
  );

  if (!appRow || appRow.status !== 'pending') {
    return res.redirect('/admin/loans');
  }

  db.transaction(() => {
    const result = sqlRun(
      `UPDATE loan_applications
       SET status = 'approved',
           adminNote = ?,
           reviewed_at = ?,
           reviewedBy = ?
       WHERE id = ? AND status = 'pending'`,
      [
        adminNote || 'Approved by administrator',
        now,
        req.session.user.id,
        id
      ]
    );

    if (result.changes !== 1) {
      throw new Error('Loan application is no longer pending.');
    }

    sqlRun(
      `INSERT INTO notifications
       (userId, title, message, type, isRead, created_at)
       VALUES (?, ?, ?, 'loan', 0, ?)`,
      [
        appRow.userId,
        'Loan Approved',
        `Your ${appRow.productType} inquiry for ${formatMoney(appRow.amount)} was approved. The administrator will handle the simulated account credit separately.`,
        now
      ]
    );
  });

  void sendAccountEmail(
    appRow.userId,
    'AgriBank Texas - Loan Inquiry Approved',
    [
      `Your ${appRow.productType} inquiry has been approved.`,
      `Approved amount: ${formatMoney(appRow.amount)}`,
      adminNote ? `Administrator note: ${adminNote}` : '',
      '',
      'The administrator will handle the simulated account credit separately.'
    ].filter(Boolean).join('\n')
  );

  res.redirect('/admin/loans');
});

app.post('/admin/loans/:id/reject', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const adminNote = String(req.body.adminNote || '').trim();
  const now = new Date().toISOString();

  const appRow = sqlGet(
    `SELECT * FROM loan_applications WHERE id = ?`,
    [id]
  );

  if (!appRow || appRow.status !== 'pending') {
    return res.redirect('/admin/loans');
  }

  db.transaction(() => {
    const result = sqlRun(
      `UPDATE loan_applications
       SET status = 'rejected',
           adminNote = ?,
           reviewed_at = ?,
           reviewedBy = ?
       WHERE id = ? AND status = 'pending'`,
      [
        adminNote || 'Not approved at this time',
        now,
        req.session.user.id,
        id
      ]
    );

    if (result.changes !== 1) {
      throw new Error('Loan application is no longer pending.');
    }

    sqlRun(
      `INSERT INTO notifications
       (userId, title, message, type, isRead, created_at)
       VALUES (?, ?, ?, 'loan', 0, ?)`,
      [
        appRow.userId,
        'Loan Inquiry Update',
        `Your ${appRow.productType} inquiry was not approved at this time.`,
        now
      ]
    );
  });

  void sendAccountEmail(
    appRow.userId,
    'AgriBank Texas - Loan Inquiry Update',
    [
      `Your ${appRow.productType} inquiry was not approved at this time.`,
      adminNote ? `Administrator note: ${adminNote}` : '',
      '',
      'Please contact the application administrator if you have questions.'
    ].filter(Boolean).join('\n')
  );

  res.redirect('/admin/loans');
});
// ------------------------------------------
// ADMIN: DISBURSE APPROVED LOAN
// ------------------------------------------

app.post('/admin/loans/:id/disburse', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const accountId = Number(req.body.accountId);
  const now = new Date().toISOString();

  if (!Number.isInteger(id) || id <= 0 ||
      !Number.isInteger(accountId) || accountId <= 0) {
    return res.redirect('/admin/loans');
  }

  const appRow = sqlGet(
    `SELECT * FROM loan_applications WHERE id = ?`,
    [id]
  );

  if (!appRow || appRow.status !== 'approved') {
    return res.redirect('/admin/loans');
  }

  const reviewedTime = Date.parse(appRow.reviewed_at);

  if (
    !Number.isFinite(reviewedTime) ||
    Date.now() - reviewedTime > 72 * 60 * 60 * 1000 ||
    Date.now() < reviewedTime
  ) {
    return res.redirect('/admin/loans');
  }

  const account = sqlGet(
    `SELECT id, userId, name
     FROM accounts
     WHERE id = ? AND userId = ?`,
    [accountId, appRow.userId]
  );

  if (!account) {
    return res.redirect('/admin/loans');
  }

  const amount = Number(appRow.amount);

  if (!Number.isFinite(amount) || amount <= 0) {
    return res.redirect('/admin/loans');
  }

  const existingDisbursement = sqlGet(
    `SELECT id FROM loan_disbursements
     WHERE applicationId = ?`,
    [id]
  );

  if (existingDisbursement) {
    return res.redirect('/admin/loans');
  }

  try {
    db.transaction(() => {
      const result = sqlRun(
        `INSERT INTO loan_disbursements
         (applicationId, userId, accountId, amount, disbursedAt, disbursedBy)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          id,
          appRow.userId,
          accountId,
          amount,
          now,
          req.session.user.id
        ]
      );

      if (result.changes !== 1) {
        throw new Error('Loan disbursement could not be recorded.');
      }

      const balanceUpdate = sqlRun(
        `UPDATE accounts
         SET balance = balance + ?
         WHERE id = ? AND userId = ?`,
        [amount, accountId, appRow.userId]
      );

      if (balanceUpdate.changes !== 1) {
        throw new Error('Applicant account could not be updated.');
      }

      sqlRun(
        `INSERT INTO transactions
         (userId, accountId, type, amount, description, date)
         VALUES (?, ?, 'Deposit', ?, ?, ?)`,
        [
          appRow.userId,
          accountId,
          amount,
          `Loan disbursement - ${appRow.productType}`,
          now
        ]
      );

      sqlRun(
        `INSERT INTO notifications
         (userId, title, message, type, isRead, created_at)
         VALUES (?, ?, ?, 'loan', 0, ?)`,
        [
          appRow.userId,
          'Loan Disbursed',
          `Your approved ${appRow.productType} loan of ${formatMoney(amount)} has been credited to your ${account.name} account.`,
          now
        ]
      );
    });

    void sendAccountEmail(
      appRow.userId,
      'AgriBank Texas - Loan Disbursement',
      [
        `Your approved ${appRow.productType} loan has been credited.`,
        `Amount: ${formatMoney(amount)}`,
        `Account: ${account.name}`,
        '',
        'Please sign in to review your account activity.'
      ].join('\n')
    );

  } catch (error) {
    console.error('Loan disbursement error:', error);
  }

  res.redirect('/admin/loans');
});
// ==========================================
// NOTIFICATIONS
// ==========================================

app.get('/notifications', requireLogin, (req, res) => {
  const notifications = sqlAll(
    `SELECT * FROM notifications
     WHERE userId = ?
     ORDER BY datetime(created_at) DESC`,
    [req.session.user.id]
  );

  res.render('notifications', {
    user: req.session.user,
    notifications
  });
});

app.post('/notifications/read-all', requireLogin, (req, res) => {
  sqlRun(
    `UPDATE notifications SET isRead = 1 WHERE userId = ?`,
    [req.session.user.id]
  );

  res.redirect('/notifications');
});

// ==========================================
// PROFILE
// ==========================================

app.get('/profile', requireLogin, (req, res) => {
  const userId = req.session.user.id;

  const loginHistory = sqlAll(
    `SELECT * FROM login_history
     WHERE userId = ?
     ORDER BY datetime(timestamp) DESC LIMIT 10`,
    [userId]
  );

  res.render('profile', {
    user: req.session.user,
    loginHistory,
    success: null,
    error: null,
    accounts: getUserAccounts(userId)
  });
});

app.post('/profile', requireLogin, (req, res) => {
  const { email, address, city, state, zip } = req.body;
  const userId = req.session.user.id;

  if (!email) {
    const loginHistory = sqlAll(
      `SELECT * FROM login_history
       WHERE userId = ?
       ORDER BY datetime(timestamp) DESC LIMIT 10`,
      [userId]
    );

    return res.status(400).render('profile', {
      user: req.session.user,
      loginHistory,
      success: null,
      error: 'Email is required.',
      accounts: getUserAccounts(userId)
    });
  }

  sqlRun(
    `UPDATE users
     SET email = ?, address = ?, city = ?, state = ?, zip = ?
     WHERE id = ?`,
    [email, address || '', city || '', state || '', zip || '', userId]
  );

  const fresh = sqlGet(
    `SELECT * FROM users WHERE id = ?`,
    [userId]
  );

  req.session.user = cleanUser(fresh);

  const loginHistory = sqlAll(
    `SELECT * FROM login_history
     WHERE userId = ?
     ORDER BY datetime(timestamp) DESC LIMIT 10`,
    [userId]
  );

  res.render('profile', {
    user: req.session.user,
    loginHistory,
    success: 'Profile updated successfully.',
    error: null,
    accounts: getUserAccounts(userId)
  });
});

// ==========================================
// ADMIN ROUTES
// ==========================================

app.get('/admin', requireAdmin, (req, res) => {
  const users = sqlAll(`SELECT * FROM users ORDER BY id DESC`);
  const accounts = sqlAll(`SELECT * FROM accounts`);
  const transactions = sqlAll(
    `SELECT * FROM transactions ORDER BY datetime(date) DESC LIMIT 10`
  );

  res.render('admin', {
    user: req.session.user,
    stats: {
      users: users.length,
      admins: users.filter(u => Number(u.isAdmin) === 1).length,
      locked: users.filter(u => Number(u.isLocked) === 1).length,
      deposits: accounts.reduce(
        (sum, account) => sum + Number(account.balance || 0), 0
      )
    },
    users: users.slice(0, 6),
    transactions: decorateTransactions(transactions)
  });
});

app.get('/admin/users', requireAdmin, (req, res) => {
  const q = String(req.query.q || '');
  let users = sqlAll(`SELECT * FROM users ORDER BY id DESC`);

  if (q) {
    const search = q.toLowerCase();

    users = users.filter(user =>
      String(user.username || '').toLowerCase().includes(search) ||
      String(user.email || '').toLowerCase().includes(search) ||
      `${user.firstName} ${user.lastName}`.toLowerCase().includes(search)
    );
  }

  res.render('admin_users', {
    user: req.session.user,
    users,
    query: q
  });
});

app.get('/admin/users/:id', requireAdmin, (req, res) => {
  const userId = Number(req.params.id);
  const viewedUser = sqlGet(
    `SELECT * FROM users WHERE id = ?`,
    [userId]
  );

  if (!viewedUser) {
    return res.status(404).render('error', {
      code: 404,
      message: 'User not found.'
    });
  }

  const accounts = getUserAccounts(userId);
  const transactions = decorateTransactions(
    getUserTransactions(userId).slice(0, 12)
  );

  const notifications = sqlAll(
    `SELECT * FROM notifications
     WHERE userId = ?
     ORDER BY datetime(created_at) DESC LIMIT 8`,
    [userId]
  );

  res.render('admin_user', {
    user: req.session.user,
    viewedUser,
    accounts,
    transactions,
    notifications
  });
});

app.post('/admin/users/:id/toggleAdmin', requireAdmin, (req, res) => {
  const userId = Number(req.params.id);

  if (userId === Number(req.session.user.id)) {
    return res.redirect(`/admin/users/${userId}`);
  }

  const target = sqlGet(
    `SELECT isAdmin FROM users WHERE id = ?`,
    [userId]
  );

  if (!target) return res.redirect('/admin/users');

  sqlRun(
    `UPDATE users SET isAdmin = ? WHERE id = ?`,
    [Number(target.isAdmin) === 1 ? 0 : 1, userId]
  );

  res.redirect(`/admin/users/${userId}`);
});

app.post('/admin/users/:id/lock', requireAdmin, (req, res) => {
  const userId = Number(req.params.id);

  sqlRun(
    `UPDATE users SET isLocked = 1 WHERE id = ?`,
    [userId]
  );

  res.redirect(`/admin/users/${userId}`);
});

app.post('/admin/users/:id/unlock', requireAdmin, (req, res) => {
  const userId = Number(req.params.id);

  sqlRun(
    `UPDATE users SET isLocked = 0 WHERE id = ?`,
    [userId]
  );

  res.redirect(`/admin/users/${userId}`);
});

// ==========================================
// ADMIN MOBILE DEPOSIT MANAGEMENT
// ==========================================

app.get('/admin/deposits', requireAdmin, (req, res) => {
  const allowed = ['pending', 'approved', 'rejected'];
  const requested = String(req.query.status || 'pending').toLowerCase();
  const status = allowed.includes(requested) ? requested : 'pending';

  const selectedStatus = status.charAt(0).toUpperCase() + status.slice(1);

  const deposits = sqlAll(`
    SELECT d.*, u.username, u.firstName, u.lastName, u.email,
           a.name AS accountName, a.number AS accountNumber
    FROM mobile_deposits d
    JOIN users u ON u.id = d.userId
    JOIN accounts a ON a.id = d.accountId
    WHERE d.status = ?
    ORDER BY datetime(d.created_at) DESC
  `, [status]);

  res.render('admin-deposits', {
    user: req.session.user,
    deposits,
    selectedStatus,
    formatMoney,
    formatDate
  });
});
// Securely display only images belonging to a recorded deposit.
app.get(
  '/admin/deposits/:id/image/:side',
  requireAdmin,
  (req, res) => {
    const id = Number(req.params.id);
    const side = req.params.side;

    if (!Number.isSafeInteger(id) ||
        !['front', 'back'].includes(side)) {
      return res.sendStatus(400);
    }

    const deposit = sqlGet(
      `SELECT frontImage, backImage
       FROM mobile_deposits
       WHERE id = ?`,
      [id]
    );

    if (!deposit) return res.sendStatus(404);

    const filename = side === 'front'
      ? deposit.frontImage
      : deposit.backImage;

    if (!filename || path.basename(filename) !== filename) {
      return res.sendStatus(404);
    }

    const imagePath = path.join(depositUploadDir, filename);

    res.sendFile(imagePath, err => {
      if (err && !res.headersSent) {
        res.sendStatus(404);
      }
    });
  }
);

// Approve or decline a pending mobile cheque deposit.
app.post(
  '/admin/deposits/:id/review',
  requireAdmin,
  (req, res) => {
    const id = Number(req.params.id);
    const action = String(req.body.action || '').trim();
    const adminNote = String(req.body.adminNote || '').trim();

    if (
      !Number.isSafeInteger(id) ||
      !['approve', 'reject'].includes(action) ||
      adminNote.length > 500
    ) {
      return res.redirect('/admin/deposits');
    }

    const deposit = sqlGet(
      `SELECT d.*, a.name AS accountName
       FROM mobile_deposits d
       JOIN accounts a ON a.id = d.accountId
       WHERE d.id = ?`,
      [id]
    );

    if (!deposit || deposit.status !== 'pending') {
      return res.redirect('/admin/deposits');
    }

    const now = new Date().toISOString();
    const newStatus = action === 'approve'
      ? 'approved'
      : 'rejected';

    try {
      db.transaction(() => {
        const review = sqlRun(
          `UPDATE mobile_deposits
           SET status = ?,
               adminNote = ?,
               reviewed_at = ?,
               reviewedBy = ?
           WHERE id = ? AND status = 'pending'`,
          [
            newStatus,
            adminNote,
            now,
            req.session.user.id,
            id
          ]
        );

        if (review.changes !== 1) {
          throw new Error('This deposit has already been reviewed.');
        }

        if (action === 'approve') {
          const balanceUpdate = sqlRun(
            `UPDATE accounts
             SET balance = balance + ?
             WHERE id = ? AND userId = ?`,
            [deposit.amount, deposit.accountId, deposit.userId]
          );

          if (balanceUpdate.changes !== 1) {
            throw new Error('Customer account could not be updated.');
          }

          sqlRun(
            `INSERT INTO transactions
             (userId, accountId, type, amount, description, date)
             VALUES (?, ?, 'Deposit', ?, ?, ?)`,
            [
              deposit.userId,
              deposit.accountId,
              deposit.amount,
              `Mobile cheque deposit - ${deposit.reference}`,
              now
            ]
          );
        }

        sqlRun(
          `INSERT INTO notifications
           (userId, title, message, type, isRead, created_at)
           VALUES (?, ?, ?, 'deposit', 0, ?)`,
          [
            deposit.userId,
            action === 'approve'
              ? 'Mobile Deposit Approved'
              : 'Mobile Deposit Declined',
            action === 'approve'
              ? `Your mobile cheque deposit ${deposit.reference} for ${formatMoney(deposit.amount)} has been approved and credited to your ${deposit.accountName} account.`
              : `Your mobile cheque deposit ${deposit.reference} was declined.${adminNote ? ` Admin note: ${adminNote}` : ''}`,
            now
          ]
        );
      });

      void sendAccountEmail(
        deposit.userId,
        `AgriBank Texas â€” Mobile Deposit ${action === 'approve' ? 'Approved' : 'Declined'}`,
        [
          `Your mobile cheque deposit ${deposit.reference} has been ${newStatus}.`,
          `Amount: ${formatMoney(deposit.amount)}`,
          `Account: ${deposit.accountName}`,
          ...(action === 'approve'
            ? ['The amount has been credited to your account.']
            : []),
          adminNote ? `Admin note: ${adminNote}` : '',
          '',
          'Please sign in to review your account activity.'
        ].filter(Boolean).join('\n')
      );

    } catch (error) {
      console.error('Mobile deposit review error:', error);
    }

    return res.redirect('/admin/deposits');
  }
);

// ==========================================
// HEALTH CHECK
// ==========================================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    env: process.env.NODE_ENV || 'development',
    uptime: process.uptime()
  });
});

// ==========================================
// ERROR HANDLERS
// ==========================================

app.use((req, res) => {
  res.status(404).render('error', {
    code: 404,
    message: 'Page not found.'
  });
});

app.use((err, req, res, next) => {
  console.error('Application error:', err);

  if (res.headersSent) return next(err);

  res.status(500).render('error', {
    code: 500,
    message: 'Something went wrong.'
  });
});
// ==========================================
// START SERVER
// ==========================================

try {
  initDB();

  app.listen(PORT, HOST, () => {
    console.log(`AgriBank Texas running on http://${HOST}:${PORT}`);
  });
} catch (err) {
  console.error('Failed to initialize the database:', err);
  process.exit(1);
}
