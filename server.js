require('dotenv').config();

const express = require('express');
const mysql = require('mysql2/promise');
const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const AVAILABILITY_HOURS = 24;
const AVAILABILITY_DURATIONS_HOURS = [4, 12, 24];
const DONOR_RESPONSE_WINDOW_MINUTES = Number(process.env.DONOR_RESPONSE_WINDOW_MINUTES || 120);
if (!Number.isInteger(DONOR_RESPONSE_WINDOW_MINUTES) ||
    DONOR_RESPONSE_WINDOW_MINUTES < 1 || DONOR_RESPONSE_WINDOW_MINUTES > 1440) {
  throw new Error('DONOR_RESPONSE_WINDOW_MINUTES must be an integer between 1 and 1440.');
}
const SESSION_TTL_SECONDS = 60 * 60 * 12;
const ADMIN_SESSION_COOKIE = 'lifedrop_admin_session';
const BLOOD_GROUPS = new Set(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']);
const GENDERS = new Set(['Female', 'Male', 'Non-binary', 'Prefer not to say']);
const REQUEST_URGENCIES = new Set(['Urgent', 'Within 24 hours', 'Planned']);
const REQUEST_STATUSES = new Set(['Pending Verification', 'Under Review', 'Fulfilled', 'Cancelled']);
const PHONE_PATTERN = /^[+0-9 ()-]{7,20}$/;
const SESSION_COOKIE = 'lifedrop_session';
const BLOOD_STOCK_API = 'https://eraktkosh.mohfw.gov.in/eraktkoshPortal/eraktkosh';
const CAMPS = new Map([
  ['camp-demo-01', 'Community Care Donation Day'],
  ['camp-demo-02', 'Give Blood, Share Hope'],
  ['camp-demo-03', 'Neighbourhood Donor Meet']
]);
const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret && process.env.NODE_ENV === 'production') {
  throw new Error('SESSION_SECRET must be configured in production.');
}
const signingSecret = sessionSecret || crypto.randomBytes(32).toString('hex');
let databaseReady = false;
let adminReady = false;
let bloodStockMasterCache = null;
let bloodStockMasterFetchedAt = 0;

const db = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'lifedrop',
  waitForConnections: true,
  connectionLimit: 10,
  timezone: 'Z'
});

app.use(express.json({ limit: '16kb' }));

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/login.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.js'));
});

app.get('/admin', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/admin.js', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'admin.js'));
});

app.get('/app.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'app.js'));
});

app.get('/styles.css', (req, res) => {
  res.sendFile(path.join(__dirname, 'styles.css'));
});

app.get('/assets/blood-donation-hero.jpg', (req, res) => {
  res.sendFile(path.join(__dirname, 'assets', 'blood-donation-hero.jpg'));
});

function isNonEmptyString(value, maxLength) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maxLength;
}

function normalizeBloodGroup(value) {
  return typeof value === 'string' ? value.trim().replace(/[−–]/g, '-') : '';
}

function isValidDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function rateLimit(maxRequests, windowMs) {
  const clients = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const client = clients.get(req.ip);
    if (!client || client.resetAt <= now) {
      clients.set(req.ip, { count: 1, resetAt: now + windowMs });
    } else if (client.count >= maxRequests) {
      return res.status(429).json({ message: 'Too many requests. Please wait before trying again.' });
    } else {
      client.count += 1;
    }

    if (clients.size > 10000) {
      for (const [ip, entry] of clients) {
        if (entry.resetAt <= now) clients.delete(ip);
      }
    }
    next();
  };
}

function requireDatabase(req, res, next) {
  if (!databaseReady) {
    return res.status(503).json({ message: 'Availability is temporarily unavailable. Check the database connection.' });
  }
  next();
}

function createSessionToken(userId) {
  const payload = Buffer.from(JSON.stringify({
    userId,
    expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', signingSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function getSessionUserId(req) {
  const cookie = (req.headers.cookie || '')
    .split(';')
    .map(part => part.trim())
    .find(part => part.startsWith(`${SESSION_COOKIE}=`));
  if (!cookie) return null;

  const [payload, signature] = cookie.slice(SESSION_COOKIE.length + 1).split('.');
  if (!payload || !signature) return null;

  const expected = crypto.createHmac('sha256', signingSecret).update(payload).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;

  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return Number.isSafeInteger(session.userId) && session.expiresAt > Date.now()
      ? session.userId
      : null;
  } catch {
    return null;
  }
}

function setSessionCookie(res, userId) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.append(
    'Set-Cookie',
    `${SESSION_COOKIE}=${createSessionToken(userId)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_SECONDS}${secure}`
  );
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.append(
    'Set-Cookie',
    `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`
  );
}

function createAdminSessionToken(adminId) {
  const payload = Buffer.from(JSON.stringify({
    adminId,
    expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', signingSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function getAdminSessionId(req) {
  const cookie = (req.headers.cookie || '')
    .split(';')
    .map(part => part.trim())
    .find(part => part.startsWith(`${ADMIN_SESSION_COOKIE}=`));
  if (!cookie) return null;

  const [payload, signature] = cookie.slice(ADMIN_SESSION_COOKIE.length + 1).split('.');
  if (!payload || !signature) return null;

  const expected = crypto.createHmac('sha256', signingSecret).update(payload).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;

  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return Number.isSafeInteger(session.adminId) && session.adminId === 1 && session.expiresAt > Date.now()
      ? session.adminId
      : null;
  } catch {
    return null;
  }
}

function setAdminSessionCookie(res, adminId) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.append(
    'Set-Cookie',
    `${ADMIN_SESSION_COOKIE}=${createAdminSessionToken(adminId)}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=${SESSION_TTL_SECONDS}${secure}`
  );
}

function clearAdminSessionCookie(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.append(
    'Set-Cookie',
    `${ADMIN_SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=0${secure}`
  );
}

function requireAdminConfigured(req, res, next) {
  res.set('Cache-Control', 'no-store');
  if (!adminReady) {
    return res.status(503).json({ message: 'Admin access is not configured. Set ADMIN_USERNAME and ADMIN_PASSWORD, then restart the server.' });
  }
  next();
}

async function requireAdmin(req, res, next) {
  const adminId = getAdminSessionId(req);
  if (!adminId) return res.status(401).json({ message: 'Admin login is required.' });
  try {
    const [admins] = await db.execute(
      'SELECT admin_id, username FROM admin_users WHERE admin_id = ? LIMIT 1',
      [adminId]
    );
    if (!admins.length) {
      clearAdminSessionCookie(res);
      return res.status(401).json({ message: 'Your admin session is no longer valid. Please log in again.' });
    }
    req.admin = admins[0];
    next();
  } catch (error) {
    console.error('Admin session verification failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not verify the admin session.' });
  }
}

async function requireSession(req, res, next) {
  const userId = getSessionUserId(req);
  if (!userId) return res.status(401).json({ message: 'Log in to check live donor availability.' });
  try {
    const [users] = await db.execute(
      'SELECT user_id, username, full_name, email, role, phone, city, state FROM users WHERE user_id = ? LIMIT 1',
      [userId]
    );
    if (!users.length) {
      clearSessionCookie(res);
      return res.status(401).json({ message: 'Your session is no longer valid. Please log in again.' });
    }
    req.user = users[0];
    next();
  } catch (error) {
    console.error('Session verification failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not verify your login session.' });
  }
}

function serveAccountDashboard(role, filename) {
  return (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.user.role !== role) {
      return res.redirect(req.user.role === 'donor' ? '/donar-dashboard.html' : '/patient-dashboard.html');
    }
    res.sendFile(path.join(__dirname, filename));
  };
}

app.get('/donar-dashboard.html', requireDatabase, requireSession, serveAccountDashboard('donor', 'donar-dashboard.html'));
app.get('/donor-dashboard.html', requireDatabase, requireSession, serveAccountDashboard('donor', 'donar-dashboard.html'));
app.get('/patient-dashboard.html', requireDatabase, requireSession, serveAccountDashboard('patient', 'patient-dashboard.html'));
app.get('/dashboard.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.js'));
});

