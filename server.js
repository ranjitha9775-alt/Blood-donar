require('dotenv').config();

const express = require('express');
const mysql = require('mysql2/promise');
const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const AVAILABILITY_HOURS = 24;
const SESSION_TTL_SECONDS = 60 * 60 * 12;
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
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${createSessionToken(userId)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_SECONDS}${secure}`
  );
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`
  );
}

async function requireSession(req, res, next) {
  const userId = getSessionUserId(req);
  if (!userId) return res.status(401).json({ message: 'Log in to check live donor availability.' });
  try {
    const [users] = await db.execute(
      'SELECT user_id, full_name, email, role, city, state FROM users WHERE user_id = ? LIMIT 1',
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
    `CREATE TABLE IF NOT EXISTS users (
      user_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      full_name VARCHAR(100) NOT NULL,
      email VARCHAR(150) NOT NULL,
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
  await db.query(
    `CREATE TABLE IF NOT EXISTS patients (
      patient_id INT NOT NULL AUTO_INCREMENT,
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
    ['area', "ALTER TABLE patients ADD COLUMN area VARCHAR(100) NOT NULL DEFAULT '' AFTER city"],
    ['request_status', "ALTER TABLE patients ADD COLUMN request_status VARCHAR(32) NOT NULL DEFAULT 'Pending' AFTER urgency"]
  ];
  for (const [columnName, statement] of patientMigrations) {
    if (!patientColumnNames.has(columnName)) await db.query(statement);
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
    ['user_id', 'ALTER TABLE donors ADD COLUMN user_id BIGINT UNSIGNED NULL AFTER id']
  ];
  for (const [columnName, statement] of migrations) {
    if (!columnNames.has(columnName)) await db.query(statement);
  }
  const [userColumns] = await db.query('SHOW COLUMNS FROM users');
  if (!userColumns.some(column => column.Field === 'state')) {
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
  const patientReference = typeof req.body?.patient === 'string' ? req.body.patient.trim() : '';
  const bloodGroup = normalizeBloodGroup(req.body?.blood);
  const units = req.body?.units;
  const urgency = typeof req.body?.urgency === 'string' ? req.body.urgency : '';
  const hospitalDetails = typeof req.body?.hospital === 'string' ? req.body.hospital.trim() : '';
  const city = typeof req.body?.city === 'string' ? req.body.city.trim() : '';
  const district = typeof req.body?.district === 'string' ? req.body.district.trim() : '';
  const contactName = typeof req.body?.contact_name === 'string' ? req.body.contact_name.trim() : '';
  const contactPhone = typeof req.body?.contact_phone === 'string' ? req.body.contact_phone.trim() : '';
  const neededAt = typeof req.body?.needed_at === 'string' ? req.body.needed_at : '';
  const neededAtTimestamp = Date.parse(neededAt);
  const phoneDigits = contactPhone.replace(/\D/g, '');

  if (!isNonEmptyString(patientReference, 100) ||
      !BLOOD_GROUPS.has(bloodGroup) ||
      !Number.isInteger(units) || units < 1 || units > 20 ||
      !REQUEST_URGENCIES.has(urgency) ||
      !isNonEmptyString(hospitalDetails, 180) ||
      !isNonEmptyString(city, 80) ||
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

  try {
    const sqlNeededAt = new Date(neededAtTimestamp).toISOString().slice(0, 19).replace('T', ' ');
    const [result] = await db.execute(
      `INSERT INTO blood_requests
         (user_id, patient_reference, blood_group, units, urgency, hospital_details,
          city, district, contact_name, contact_phone, needed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.user_id,
        patientReference,
        bloodGroup,
        units,
        urgency,
        hospitalDetails,
        city,
        district,
        contactName,
        contactPhone,
        sqlNeededAt
      ]
    );
    res.status(201).json({
      message: 'Blood request saved. Its status is self-reported and has not been independently verified.',
      request_id: String(result.insertId),
      status: 'Pending Verification'
    });
  } catch (error) {
    console.error('Blood-request creation failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not save the blood request.' });
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
        name: record.hospitalname || 'Blood centre',
        address: record.hospitaladd || '',
        contact: record.hospitalcontact || '',
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
  const bloodGroup = normalizeBloodGroup(submittedBloodGroup);
  const normalizedPhone = typeof phone === 'string' ? phone.trim() : '';
  const phoneDigits = normalizedPhone.replace(/\D/g, '');
  const hospitalName = typeof submittedHospitalName === 'string' ? submittedHospitalName.trim() : '';
  const urgency = typeof submittedUrgency === 'string' ? submittedUrgency : '';

  if (
    !isNonEmptyString(fullName, 100) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    email.length > 150 ||
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
       (full_name, email, password_hash, role, age, gender, blood_group, phone, city, state, place)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [fullName.trim(), email, passwordHash, role, age, gender, bloodGroup, normalizedPhone, city.trim(), state.trim(), place.trim()]
    );
    if (role === 'donor') {
      const availabilityExpiresAt = isAvailable
        ? new Date(Math.ceil(Date.now() / 1000) * 1000 + AVAILABILITY_HOURS * 60 * 60 * 1000)
        : null;
      await connection.execute(
        `INSERT INTO donors
         (user_id, full_name, age, gender, blood_group, phone, city, state, place,
          last_donation_date, available, public_contact_consent, availability_expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          availabilityExpiresAt
        ]
      );
    }
    if (role === 'patient') {
      await connection.execute(
        `INSERT INTO patients
         (patient_name, age, gender, blood_group, hospital_name, city, area,
          contact_number, units_required, urgency, request_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
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
    res.status(201).json({
      message: role === 'patient'
        ? 'Account and blood request created. Please log in.'
        : 'Account created. Please log in.'
    });
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'An account with this email already exists.' });
    }
    console.error('Account registration failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not create the account.' });
  } finally {
    if (connection) connection.release();
  }
});

app.post('/api/login', rateLimit(10, 15 * 60 * 1000), requireDatabase, async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = req.body?.password;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 150 ||
      typeof password !== 'string' || !password || password.length > 128) {
    return res.status(400).json({ message: 'Enter a valid email address and password.' });
  }

  try {
    const [users] = await db.execute(
      'SELECT user_id, full_name, email, password_hash, role, city, state FROM users WHERE email = ? LIMIT 1',
      [email]
    );
    const user = users[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ message: 'Email or password is incorrect.' });
    }
    setSessionCookie(res, user.user_id);
    res.json({
      message: 'Login successful.',
      user: {
        user_id: user.user_id,
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

app.get('/api/me', requireDatabase, async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) return res.json({ user: null });
  try {
    const [users] = await db.execute(
      'SELECT user_id, full_name, email, role, city, state FROM users WHERE user_id = ? LIMIT 1',
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
  res.json({ message: 'Logged out successfully.' });
});

app.get('/api/availability/status', requireDatabase, requireSession, async (req, res) => {
  if (req.user.role !== 'donor') {
    return res.status(403).json({ message: 'Only donor accounts can manage donor availability.' });
  }
  try {
    const [donors] = await db.execute(
      `SELECT available, public_contact_consent,
              DATE_FORMAT(availability_expires_at, '%Y-%m-%dT%H:%i:%sZ') AS available_until
       FROM donors
       WHERE user_id = ?
       LIMIT 1`,
      [req.user.user_id]
    );
    if (!donors.length) {
      return res.status(404).json({ message: 'No donor profile is linked to this account.' });
    }
    const active = donors[0].available === 1 &&
      donors[0].public_contact_consent === 1 &&
      donors[0].available_until &&
      new Date(donors[0].available_until).getTime() > Date.now();
    res.json({
      is_available: Boolean(active),
      available_until: active ? donors[0].available_until : null
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
  const { is_available: isAvailable, public_contact_consent: publicContactConsent } = req.body || {};
  if (typeof isAvailable !== 'boolean' || typeof publicContactConsent !== 'boolean') {
    return res.status(400).json({ message: 'Confirm your availability and contact-display consent.' });
  }
  if (isAvailable && !publicContactConsent) {
    return res.status(400).json({ message: 'To appear in donor search, confirm availability and consent to display your contact details.' });
  }

  try {
    const availableUntil = isAvailable
      ? new Date(Math.ceil(Date.now() / 1000) * 1000 + AVAILABILITY_HOURS * 60 * 60 * 1000)
      : null;
    const [result] = await db.execute(
      `UPDATE donors
       SET available = ?, public_contact_consent = ?, availability_expires_at = ?
       WHERE user_id = ?`,
      isAvailable
        ? [1, 1, availableUntil, req.user.user_id]
        : [0, 0, null, req.user.user_id]
    );
    if (!result.affectedRows) {
      const [donors] = await db.execute(
        'SELECT id FROM donors WHERE user_id = ? LIMIT 1',
        [req.user.user_id]
      );
      if (!donors.length) {
        return res.status(404).json({ message: 'No donor profile is linked to this account.' });
      }
    }
    res.json({
      is_available: isAvailable,
      available_until: availableUntil?.toISOString() || null
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
         AND availability_expires_at > UTC_TIMESTAMP()`
    );
    res.json({ available_count: Number(rows[0].available_count), checked_at: new Date().toISOString() });
  } catch (error) {
    console.error('Availability count failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not check current donor availability.' });
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
    const filters = [
      'available = 1',
      'public_contact_consent = 1',
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
      `SELECT full_name AS name, blood_group, city, state, place, phone,
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