async function initializeDatabase() {
  await db.query(
    `CREATE TABLE IF NOT EXISTS camp_registrations (
      registration_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      camp_id VARCHAR(32) NOT NULL,
      camp_name VARCHAR(120) NOT NULL,
      attendee_name VARCHAR(100) NOT NULL,
      email VARCHAR(254) NOT NULL,
      phone VARCHAR(20) NOT NULL,
      consented_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (registration_id),
      UNIQUE KEY uq_camp_registration_email (camp_id, email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS admin_users (
      admin_id TINYINT UNSIGNED NOT NULL,
      username VARCHAR(80) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (admin_id),
      UNIQUE KEY uq_admin_users_username (username)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS users (
      user_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      full_name VARCHAR(100) NOT NULL,
      email VARCHAR(150) NOT NULL,
      username VARCHAR(32) NULL,
      password_hash VARCHAR(255) NOT NULL,
      role ENUM('donor', 'patient') NOT NULL,
      age TINYINT UNSIGNED NOT NULL,
      gender VARCHAR(30) NOT NULL,
      blood_group VARCHAR(3) NOT NULL,
      phone VARCHAR(20) NOT NULL,
      city VARCHAR(80) NOT NULL,
      state VARCHAR(80) NOT NULL DEFAULT '',
      place VARCHAR(100) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id),
      UNIQUE KEY uq_users_email (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  const [userColumns] = await db.query('SHOW COLUMNS FROM users');
  if (!userColumns.some(column => column.Field === 'username')) {
    await db.query('ALTER TABLE users ADD COLUMN username VARCHAR(32) NULL AFTER email');
  }
  const [userIndexes] = await db.query('SHOW INDEX FROM users');
  if (!userIndexes.some(index => index.Key_name === 'uq_users_username')) {
    await db.query('CREATE UNIQUE INDEX uq_users_username ON users (username)');
  }
  await db.query(
    `CREATE TABLE IF NOT EXISTS patients (
      patient_id INT NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NULL,
      patient_name VARCHAR(100) NOT NULL,
      age INT NULL,
      gender VARCHAR(20) NULL,
      blood_group VARCHAR(5) NOT NULL,
      hospital_name VARCHAR(150) NULL,
      city VARCHAR(100) NULL,
      area VARCHAR(100) NOT NULL DEFAULT '',
      contact_number VARCHAR(20) NOT NULL,
      units_required INT NULL DEFAULT 1,
      urgency VARCHAR(20) NULL DEFAULT 'Normal',
      request_status VARCHAR(32) NOT NULL DEFAULT 'Pending',
      request_date TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (patient_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  const [patientColumns] = await db.query('SHOW COLUMNS FROM patients');
  const patientColumnNames = new Set(patientColumns.map(column => column.Field));
  const patientMigrations = [
    ['user_id', 'ALTER TABLE patients ADD COLUMN user_id BIGINT UNSIGNED NULL AFTER patient_id'],
    ['area', "ALTER TABLE patients ADD COLUMN area VARCHAR(100) NOT NULL DEFAULT '' AFTER city"],
    ['request_status', "ALTER TABLE patients ADD COLUMN request_status VARCHAR(32) NOT NULL DEFAULT 'Pending' AFTER urgency"]
  ];
  for (const [columnName, statement] of patientMigrations) {
    if (!patientColumnNames.has(columnName)) await db.query(statement);
  }
  const [patientIndexes] = await db.query('SHOW INDEX FROM patients');
  if (!patientIndexes.some(index => index.Key_name === 'uq_patients_user_id')) {
    await db.query('CREATE UNIQUE INDEX uq_patients_user_id ON patients (user_id)');
  }
  const patientPhoneColumn = patientColumns.find(column => column.Field === 'contact_number');
  const patientPhoneLength = patientPhoneColumn?.Type.match(/^varchar\((\d+)\)$/i);
  if (patientPhoneLength && Number(patientPhoneLength[1]) < 20) {
    await db.query('ALTER TABLE patients MODIFY COLUMN contact_number VARCHAR(20) NOT NULL');
  }
  await db.query(
    `CREATE TABLE IF NOT EXISTS blood_requests (
      request_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      patient_reference VARCHAR(100) NOT NULL,
      blood_group VARCHAR(3) NOT NULL,
      units TINYINT UNSIGNED NOT NULL,
      urgency ENUM('Urgent', 'Within 24 hours', 'Planned') NOT NULL,
      hospital_details VARCHAR(180) NOT NULL,
      hospital_name VARCHAR(150) NOT NULL DEFAULT '',
      city VARCHAR(80) NOT NULL,
      district VARCHAR(80) NOT NULL,
      contact_name VARCHAR(100) NOT NULL,
      contact_phone VARCHAR(20) NOT NULL,
      needed_at DATETIME NOT NULL,
      verification_status ENUM('Not verified', 'Pending') NOT NULL DEFAULT 'Not verified',
      status ENUM('Pending Verification', 'Under Review', 'Fulfilled', 'Cancelled') NOT NULL DEFAULT 'Pending Verification',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (request_id),
      KEY idx_blood_requests_board (created_at),
      KEY idx_blood_requests_owner (user_id, created_at),
      CONSTRAINT fk_blood_requests_user FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  const [bloodRequestColumns] = await db.query('SHOW COLUMNS FROM blood_requests');
  if (!bloodRequestColumns.some(column => column.Field === 'hospital_name')) {
    await db.query("ALTER TABLE blood_requests ADD COLUMN hospital_name VARCHAR(150) NOT NULL DEFAULT '' AFTER hospital_details");
  }
  if (!bloodRequestColumns.some(column => column.Field === 'state')) {
    await db.query("ALTER TABLE blood_requests ADD COLUMN state VARCHAR(80) NOT NULL DEFAULT '' AFTER city");
  }
  await db.query(
    `CREATE TABLE IF NOT EXISTS donor_request_responses (
      request_id BIGINT UNSIGNED NOT NULL,
      donor_user_id BIGINT UNSIGNED NOT NULL,
      response ENUM('pending', 'can_help', 'cannot_help') NOT NULL DEFAULT 'pending',
      matched_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      response_deadline DATETIME NOT NULL,
      responded_at DATETIME NULL,
      read_at DATETIME NULL,
      contact_sharing_consent TINYINT(1) NOT NULL DEFAULT 0,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (request_id, donor_user_id),
      KEY idx_donor_responses_donor (donor_user_id, matched_at),
      KEY idx_donor_response_unread (donor_user_id, read_at, matched_at),
      CONSTRAINT fk_donor_responses_request FOREIGN KEY (request_id)
        REFERENCES blood_requests (request_id) ON DELETE CASCADE,
      CONSTRAINT fk_donor_responses_user FOREIGN KEY (donor_user_id)
        REFERENCES users (user_id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  const [donorResponseColumns] = await db.query('SHOW COLUMNS FROM donor_request_responses');
  const donorResponseMigrations = [
    ['read_at', 'ALTER TABLE donor_request_responses ADD COLUMN read_at DATETIME NULL AFTER responded_at'],
    ['contact_sharing_consent', 'ALTER TABLE donor_request_responses ADD COLUMN contact_sharing_consent TINYINT(1) NOT NULL DEFAULT 0 AFTER read_at']
  ];
  for (const [columnName, statement] of donorResponseMigrations) {
    if (!donorResponseColumns.some(column => column.Field === columnName)) await db.query(statement);
  }
  const [donorResponseIndexes] = await db.query('SHOW INDEX FROM donor_request_responses');
  if (!donorResponseIndexes.some(index => index.Key_name === 'idx_donor_response_unread')) {
    await db.query('CREATE INDEX idx_donor_response_unread ON donor_request_responses (donor_user_id, read_at, matched_at)');
  }
  await db.query(
    `CREATE TABLE IF NOT EXISTS donors (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      full_name VARCHAR(100) NOT NULL,
      age TINYINT UNSIGNED NOT NULL,
      gender VARCHAR(30) NOT NULL,
      blood_group VARCHAR(3) NOT NULL,
      phone VARCHAR(20) NOT NULL,
      city VARCHAR(80) NOT NULL,
      state VARCHAR(80) NOT NULL DEFAULT '',
      place VARCHAR(100) NOT NULL DEFAULT '',
      last_donation_date DATE NULL,
      available TINYINT(1) NOT NULL DEFAULT 0,
      public_contact_consent TINYINT(1) NOT NULL DEFAULT 0,
      availability_expires_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  const [columns] = await db.query('SHOW COLUMNS FROM donors');
  const columnNames = new Set(columns.map(column => column.Field));
  const migrations = [
    ['state', "ALTER TABLE donors ADD COLUMN state VARCHAR(80) NOT NULL DEFAULT '' AFTER city"],
    ['place', "ALTER TABLE donors ADD COLUMN place VARCHAR(100) NOT NULL DEFAULT '' AFTER city"],
    ['available', 'ALTER TABLE donors ADD COLUMN available TINYINT(1) NOT NULL DEFAULT 0 AFTER last_donation_date'],
    ['public_contact_consent', 'ALTER TABLE donors ADD COLUMN public_contact_consent TINYINT(1) NOT NULL DEFAULT 0 AFTER available'],
    ['availability_expires_at', 'ALTER TABLE donors ADD COLUMN availability_expires_at DATETIME NULL AFTER public_contact_consent'],
    ['availability_status', "ALTER TABLE donors ADD COLUMN availability_status ENUM('available', 'not_available') NOT NULL DEFAULT 'not_available' AFTER availability_expires_at"],
    ['last_confirmed_at', 'ALTER TABLE donors ADD COLUMN last_confirmed_at DATETIME NULL AFTER availability_status'],
    ['availability_updated_at', 'ALTER TABLE donors ADD COLUMN availability_updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER last_confirmed_at'],
    ['emergency_response_consent', 'ALTER TABLE donors ADD COLUMN emergency_response_consent TINYINT(1) NOT NULL DEFAULT 0 AFTER availability_updated_at'],
    ['user_id', 'ALTER TABLE donors ADD COLUMN user_id BIGINT UNSIGNED NULL AFTER id']
  ];
  for (const [columnName, statement] of migrations) {
    if (!columnNames.has(columnName)) await db.query(statement);
  }
  const [currentUserColumns] = await db.query('SHOW COLUMNS FROM users');
  if (!currentUserColumns.some(column => column.Field === 'state')) {
    await db.query("ALTER TABLE users ADD COLUMN state VARCHAR(80) NOT NULL DEFAULT '' AFTER city");
  }
  const phoneColumn = columns.find(column => column.Field === 'phone');
  const phoneLength = phoneColumn?.Type.match(/^varchar\((\d+)\)$/i);
  if (phoneLength && Number(phoneLength[1]) < 20) {
    await db.query('ALTER TABLE donors MODIFY COLUMN phone VARCHAR(20) NOT NULL');
  }
  const [indexes] = await db.query('SHOW INDEX FROM donors');
  if (!indexes.some(index => index.Key_name === 'idx_donors_live_search')) {
    await db.query(
      'CREATE INDEX idx_donors_live_search ON donors (blood_group, city, public_contact_consent, availability_expires_at)'
    );
  }
  if (!indexes.some(index => index.Key_name === 'idx_donors_location_live')) {
    await db.query(
      'CREATE INDEX idx_donors_location_live ON donors (blood_group, state, city, public_contact_consent, availability_expires_at)'
    );
  }
  if (!indexes.some(index => index.Key_name === 'uq_donors_user_id')) {
    await db.query('CREATE UNIQUE INDEX uq_donors_user_id ON donors (user_id)');
  }
  const adminUsername = typeof process.env.ADMIN_USERNAME === 'string'
    ? process.env.ADMIN_USERNAME.trim()
    : '';
  const adminPassword = process.env.ADMIN_PASSWORD;
  adminReady = false;
  if (adminUsername && typeof adminPassword === 'string' &&
      adminUsername.length >= 3 && adminUsername.length <= 80 &&
      adminPassword.length >= 12 && adminPassword.length <= 128) {
    const passwordHash = await bcrypt.hash(adminPassword, 12);
    await db.execute(
      `INSERT INTO admin_users (admin_id, username, password_hash)
       VALUES (1, ?, ?)
       ON DUPLICATE KEY UPDATE username = ?, password_hash = ?`,
      [adminUsername, passwordHash, adminUsername, passwordHash]
    );
    adminReady = true;
  } else if (adminUsername || adminPassword) {
    console.error('Admin access is disabled: configure ADMIN_USERNAME (3-80 characters) and ADMIN_PASSWORD (12-128 characters).');
  } else {
    console.warn('Admin access is disabled until ADMIN_USERNAME and ADMIN_PASSWORD are configured.');
  }
  databaseReady = true;
}

app.get('/api/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    if (!databaseReady) {
      return res.status(503).json({ server: 'running', database: 'initializing' });
    }
    res.json({ server: 'running', database: 'connected' });
  } catch (error) {
    console.error('Database health check failed:', error.code || error.message);
    res.status(503).json({ server: 'running', database: 'disconnected' });
  }
});

app.post('/api/camp-registrations', rateLimit(5, 15 * 60 * 1000), requireDatabase, async (req, res) => {
  const campId = typeof req.body?.camp_id === 'string' ? req.body.camp_id : '';
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const phone = typeof req.body?.phone === 'string' ? req.body.phone.trim() : '';
  const phoneDigits = phone.replace(/\D/g, '');
  if (!CAMPS.has(campId) ||
      !isNonEmptyString(name, 100) ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      email.length > 254 ||
      !PHONE_PATTERN.test(phone) ||
      phoneDigits.length < 7 ||
      req.body?.consent !== true) {
    return res.status(400).json({ message: 'Enter valid name, email, phone, camp details, and consent.' });
  }

  try {
    await db.execute(
      `INSERT INTO camp_registrations (camp_id, camp_name, attendee_name, email, phone)
       VALUES (?, ?, ?, ?, ?)`,
      [campId, CAMPS.get(campId), name, email, phone]
    );
    res.status(201).json({
      message: 'Your interest has been registered.',
      camp_name: CAMPS.get(campId)
    });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'This email is already registered for this camp.' });
    }
    console.error('Camp registration failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not save your camp registration.' });
  }
});

app.get('/api/blood-requests', requireDatabase, requireSession, rateLimit(60, 60 * 1000), async (req, res) => {
  try {
    const [requests] = await db.execute(
      `SELECT CAST(request_id AS CHAR) AS request_id,
              blood_group, units, urgency, city, district,
              DATE_FORMAT(needed_at, '%Y-%m-%dT%H:%i:%sZ') AS needed_at,
              verification_status, status,
              DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%sZ') AS created_at,
              user_id
       FROM blood_requests
       ORDER BY created_at DESC, request_id DESC
       LIMIT 100`
    );
    res.json({
      requests: requests.map(({ user_id: ownerId, ...request }) => ({
        ...request,
        units: Number(request.units),
        is_owner: ownerId === req.user.user_id
      }))
    });
  } catch (error) {
    console.error('Blood-request list failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not load blood requests.' });
  }
});

app.post('/api/blood-requests', rateLimit(5, 15 * 60 * 1000), requireDatabase, requireSession, async (req, res) => {
  const patientReference = typeof req.body?.patient === 'string' && req.body.patient.trim()
    ? req.body.patient.trim()
    : req.user.full_name;
  const bloodGroup = normalizeBloodGroup(req.body?.blood);
  const units = req.body?.units;
  const urgency = typeof req.body?.urgency === 'string' ? req.body.urgency : '';
  const hasSeparateHospitalName = typeof req.body?.hospital_name === 'string';
  const hospitalName = hasSeparateHospitalName
    ? req.body.hospital_name.trim()
    : typeof req.body?.hospital === 'string' ? req.body.hospital.trim() : '';
  const hospitalAddress = typeof req.body?.hospital_address === 'string'
    ? req.body.hospital_address.trim()
    : '';
  const hospitalDetails = req.body?.hospital_name
    ? [hospitalName, hospitalAddress].filter(Boolean).join(' — ')
    : hospitalName;
  const city = typeof req.body?.city === 'string' ? req.body.city.trim() : '';
  const state = typeof req.body?.state === 'string' ? req.body.state.trim() : req.user.state;
  const district = typeof req.body?.district === 'string' ? req.body.district.trim() : '';
  const contactName = typeof req.body?.contact_name === 'string' && req.body.contact_name.trim()
    ? req.body.contact_name.trim()
    : req.user.full_name;
  const contactPhone = typeof req.body?.contact_phone === 'string' && req.body.contact_phone.trim()
    ? req.body.contact_phone.trim()
    : req.user.phone;
  const neededAt = typeof req.body?.needed_at === 'string' ? req.body.needed_at : '';
  const neededAtTimestamp = Date.parse(neededAt);
  const phoneDigits = contactPhone.replace(/\D/g, '');

  if (typeof req.body?.match_donors !== 'boolean' ||
      (req.body.match_donors && !hasSeparateHospitalName)) {
    return res.status(400).json({
      message: 'Choose whether to create donor notifications. Matching requires a separate hospital name so private address details are never shared.'
    });
  }
  if (!isNonEmptyString(patientReference, 100) ||
      !BLOOD_GROUPS.has(bloodGroup) ||
      !Number.isInteger(units) || units < 1 || units > 20 ||
      !REQUEST_URGENCIES.has(urgency) ||
      !isNonEmptyString(hospitalName, 150) ||
      hospitalDetails.length > 180 ||
      hospitalAddress.length > 180 ||
      !isNonEmptyString(city, 80) ||
      !isNonEmptyString(state, 80) ||
      !isNonEmptyString(district, 80) ||
      !isNonEmptyString(contactName, 100) ||
      !PHONE_PATTERN.test(contactPhone) || phoneDigits.length < 7 ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(neededAt) ||
      !Number.isFinite(neededAtTimestamp) || neededAtTimestamp <= Date.now() ||
      req.body?.consent !== true) {
    return res.status(400).json({
      message: 'Enter valid request details, choose a future date and time, and consent to secure storage.'
    });
  }

  let connection;
  try {
    const sqlNeededAt = new Date(neededAtTimestamp).toISOString().slice(0, 19).replace('T', ' ');
    connection = await db.getConnection();
    await connection.beginTransaction();
    const [result] = await connection.execute(
      `INSERT INTO blood_requests
         (user_id, patient_reference, blood_group, units, urgency, hospital_details, hospital_name,
          city, state, district, contact_name, contact_phone, needed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.user_id,
        patientReference,
        bloodGroup,
        units,
        urgency,
        hospitalDetails,
        hospitalName,
        city,
        state,
        district,
        contactName,
        contactPhone,
        sqlNeededAt
      ]
    );
    let matchedDonorCount = 0;
    if (urgency === 'Urgent' && req.body.match_donors) {
      const responseDeadline = new Date(Date.now() + DONOR_RESPONSE_WINDOW_MINUTES * 60 * 1000);
      const [matches] = await connection.execute(
        `INSERT INTO donor_request_responses
           (request_id, donor_user_id, response, matched_at, response_deadline)
         SELECT ?, d.user_id, 'pending', UTC_TIMESTAMP(), ?
         FROM donors d
         JOIN users matched_user ON matched_user.user_id = d.user_id AND matched_user.role = 'donor'
         WHERE d.available = 1
           AND d.last_confirmed_at IS NOT NULL
           AND d.emergency_response_consent = 1
           AND d.availability_expires_at > UTC_TIMESTAMP()
           AND d.blood_group = ?
           AND LOWER(d.city) = LOWER(?)
           AND LOWER(d.state) = LOWER(?)
           AND d.user_id <> ?`,
        [result.insertId, responseDeadline, bloodGroup, city, state, req.user.user_id]
      );
      matchedDonorCount = matches.affectedRows;
    }
    await connection.commit();
    res.status(201).json({
      message: matchedDonorCount
        ? 'Blood request saved. Matching donor notifications were created in the LifeDrop app; no email or SMS was sent, and no response or donation is guaranteed.'
        : urgency === 'Urgent' && req.body.match_donors
          ? 'Blood request saved. No eligible opted-in donors matched this exact blood group and city; no notification was created.'
          : 'Blood request saved. No donor notifications were requested; no email or SMS was sent.',
      request_id: String(result.insertId),
      status: 'Pending Verification',
      matched_donor_count: matchedDonorCount
    });
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    console.error('Blood-request creation failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not save the blood request.' });
  } finally {
    connection?.release();
  }
});

app.get(['/api/donor/notifications', '/api/donor/emergency-requests'],
  requireDatabase, requireSession, async (req, res) => {
  if (req.user.role !== 'donor') {
    return res.status(403).json({ message: 'Only donor accounts can view matched emergency requests.' });
  }
  try {
    const [[unreadCount], [requests]] = await Promise.all([
      db.execute(
        'SELECT COUNT(*) AS unread_count FROM donor_request_responses WHERE donor_user_id = ? AND read_at IS NULL',
        [req.user.user_id]
      ),
      db.execute(
      `SELECT CAST(r.request_id AS CHAR) AS request_id,
              r.blood_group, r.units, r.urgency, r.hospital_name, r.city, r.district,
              DATE_FORMAT(r.needed_at, '%Y-%m-%dT%H:%i:%sZ') AS needed_at,
              DATE_FORMAT(r.created_at, '%Y-%m-%dT%H:%i:%sZ') AS requested_at,
              r.status AS request_status, dr.response,
              CASE WHEN r.status IN ('Fulfilled', 'Cancelled') THEN 'Request Closed'
                   WHEN dr.response = 'pending' AND dr.response_deadline <= UTC_TIMESTAMP() THEN 'Expired'
                   WHEN dr.response = 'pending' THEN 'Pending'
                   WHEN dr.response = 'can_help' THEN 'Accepted'
                   ELSE 'Declined' END AS response_status,
              CASE
                WHEN d.available = 1 AND d.last_confirmed_at IS NOT NULL
                     AND d.availability_expires_at > UTC_TIMESTAMP() THEN 'Available'
                WHEN d.last_confirmed_at IS NULL THEN 'Unconfirmed'
                WHEN d.available = 0 AND d.availability_status = 'not_available' THEN 'Not Available'
                ELSE 'Unconfirmed'
              END AS donor_availability_status,
              CASE WHEN d.available = 1 AND d.last_confirmed_at IS NOT NULL
                         AND d.emergency_response_consent = 1
                         AND d.availability_expires_at > UTC_TIMESTAMP()
                   THEN 1 ELSE 0 END AS can_offer_help,
              DATE_FORMAT(dr.response_deadline, '%Y-%m-%dT%H:%i:%sZ') AS response_deadline,
              DATE_FORMAT(dr.matched_at, '%Y-%m-%dT%H:%i:%sZ') AS matched_at,
              DATE_FORMAT(dr.responded_at, '%Y-%m-%dT%H:%i:%sZ') AS responded_at,
              DATE_FORMAT(dr.read_at, '%Y-%m-%dT%H:%i:%sZ') AS read_at
       FROM donor_request_responses dr
       JOIN blood_requests r ON r.request_id = dr.request_id
       JOIN donors d ON d.user_id = dr.donor_user_id
       WHERE dr.donor_user_id = ?
       ORDER BY dr.matched_at DESC
       LIMIT 100`,
      [req.user.user_id])
    ]);
    res.json({ requests, unread_count: Number(unreadCount[0].unread_count) });
  } catch (error) {
    console.error('Matched emergency requests lookup failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not load matched emergency requests.' });
  }
});

app.post('/api/donor/notifications/:requestId/read', requireDatabase, requireSession,
  rateLimit(60, 60 * 1000), async (req, res) => {
    if (req.user.role !== 'donor') {
      return res.status(403).json({ message: 'Only donor accounts can update their notifications.' });
    }
    const requestId = typeof req.params.requestId === 'string' ? req.params.requestId : '';
    if (!/^[1-9]\d{0,19}$/.test(requestId)) {
      return res.status(400).json({ message: 'Choose a valid notification.' });
    }
    try {
      const [result] = await db.execute(
        `UPDATE donor_request_responses
         SET read_at = COALESCE(read_at, UTC_TIMESTAMP())
         WHERE request_id = ? AND donor_user_id = ?`,
        [requestId, req.user.user_id]
      );
      if (!result.affectedRows) {
        const [notifications] = await db.execute(
          'SELECT request_id FROM donor_request_responses WHERE request_id = ? AND donor_user_id = ? LIMIT 1',
          [requestId, req.user.user_id]
        );
        if (!notifications.length) {
          return res.status(404).json({ message: 'Notification not found.' });
        }
      }
      res.json({ message: 'Notification marked as read.' });
    } catch (error) {
      console.error('Donor notification update failed:', error.code || error.message);
      res.status(500).json({ message: 'Could not update the notification.' });
    }
  });

app.post('/api/donor/emergency-requests/:requestId/response', requireDatabase, requireSession,
  rateLimit(20, 60 * 1000), async (req, res) => {
    if (req.user.role !== 'donor') {
      return res.status(403).json({ message: 'Only donor accounts can respond to emergency requests.' });
    }
    const requestId = typeof req.params.requestId === 'string' ? req.params.requestId : '';
    const response = req.body?.response;
    const shareContact = req.body?.share_contact;
    if (!/^[1-9]\d{0,19}$/.test(requestId) ||
        !['can_help', 'cannot_help'].includes(response) ||
        typeof shareContact !== 'boolean') {
      return res.status(400).json({ message: 'Choose a valid request response.' });
    }
    try {
      const [result] = await db.execute(
        `UPDATE donor_request_responses dr
         JOIN blood_requests r ON r.request_id = dr.request_id
         JOIN donors d ON d.user_id = dr.donor_user_id
         SET dr.response = ?, dr.responded_at = UTC_TIMESTAMP(),
             dr.read_at = COALESCE(dr.read_at, UTC_TIMESTAMP()),
             dr.contact_sharing_consent = ?
         WHERE dr.request_id = ? AND dr.donor_user_id = ?
           AND dr.response = 'pending'
           AND dr.response_deadline > UTC_TIMESTAMP()
           AND r.status NOT IN ('Fulfilled', 'Cancelled')
           AND (? = 'cannot_help' OR (
             d.available = 1
             AND d.last_confirmed_at IS NOT NULL
             AND d.emergency_response_consent = 1
             AND d.availability_expires_at > UTC_TIMESTAMP()
           ))`,
        [response, response === 'can_help' && shareContact ? 1 : 0,
          requestId, req.user.user_id, response]
      );
      if (!result.affectedRows) {
        const [matches] = await db.execute(
          `SELECT dr.response, dr.response_deadline <= UTC_TIMESTAMP() AS expired,
                  r.status, d.availability_status, d.available, d.last_confirmed_at,
                  d.emergency_response_consent,
                  d.availability_expires_at > UTC_TIMESTAMP() AS confirmation_current
           FROM donor_request_responses dr
           JOIN blood_requests r ON r.request_id = dr.request_id
           JOIN donors d ON d.user_id = dr.donor_user_id
           WHERE dr.request_id = ? AND dr.donor_user_id = ?
           LIMIT 1`,
          [requestId, req.user.user_id]
        );
        if (!matches.length) {
          return res.status(404).json({ message: 'Matched request not found.' });
        }
        if (matches[0].expired) {
          return res.status(409).json({ message: 'The response period has ended.' });
        }
        if (response === 'can_help' &&
            (matches[0].available !== 1 ||
             !matches[0].last_confirmed_at ||
             matches[0].emergency_response_consent !== 1 ||
             matches[0].confirmation_current !== 1)) {
          return res.status(409).json({ message: 'Confirm current availability and keep emergency matching enabled before responding Available.' });
        }
        return res.status(409).json({ message: 'You have already responded, or this request is no longer active.' });
      }
      res.json({
        message: response === 'can_help'
          ? 'Your response was saved. The patient must still coordinate with the hospital.'
          : 'Your response was saved.',
        response_status: response === 'can_help' ? 'Accepted' : 'Declined',
        contact_shared: response === 'can_help' && shareContact
      });
    } catch (error) {
      console.error('Emergency request response failed:', error.code || error.message);
      res.status(500).json({ message: 'Could not save your emergency request response.' });
    }
  });

app.get('/api/my-emergency-responses', requireDatabase, requireSession, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT CAST(r.request_id AS CHAR) AS request_id,
              r.blood_group, r.units, r.urgency, r.city, r.district,
              DATE_FORMAT(r.needed_at, '%Y-%m-%dT%H:%i:%sZ') AS needed_at,
              DATE_FORMAT(r.created_at, '%Y-%m-%dT%H:%i:%sZ') AS requested_at,
              r.status AS request_status, dr.response,
              CASE WHEN r.status IN ('Fulfilled', 'Cancelled') THEN 'Request Closed'
                   WHEN dr.response = 'pending' AND dr.response_deadline <= UTC_TIMESTAMP()
                     OR dr.response IS NULL THEN 'Expired'
                   WHEN dr.response = 'pending' THEN 'Pending'
                   WHEN dr.response = 'can_help' THEN 'Accepted'
                   ELSE 'Declined' END AS response_status,
              CASE
                WHEN dr.donor_user_id IS NULL OR d.emergency_response_consent = 0 THEN NULL
                WHEN d.available = 1 AND d.last_confirmed_at IS NOT NULL
                     AND d.availability_expires_at > UTC_TIMESTAMP() THEN 'Available'
                WHEN d.last_confirmed_at IS NULL THEN 'Unconfirmed'
                WHEN d.available = 0 AND d.availability_status = 'not_available' THEN 'Not Available'
                ELSE 'Unconfirmed'
              END AS donor_availability_status,
              CASE WHEN d.emergency_response_consent = 1
                   THEN DATE_FORMAT(d.last_confirmed_at, '%Y-%m-%dT%H:%i:%sZ')
                   ELSE NULL END AS donor_last_confirmed_at,
              CASE WHEN dr.response = 'can_help' AND dr.contact_sharing_consent = 1
                   THEN matched_user.full_name ELSE NULL END AS consenting_donor_name,
              CASE WHEN dr.response = 'can_help' AND dr.contact_sharing_consent = 1
                   THEN matched_user.phone ELSE NULL END AS consenting_donor_phone
       FROM blood_requests r
       LEFT JOIN donor_request_responses dr ON dr.request_id = r.request_id
       LEFT JOIN donors d ON d.user_id = dr.donor_user_id
       LEFT JOIN users matched_user ON matched_user.user_id = dr.donor_user_id
       WHERE r.user_id = ? AND r.urgency = 'Urgent'
       ORDER BY r.created_at DESC, dr.matched_at DESC
       LIMIT 500`,
      [req.user.user_id]
    );
    const requestMap = new Map();
    for (const row of rows) {
      if (!requestMap.has(row.request_id)) {
        requestMap.set(row.request_id, {
          request_id: row.request_id,
          blood_group: row.blood_group,
          units: Number(row.units),
          urgency: row.urgency,
          city: row.city,
          district: row.district,
          needed_at: row.needed_at,
          requested_at: row.requested_at,
          request_status: row.request_status,
          status: 'No Response',
          counts: { can_help: 0, cannot_help: 0, pending: 0, no_response: 0 },
          donor_responses: []
        });
      }
      const request = requestMap.get(row.request_id);
      if (row.response === 'can_help') request.counts.can_help += 1;
      if (row.response === 'cannot_help') request.counts.cannot_help += 1;
      if (row.response === 'pending' && row.response_status === 'Pending') {
        request.counts.pending += 1;
      }
      if (!row.response || row.response_status === 'Expired') request.counts.no_response += 1;
      if (row.response) {
        request.donor_responses.push({
          status: row.response_status,
          availability_status: row.donor_availability_status,
          last_confirmed_at: row.donor_last_confirmed_at,
          donor_name: row.consenting_donor_name,
          donor_phone: row.consenting_donor_phone
        });
      }
    }
    const requests = [...requestMap.values()].map(request => {
      if (['Fulfilled', 'Cancelled'].includes(request.request_status)) {
        request.status = 'Request Closed';
      } else if (request.counts.can_help) {
        request.status = 'Accepted';
      } else if (request.counts.pending) {
        request.status = 'Pending';
      } else if (request.counts.cannot_help) {
        request.status = 'Declined';
      } else if (request.donor_responses.length) {
        request.status = 'Expired';
      } else {
        request.status = 'Pending';
      }
      return request;
    });
    res.json({ requests });
  } catch (error) {
    console.error('Emergency response summary lookup failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not load responses to your requests.' });
  }
});

app.patch('/api/blood-requests/:requestId/status', requireDatabase, requireSession, rateLimit(30, 60 * 1000), async (req, res) => {
  const requestId = typeof req.params.requestId === 'string' ? req.params.requestId : '';
  const status = typeof req.body?.status === 'string' ? req.body.status : '';
  if (!/^[1-9]\d{0,19}$/.test(requestId) || !REQUEST_STATUSES.has(status)) {
    return res.status(400).json({ message: 'Choose a valid request and status.' });
  }

  try {
    const [result] = await db.execute(
      'UPDATE blood_requests SET status = ? WHERE request_id = ? AND user_id = ?',
      [status, requestId, req.user.user_id]
    );
    if (!result.affectedRows) {
      const [ownedRequests] = await db.execute(
        'SELECT request_id FROM blood_requests WHERE request_id = ? AND user_id = ? LIMIT 1',
        [requestId, req.user.user_id]
      );
      if (!ownedRequests.length) {
        return res.status(404).json({ message: 'Request not found or you do not have permission to update it.' });
      }
    }
    res.json({ message: 'Request status updated.', request_id: requestId, status });
  } catch (error) {
    console.error('Blood-request status update failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not update the blood-request status.' });
  }
});

async function getBloodStockMaster() {
  if (bloodStockMasterCache && Date.now() - bloodStockMasterFetchedAt < 60 * 60 * 1000) {
    return bloodStockMasterCache;
  }

  const response = await fetch(`${BLOOD_STOCK_API}/master/all`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hospitalCode: 100 }),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) {
    throw new Error(`Blood-stock source returned HTTP ${response.status}.`);
  }

  const data = await response.json();
  if (!Array.isArray(data.statesWithDistricts) ||
      !Array.isArray(data.bloodGroups) ||
      !Array.isArray(data.componentList)) {
    throw new Error('Blood-stock source returned invalid filter data.');
  }
  bloodStockMasterCache = data;
  bloodStockMasterFetchedAt = Date.now();
  return data;
}

async function fetchBloodStockRecords({ stateCode, districtId, componentId, bloodGroupId, hospitalCode }) {
  const params = new URLSearchParams({ stateCode, componentId });
  if (districtId) params.set('districtId', districtId);
  if (bloodGroupId) params.set('bloodGroupId', bloodGroupId);
  if (hospitalCode) params.set('hospitalCodes', hospitalCode);
  const response = await fetch(`${BLOOD_STOCK_API}/blood-availability?${params}`, {
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) {
    throw new Error(`Blood-stock source returned HTTP ${response.status}.`);
  }
  const records = await response.json();
  if (!Array.isArray(records)) {
    throw new Error('Blood-stock source returned invalid stock data.');
  }
  return records;
}

function parseReportedStockGroups(stock, bloodGroups) {
  const quantities = new Map();
  function recordQuantities(value, units) {
    if (typeof value !== 'string') return;
    for (const entry of value.split(',')) {
      const match = entry.trim().match(/^(.+?)\s*:\s*(\d+)$/);
      if (match) quantities.set(match[1].trim().toLowerCase(), units === null ? Number(match[2]) : units);
    }
  }
  recordQuantities(stock?.available_WithQty, null);
  recordQuantities(stock?.not_available_WithQty, 0);
  return bloodGroups.map(group => {
    const name = group.bloodGroupName;
    const units = quantities.get(name.toLowerCase());
    return { blood_group: name, units: units ?? null };
  });
}

function getHospitalEmail(record) {
  const email = record.hospitalemail || record.hospitalEmail || record.hospital_email ||
    record.email || record.emailId || record.email_id || '';
  return typeof email === 'string' ? email.trim() : '';
}

app.get('/api/blood-stocks/filters', rateLimit(30, 60 * 1000), async (req, res) => {
  try {
    const master = await getBloodStockMaster();
    res.json({
      states: master.statesWithDistricts.map(state => ({
        code: state.stateCode,
        name: state.stateName,
        districts: state.districts.map(district => ({
          code: district.districtCode,
          name: district.districtName
        }))
      })),
      bloodGroups: master.bloodGroups.map(group => ({
        code: group.bloodGroupCode,
        name: group.bloodGroupName
      })),
      components: master.componentList.map(component => ({
        code: component.componentCode,
        name: component.componentName,
        short_name: component.componentShortName
      }))
    });
  } catch (error) {
    console.error('Blood-stock filter lookup failed:', error.message);
    res.status(503).json({ message: 'Blood-stock filters are temporarily unavailable. Please try again.' });
  }
});

app.get('/api/blood-stocks/hospitals', rateLimit(30, 60 * 1000), async (req, res) => {
  const stateCode = typeof req.query.state_code === 'string' ? req.query.state_code : '';
  const districtId = typeof req.query.district_id === 'string' ? req.query.district_id : '';
  const componentId = typeof req.query.component_id === 'string' ? req.query.component_id : '';

  try {
    const master = await getBloodStockMaster();
    const state = master.statesWithDistricts.find(item => item.stateCode === stateCode);
    const district = districtId && state
      ? state.districts.find(item => item.districtCode === districtId)
      : null;
    if (!state || (districtId && !district) ||
        !master.componentList.some(item => item.componentCode === componentId)) {
      return res.status(400).json({ message: 'Choose a valid state, district, and blood component.' });
    }

    const records = await fetchBloodStockRecords({ stateCode, districtId, componentId });
    const centres = new Map();
    for (const record of records) {
      if (!record.hospitalCode || !record.hospitalname || centres.has(String(record.hospitalCode))) continue;
      centres.set(String(record.hospitalCode), {
        code: String(record.hospitalCode),
        name: record.hospitalname,
        address: record.hospitaladd || '',
        phone: record.hospitalcontact || '',
        email: getHospitalEmail(record),
        type: record.hospitalType || record.type || ''
      });
    }
    res.json({
      state: state.stateName,
      district: district?.districtName || null,
      checked_at: new Date().toISOString(),
      hospitals: [...centres.values()].sort((left, right) => left.name.localeCompare(right.name))
    });
  } catch (error) {
    console.error('Blood-centre lookup failed:', error.message);
    res.status(503).json({ message: 'Blood-centre choices are temporarily unavailable. Please try again.' });
  }
});

app.get('/api/blood-stocks/by-hospital', rateLimit(30, 60 * 1000), async (req, res) => {
  const stateCode = typeof req.query.state_code === 'string' ? req.query.state_code : '';
  const districtId = typeof req.query.district_id === 'string' ? req.query.district_id : '';
  const componentId = typeof req.query.component_id === 'string' ? req.query.component_id : '';
  const hospitalCode = typeof req.query.hospital_code === 'string' ? req.query.hospital_code : '';

  try {
    const master = await getBloodStockMaster();
    const state = master.statesWithDistricts.find(item => item.stateCode === stateCode);
    const district = districtId && state
      ? state.districts.find(item => item.districtCode === districtId)
      : null;
    const component = master.componentList.find(item => item.componentCode === componentId);
    if (!state || (districtId && !district) || !component || !/^\d{1,20}$/.test(hospitalCode)) {
      return res.status(400).json({ message: 'Choose a valid state, district, blood component, and hospital.' });
    }

    const records = await fetchBloodStockRecords({
      stateCode,
      districtId,
      componentId,
      hospitalCode
    });
    const centres = records
      .filter(record => String(record.hospitalCode) === hospitalCode)
      .map(record => ({
        code: String(record.hospitalCode),
        name: record.hospitalname || 'Blood centre',
        address: record.hospitaladd || '',
        contact: record.hospitalcontact || '',
        phone: record.hospitalcontact || '',
        email: getHospitalEmail(record),
        type: record.hospitalType || record.type || '',
        updated_at: record.entrydate || null,
        live: record.offline === '0',
        stocks: parseReportedStockGroups(
          record.components?.[component.componentName],
          master.bloodGroups
        )
      }));
    res.json({
      state: state.stateName,
      district: district?.districtName || null,
      component: component.componentName,
      checked_at: new Date().toISOString(),
      centres
    });
  } catch (error) {
    console.error('Hospital blood-stock search failed:', error.message);
    res.status(503).json({ message: 'Current hospital blood-stock data is temporarily unavailable. Please try again.' });
  }
});

app.get('/api/blood-stocks', rateLimit(30, 60 * 1000), async (req, res) => {
  const stateCode = typeof req.query.state_code === 'string' ? req.query.state_code : '';
  const districtId = typeof req.query.district_id === 'string' ? req.query.district_id : '';
  const componentId = typeof req.query.component_id === 'string' ? req.query.component_id : '';
  const bloodGroupId = typeof req.query.blood_group_id === 'string' ? req.query.blood_group_id : '';

  try {
    const master = await getBloodStockMaster();
    const state = master.statesWithDistricts.find(item => item.stateCode === stateCode);
    const district = districtId && state
      ? state.districts.find(item => item.districtCode === districtId)
      : null;
    if (!state || (districtId && !district) ||
        !master.componentList.some(item => item.componentCode === componentId) ||
        (bloodGroupId && !master.bloodGroups.some(item => item.bloodGroupCode === bloodGroupId))) {
      return res.status(400).json({ message: 'Choose valid blood-stock search filters.' });
    }

    const records = await fetchBloodStockRecords({ stateCode, districtId, componentId, bloodGroupId });
    const component = master.componentList.find(item => item.componentCode === componentId);
    const bloodGroup = bloodGroupId
      ? master.bloodGroups.find(item => item.bloodGroupCode === bloodGroupId)
      : null;
    const selectedBloodGroupName = bloodGroup?.bloodGroupName;
    const bloodCentres = records.map(record => {
      const componentStock = record.components?.[component.componentName];
      const stocks = typeof componentStock?.available_WithQty === 'string'
        ? componentStock.available_WithQty.split(',').map(entry => {
          const match = entry.trim().match(/^(.+?)\s*:\s*(\d+)$/);
          return match ? { blood_group: match[1], units: Number(match[2]) } : null;
        }).filter(stock => stock && stock.units > 0)
        : [];
      return {
        name: record.hospitalname || 'Blood centre',
        address: record.hospitaladd || '',
        contact: record.hospitalcontact || '',
        type: record.hospitalType || record.type || '',
        updated_at: record.entrydate || null,
        live: record.offline === '0',
        stocks: selectedBloodGroupName
          ? stocks.filter(stock => stock.blood_group.toLowerCase() === selectedBloodGroupName.toLowerCase())
          : stocks
      };
    }).filter(centre => centre.stocks.length > 0);

    res.json({
      state: state.stateName,
      district: district?.districtName || null,
      component: component.componentName,
      checked_at: new Date().toISOString(),
      centres: bloodCentres
    });
  } catch (error) {
    console.error('Blood-stock search failed:', error.message);
    res.status(503).json({ message: 'Current blood-stock data is temporarily unavailable. Please try again.' });
  }
});

app.post('/api/register', rateLimit(5, 15 * 60 * 1000), requireDatabase, async (req, res) => {
  const {
    full_name: fullName,
    email: submittedEmail,
    username: submittedUsername,
    password,
    role,
    age,
    gender,
    blood_group: submittedBloodGroup,
    phone,
    city,
    place,
    last_donation_date: lastDonationDate,
    is_available: isAvailable,
    public_contact_consent: publicContactConsent,
    hospital_name: submittedHospitalName,
    units_required: submittedUnitsRequired,
    urgency: submittedUrgency,
    consent,
    state
  } = req.body || {};
  const email = typeof submittedEmail === 'string' ? submittedEmail.trim().toLowerCase() : '';
  const username = typeof submittedUsername === 'string' ? submittedUsername.trim().toLowerCase() : '';
  const bloodGroup = normalizeBloodGroup(submittedBloodGroup);
  const normalizedPhone = typeof phone === 'string' ? phone.trim() : '';
  const phoneDigits = normalizedPhone.replace(/\D/g, '');
  const hospitalName = typeof submittedHospitalName === 'string' ? submittedHospitalName.trim() : '';
  const urgency = typeof submittedUrgency === 'string' ? submittedUrgency : '';

  if (
    !isNonEmptyString(fullName, 100) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    email.length > 150 ||
    !/^[a-z0-9._-]{3,32}$/.test(username) ||
    typeof password !== 'string' ||
    password.length < 8 ||
    password.length > 128 ||
    !['donor', 'patient'].includes(role) ||
    !Number.isInteger(age) ||
    age < 1 ||
    age > 120 ||
    !GENDERS.has(gender) ||
    !BLOOD_GROUPS.has(bloodGroup) ||
    !PHONE_PATTERN.test(normalizedPhone) ||
    phoneDigits.length < 7 ||
    !isNonEmptyString(city, 80) ||
    !isNonEmptyString(state, 80) ||
    !isNonEmptyString(place, 100) ||
    (role === 'patient' &&
      (!isNonEmptyString(hospitalName, 150) ||
       !Number.isInteger(submittedUnitsRequired) || submittedUnitsRequired < 1 || submittedUnitsRequired > 20 ||
       !REQUEST_URGENCIES.has(urgency))) ||
    (lastDonationDate !== null && lastDonationDate !== '' &&
      (!isValidDateOnly(lastDonationDate) || lastDonationDate > new Date().toISOString().slice(0, 10))) ||
    typeof isAvailable !== 'boolean' ||
    typeof publicContactConsent !== 'boolean' ||
    consent !== true
  ) {
    return res.status(400).json({ message: 'Check the account details, password, donor availability, and consent.' });
  }

  let connection;
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    connection = await db.getConnection();
    await connection.beginTransaction();
    const [userResult] = await connection.execute(
      `INSERT INTO users
       (full_name, email, username, password_hash, role, age, gender, blood_group, phone, city, state, place)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [fullName.trim(), email, username, passwordHash, role, age, gender, bloodGroup, normalizedPhone, city.trim(), state.trim(), place.trim()]
    );
    if (role === 'donor') {
      const availabilityExpiresAt = isAvailable
        ? new Date(Math.ceil(Date.now() / 1000) * 1000 + AVAILABILITY_HOURS * 60 * 60 * 1000)
        : null;
      await connection.execute(
        `INSERT INTO donors
         (user_id, full_name, age, gender, blood_group, phone, city, state, place,
          last_donation_date, available, public_contact_consent, availability_expires_at,
          availability_status, last_confirmed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          userResult.insertId,
          fullName.trim(),
          age,
          gender,
          bloodGroup,
          normalizedPhone,
          city.trim(),
          state.trim(),
          place.trim(),
          lastDonationDate || null,
          isAvailable ? 1 : 0,
          publicContactConsent ? 1 : 0,
          availabilityExpiresAt,
          isAvailable ? 'available' : 'not_available',
          isAvailable ? new Date() : null
        ]
      );
    }
    if (role === 'patient') {
      await connection.execute(
        `INSERT INTO patients
         (user_id, patient_name, age, gender, blood_group, hospital_name, city, area,
          contact_number, units_required, urgency, request_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          userResult.insertId,
          fullName.trim(),
          age,
          gender,
          bloodGroup,
          hospitalName,
          city.trim(),
          place.trim(),
          normalizedPhone,
          submittedUnitsRequired,
          urgency,
          'Pending'
        ]
      );
    }
    await connection.commit();
    clearSessionCookie(res);
    clearAdminSessionCookie(res);
    res.status(201).json({
      message: role === 'patient'
        ? 'Account and blood request created. Please log in.'
        : 'Account created. Please log in.'
    });
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'An account with this email or username already exists.' });
    }
    console.error('Account registration failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not create the account.' });
  } finally {
    if (connection) connection.release();
  }
});

app.post('/api/login', rateLimit(10, 15 * 60 * 1000), requireDatabase, async (req, res) => {
  const identifier = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
  const password = req.body?.password;
  if (!identifier || identifier.length > 150 ||
      typeof password !== 'string' || !password || password.length > 128) {
    return res.status(400).json({ message: 'Enter your username and password.' });
  }

  try {
    const [users] = await db.execute(
      `SELECT user_id, username, full_name, email, password_hash, role, city, state
       FROM users
       WHERE username = ? OR (username IS NULL AND email = ?)
       LIMIT 1`,
      [identifier, identifier]
    );
    const user = users[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ message: 'Username or password is incorrect.' });
    }
    clearAdminSessionCookie(res);
    setSessionCookie(res, user.user_id);
    res.json({
      message: 'Login successful.',
      user: {
        user_id: user.user_id,
        username: user.username,
        full_name: user.full_name,
        email: user.email,
        role: user.role,
        city: user.city,
        state: user.state
      }
    });
  } catch (error) {
    console.error('Login failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not log in. Please try again.' });
  }
});

app.post('/api/admin/login', rateLimit(8, 15 * 60 * 1000), requireDatabase, requireAdminConfigured, async (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = req.body?.password;
  if (!username || username.length > 80 || typeof password !== 'string' || !password || password.length > 128) {
    return res.status(400).json({ message: 'Enter a valid admin username and password.' });
  }

  try {
    const [admins] = await db.execute(
      'SELECT admin_id, username, password_hash FROM admin_users WHERE admin_id = 1 AND username = ? LIMIT 1',
      [username]
    );
    const admin = admins[0];
    const passwordMatches = admin && (
      await bcrypt.compare(password, admin.password_hash) ||
      (password.trim() !== password && await bcrypt.compare(password.trim(), admin.password_hash))
    );
    if (!passwordMatches) {
      return res.status(401).json({ message: 'Admin username or password is incorrect.' });
    }
    clearSessionCookie(res);
    setAdminSessionCookie(res, admin.admin_id);
    res.json({ message: 'Admin login successful.', admin: { username: admin.username } });
  } catch (error) {
    console.error('Admin login failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not log in as admin. Please try again.' });
  }
});

app.get('/api/admin/session', requireDatabase, requireAdminConfigured, requireAdmin, (req, res) => {
  res.json({ admin: { username: req.admin.username } });
});

app.post('/api/admin/logout', (req, res) => {
  clearAdminSessionCookie(res);
  res.json({ message: 'Admin logged out successfully.' });
});

app.get('/api/admin/dashboard', requireDatabase, requireAdminConfigured, requireAdmin, async (req, res) => {
  try {
    const [[countRows], [donors], [patients], [patientRequests], [bloodRequests]] = await Promise.all([
      db.execute(
        `SELECT
           (SELECT COUNT(*) FROM users WHERE role IN ('donor', 'patient')) AS total_registrations,
           (SELECT COUNT(*) FROM users WHERE role = 'donor') AS donor_count,
           (SELECT COUNT(*) FROM users WHERE role = 'patient') AS patient_count,
           ((SELECT COUNT(*) FROM patients) + (SELECT COUNT(*) FROM blood_requests)) AS patient_request_count`
      ),
      db.execute(
        `SELECT u.user_id, u.username, u.full_name, u.email, u.age, u.gender, u.blood_group,
                u.phone, u.city, u.state, u.place,
                DATE_FORMAT(u.created_at, '%Y-%m-%dT%H:%i:%sZ') AS registered_at,
                d.last_donation_date,
                CASE
                  WHEN d.available = 1 AND d.last_confirmed_at IS NOT NULL
                       AND d.availability_expires_at > UTC_TIMESTAMP() THEN 'Available'
                  WHEN d.user_id IS NULL OR d.last_confirmed_at IS NULL THEN 'Unconfirmed'
                  WHEN d.available = 0 AND d.availability_status = 'not_available' THEN 'Not Available'
                  ELSE 'Unconfirmed'
                END AS availability_status,
                DATE_FORMAT(d.last_confirmed_at, '%Y-%m-%dT%H:%i:%sZ') AS last_confirmed_at,
                DATE_FORMAT(d.availability_expires_at, '%Y-%m-%dT%H:%i:%sZ') AS available_until
         FROM users u
         LEFT JOIN donors d ON d.user_id = u.user_id
         WHERE u.role = 'donor'
         ORDER BY u.created_at DESC, u.user_id DESC`
      ),
      db.execute(
        `SELECT u.user_id, u.username, u.full_name, u.email, u.age, u.gender,
                COALESCE(p.blood_group, u.blood_group) AS blood_group,
                u.phone, COALESCE(NULLIF(p.city, ''), u.city) AS city, u.state,
                COALESCE(NULLIF(p.area, ''), u.place) AS area, u.place,
                DATE_FORMAT(u.created_at, '%Y-%m-%dT%H:%i:%sZ') AS registered_at,
                p.patient_id AS request_id, p.hospital_name, p.units_required,
                p.urgency, p.request_status,
                DATE_FORMAT(p.request_date, '%Y-%m-%dT%H:%i:%sZ') AS request_date
         FROM users u
         LEFT JOIN patients p ON p.user_id = u.user_id
         WHERE u.role = 'patient'
         ORDER BY u.created_at DESC, u.user_id DESC`
      ),
      db.execute(
        `SELECT patient_id AS request_id, patient_name, age, gender, blood_group,
                hospital_name, city, area, contact_number, units_required,
                urgency, request_status,
                DATE_FORMAT(request_date, '%Y-%m-%dT%H:%i:%sZ') AS request_date
         FROM patients
         ORDER BY request_date DESC, patient_id DESC`
      ),
      db.execute(
        `SELECT CAST(request_id AS CHAR) AS request_id,
                patient_reference AS patient_name, NULL AS age, NULL AS gender,
                blood_group, hospital_details AS hospital_name, city,
                district AS area, contact_phone AS contact_number, contact_name,
                units AS units_required, urgency, status AS request_status,
                DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%sZ') AS request_date,
                DATE_FORMAT(needed_at, '%Y-%m-%dT%H:%i:%sZ') AS needed_at
         FROM blood_requests
         ORDER BY created_at DESC, request_id DESC`
      )
    ]);
    const counts = countRows[0];
    res.json({
      counts: {
        total_registrations: Number(counts.total_registrations),
        donor_count: Number(counts.donor_count),
        patient_count: Number(counts.patient_count),
        patient_request_count: Number(counts.patient_request_count)
      },
      donors,
      patients,
      patient_requests: patientRequests,
      blood_requests: bloodRequests,
      refreshed_at: new Date().toISOString()
    });
  } catch (error) {
    console.error('Admin dashboard lookup failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not load registrations from MySQL.' });
  }
});

app.get('/api/me', requireDatabase, async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) return res.json({ user: null });
  try {
    const [users] = await db.execute(
      'SELECT user_id, username, full_name, email, role, city, state FROM users WHERE user_id = ? LIMIT 1',
      [userId]
    );
    if (!users.length) {
      clearSessionCookie(res);
      return res.json({ user: null });
    }
    res.json({ user: users[0] });
  } catch (error) {
    console.error('Session lookup failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not verify your login session.' });
  }
});

app.post('/api/logout', (req, res) => {
  clearSessionCookie(res);
  clearAdminSessionCookie(res);
  res.json({ message: 'Logged out successfully.' });
});

app.get('/api/availability/status', requireDatabase, requireSession, async (req, res) => {
  if (req.user.role !== 'donor') {
    return res.status(403).json({ message: 'Only donor accounts can manage donor availability.' });
  }
  try {
    const [donors] = await db.execute(
      `SELECT availability_status, available, public_contact_consent,
              emergency_response_consent,
              availability_expires_at > UTC_TIMESTAMP() AS confirmation_current,
              DATE_FORMAT(availability_expires_at, '%Y-%m-%dT%H:%i:%sZ') AS available_until,
              DATE_FORMAT(last_confirmed_at, '%Y-%m-%dT%H:%i:%sZ') AS last_confirmed_at
       FROM donors
       WHERE user_id = ?
       LIMIT 1`,
      [req.user.user_id]
    );
    if (!donors.length) {
      return res.status(404).json({ message: 'No donor profile is linked to this account.' });
    }
    const active = donors[0].available === 1 &&
      donors[0].confirmation_current === 1 &&
      Boolean(donors[0].last_confirmed_at);
    const status = active
      ? 'Available'
      : donors[0].last_confirmed_at &&
        donors[0].available === 0 &&
        donors[0].availability_status === 'not_available'
        ? 'Not Available'
        : 'Unconfirmed';
    res.json({
      status,
      availability_status: donors[0].availability_status,
      is_available: Boolean(active),
      available_until: donors[0].available_until,
      last_confirmed_at: donors[0].last_confirmed_at,
      public_contact_consent: donors[0].public_contact_consent === 1,
      emergency_response_consent: donors[0].emergency_response_consent === 1
    });
  } catch (error) {
    console.error('Donor availability status lookup failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not check your donor availability status.' });
  }
});

app.post('/api/availability/status', requireDatabase, requireSession, rateLimit(10, 15 * 60 * 1000), async (req, res) => {
  if (req.user.role !== 'donor') {
    return res.status(403).json({ message: 'Only donor accounts can manage donor availability.' });
  }
  const { status, public_contact_consent: publicContactConsent,
    emergency_response_consent: emergencyResponseConsent,
    expires_in_hours: expiresInHours = AVAILABILITY_HOURS } = req.body || {};
  if (!['available', 'not_available'].includes(status) ||
      typeof publicContactConsent !== 'boolean' ||
      typeof emergencyResponseConsent !== 'boolean' ||
      !AVAILABILITY_DURATIONS_HOURS.includes(expiresInHours)) {
    return res.status(400).json({ message: 'Choose a valid status, a 4-, 12-, or 24-hour duration, and confirm your privacy choices.' });
  }

  try {
    const isAvailable = status === 'available';
    const availableUntil = isAvailable
      ? new Date(Math.ceil(Date.now() / 1000) * 1000 + expiresInHours * 60 * 60 * 1000)
      : null;
    await db.execute(
      `UPDATE donors
       SET availability_status = ?, available = ?, public_contact_consent = ?,
           emergency_response_consent = ?, availability_expires_at = ?,
           last_confirmed_at = UTC_TIMESTAMP()
       WHERE user_id = ?`,
      [status, isAvailable ? 1 : 0, isAvailable && publicContactConsent ? 1 : 0,
        isAvailable && emergencyResponseConsent ? 1 : 0, availableUntil, req.user.user_id]
    );
    const [donors] = await db.execute(
      `SELECT availability_status, available, public_contact_consent,
              emergency_response_consent,
              DATE_FORMAT(availability_expires_at, '%Y-%m-%dT%H:%i:%sZ') AS available_until,
              DATE_FORMAT(last_confirmed_at, '%Y-%m-%dT%H:%i:%sZ') AS last_confirmed_at
       FROM donors
       WHERE user_id = ?
       LIMIT 1`,
      [req.user.user_id]
    );
    if (!donors.length) {
      return res.status(404).json({ message: 'No donor profile is linked to this account.' });
    }
    const updatedDonor = donors[0];
    res.json({
      status: isAvailable ? 'Available' : 'Not Available',
      availability_status: updatedDonor.availability_status,
      is_available: updatedDonor.available === 1,
      available_until: updatedDonor.available_until,
      last_confirmed_at: updatedDonor.last_confirmed_at,
      public_contact_consent: updatedDonor.public_contact_consent === 1,
      emergency_response_consent: updatedDonor.emergency_response_consent === 1
    });
  } catch (error) {
    console.error('Donor availability status update failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not update your donor availability.' });
  }
});

app.get('/api/availability/count', requireDatabase, requireSession, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT COUNT(*) AS available_count
       FROM donors
       WHERE available = 1
         AND public_contact_consent = 1
         AND last_confirmed_at IS NOT NULL
         AND availability_expires_at > UTC_TIMESTAMP()`
    );
    res.json({ available_count: Number(rows[0].available_count), checked_at: new Date().toISOString() });
  } catch (error) {
    console.error('Availability count failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not check current donor availability.' });
  }
});

app.get('/api/donors/search', requireDatabase, requireSession, rateLimit(30, 60 * 1000), async (req, res) => {
  if (req.user.role !== 'patient') {
    return res.status(403).json({ message: 'Patient accounts can search for available donors.' });
  }
  const city = typeof req.query.city === 'string' ? req.query.city.trim() : '';
  const state = typeof req.query.state === 'string' ? req.query.state.trim() : '';
  const bloodGroup = normalizeBloodGroup(req.query.blood_group || '');
  const radius = typeof req.query.radius_km === 'string' ? req.query.radius_km : '25';
  const units = req.query.units === undefined ? null : Number(req.query.units);
  const emergency = req.query.emergency === 'true';
  const allowedRadii = new Set(['5', '10', '25', '50', 'wider']);
  if (!isNonEmptyString(city, 80) ||
      !isNonEmptyString(state, 80) ||
      state.toLowerCase() !== 'karnataka' ||
      !BLOOD_GROUPS.has(bloodGroup) ||
      !allowedRadii.has(radius) ||
      (units !== null && (!Number.isInteger(units) || units < 1 || units > 20)) ||
      (req.query.emergency !== undefined && !['true', 'false'].includes(req.query.emergency))) {
    return res.status(400).json({ message: 'Choose Karnataka, a city, valid blood group, search area and required units.' });
  }

  try {
    await db.execute(
      `UPDATE donors
       SET available = 0
       WHERE available = 1 AND availability_expires_at IS NOT NULL
         AND availability_expires_at <= UTC_TIMESTAMP()`
    );
    const locationFilter = radius === 'wider'
      ? 'LOWER(d.state) = LOWER(?)'
      : 'LOWER(d.city) = LOWER(?) AND LOWER(d.state) = LOWER(?)';
    const locationValues = radius === 'wider' ? [state] : [city, state];
    const [donors] = await db.execute(
      `SELECT 'Available donor' AS display_name, d.blood_group, d.city, d.state,
              d.emergency_response_consent = 1 AS emergency_matching_enabled,
              'Available' AS availability_status,
              DATE_FORMAT(d.last_confirmed_at, '%Y-%m-%dT%H:%i:%sZ') AS last_confirmed_at,
              DATE_FORMAT(d.availability_expires_at, '%Y-%m-%dT%H:%i:%sZ') AS available_until
       FROM donors d
       JOIN users u ON u.user_id = d.user_id AND u.role = 'donor'
       WHERE d.available = 1
         AND d.public_contact_consent = 1
         AND d.last_confirmed_at IS NOT NULL
         AND d.availability_expires_at > UTC_TIMESTAMP()
         AND d.blood_group = ?
         AND ${locationFilter}
       ORDER BY CASE WHEN ? = 1 THEN d.emergency_response_consent ELSE 0 END DESC,
                d.last_confirmed_at DESC
       LIMIT 50`,
      [bloodGroup, ...locationValues, emergency ? 1 : 0]
    );
    res.json({
      donors,
      checked_at: new Date().toISOString(),
      search_area: radius === 'wider' ? 'Karnataka (wider search)' : `${city}, ${state}`,
      radius_km: radius === 'wider' ? null : Number(radius),
      location_precision: 'Approximate city-level match; donor coordinates are not stored.',
      distance_available: false,
      emergency_priority: emergency,
      units_requested: units
    });
  } catch (error) {
    console.error('Patient donor search failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not search current donor availability.' });
  }
});

app.get('/api/availability', requireDatabase, requireSession, rateLimit(30, 60 * 1000), async (req, res) => {
  const city = typeof req.query.city === 'string' ? req.query.city.trim() : '';
  const state = typeof req.query.state === 'string' ? req.query.state.trim() : '';
  if (req.query.blood_group !== undefined && typeof req.query.blood_group !== 'string') {
    return res.status(400).json({ message: 'Select a valid blood group.' });
  }
  const bloodGroup = normalizeBloodGroup(req.query.blood_group || '');
  if (
    !isNonEmptyString(city, 80) ||
    city.length < 2 ||
    !isNonEmptyString(state, 80) ||
    (bloodGroup && !BLOOD_GROUPS.has(bloodGroup))
  ) {
    return res.status(400).json({ message: 'Enter a city and state, and select a valid blood group.' });
  }

  try {
    await db.execute(
      `UPDATE donors
       SET available = 0
       WHERE available = 1 AND availability_expires_at IS NOT NULL
         AND availability_expires_at <= UTC_TIMESTAMP()`
    );
    const filters = [
      'available = 1',
      'public_contact_consent = 1',
      'last_confirmed_at IS NOT NULL',
      'availability_expires_at > UTC_TIMESTAMP()',
      'LOWER(city) = LOWER(?)',
      'LOWER(state) = LOWER(?)'
    ];
    const values = [city, state];
    if (bloodGroup) {
      filters.push('blood_group = ?');
      values.push(bloodGroup);
    }
    const [donors] = await db.execute(
      `SELECT 'Available donor' AS name, blood_group, city, state,
              DATE_FORMAT(last_confirmed_at, '%Y-%m-%dT%H:%i:%sZ') AS last_confirmed_at,
              DATE_FORMAT(availability_expires_at, '%Y-%m-%dT%H:%i:%sZ') AS available_until
       FROM donors
       WHERE ${filters.join(' AND ')}
       ORDER BY availability_expires_at DESC
       LIMIT 25`,
      values
    );
    res.json({ donors, checked_at: new Date().toISOString() });
  } catch (error) {
    console.error('Live availability search failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not search live donor availability.' });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const server = app.listen(PORT, async () => {
  console.log(`LifeDrop backend running at http://localhost:${PORT}`);
  try {
    await initializeDatabase();
    console.log('MySQL database connected and donor availability table is ready.');
  } catch (error) {
    console.error('Database initialization failed:', error.code || error.message);
  }
});

function shutdown() {
  server.close(() => {
    db.end().catch(error => {
      console.error('Database shutdown failed:', error.code || error.message);
      process.exitCode = 1;
    });
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
