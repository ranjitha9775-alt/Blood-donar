const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const mysql = require('mysql2/promise');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const {
  addCalendarMonths,
  isValidDateOnly: isValidDateOnlyValue,
  isValidDonationDate
} = require('./donation-date');
const {
  areBloodGroupsCompatible,
  getCompatibleDonorBloodGroups
} = require('./blood-group-utils');
const { canAccessBloodBankPortal } = require('./authorization-utils');
const { isAvailabilitySearchEligible, normalizeAvailabilityState } = require('./availability-utils');
const { calculateStock, getStockStatus, isStockFreshForUtcDate } = require('./stock-utils');
const {
  canRequestEligibilityReview,
  getEligibilityPortalStatus,
  getRecoveryProgress,
  isMatchingEligibilityConfirmed
} = require('./eligibility-portal-utils');
const {
  createNotificationPayload,
  isValidNotificationId
} = require('./notification-utils');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATABASE_NAME = process.env.DB_NAME || 'lifedrop';
const PORTAL_SCHEMA = DATABASE_NAME === 'blood_donar_portal';
const AVAILABILITY_HOURS = 24;
const AVAILABILITY_DURATIONS_HOURS = [4, 12, 24];
const DONATION_ELIGIBILITY_MONTHS = Number(process.env.DONATION_ELIGIBILITY_MONTHS || 3);
if (!Number.isInteger(DONATION_ELIGIBILITY_MONTHS) ||
    DONATION_ELIGIBILITY_MONTHS < 1 || DONATION_ELIGIBILITY_MONTHS > 24) {
  throw new Error('DONATION_ELIGIBILITY_MONTHS must be an integer between 1 and 24.');
}

async function saveInAppNotification(executor, notification) {
  const payload = createNotificationPayload(notification);
  if (!payload) throw new Error('Invalid in-app notification payload.');
  await executor.execute(
    `INSERT IGNORE INTO in_app_notifications
       (recipient_user_id, recipient_admin_id, title, message, notification_type,
        related_request_id, dedupe_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
    [payload.recipient_user_id, payload.recipient_admin_id, payload.title,
      payload.message, payload.notification_type, payload.related_request_id,
      payload.dedupe_key]
  );
}

async function saveAdminNotifications(executor, notification) {
  const payload = createNotificationPayload({ ...notification, recipientAdminId: 1 });
  if (!payload) throw new Error('Invalid admin in-app notification payload.');
  await executor.execute(
    `INSERT IGNORE INTO in_app_notifications
       (recipient_admin_id, title, message, notification_type, related_request_id,
        dedupe_key, created_at)
     SELECT admin_id, ?, ?, ?, ?, ?, UTC_TIMESTAMP()
     FROM admin_users`,
    [payload.title, payload.message, payload.notification_type,
      payload.related_request_id, payload.dedupe_key]
  );
}
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
const DONOR_ELIGIBILITY_SQL = `(
  COALESCE(d.next_eligible_date,
    DATE_ADD(d.last_donation_date, INTERVAL ${DONATION_ELIGIBILITY_MONTHS} MONTH)) IS NULL
  OR COALESCE(d.next_eligible_date,
    DATE_ADD(d.last_donation_date, INTERVAL ${DONATION_ELIGIBILITY_MONTHS} MONTH)) <= UTC_DATE()
)
AND (d.last_donation_date IS NULL OR d.last_confirmed_at >= COALESCE(
  d.next_eligible_date,
  DATE_ADD(d.last_donation_date, INTERVAL ${DONATION_ELIGIBILITY_MONTHS} MONTH)
))
AND EXISTS (
  SELECT 1
  FROM donor_health_screenings hs
  WHERE hs.donor_user_id = d.user_id
    AND hs.screening_id = (
      SELECT latest_hs.screening_id
      FROM donor_health_screenings latest_hs
      WHERE latest_hs.donor_user_id = d.user_id
      ORDER BY latest_hs.submitted_at DESC, latest_hs.screening_id DESC
      LIMIT 1
    )
    AND hs.review_status = 'Cleared'
    AND hs.health_data_consent_at IS NOT NULL
    AND hs.submitted_at >= COALESCE(
      (SELECT MAX(dh.verified_at) FROM donor_donation_history dh
       WHERE dh.donor_user_id = d.user_id AND dh.verification_status = 'verified'),
      d.last_donation_date,
      '1000-01-01 00:00:00'
    )
    AND EXISTS (
      SELECT 1
      FROM donor_eligibility_reviews er
      WHERE er.donor_user_id = d.user_id
        AND er.decision = 'eligible'
        AND er.reviewed_at >= hs.submitted_at
        AND d.last_confirmed_at >= er.reviewed_at
        AND er.reviewed_at >= COALESCE(
          (SELECT MAX(dh.verified_at) FROM donor_donation_history dh
           WHERE dh.donor_user_id = d.user_id AND dh.verification_status = 'verified'),
          d.last_donation_date,
          '1000-01-01 00:00:00'
        )
        AND NOT EXISTS (
          SELECT 1 FROM donor_eligibility_reviews newer_review
          WHERE newer_review.donor_user_id = d.user_id
            AND (newer_review.reviewed_at > er.reviewed_at
              OR (newer_review.reviewed_at = er.reviewed_at
                AND newer_review.review_id > er.review_id))
        )
    )
)`;
const DONOR_AVAILABILITY_STATUS_SQL = `CASE
  WHEN d.available = 1
       AND d.last_confirmed_at IS NOT NULL
       AND ${DONOR_ELIGIBILITY_SQL}
       AND COALESCE(d.availability_mode, 'general') = 'selected_dates'
       AND EXISTS (
         SELECT 1 FROM donor_availability_dates ad
         WHERE ad.donor_user_id = d.user_id
           AND ad.status = 'available'
           AND ad.available_date >= UTC_DATE()
       ) THEN 'available'
  WHEN d.available = 1
       AND d.last_confirmed_at IS NOT NULL
      AND ${DONOR_ELIGIBILITY_SQL}
       AND COALESCE(d.availability_mode, 'general') = 'general'
       AND d.availability_expires_at > UTC_TIMESTAMP() THEN 'available'
  WHEN d.available = 1
       AND d.last_confirmed_at IS NOT NULL
       AND COALESCE(d.availability_mode, 'general') = 'general'
       AND d.availability_expires_at <= UTC_TIMESTAMP() THEN 'expired'
  WHEN d.last_confirmed_at IS NOT NULL
       AND COALESCE(d.availability_mode, 'general') = 'selected_dates'
       AND EXISTS (
         SELECT 1 FROM donor_availability_dates ad
         WHERE ad.donor_user_id = d.user_id AND ad.status = 'available'
       )
       AND NOT EXISTS (
         SELECT 1 FROM donor_availability_dates ad
         WHERE ad.donor_user_id = d.user_id
           AND ad.status = 'available'
           AND ad.available_date >= UTC_DATE()
       ) THEN 'expired'
  WHEN d.available = 0
       AND d.last_confirmed_at IS NOT NULL
       AND LOWER(COALESCE(d.availability_status, '')) = 'temporarily_unavailable'
       THEN 'temporarily_unavailable'
  WHEN d.available = 0
       AND d.last_confirmed_at IS NOT NULL
       AND REPLACE(REPLACE(LOWER(COALESCE(d.availability_status, '')), ' ', '_'), '-', '_')
           IN ('not_available', 'unavailable') THEN 'unavailable'
  ELSE 'unconfirmed'
END`;
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
const healthDataEncryptionKey = typeof process.env.HEALTH_DATA_ENCRYPTION_KEY === 'string' &&
  /^[a-f\d]{64}$/i.test(process.env.HEALTH_DATA_ENCRYPTION_KEY)
  ? Buffer.from(process.env.HEALTH_DATA_ENCRYPTION_KEY, 'hex')
  : null;
let databaseReady = false;
let adminReady = false;
let bloodStockMasterCache = null;
let bloodStockMasterFetchedAt = 0;
let bloodStockAlertTimer = null;

const db = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: DATABASE_NAME,
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
  return isValidDateOnlyValue(value);
}

function formatDatabaseDateOnly(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return value.slice(0, 10);
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '';
}

function encryptHealthResponses(responses) {
  if (!healthDataEncryptionKey) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', healthDataEncryptionKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(responses), 'utf8'),
    cipher.final()
  ]);
  return JSON.stringify({
    encryption: 'aes-256-gcm-v1',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64')
  });
}

function decryptHealthResponses(value) {
  const stored = typeof value === 'string' ? JSON.parse(value) : value;
  if (stored?.encryption !== 'aes-256-gcm-v1') return stored || {};
  if (!healthDataEncryptionKey) {
    throw new Error('HEALTH_DATA_ENCRYPTION_KEY is required to decrypt health screening records.');
  }
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    healthDataEncryptionKey,
    Buffer.from(stored.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(stored.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(stored.ciphertext, 'base64')),
    decipher.final()
  ]).toString('utf8');
  return JSON.parse(plaintext);
}

function formatSqlUtcDateTime(value) {
  return value.toISOString().slice(0, 19).replace('T', ' ');
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

function normalizeUserRole(role) {
  return role === 'recipient' ? 'patient' : role;
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
    req.user = { ...users[0], role: normalizeUserRole(users[0].role) };
    next();
  } catch (error) {
    console.error('Session verification failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not verify your login session.' });
  }
}

async function requireBloodBankStaff(req, res, next) {
  if (req.user?.role !== 'blood_bank') {
    return res.status(403).json({ message: 'Authorized blood-bank staff access is required.' });
  }
  try {
    const [staffRows] = await db.execute(
      `SELECT s.bank_id, b.bank_name, b.city, b.district, b.state, b.is_active
       FROM blood_bank_staff s
       JOIN blood_banks b ON b.blood_bank_id = s.bank_id
       WHERE s.user_id = ? AND b.is_active = 1
       LIMIT 1`,
      [req.user.user_id]
    );
    if (!staffRows.length) {
      return res.status(403).json({ message: 'A verified blood-bank administrator must map your staff account to an active bank.' });
    }
    if (!canAccessBloodBankPortal(req.user, staffRows[0])) {
      return res.status(403).json({ message: 'Authorized blood-bank staff access is required.' });
    }
    req.bloodBank = staffRows[0];
    next();
  } catch (error) {
    console.error('Blood-bank staff authorization failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not verify blood-bank staff access.' });
  }
}

function requireDashboardSession(req, res, next) {
  if (!getSessionUserId(req)) {
    return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
  return requireSession(req, res, next);
}

function serveAccountDashboard(role, filename) {
  return (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.user.role !== role) {
      const dashboardByRole = {
        donor: '/donar-dashboard.html',
        patient: '/patient-dashboard.html',
        blood_bank: '/blood-bank-portal.html'
      };
      return res.redirect(dashboardByRole[req.user.role] || '/login');
    }
    res.sendFile(path.join(__dirname, filename));
  };
}

app.get('/donar-dashboard.html', requireDatabase, requireDashboardSession, serveAccountDashboard('donor', 'donar-dashboard.html'));
app.get('/donor-dashboard.html', requireDatabase, requireDashboardSession, serveAccountDashboard('donor', 'donar-dashboard.html'));
app.get('/donor-eligibility.html', requireDatabase, requireDashboardSession, (req, res) => {
  if (req.user.role !== 'donor') return res.redirect('/donar-dashboard.html');
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'donor-eligibility.html'));
});
app.get('/patient-dashboard.html', requireDatabase, requireDashboardSession, serveAccountDashboard('patient', 'patient-dashboard.html'));
app.get('/blood-bank-review.html', requireDatabase, requireDashboardSession, (req, res) => {
  if (req.user.role !== 'blood_bank') return res.redirect('/login');
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'blood-bank-review.html'));
});
app.get('/blood-bank-portal.html', requireDatabase, requireDashboardSession,
  serveAccountDashboard('blood_bank', 'blood-bank-portal.html'));
app.get('/blood-bank-review.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'blood-bank-review.js'));
});
app.get('/blood-bank-portal.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'blood-bank-portal.js'));
});
app.get('/dashboard.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.js'));
});
app.get('/donor-eligibility.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'donor-eligibility.js'));
});

async function ensureColumn(table, name, definition) {
  const [columns] = await db.query(`SHOW COLUMNS FROM \`${table}\``);
  if (!columns.some(column => column.Field === name)) {
    await db.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${name}\` ${definition}`);
  }
}

async function ensureTemporaryUnavailableStatus() {
  const [columns] = await db.query('SHOW COLUMNS FROM donors');
  const availabilityStatus = columns.find(column => column.Field === 'availability_status');
  if (!availabilityStatus) {
    throw new Error('The donors.availability_status column is unavailable.');
  }
  if (!availabilityStatus.Type.includes('temporarily_unavailable')) {
    await db.query(
      `ALTER TABLE donors MODIFY COLUMN availability_status
       ENUM('available', 'not_available', 'temporarily_unavailable')
       NOT NULL DEFAULT 'not_available'`
    );
  }
}

async function setBloodStockAlert({ bankId, scopeKey, bloodGroup = null, component = null, type, message }) {
  await db.execute(
    `INSERT INTO blood_stock_alerts
       (blood_bank_id, scope_key, blood_group, component, alert_type, is_active,
        message, first_triggered_at, last_triggered_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE
       first_triggered_at = IF(is_active = 0, UTC_TIMESTAMP(), first_triggered_at),
       last_triggered_at = IF(is_active = 0, UTC_TIMESTAMP(), last_triggered_at),
       resolved_at = NULL,
       message = VALUES(message),
       is_active = 1`,
    [bankId, scopeKey, bloodGroup, component, type, message]
  );
}

async function resolveBloodStockAlerts(bankId, scopeKey, exceptType = null) {
  await db.execute(
    `UPDATE blood_stock_alerts
     SET is_active = 0, resolved_at = UTC_TIMESTAMP()
     WHERE blood_bank_id = ? AND scope_key = ? AND is_active = 1
       AND (? IS NULL OR alert_type <> ?)`,
    [bankId, scopeKey, exceptType, exceptType]
  );
}

async function syncBloodStockAlerts() {
  const [banks] = await db.query(
    `SELECT b.blood_bank_id, b.bank_name,
            EXISTS(
              SELECT 1 FROM blood_stock s
              WHERE s.blood_bank_id = b.blood_bank_id
                AND s.last_updated >= UTC_DATE()
                AND s.last_updated < DATE_ADD(UTC_DATE(), INTERVAL 1 DAY)
            ) AS update_submitted_today
     FROM blood_banks b
     WHERE b.is_active = 1`
  );
  const [stocks] = await db.query(
    `SELECT s.stock_id, s.blood_bank_id, b.bank_name, s.blood_group, s.component,
            s.available_units, s.low_stock_threshold, s.verification_status,
            s.last_updated, COALESCE(t.low_stock_threshold, s.low_stock_threshold, 0) AS threshold
     FROM blood_stock s
     JOIN blood_banks b ON b.blood_bank_id = s.blood_bank_id
     LEFT JOIN blood_stock_thresholds t
       ON t.blood_bank_id = s.blood_bank_id
      AND t.blood_group = s.blood_group AND t.component = s.component
     WHERE b.is_active = 1`
  );
  for (const bank of banks) {
    if (Boolean(bank.update_submitted_today)) {
      await resolveBloodStockAlerts(bank.blood_bank_id, 'BANK');
      continue;
    }
    await setBloodStockAlert({
      bankId: bank.blood_bank_id,
      scopeKey: 'BANK',
      type: 'update_required',
      message: `${bank.bank_name} has no confirmed daily stock update for the current UTC date.`
    });
  }
  for (const stock of stocks) {
    const stale = !isStockFreshForUtcDate(stock.last_updated);
    let alertType = null;
    let message = '';
    if (stock.verification_status !== 'verified') {
      alertType = 'unverified';
      message = `${stock.bank_name}: ${stock.blood_group} ${stock.component} requires staff verification.`;
    } else if (stale) {
      alertType = 'update_required';
      message = `${stock.bank_name}: ${stock.blood_group} ${stock.component} stock update is overdue.`;
    } else if (Number(stock.available_units) === 0) {
      alertType = 'out_of_stock';
      message = `${stock.bank_name}: ${stock.blood_group} ${stock.component} is out of stock.`;
    } else if (Number(stock.available_units) < Number(stock.threshold)) {
      alertType = 'low_stock';
      message = `${stock.bank_name}: ${stock.blood_group} ${stock.component} is below its configured threshold.`;
    }
    const scopeKey = `${stock.blood_group}:${stock.component}`;
    await resolveBloodStockAlerts(stock.blood_bank_id, scopeKey, alertType);
    if (alertType) {
      await setBloodStockAlert({
        bankId: stock.blood_bank_id,
        scopeKey,
        bloodGroup: stock.blood_group,
        component: stock.component,
        type: alertType,
        message
      });
    }
  }
}

async function initializeDonationCoordinationSchema(userIdType) {
  await ensureColumn('donors', 'next_eligible_date', 'DATE NULL AFTER last_donation_date');
  await ensureColumn('donor_health_screenings', 'health_data_consent_at', 'DATETIME NULL AFTER review_notes');
  await ensureColumn('donor_health_screenings', 'form_version', 'VARCHAR(20) NULL AFTER health_data_consent_at');
  await ensureColumn('blood_requests', 'component', "ENUM('whole_blood', 'red_cells', 'platelets', 'plasma') NOT NULL DEFAULT 'whole_blood' AFTER blood_group");
  await ensureColumn('blood_requests', 'coordination_status', "ENUM('Pending', 'Under Review', 'Accepted', 'Rejected', 'In Progress', 'Fulfilled', 'Cancelled') NOT NULL DEFAULT 'Pending' AFTER status");
  await db.query(
    `ALTER TABLE blood_requests MODIFY COLUMN coordination_status
     ENUM('Pending', 'Under Review', 'Accepted', 'Rejected', 'In Progress', 'Fulfilled', 'Cancelled')
     NOT NULL DEFAULT 'Pending'`
  );
  await ensureColumn('blood_requests', 'coordinator_user_id', `${userIdType} NULL AFTER coordination_status`);
  await ensureColumn('blood_requests', 'coordinator_bank_id', 'INT NULL AFTER coordinator_user_id');
  await ensureColumn('blood_requests', 'coordination_updated_at', 'DATETIME NULL AFTER coordinator_bank_id');
  await db.query(
    `CREATE TABLE IF NOT EXISTS donor_donation_history (
      donation_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      donor_user_id ${userIdType} NOT NULL,
      donation_date DATE NOT NULL,
      eligibility_interval_months SMALLINT UNSIGNED NOT NULL DEFAULT 3,
      next_eligible_date DATE NOT NULL,
      verification_status ENUM('verified', 'rejected') NOT NULL DEFAULT 'verified',
      recorded_by_admin_username VARCHAR(80) NOT NULL,
      verified_by_admin_username VARCHAR(80) NOT NULL,
      verified_at DATETIME NOT NULL,
      notes VARCHAR(500) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (donation_id),
      KEY idx_donation_history_donor (donor_user_id, donation_date),
      KEY idx_donation_history_eligibility (donor_user_id, next_eligible_date, verification_status),
      CONSTRAINT fk_donation_history_donor FOREIGN KEY (donor_user_id)
        REFERENCES users (user_id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS donor_eligibility_reviews (
      review_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      donor_user_id ${userIdType} NOT NULL,
      decision ENUM('eligible', 'deferred') NOT NULL,
      reviewed_by_user_id ${userIdType} NOT NULL,
      reviewed_at DATETIME NOT NULL,
      notes VARCHAR(500) NULL,
      PRIMARY KEY (review_id),
      KEY idx_eligibility_review_donor (donor_user_id, reviewed_at),
      CONSTRAINT fk_eligibility_review_donor FOREIGN KEY (donor_user_id)
        REFERENCES users (user_id) ON DELETE RESTRICT,
      CONSTRAINT fk_eligibility_review_staff FOREIGN KEY (reviewed_by_user_id)
        REFERENCES users (user_id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS donor_eligibility_review_requests (
      request_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      donor_user_id ${userIdType} NOT NULL,
      request_status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
      requested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reviewed_by_admin_id TINYINT UNSIGNED NULL,
      reviewed_at DATETIME NULL,
      instructions VARCHAR(500) NULL,
      PRIMARY KEY (request_id),
      KEY idx_eligibility_requests_status (request_status, requested_at),
      KEY idx_eligibility_requests_donor (donor_user_id, requested_at),
      CONSTRAINT fk_eligibility_request_donor FOREIGN KEY (donor_user_id)
        REFERENCES users (user_id) ON DELETE RESTRICT,
      CONSTRAINT fk_eligibility_request_admin FOREIGN KEY (reviewed_by_admin_id)
        REFERENCES admin_users (admin_id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS donor_donation_history_corrections (
      correction_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      donation_id BIGINT UNSIGNED NOT NULL,
      donor_user_id ${userIdType} NOT NULL,
      previous_donation_date DATE NOT NULL,
      corrected_donation_date DATE NOT NULL,
      corrected_by_admin_id TINYINT UNSIGNED NOT NULL,
      correction_note VARCHAR(500) NOT NULL,
      corrected_at DATETIME NOT NULL,
      PRIMARY KEY (correction_id),
      KEY idx_donation_corrections_record (donation_id, corrected_at),
      CONSTRAINT fk_donation_correction_record FOREIGN KEY (donation_id)
        REFERENCES donor_donation_history (donation_id) ON DELETE RESTRICT,
      CONSTRAINT fk_donation_correction_donor FOREIGN KEY (donor_user_id)
        REFERENCES users (user_id) ON DELETE RESTRICT,
      CONSTRAINT fk_donation_correction_admin FOREIGN KEY (corrected_by_admin_id)
        REFERENCES admin_users (admin_id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS in_app_notifications (
      notification_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      recipient_user_id ${userIdType} NULL,
      recipient_admin_id TINYINT UNSIGNED NULL,
      title VARCHAR(120) NOT NULL,
      message VARCHAR(500) NOT NULL,
      notification_type VARCHAR(40) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      read_at DATETIME NULL,
      related_request_id ${PORTAL_SCHEMA ? 'INT' : 'BIGINT UNSIGNED'} NULL,
      dedupe_key VARCHAR(160) NOT NULL,
      PRIMARY KEY (notification_id),
      UNIQUE KEY uq_user_notification_dedupe (recipient_user_id, dedupe_key),
      UNIQUE KEY uq_admin_notification_dedupe (recipient_admin_id, dedupe_key),
      KEY idx_user_notifications_unread (recipient_user_id, read_at, created_at),
      KEY idx_admin_notifications_unread (recipient_admin_id, read_at, created_at),
      CONSTRAINT fk_notification_recipient_user FOREIGN KEY (recipient_user_id)
        REFERENCES users (user_id) ON DELETE RESTRICT,
      CONSTRAINT fk_notification_recipient_admin FOREIGN KEY (recipient_admin_id)
        REFERENCES admin_users (admin_id) ON DELETE RESTRICT,
      CONSTRAINT fk_notification_request FOREIGN KEY (related_request_id)
        REFERENCES blood_requests (request_id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS blood_request_events (
      event_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      request_id ${PORTAL_SCHEMA ? 'INT' : 'BIGINT UNSIGNED'} NOT NULL,
      actor_user_id ${userIdType} NULL,
      event_type VARCHAR(40) NOT NULL,
      previous_status VARCHAR(32) NULL,
      new_status VARCHAR(32) NULL,
      details JSON NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (event_id),
      KEY idx_request_events_request (request_id, created_at),
      CONSTRAINT fk_request_events_request FOREIGN KEY (request_id)
        REFERENCES blood_requests (request_id) ON DELETE RESTRICT,
      CONSTRAINT fk_request_events_actor FOREIGN KEY (actor_user_id)
        REFERENCES users (user_id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS blood_banks (
      blood_bank_id INT NOT NULL AUTO_INCREMENT,
      bank_name VARCHAR(150) NOT NULL,
      phone VARCHAR(20) NULL,
      email VARCHAR(150) NULL,
      address_text VARCHAR(255) NOT NULL,
      city VARCHAR(80) NULL,
      district VARCHAR(80) NULL,
      state VARCHAR(80) NULL,
      operating_hours VARCHAR(120) NULL,
      latitude DECIMAL(10,7) NULL,
      longitude DECIMAL(10,7) NULL,
      verified TINYINT(1) NOT NULL DEFAULT 0,
      verification_status ENUM('pending', 'verified', 'rejected') NOT NULL DEFAULT 'pending',
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (blood_bank_id),
      KEY idx_blood_banks_public_search (verification_status, is_active, city)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS blood_bank_staff (
      user_id ${userIdType} NOT NULL,
      bank_id INT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id),
      KEY idx_blood_bank_staff_bank (bank_id),
      CONSTRAINT fk_blood_bank_staff_bank FOREIGN KEY (bank_id)
        REFERENCES blood_banks (blood_bank_id) ON DELETE CASCADE,
      CONSTRAINT fk_blood_bank_staff_user FOREIGN KEY (user_id)
        REFERENCES users (user_id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS blood_inventory (
      inventory_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      bank_id INT NOT NULL,
      blood_group VARCHAR(3) NOT NULL,
      component ENUM('whole_blood', 'red_cells', 'platelets', 'plasma') NOT NULL,
      available_units INT UNSIGNED NOT NULL DEFAULT 0,
      low_stock_threshold INT UNSIGNED NOT NULL DEFAULT 0,
      expires_at DATETIME NOT NULL,
      verification_status ENUM('pending', 'verified', 'rejected') NOT NULL DEFAULT 'pending',
      last_updated DATETIME NOT NULL,
      updated_by ${userIdType} NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (inventory_id),
      UNIQUE KEY uq_blood_inventory_lot (bank_id, blood_group, component, expires_at),
      KEY idx_blood_inventory_search (blood_group, component, verification_status, last_updated, expires_at),
      KEY idx_blood_inventory_bank (bank_id, verification_status),
      CONSTRAINT fk_blood_inventory_bank FOREIGN KEY (bank_id)
        REFERENCES blood_banks (blood_bank_id) ON DELETE CASCADE,
      CONSTRAINT fk_blood_inventory_user FOREIGN KEY (updated_by)
        REFERENCES users (user_id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS blood_bank_audit_logs (
      audit_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      actor_user_id ${userIdType} NOT NULL,
      bank_id INT NOT NULL,
      inventory_id BIGINT UNSIGNED NULL,
      action VARCHAR(40) NOT NULL,
      details JSON NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (audit_id),
      KEY idx_blood_bank_audit_bank_date (bank_id, created_at),
      KEY idx_blood_bank_audit_actor_date (actor_user_id, created_at),
      CONSTRAINT fk_blood_bank_audit_actor FOREIGN KEY (actor_user_id)
        REFERENCES users (user_id) ON DELETE RESTRICT,
      CONSTRAINT fk_blood_bank_audit_bank FOREIGN KEY (bank_id)
        REFERENCES blood_banks (blood_bank_id) ON DELETE RESTRICT,
      CONSTRAINT fk_blood_bank_audit_inventory FOREIGN KEY (inventory_id)
        REFERENCES blood_inventory (inventory_id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  await ensureColumn('blood_inventory', 'low_stock_threshold', 'INT UNSIGNED NOT NULL DEFAULT 0 AFTER available_units');
  await db.query(
    `CREATE TABLE IF NOT EXISTS blood_stock (
      stock_id INT NOT NULL AUTO_INCREMENT,
      blood_bank_id INT NOT NULL,
      blood_group ENUM('A+','A-','B+','B-','AB+','AB-','O+','O-') NOT NULL,
      component ENUM('whole_blood', 'red_cells', 'platelets', 'plasma') NOT NULL DEFAULT 'whole_blood',
      units_available INT UNSIGNED NOT NULL DEFAULT 0,
      physical_units INT UNSIGNED NOT NULL DEFAULT 0,
      reserved_units INT UNSIGNED NOT NULL DEFAULT 0,
      issued_units INT UNSIGNED NOT NULL DEFAULT 0,
      discarded_units INT UNSIGNED NOT NULL DEFAULT 0,
      total_eligible_units INT UNSIGNED NOT NULL DEFAULT 0,
      available_units INT UNSIGNED NOT NULL DEFAULT 0,
      low_stock_threshold INT UNSIGNED NOT NULL DEFAULT 0,
      verification_status ENUM('pending', 'verified', 'rejected') NOT NULL DEFAULT 'pending',
      updated_by ${userIdType} NULL,
      reviewed_by_admin_id TINYINT UNSIGNED NULL,
      reviewed_at DATETIME NULL,
      last_updated TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (stock_id),
      UNIQUE KEY uq_blood_stock_bank_group_component (blood_bank_id, blood_group, component),
      KEY idx_blood_stock_public_search (blood_group, component, verification_status, last_updated),
      CONSTRAINT fk_blood_stock_bank FOREIGN KEY (blood_bank_id)
        REFERENCES blood_banks (blood_bank_id) ON DELETE CASCADE,
      CONSTRAINT fk_blood_stock_staff FOREIGN KEY (updated_by)
        REFERENCES users (user_id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  for (const [name, definition] of [
    ['component', "ENUM('whole_blood', 'red_cells', 'platelets', 'plasma') NOT NULL DEFAULT 'whole_blood' AFTER blood_group"],
    ['physical_units', 'INT UNSIGNED NOT NULL DEFAULT 0 AFTER units_available'],
    ['reserved_units', 'INT UNSIGNED NOT NULL DEFAULT 0 AFTER physical_units'],
    ['issued_units', 'INT UNSIGNED NOT NULL DEFAULT 0 AFTER reserved_units'],
    ['discarded_units', 'INT UNSIGNED NOT NULL DEFAULT 0 AFTER issued_units'],
    ['total_eligible_units', 'INT UNSIGNED NOT NULL DEFAULT 0 AFTER discarded_units'],
    ['available_units', 'INT UNSIGNED NOT NULL DEFAULT 0 AFTER total_eligible_units'],
    ['low_stock_threshold', 'INT UNSIGNED NOT NULL DEFAULT 0 AFTER available_units'],
    ['verification_status', "ENUM('pending', 'verified', 'rejected') NOT NULL DEFAULT 'pending' AFTER low_stock_threshold"],
    ['updated_by', `${userIdType} NULL AFTER verification_status`],
    ['reviewed_by_admin_id', 'TINYINT UNSIGNED NULL AFTER updated_by'],
    ['reviewed_at', 'DATETIME NULL AFTER reviewed_by_admin_id']
  ]) {
    await ensureColumn('blood_stock', name, definition);
  }
  const [stockIndexes] = await db.query('SHOW INDEX FROM blood_stock');
  if (!stockIndexes.some(index => index.Key_name === 'uq_blood_stock_bank_group_component')) {
    await db.query(
      'CREATE UNIQUE INDEX uq_blood_stock_bank_group_component ON blood_stock (blood_bank_id, blood_group, component)'
    );
  }
  const [updatedStockIndexes] = await db.query('SHOW INDEX FROM blood_stock');
  if (updatedStockIndexes.some(index => index.Key_name === 'uq_bank_blood_group')) {
    await db.query('ALTER TABLE blood_stock DROP INDEX uq_bank_blood_group');
  }
  const [finalStockIndexes] = await db.query('SHOW INDEX FROM blood_stock');
  if (!finalStockIndexes.some(index => index.Key_name === 'idx_blood_stock_public_search')) {
    await db.query(
      'CREATE INDEX idx_blood_stock_public_search ON blood_stock (blood_group, component, verification_status, last_updated)'
    );
  }
  await db.query(
    `CREATE TABLE IF NOT EXISTS stock_history (
      history_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      stock_id INT NOT NULL,
      blood_bank_id INT NOT NULL,
      blood_group VARCHAR(3) NOT NULL,
      component ENUM('whole_blood', 'red_cells', 'platelets', 'plasma') NOT NULL,
      previous_physical_units INT UNSIGNED NOT NULL,
      physical_units INT UNSIGNED NOT NULL,
      previous_reserved_units INT UNSIGNED NOT NULL,
      reserved_units INT UNSIGNED NOT NULL,
      previous_issued_units INT UNSIGNED NOT NULL,
      issued_units INT UNSIGNED NOT NULL,
      previous_discarded_units INT UNSIGNED NOT NULL,
      discarded_units INT UNSIGNED NOT NULL,
      previous_available_units INT UNSIGNED NOT NULL,
      available_units INT UNSIGNED NOT NULL,
      transaction_type ENUM('daily_update', 'correction') NOT NULL DEFAULT 'daily_update',
      quantity_changed INT NOT NULL,
      idempotency_key CHAR(36) NOT NULL,
      remarks VARCHAR(500) NULL,
      staff_user_id ${userIdType} NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (history_id),
      UNIQUE KEY uq_stock_history_idempotency (idempotency_key),
      KEY idx_stock_history_bank_date (blood_bank_id, created_at),
      KEY idx_stock_history_stock_date (stock_id, created_at),
      CONSTRAINT fk_stock_history_stock FOREIGN KEY (stock_id)
        REFERENCES blood_stock (stock_id) ON DELETE RESTRICT,
      CONSTRAINT fk_stock_history_bank FOREIGN KEY (blood_bank_id)
        REFERENCES blood_banks (blood_bank_id) ON DELETE RESTRICT,
      CONSTRAINT fk_stock_history_staff FOREIGN KEY (staff_user_id)
        REFERENCES users (user_id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS blood_stock_thresholds (
      blood_bank_id INT NOT NULL,
      blood_group ENUM('A+','A-','B+','B-','AB+','AB-','O+','O-') NOT NULL,
      component ENUM('whole_blood', 'red_cells', 'platelets', 'plasma') NOT NULL,
      low_stock_threshold INT UNSIGNED NOT NULL DEFAULT 0,
      updated_by_admin_id TINYINT UNSIGNED NOT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (blood_bank_id, blood_group, component),
      CONSTRAINT fk_stock_threshold_bank FOREIGN KEY (blood_bank_id)
        REFERENCES blood_banks (blood_bank_id) ON DELETE CASCADE,
      CONSTRAINT fk_stock_threshold_admin FOREIGN KEY (updated_by_admin_id)
        REFERENCES admin_users (admin_id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS blood_stock_threshold_history (
      threshold_history_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      blood_bank_id INT NOT NULL,
      blood_group VARCHAR(3) NOT NULL,
      component ENUM('whole_blood', 'red_cells', 'platelets', 'plasma') NOT NULL,
      previous_threshold INT UNSIGNED NULL,
      new_threshold INT UNSIGNED NOT NULL,
      updated_by_admin_id TINYINT UNSIGNED NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (threshold_history_id),
      KEY idx_stock_threshold_history (blood_bank_id, blood_group, component, created_at),
      CONSTRAINT fk_stock_threshold_history_bank FOREIGN KEY (blood_bank_id)
        REFERENCES blood_banks (blood_bank_id) ON DELETE CASCADE,
      CONSTRAINT fk_stock_threshold_history_admin FOREIGN KEY (updated_by_admin_id)
        REFERENCES admin_users (admin_id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS blood_stock_alerts (
      alert_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      blood_bank_id INT NOT NULL,
      scope_key VARCHAR(32) NOT NULL,
      blood_group VARCHAR(3) NULL,
      component VARCHAR(20) NULL,
      alert_type ENUM('low_stock', 'out_of_stock', 'update_required', 'unverified') NOT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      message VARCHAR(255) NOT NULL,
      first_triggered_at DATETIME NOT NULL,
      last_triggered_at DATETIME NOT NULL,
      resolved_at DATETIME NULL,
      PRIMARY KEY (alert_id),
      UNIQUE KEY uq_stock_alert_scope (blood_bank_id, scope_key, alert_type),
      KEY idx_stock_alert_active (is_active, blood_bank_id, alert_type),
      CONSTRAINT fk_stock_alert_bank FOREIGN KEY (blood_bank_id)
        REFERENCES blood_banks (blood_bank_id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS blood_bank_notifications (
      notification_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      staff_user_id ${userIdType} NOT NULL,
      request_id ${PORTAL_SCHEMA ? 'INT' : 'BIGINT UNSIGNED'} NOT NULL,
      notification_type ENUM('emergency_request') NOT NULL DEFAULT 'emergency_request',
      read_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (notification_id),
      UNIQUE KEY uq_bank_request_notification (staff_user_id, request_id, notification_type),
      KEY idx_bank_notifications_unread (staff_user_id, read_at, created_at),
      CONSTRAINT fk_bank_notification_staff FOREIGN KEY (staff_user_id)
        REFERENCES users (user_id) ON DELETE CASCADE,
      CONSTRAINT fk_bank_notification_request FOREIGN KEY (request_id)
        REFERENCES blood_requests (request_id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
}

async function initializePortalSchemaCompatibility() {
  const [users] = await db.query('SHOW COLUMNS FROM users');
  const userIdType = users.find(column => column.Field === 'user_id')?.Type;
  if (!userIdType || !/^(int|bigint)( unsigned)?$/i.test(userIdType)) {
    throw new Error('The blood_donar_portal users.user_id type is not supported.');
  }

  await db.query(
    `ALTER TABLE users MODIFY COLUMN role
     ENUM('donor', 'recipient', 'patient', 'blood_bank', 'admin')
     NOT NULL DEFAULT 'recipient'`
  );
  for (const [name, definition] of [
    ['username', 'VARCHAR(32) NULL'],
    ['age', 'TINYINT UNSIGNED NOT NULL DEFAULT 18'],
    ['gender', "VARCHAR(30) NOT NULL DEFAULT 'Prefer not to say'"],
    ['state', "VARCHAR(80) NOT NULL DEFAULT 'Karnataka'"],
    ['place', "VARCHAR(100) NOT NULL DEFAULT ''"]
  ]) {
    await ensureColumn('users', name, definition);
  }

  const [userIndexes] = await db.query('SHOW INDEX FROM users');
  if (!userIndexes.some(index => index.Key_name === 'uq_users_username')) {
    await db.query('CREATE UNIQUE INDEX uq_users_username ON users (username)');
  }

  for (const [name, definition] of [
    ['full_name', 'VARCHAR(100) NULL'],
    ['gender', "VARCHAR(30) NOT NULL DEFAULT 'Prefer not to say'"],
    ['phone', "VARCHAR(20) NOT NULL DEFAULT ''"],
    ['city', "VARCHAR(80) NOT NULL DEFAULT ''"],
    ['state', "VARCHAR(80) NOT NULL DEFAULT 'Karnataka'"],
    ['place', "VARCHAR(100) NOT NULL DEFAULT ''"],
    ['available', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['public_contact_consent', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['availability_expires_at', 'DATETIME NULL'],
    ["availability_status", "ENUM('available', 'not_available') NOT NULL DEFAULT 'not_available'"],
    ['last_confirmed_at', 'DATETIME NULL'],
    ['availability_updated_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'],
    ['emergency_response_consent', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ["availability_mode", "ENUM('selected_dates', 'general', 'unavailable') NOT NULL DEFAULT 'unavailable'"]
  ]) {
    await ensureColumn('donors', name, definition);
  }
  await ensureTemporaryUnavailableStatus();

  await db.execute(
    `UPDATE donors d
     JOIN users u ON u.user_id = d.user_id
     SET d.full_name = COALESCE(NULLIF(d.full_name, ''), u.full_name),
         d.gender = COALESCE(NULLIF(d.gender, ''), u.gender),
         d.phone = COALESCE(NULLIF(d.phone, ''), u.phone),
         d.city = COALESCE(NULLIF(d.city, ''), u.city),
         d.state = COALESCE(NULLIF(d.state, ''), u.state),
         d.place = COALESCE(NULLIF(d.place, ''), u.place)`
  );
  await db.execute(
    `INSERT INTO donors
       (user_id, blood_group, age, health_declaration, last_donation_date,
        is_available, available_until, verified, full_name, gender, phone, city, state, place,
        available, public_contact_consent, availability_status, availability_mode)
     SELECT u.user_id, u.blood_group, u.age, NULL, NULL,
            0, NULL, 0, u.full_name, u.gender, u.phone, COALESCE(u.city, ''),
            COALESCE(NULLIF(u.state, ''), 'Karnataka'), COALESCE(u.place, ''),
            0, 0, 'not_available', 'unavailable'
     FROM users u
     LEFT JOIN donors d ON d.user_id = u.user_id
     WHERE u.role = 'donor' AND d.user_id IS NULL`
  );
  await db.execute(
    `UPDATE donors d
     JOIN donor_availability da ON da.donor_user_id = d.user_id
     SET d.available = da.is_available,
         d.is_available = da.is_available,
         d.availability_expires_at = da.expires_at,
         d.available_until = da.expires_at,
         d.last_confirmed_at = da.confirmed_at,
         d.availability_status = CASE WHEN da.is_available = 1 THEN 'available' ELSE 'not_available' END,
         d.availability_mode = CASE WHEN da.is_available = 1 THEN 'general' ELSE 'unavailable' END
     WHERE d.last_confirmed_at IS NULL AND da.confirmed_at IS NOT NULL`
  );
  await db.execute(
    `UPDATE donors
     SET available = is_available,
         availability_expires_at = COALESCE(availability_expires_at, available_until),
         availability_status = CASE WHEN is_available = 1 THEN 'available' ELSE 'not_available' END,
         availability_mode = CASE WHEN is_available = 1 THEN 'general' ELSE 'unavailable' END
     WHERE last_confirmed_at IS NULL AND available = 0`
  );

  const [requests] = await db.query('SHOW COLUMNS FROM blood_requests');
  const requestIdType = requests.find(column => column.Field === 'request_id')?.Type;
  if (!requestIdType || !/^(int|bigint)( unsigned)?$/i.test(requestIdType)) {
    throw new Error('The blood_donar_portal blood_requests.request_id type is not supported.');
  }
  await db.query('ALTER TABLE blood_requests MODIFY COLUMN urgency VARCHAR(32) NOT NULL DEFAULT \'urgent\'');
  await db.query('ALTER TABLE blood_requests MODIFY COLUMN status VARCHAR(32) NOT NULL DEFAULT \'open\'');
  for (const [name, definition] of [
    ['user_id', `${userIdType} NULL`],
    ['patient_reference', 'VARCHAR(100) NULL'],
    ['units', 'INT UNSIGNED NULL'],
    ['hospital_details', "VARCHAR(255) NOT NULL DEFAULT ''"],
    ['city', "VARCHAR(80) NOT NULL DEFAULT ''"],
    ['state', "VARCHAR(80) NOT NULL DEFAULT 'Karnataka'"],
    ['district', "VARCHAR(80) NOT NULL DEFAULT ''"],
    ['contact_name', 'VARCHAR(100) NULL'],
    ['needed_at', 'DATETIME NULL'],
    ['verification_status', "VARCHAR(32) NOT NULL DEFAULT 'Not verified'"],
    ['updated_at', 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP']
  ]) {
    await ensureColumn('blood_requests', name, definition);
  }

  await db.query(
    `CREATE TABLE IF NOT EXISTS donor_availability_dates (
      donor_user_id ${userIdType} NOT NULL,
      available_date DATE NOT NULL,
      status ENUM('available', 'unavailable') NOT NULL DEFAULT 'available',
      confirmed_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (donor_user_id, available_date),
      KEY idx_donor_availability_date (available_date, status),
      CONSTRAINT fk_donor_availability_dates_user FOREIGN KEY (donor_user_id)
        REFERENCES users (user_id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS donor_availability_date_history (
      history_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      donor_user_id ${userIdType} NOT NULL,
      available_date DATE NOT NULL,
      previous_status VARCHAR(20) NULL,
      new_status VARCHAR(20) NOT NULL,
      changed_at DATETIME NOT NULL,
      PRIMARY KEY (history_id),
      KEY idx_availability_date_history (donor_user_id, available_date, changed_at),
      CONSTRAINT fk_availability_date_history_user FOREIGN KEY (donor_user_id)
        REFERENCES users (user_id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS donor_health_screenings (
      screening_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      donor_user_id ${userIdType} NOT NULL,
      responses JSON NOT NULL,
      review_status ENUM('Pending Review', 'Cleared', 'Not Cleared') NOT NULL DEFAULT 'Pending Review',
      submitted_at DATETIME NOT NULL,
      reviewed_at DATETIME NULL,
      reviewed_by_user_id ${userIdType} NULL,
      review_notes VARCHAR(500) NULL,
      PRIMARY KEY (screening_id),
      KEY idx_donor_screening_owner (donor_user_id, submitted_at),
      KEY idx_donor_screening_review (review_status, submitted_at),
      CONSTRAINT fk_donor_screening_user FOREIGN KEY (donor_user_id)
        REFERENCES users (user_id) ON DELETE CASCADE,
      CONSTRAINT fk_donor_screening_reviewer FOREIGN KEY (reviewed_by_user_id)
        REFERENCES users (user_id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  const [requestIndexes] = await db.query('SHOW INDEX FROM blood_requests');
  if (!requestIndexes.some(index => index.Key_name === 'idx_portal_blood_request_user')) {
    await db.query('CREATE INDEX idx_portal_blood_request_user ON blood_requests (user_id, created_at)');
  }
}

async function initializeDatabase() {
  if (PORTAL_SCHEMA) {
    await initializePortalSchemaCompatibility();
  }
  const appUserIdType = PORTAL_SCHEMA ? 'INT' : 'BIGINT UNSIGNED';
  const appRequestIdType = PORTAL_SCHEMA ? 'INT' : 'BIGINT UNSIGNED';
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
  if (!PORTAL_SCHEMA) {
    await db.query(
      `ALTER TABLE users MODIFY COLUMN role
       ENUM('donor', 'patient', 'blood_bank') NOT NULL`
    );
  }
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
      user_id ${appUserIdType} NULL,
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
      request_id ${appRequestIdType} NOT NULL AUTO_INCREMENT,
      user_id ${appUserIdType} NOT NULL,
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
      request_id ${appRequestIdType} NOT NULL,
      donor_user_id ${appUserIdType} NOT NULL,
      response ENUM('pending', 'can_help', 'cannot_help', 'busy', 'declined', 'expired') NOT NULL DEFAULT 'pending',
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
  await db.query(
    `ALTER TABLE donor_request_responses
     MODIFY COLUMN response
     ENUM('pending', 'can_help', 'cannot_help', 'busy', 'declined', 'expired')
     NOT NULL DEFAULT 'pending'`
  );
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
      public_identity_consent TINYINT(1) NOT NULL DEFAULT 0,
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
    ['is_available', 'ALTER TABLE donors ADD COLUMN is_available TINYINT(1) NOT NULL DEFAULT 0 AFTER available'],
    ['public_contact_consent', 'ALTER TABLE donors ADD COLUMN public_contact_consent TINYINT(1) NOT NULL DEFAULT 0 AFTER available'],
    ['public_identity_consent', 'ALTER TABLE donors ADD COLUMN public_identity_consent TINYINT(1) NOT NULL DEFAULT 0 AFTER public_contact_consent'],
    ['availability_expires_at', 'ALTER TABLE donors ADD COLUMN availability_expires_at DATETIME NULL AFTER public_contact_consent'],
    ['available_until', 'ALTER TABLE donors ADD COLUMN available_until DATETIME NULL AFTER availability_expires_at'],
    ['availability_mode', "ALTER TABLE donors ADD COLUMN availability_mode ENUM('selected_dates', 'general', 'unavailable') NOT NULL DEFAULT 'general' AFTER availability_expires_at"],
    ['availability_status', "ALTER TABLE donors ADD COLUMN availability_status ENUM('available', 'not_available') NOT NULL DEFAULT 'not_available' AFTER availability_expires_at"],
    ['last_confirmed_at', 'ALTER TABLE donors ADD COLUMN last_confirmed_at DATETIME NULL AFTER availability_status'],
    ['availability_updated_at', 'ALTER TABLE donors ADD COLUMN availability_updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER last_confirmed_at'],
    ['emergency_response_consent', 'ALTER TABLE donors ADD COLUMN emergency_response_consent TINYINT(1) NOT NULL DEFAULT 0 AFTER availability_updated_at'],
    ['user_id', 'ALTER TABLE donors ADD COLUMN user_id BIGINT UNSIGNED NULL AFTER id']
  ];
  for (const [columnName, statement] of migrations) {
    if (!columnNames.has(columnName)) await db.query(statement);
  }
  await ensureTemporaryUnavailableStatus();
  await db.query(
    `CREATE TABLE IF NOT EXISTS donor_availability_dates (
      donor_user_id ${appUserIdType} NOT NULL,
      available_date DATE NOT NULL,
      status ENUM('available', 'unavailable') NOT NULL DEFAULT 'available',
      confirmed_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (donor_user_id, available_date),
      KEY idx_donor_availability_date (available_date, status),
      CONSTRAINT fk_donor_availability_dates_user FOREIGN KEY (donor_user_id)
        REFERENCES users (user_id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS donor_availability_date_history (
      history_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      donor_user_id ${appUserIdType} NOT NULL,
      available_date DATE NOT NULL,
      previous_status VARCHAR(20) NULL,
      new_status VARCHAR(20) NOT NULL,
      changed_at DATETIME NOT NULL,
      PRIMARY KEY (history_id),
      KEY idx_availability_date_history (donor_user_id, available_date, changed_at),
      CONSTRAINT fk_availability_date_history_user FOREIGN KEY (donor_user_id)
        REFERENCES users (user_id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS donor_health_screenings (
      screening_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      donor_user_id ${appUserIdType} NOT NULL,
      responses JSON NOT NULL,
      review_status ENUM('Pending Review', 'Cleared', 'Not Cleared') NOT NULL DEFAULT 'Pending Review',
      submitted_at DATETIME NOT NULL,
      reviewed_at DATETIME NULL,
      reviewed_by_user_id ${appUserIdType} NULL,
      review_notes VARCHAR(500) NULL,
      PRIMARY KEY (screening_id),
      KEY idx_donor_screening_owner (donor_user_id, submitted_at),
      KEY idx_donor_screening_review (review_status, submitted_at),
      CONSTRAINT fk_donor_screening_user FOREIGN KEY (donor_user_id)
        REFERENCES users (user_id) ON DELETE CASCADE,
      CONSTRAINT fk_donor_screening_reviewer FOREIGN KEY (reviewed_by_user_id)
        REFERENCES users (user_id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  await initializeDonationCoordinationSchema(appUserIdType);
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
  await syncBloodStockAlerts().catch(error => {
    console.error('Initial blood-stock alert refresh failed:', error.code || error.message);
  });
  if (!bloodStockAlertTimer) {
    bloodStockAlertTimer = setInterval(() => {
      syncBloodStockAlerts().catch(error => {
        console.error('Scheduled blood-stock alert refresh failed:', error.code || error.message);
      });
    }, 15 * 60 * 1000);
    bloodStockAlertTimer.unref();
  }
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
              blood_group, component, units, urgency, city, district,
              DATE_FORMAT(needed_at, '%Y-%m-%dT%H:%i:%sZ') AS needed_at,
              verification_status, status, coordination_status,
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
  const component = typeof req.body?.component === 'string' ? req.body.component : 'whole_blood';
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
      !['whole_blood', 'red_cells', 'platelets', 'plasma'].includes(component) ||
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
    const requestValues = [
        req.user.user_id,
        patientReference,
        bloodGroup,
        component,
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
      ];
    const [result] = PORTAL_SCHEMA
      ? await connection.execute(
        `INSERT INTO blood_requests
            (requester_user_id, patient_name, blood_group, component, units_needed, hospital_name,
            hospital_address, contact_phone, urgency, needed_by, status,
            user_id, patient_reference, units, hospital_details, city, state, district,
            contact_name, needed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.user.user_id,
          patientReference,
          bloodGroup,
          component,
          units,
          hospitalName,
          hospitalAddress,
          contactPhone,
          urgency,
          sqlNeededAt,
          'Pending Verification',
          req.user.user_id,
          patientReference,
          units,
          hospitalDetails,
          city,
          state,
          district,
          contactName,
          sqlNeededAt
        ]
      )
      : await connection.execute(
        `INSERT INTO blood_requests
           (user_id, patient_reference, blood_group, component, units, urgency, hospital_details, hospital_name,
            city, state, district, contact_name, contact_phone, needed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        requestValues
      );
    await connection.execute(
      `INSERT INTO blood_request_events
         (request_id, actor_user_id, event_type, previous_status, new_status, details)
       VALUES (?, ?, 'request_submitted', NULL, 'Pending', ?)`,
      [result.insertId, req.user.user_id, JSON.stringify({ submitted_by: 'patient' })]
    );
    let matchedDonorCount = 0;
    if (urgency === 'Urgent' && req.body.match_donors) {
      const responseDeadline = formatSqlUtcDateTime(
        new Date(Date.now() + DONOR_RESPONSE_WINDOW_MINUTES * 60 * 1000)
      );
      const [matches] = await connection.execute(
        `INSERT INTO donor_request_responses
           (request_id, donor_user_id, response, matched_at, response_deadline)
         SELECT ?, d.user_id, 'pending', UTC_TIMESTAMP(), ?
         FROM donors d
         JOIN users matched_user ON matched_user.user_id = d.user_id AND matched_user.role = 'donor'
         WHERE d.available = 1
           AND d.last_confirmed_at IS NOT NULL
           AND d.emergency_response_consent = 1
           AND ${DONOR_ELIGIBILITY_SQL}
           AND (
             (COALESCE(d.availability_mode, 'general') = 'general'
               AND d.availability_expires_at > UTC_TIMESTAMP())
             OR
             (COALESCE(d.availability_mode, 'general') = 'selected_dates'
               AND EXISTS (
                 SELECT 1 FROM donor_availability_dates ad
                 WHERE ad.donor_user_id = d.user_id
                   AND ad.available_date = DATE(?)
                   AND ad.status = 'available'
               ))
           )
           AND d.blood_group IN (${getCompatibleDonorBloodGroups(bloodGroup).map(() => '?').join(', ')})
           AND LOWER(d.city) = LOWER(?)
           AND LOWER(d.state) = LOWER(?)
           AND d.user_id <> ?`,
        [result.insertId, responseDeadline, sqlNeededAt,
          ...getCompatibleDonorBloodGroups(bloodGroup), city, state, req.user.user_id]
      );
      matchedDonorCount = matches.affectedRows;
    }
    await saveInAppNotification(connection, {
      recipientUserId: req.user.user_id,
      title: 'Emergency request received',
      message: `Your ${bloodGroup} blood request was submitted and is awaiting coordination.`,
      type: 'request_submitted',
      relatedRequestId: Number(result.insertId),
      dedupeKey: `request-submitted:${result.insertId}`
    });
    await saveAdminNotifications(connection, {
      title: 'New emergency blood request',
      message: `A ${bloodGroup} blood request was submitted for ${city}, ${state}.`,
      type: 'admin_request',
      relatedRequestId: Number(result.insertId),
      dedupeKey: `new-request:${result.insertId}`
    });
    await connection.execute(
      `INSERT IGNORE INTO in_app_notifications
         (recipient_user_id, title, message, notification_type, related_request_id,
          dedupe_key, created_at)
       SELECT dr.donor_user_id, 'Relevant emergency blood request',
              CONCAT('A request for ', r.blood_group, ' blood needs assistance in ',
                     r.city, '. Sign in to review the details.'),
              'emergency_request', r.request_id,
              CONCAT('emergency-request:', r.request_id), UTC_TIMESTAMP()
       FROM donor_request_responses dr
       JOIN blood_requests r ON r.request_id = dr.request_id
       WHERE dr.request_id = ?`,
      [result.insertId]
    );
    const [matchingBanks] = await connection.execute(
      `SELECT b.blood_bank_id, b.bank_name, b.address_text, b.phone, b.city, b.district, b.state,
              s.available_units,
              DATE_FORMAT(s.last_updated, '%Y-%m-%d') AS stock_date,
              DATE_FORMAT(s.last_updated, '%Y-%m-%dT%H:%i:%sZ') AS last_updated
       FROM blood_stock s
       JOIN blood_banks b ON b.blood_bank_id = s.blood_bank_id
       WHERE b.is_active = 1 AND (b.verification_status = 'verified' OR b.verified = 1)
         AND s.verification_status = 'verified'
         AND s.last_updated >= UTC_DATE()
         AND s.last_updated < DATE_ADD(UTC_DATE(), INTERVAL 1 DAY)
         AND s.blood_group = ? AND s.component = ? AND s.available_units >= ?
         AND LOWER(COALESCE(b.state, '')) = LOWER(?)
         AND (LOWER(COALESCE(b.city, '')) = LOWER(?)
           OR LOWER(COALESCE(b.district, '')) = LOWER(?))
       ORDER BY s.available_units ASC, b.bank_name LIMIT 50`,
      [bloodGroup, component, units, state, city, district]
    );
    const [bankNotifications] = await connection.execute(
      `INSERT IGNORE INTO blood_bank_notifications (staff_user_id, request_id, notification_type)
       SELECT s.user_id, ?, 'emergency_request'
       FROM blood_bank_staff s
       JOIN blood_banks b ON b.blood_bank_id = s.bank_id
       WHERE b.is_active = 1 AND (b.verification_status = 'verified' OR b.verified = 1)
         AND LOWER(COALESCE(b.state, '')) = LOWER(?)
         AND (LOWER(COALESCE(b.city, '')) = LOWER(?)
           OR LOWER(COALESCE(b.district, '')) = LOWER(?))`,
      [result.insertId, state, city, district]
    );
    await connection.execute(
      `INSERT INTO blood_request_events
         (request_id, actor_user_id, event_type, previous_status, new_status, details)
       VALUES (?, ?, 'stock_matches_checked', NULL, NULL, ?)`,
      [result.insertId, req.user.user_id, JSON.stringify({
        matching_bank_count: matchingBanks.length,
        staff_notifications_created: bankNotifications.affectedRows,
        stock_deducted: false
      })]
    );
    await connection.commit();
    res.status(201).json({
      message: matchedDonorCount
        ? 'Blood request saved. Matching donor notifications were created in the LifeDrop app; no email, SMS, or push notification was sent, and no response or donation is guaranteed.'
        : urgency === 'Urgent' && req.body.match_donors
          ? 'Blood request saved. No eligible opted-in donors matched this exact blood group and city; no notification was created.'
          : 'Blood request saved. No donor notifications were requested; no email, SMS, or push notification was sent.',
      request_id: String(result.insertId),
      status: 'Pending Verification',
      matched_donor_count: matchedDonorCount,
      matching_blood_banks: matchingBanks.map(bank => ({
        ...bank,
        available_units: Number(bank.available_units),
        availability_status: 'Available'
      })),
      bank_staff_notifications_created: Number(bankNotifications.affectedRows),
      inventory_reserved_or_deducted: false
    });
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    console.error('Blood-request creation failed:', error.code || 'ERROR', error.message);
    res.status(500).json({ message: 'Could not save the blood request.' });
  } finally {
    connection?.release();
  }
});

app.get('/api/my-blood-requests', requireDatabase, requireSession, async (req, res) => {
  if (req.user.role !== 'patient') {
    return res.status(403).json({ message: 'Patient accounts can view their request updates.' });
  }
  try {
    const [requests] = await db.execute(
      `SELECT CAST(request_id AS CHAR) AS request_id, blood_group, component,
              COALESCE(units, units_needed) AS units, urgency, city, district,
              status AS request_status, coordination_status,
              DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%sZ') AS submitted_at,
              DATE_FORMAT(needed_at, '%Y-%m-%dT%H:%i:%sZ') AS needed_at
       FROM blood_requests WHERE user_id = ?
       ORDER BY created_at DESC, request_id DESC LIMIT 100`,
      [req.user.user_id]
    );
    const [events] = requests.length
      ? await db.execute(
        `SELECT CAST(e.request_id AS CHAR) AS request_id, e.event_type,
                e.previous_status, e.new_status,
                DATE_FORMAT(e.created_at, '%Y-%m-%dT%H:%i:%sZ') AS created_at
         FROM blood_request_events e
         JOIN blood_requests r ON r.request_id = e.request_id
         WHERE r.user_id = ? AND e.event_type IN ('request_submitted', 'request_escalated', 'coordination_status')
         ORDER BY e.created_at DESC, e.event_id DESC LIMIT 500`,
        [req.user.user_id]
      )
      : [[]];
    const eventsByRequest = new Map();
    for (const event of events) {
      if (!eventsByRequest.has(event.request_id)) eventsByRequest.set(event.request_id, []);
      eventsByRequest.get(event.request_id).push(event);
    }
    res.set('Cache-Control', 'no-store');
    res.json({ requests: requests.map(request => ({
      ...request,
      units: Number(request.units),
      events: eventsByRequest.get(request.request_id) || []
    })) });
  } catch (error) {
    console.error('Patient request status lookup failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not load your request status updates.' });
  }
});

app.post('/api/blood-requests/:requestId/escalate', requireDatabase, requireSession,
  rateLimit(10, 60 * 60 * 1000), async (req, res) => {
    const requestId = req.params.requestId;
    if (req.user.role !== 'patient') {
      return res.status(403).json({ message: 'Only the patient who submitted the request can escalate it.' });
    }
    if (!/^[1-9]\d{0,19}$/.test(requestId)) {
      return res.status(400).json({ message: 'Choose a valid emergency request.' });
    }
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const [[request]] = await connection.execute(
        `SELECT request_id, status, urgency FROM blood_requests
         WHERE request_id = ? AND user_id = ? FOR UPDATE`,
        [requestId, req.user.user_id]
      );
      if (!request) {
        await connection.rollback();
        return res.status(404).json({ message: 'Request not found or you do not have permission to escalate it.' });
      }
      if (request.urgency !== 'Urgent' || ['Fulfilled', 'Cancelled'].includes(request.status)) {
        await connection.rollback();
        return res.status(409).json({ message: 'Only active urgent requests can be escalated.' });
      }
      const [existing] = await connection.execute(
        `SELECT event_id FROM blood_request_events
         WHERE request_id = ? AND event_type = 'request_escalated'
         LIMIT 1`,
        [requestId]
      );
      if (existing.length) {
        await connection.rollback();
        return res.status(409).json({ message: 'This urgent request is already escalated to the LifeDrop service-area coordinator queue.' });
      }
      await connection.execute(
        `INSERT INTO blood_request_events
           (request_id, actor_user_id, event_type, previous_status, new_status, details)
         VALUES (?, ?, 'request_escalated', ?, ?, ?)`,
        [requestId, req.user.user_id, request.status, request.status,
          JSON.stringify({ destination: 'LifeDrop service-area coordinator queue', external_delivery: false })]
      );
      await connection.commit();
      res.status(202).json({
        request_id: requestId,
        message: 'Urgent request flagged for the matching LifeDrop coordinator queue. It has not been sent to an external service; contact the hospital or blood bank directly now.'
      });
    } catch (error) {
      await connection.rollback().catch(() => {});
      console.error('Emergency request escalation failed:', error.code || error.message);
      res.status(500).json({ message: 'Could not escalate the emergency request.' });
    } finally {
      connection.release();
    }
  }
);

app.get('/api/blood-bank/notifications', requireDatabase, requireSession,
  requireBloodBankStaff, async (req, res) => {
    try {
      const [[count], [notifications]] = await Promise.all([
        db.execute(
          'SELECT COUNT(*) AS unread_count FROM blood_bank_notifications WHERE staff_user_id = ? AND read_at IS NULL',
          [req.user.user_id]
        ),
        db.execute(
          `SELECT n.notification_id, CAST(r.request_id AS CHAR) AS request_id,
                  r.blood_group, r.component, COALESCE(r.units, r.units_needed) AS units,
                  r.urgency, r.hospital_name, r.city, r.district, r.coordination_status,
                  DATE_FORMAT(n.created_at, '%Y-%m-%dT%H:%i:%sZ') AS created_at,
                  DATE_FORMAT(n.read_at, '%Y-%m-%dT%H:%i:%sZ') AS read_at
           FROM blood_bank_notifications n
           JOIN blood_requests r ON r.request_id = n.request_id
           WHERE n.staff_user_id = ?
           ORDER BY n.created_at DESC LIMIT 100`,
          [req.user.user_id]
        )
      ]);
      res.set('Cache-Control', 'no-store');
      res.json({ unread_count: Number(count[0].unread_count), notifications });
    } catch (error) {
      console.error('Blood-bank notifications lookup failed:', error.code || error.message);
      res.status(500).json({ message: 'Could not load blood-bank notifications.' });
    }
  }
);

app.post('/api/blood-bank/notifications/:notificationId/read', requireDatabase,
  requireSession, requireBloodBankStaff, async (req, res) => {
    const notificationId = req.params.notificationId;
    if (!/^[1-9]\d{0,19}$/.test(notificationId)) {
      return res.status(400).json({ message: 'Choose a valid bank notification.' });
    }
    try {
      const [result] = await db.execute(
        `UPDATE blood_bank_notifications SET read_at = COALESCE(read_at, UTC_TIMESTAMP())
         WHERE notification_id = ? AND staff_user_id = ?`,
        [notificationId, req.user.user_id]
      );
      if (!result.affectedRows) {
        return res.status(404).json({ message: 'Notification was not found for this staff account.' });
      }
      res.json({ message: 'Notification marked as read.' });
    } catch (error) {
      console.error('Blood-bank notification read update failed:', error.code || error.message);
      res.status(500).json({ message: 'Could not update the notification.' });
    }
  }
);

app.get('/api/blood-bank/emergency-requests', requireDatabase, requireSession,
  requireBloodBankStaff, async (req, res) => {
    try {
      const [requests] = await db.execute(
        `SELECT CAST(r.request_id AS CHAR) AS request_id, r.blood_group, r.component,
          COALESCE(r.units, r.units_needed) AS units, r.urgency, r.city, r.district,
          r.hospital_name, r.hospital_address, r.contact_name, r.contact_phone,
          r.coordination_status,
                  EXISTS (SELECT 1 FROM blood_request_events e
                          WHERE e.request_id = r.request_id
                            AND e.event_type = 'request_escalated') AS is_escalated,
                DATE_FORMAT(r.created_at, '%Y-%m-%dT%H:%i:%sZ') AS submitted_at,
                DATE_FORMAT(r.needed_at, '%Y-%m-%dT%H:%i:%sZ') AS needed_at
         FROM blood_requests r
         JOIN blood_banks b ON b.blood_bank_id = ?
         WHERE r.coordination_status IN ('Pending', 'Under Review', 'Accepted', 'In Progress')
           AND r.needed_at > UTC_TIMESTAMP()
           AND (r.coordinator_bank_id = b.blood_bank_id OR (
             r.coordinator_bank_id IS NULL
             AND LOWER(r.state) = LOWER(COALESCE(b.state, ''))
             AND (LOWER(r.city) = LOWER(COALESCE(b.city, ''))
               OR LOWER(r.district) = LOWER(COALESCE(b.district, '')))
           ))
         ORDER BY is_escalated DESC,
                  CASE WHEN LOWER(r.urgency) = 'urgent' THEN 0 ELSE 1 END,
                  r.needed_at, r.created_at
         LIMIT 200`,
        [req.bloodBank.bank_id]
      );
      res.set('Cache-Control', 'no-store');
      res.json({ requests: requests.map(request => ({ ...request, units: Number(request.units) })) });
    } catch (error) {
      console.error('Blood-bank emergency request lookup failed:', error.code || error.message);
      res.status(500).json({ message: 'Could not load requests for this blood bank.' });
    }
  }
);

app.post('/api/blood-bank/emergency-requests/:requestId/status', requireDatabase, requireSession,
  requireBloodBankStaff, rateLimit(60, 60 * 60 * 1000), async (req, res) => {
    const requestId = req.params.requestId;
    const status = req.body?.status;
    const allowedStatuses = new Set(['Under Review', 'Accepted', 'Rejected', 'In Progress', 'Fulfilled', 'Cancelled']);
    if (!/^[1-9]\d{0,19}$/.test(requestId) || !allowedStatuses.has(status) ||
        (status === 'Fulfilled' && req.body?.fulfillment_confirmed !== true)) {
      return res.status(400).json({ message: 'Choose a valid request status. Fulfilled requires explicit confirmation that the request was fulfilled.' });
    }
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const [[request]] = await connection.execute(
        `SELECT request_id, user_id, coordination_status, coordinator_bank_id
         FROM blood_requests WHERE request_id = ? FOR UPDATE`,
        [requestId]
      );
      if (!request) {
        await connection.rollback();
        return res.status(404).json({ message: 'Emergency request was not found.' });
      }
      const [inScope] = await connection.execute(
        `SELECT r.request_id
         FROM blood_requests r JOIN blood_banks b ON b.blood_bank_id = ?
         WHERE r.request_id = ? AND (
           r.coordinator_bank_id = b.blood_bank_id OR (
             r.coordinator_bank_id IS NULL
             AND LOWER(r.state) = LOWER(COALESCE(b.state, ''))
             AND (LOWER(r.city) = LOWER(COALESCE(b.city, ''))
               OR LOWER(r.district) = LOWER(COALESCE(b.district, '')))
           )
         ) LIMIT 1`,
        [req.bloodBank.bank_id, requestId]
      );
      if (!inScope.length) {
        await connection.rollback();
        return res.status(404).json({ message: 'Request not found for this blood bank.' });
      }
      if (request.coordinator_bank_id && request.coordinator_bank_id !== req.bloodBank.bank_id) {
        await connection.rollback();
        return res.status(409).json({ message: 'This request is assigned to another blood bank.' });
      }
      const validTransition = status === 'Under Review'
        ? request.coordination_status === 'Pending'
        : status === 'Accepted'
          ? ['Pending', 'Under Review'].includes(request.coordination_status)
        : status === 'Rejected'
          ? ['Pending', 'Under Review'].includes(request.coordination_status)
          : status === 'In Progress'
            ? ['Accepted', 'In Progress'].includes(request.coordination_status)
            : status === 'Fulfilled'
              ? ['Accepted', 'In Progress'].includes(request.coordination_status)
              : status === 'Cancelled'
                ? !['Fulfilled', 'Cancelled'].includes(request.coordination_status)
                : false;
      if (!validTransition) {
        await connection.rollback();
        return res.status(409).json({ message: `Cannot change ${request.coordination_status} to ${status}.` });
      }
      await connection.execute(
        `UPDATE blood_requests
         SET coordination_status = ?, coordinator_user_id = ?, coordinator_bank_id = ?,
             coordination_updated_at = UTC_TIMESTAMP()
         WHERE request_id = ?`,
        [status, req.user.user_id, req.bloodBank.bank_id, requestId]
      );
      const [eventResult] = await connection.execute(
        `INSERT INTO blood_request_events
           (request_id, actor_user_id, event_type, previous_status, new_status, details)
         VALUES (?, ?, 'coordination_status', ?, ?, ?)`,
        [requestId, req.user.user_id, request.coordination_status, status,
          JSON.stringify({ bank_id: req.bloodBank.bank_id, bank_name: req.bloodBank.bank_name,
            fulfillment_confirmed: status === 'Fulfilled' })]
      );
      await saveInAppNotification(connection, {
        recipientUserId: request.user_id,
        title: 'Blood request status updated',
        message: `An authorized blood-bank staff member updated your request to ${status}.`,
        type: 'request_status',
        relatedRequestId: Number(requestId),
        dedupeKey: `request-status-event:${eventResult.insertId}`
      });
      await connection.commit();
      res.json({
        request_id: requestId,
        coordination_status: status,
        message: status === 'Accepted'
          ? 'Your blood bank accepted the request. This is not confirmation that blood has been issued.'
          : status === 'Fulfilled'
            ? 'The blood bank marked the request fulfilled.'
            : `The request status was updated to ${status}.`
      });
    } catch (error) {
      await connection.rollback().catch(() => {});
      console.error('Blood-bank request status update failed:', error.code || error.message);
      res.status(500).json({ message: 'Could not update the request status.' });
    } finally {
      connection.release();
    }
  }
);

async function notifyAdditionalMatchingDonors(requestId) {
  const [[request]] = await db.execute(
    'SELECT blood_group FROM blood_requests WHERE request_id = ? LIMIT 1',
    [requestId]
  );
  if (!request) return 0;
  const compatibleBloodGroups = getCompatibleDonorBloodGroups(request.blood_group);
  if (!compatibleBloodGroups.length) return 0;
  const [[progress]] = await db.execute(
    `SELECT COUNT(*) AS active_responses
     FROM donor_request_responses
     WHERE request_id = ?
       AND (response = 'can_help'
         OR (response = 'pending' AND response_deadline > UTC_TIMESTAMP()))`,
    [requestId]
  );
  if (Number(progress.active_responses) > 0) return 0;
  const [result] = await db.execute(
    `INSERT IGNORE INTO donor_request_responses
       (request_id, donor_user_id, response, matched_at, response_deadline)
     SELECT r.request_id, d.user_id, 'pending', UTC_TIMESTAMP(),
            DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE)
     FROM blood_requests r
     JOIN donors d ON d.blood_group IN (${compatibleBloodGroups.map(() => '?').join(', ')})
     JOIN users u ON u.user_id = d.user_id AND u.role = 'donor'
     WHERE r.request_id = ?
       AND LOWER(r.urgency) = 'urgent'
       AND r.status NOT IN ('Fulfilled', 'Cancelled')
       AND r.needed_at > UTC_TIMESTAMP()
       AND d.available = 1
       AND d.last_confirmed_at IS NOT NULL
       AND d.emergency_response_consent = 1
      AND ${DONOR_ELIGIBILITY_SQL}
       AND LOWER(d.city) = LOWER(r.city)
       AND LOWER(d.state) = LOWER(r.state)
       AND (
         (COALESCE(d.availability_mode, 'general') = 'general'
           AND d.availability_expires_at > UTC_TIMESTAMP())
         OR
         (COALESCE(d.availability_mode, 'general') = 'selected_dates'
           AND EXISTS (
             SELECT 1 FROM donor_availability_dates ad
             WHERE ad.donor_user_id = d.user_id
               AND ad.available_date = DATE(r.needed_at)
               AND ad.status = 'available'
           ))
       )
       AND NOT EXISTS (
         SELECT 1 FROM donor_request_responses existing_response
         WHERE existing_response.request_id = r.request_id
           AND existing_response.donor_user_id = d.user_id
       )`,
    [DONOR_RESPONSE_WINDOW_MINUTES, ...compatibleBloodGroups, requestId]
  );
  if (result.affectedRows) {
    await db.execute(
      `INSERT IGNORE INTO in_app_notifications
         (recipient_user_id, title, message, notification_type, related_request_id,
          dedupe_key, created_at)
       SELECT dr.donor_user_id, 'Relevant emergency blood request',
              CONCAT('A request for ', r.blood_group, ' blood needs assistance in ',
                     r.city, '. Sign in to review the details.'),
              'emergency_request', r.request_id,
              CONCAT('emergency-request:', r.request_id), UTC_TIMESTAMP()
       FROM donor_request_responses dr
       JOIN blood_requests r ON r.request_id = dr.request_id
       WHERE dr.request_id = ?`,
      [requestId]
    );
  }
  return result.affectedRows;
}

async function createDonorReminderNotifications(userId) {
  await db.execute(
    `INSERT IGNORE INTO in_app_notifications
       (recipient_user_id, title, message, notification_type, dedupe_key, created_at)
     SELECT d.user_id, 'Eligibility review is due',
            'Your configured recovery interval has passed. Please review your eligibility portal and request qualified staff review.',
            'eligibility_review_due',
            CONCAT('eligibility-review-due:', d.user_id, ':',
              DATE_FORMAT(COALESCE(d.next_eligible_date,
                DATE_ADD(d.last_donation_date, INTERVAL ${DONATION_ELIGIBILITY_MONTHS} MONTH)), '%Y-%m-%d')),
            UTC_TIMESTAMP()
     FROM donors d
     WHERE d.user_id = ?
       AND d.last_donation_date IS NOT NULL
       AND COALESCE(d.next_eligible_date,
         DATE_ADD(d.last_donation_date, INTERVAL ${DONATION_ELIGIBILITY_MONTHS} MONTH)) <= UTC_DATE()
       AND NOT (${DONOR_ELIGIBILITY_SQL})`,
    [userId]
  );
  await db.execute(
    `INSERT IGNORE INTO in_app_notifications
       (recipient_user_id, title, message, notification_type, dedupe_key, created_at)
     SELECT d.user_id, 'Please reconfirm your availability',
            'Your previous availability confirmation has expired. Update your availability if you are ready to be considered for matching.',
            'availability_reconfirmation',
            CONCAT('availability-reconfirm:', d.user_id, ':',
              DATE_FORMAT(d.last_confirmed_at, '%Y%m%d%H%i%s')),
            UTC_TIMESTAMP()
     FROM donors d
     WHERE d.user_id = ?
       AND d.available = 1
       AND d.last_confirmed_at IS NOT NULL
       AND (
         (COALESCE(d.availability_mode, 'general') = 'general'
           AND d.availability_expires_at <= UTC_TIMESTAMP())
         OR
         (COALESCE(d.availability_mode, 'general') = 'selected_dates'
           AND NOT EXISTS (
             SELECT 1 FROM donor_availability_dates ad
             WHERE ad.donor_user_id = d.user_id
               AND ad.status = 'available'
               AND ad.available_date >= UTC_DATE()
           ))
       )`,
    [userId]
  );
}

app.get('/api/notifications', requireDatabase, requireSession, async (req, res) => {
  if (!['donor', 'patient'].includes(req.user.role)) {
    return res.status(403).json({ message: 'Notifications are not available for this account.' });
  }
  try {
    if (req.user.role === 'donor') {
      await createDonorReminderNotifications(req.user.user_id);
    }
    const [[count], [notifications]] = await Promise.all([
      db.execute(
        'SELECT COUNT(*) AS unread_count FROM in_app_notifications WHERE recipient_user_id = ? AND read_at IS NULL',
        [req.user.user_id]
      ),
      db.execute(
        `SELECT notification_id, title, message, notification_type,
                DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%sZ') AS created_at,
                DATE_FORMAT(read_at, '%Y-%m-%dT%H:%i:%sZ') AS read_at,
                related_request_id
         FROM in_app_notifications
         WHERE recipient_user_id = ?
         ORDER BY created_at DESC, notification_id DESC
         LIMIT 100`,
        [req.user.user_id]
      )
    ]);
    res.set('Cache-Control', 'no-store');
    res.json({ unread_count: Number(count[0].unread_count), notifications });
  } catch (error) {
    console.error('In-app notification lookup failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not load your notifications.' });
  }
});

app.post('/api/notifications/:notificationId/read', requireDatabase, requireSession,
  rateLimit(120, 60 * 60 * 1000), async (req, res) => {
    if (!['donor', 'patient'].includes(req.user.role)) {
      return res.status(403).json({ message: 'Notifications are not available for this account.' });
    }
    const notificationId = req.params.notificationId;
    if (!isValidNotificationId(notificationId)) {
      return res.status(400).json({ message: 'Choose a valid notification.' });
    }
    try {
      const [result] = await db.execute(
        `UPDATE in_app_notifications
         SET read_at = COALESCE(read_at, UTC_TIMESTAMP())
         WHERE notification_id = ? AND recipient_user_id = ?`,
        [notificationId, req.user.user_id]
      );
      if (!result.affectedRows) {
        const [owned] = await db.execute(
          `SELECT notification_id FROM in_app_notifications
           WHERE notification_id = ? AND recipient_user_id = ? LIMIT 1`,
          [notificationId, req.user.user_id]
        );
        if (!owned.length) return res.status(404).json({ message: 'Notification not found.' });
      }
      res.json({ message: 'Notification marked as read.' });
    } catch (error) {
      console.error('In-app notification read update failed:', error.code || error.message);
      res.status(500).json({ message: 'Could not update the notification.' });
    }
  });

app.get('/api/admin/notifications', requireDatabase, requireAdminConfigured, requireAdmin,
  async (req, res) => {
    try {
      await db.execute(
        `INSERT IGNORE INTO in_app_notifications
           (recipient_admin_id, title, message, notification_type, dedupe_key, created_at)
         SELECT a.admin_id, 'Donor eligibility review requested',
                'A donor eligibility review request is awaiting admin handling.',
                'eligibility_review_request',
                CONCAT('eligibility-request:', r.request_id), UTC_TIMESTAMP()
         FROM admin_users a
         JOIN donor_eligibility_review_requests r ON r.request_status = 'pending'`
      );
      await db.execute(
        `INSERT IGNORE INTO in_app_notifications
           (recipient_admin_id, title, message, notification_type, dedupe_key, created_at)
         SELECT a.admin_id, 'Blood bank daily update missing',
                CONCAT(b.bank_name, ' had not submitted a stock update for ', DATE_FORMAT(UTC_DATE(), '%Y-%m-%d'), ' (UTC) when this alert was generated.'),
                'blood_bank_stock_missing',
                CONCAT('missing-stock:', b.blood_bank_id, ':', DATE_FORMAT(UTC_DATE(), '%Y-%m-%d')),
                UTC_TIMESTAMP()
         FROM admin_users a
         CROSS JOIN blood_banks b
         WHERE b.is_active = 1
           AND (b.verification_status = 'verified' OR b.verified = 1)
           AND NOT EXISTS (
             SELECT 1 FROM blood_stock s
             WHERE s.blood_bank_id = b.blood_bank_id
               AND s.last_updated >= UTC_DATE()
               AND s.last_updated < DATE_ADD(UTC_DATE(), INTERVAL 1 DAY)
           )`
      );
      const [[count], [notifications]] = await Promise.all([
        db.execute(
          'SELECT COUNT(*) AS unread_count FROM in_app_notifications WHERE recipient_admin_id = ? AND read_at IS NULL',
          [req.admin.admin_id]
        ),
        db.execute(
          `SELECT notification_id, title, message, notification_type,
                  DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%sZ') AS created_at,
                  DATE_FORMAT(read_at, '%Y-%m-%dT%H:%i:%sZ') AS read_at,
                  related_request_id
           FROM in_app_notifications
           WHERE recipient_admin_id = ?
           ORDER BY created_at DESC, notification_id DESC
           LIMIT 100`,
          [req.admin.admin_id]
        )
      ]);
      res.set('Cache-Control', 'no-store');
      res.json({ unread_count: Number(count[0].unread_count), notifications });
    } catch (error) {
      console.error('Admin in-app notification lookup failed:', error.code || error.message);
      res.status(500).json({ message: 'Could not load admin notifications.' });
    }
  }
);

app.post('/api/admin/notifications/:notificationId/read', requireDatabase,
  requireAdminConfigured, requireAdmin, rateLimit(120, 60 * 60 * 1000), async (req, res) => {
    const notificationId = req.params.notificationId;
    if (!isValidNotificationId(notificationId)) {
      return res.status(400).json({ message: 'Choose a valid notification.' });
    }
    try {
      const [result] = await db.execute(
        `UPDATE in_app_notifications
         SET read_at = COALESCE(read_at, UTC_TIMESTAMP())
         WHERE notification_id = ? AND recipient_admin_id = ?`,
        [notificationId, req.admin.admin_id]
      );
      if (!result.affectedRows) {
        const [owned] = await db.execute(
          `SELECT notification_id FROM in_app_notifications
           WHERE notification_id = ? AND recipient_admin_id = ? LIMIT 1`,
          [notificationId, req.admin.admin_id]
        );
        if (!owned.length) return res.status(404).json({ message: 'Notification not found.' });
      }
      res.json({ message: 'Notification marked as read.' });
    } catch (error) {
      console.error('Admin notification read update failed:', error.code || error.message);
      res.status(500).json({ message: 'Could not update the notification.' });
    }
  });

app.get(['/api/donor/notifications', '/api/donor/emergency-requests'],
  requireDatabase, requireSession, async (req, res) => {
  if (req.user.role !== 'donor') {
    return res.status(403).json({ message: 'Only donor accounts can view matched emergency requests.' });
  }
  try {
    const [expiredRows] = await db.execute(
      `SELECT DISTINCT request_id
       FROM donor_request_responses
       WHERE donor_user_id = ? AND response = 'pending'
         AND response_deadline <= UTC_TIMESTAMP()`,
      [req.user.user_id]
    );
    await db.execute(
      `UPDATE donor_request_responses
       SET response = 'expired'
       WHERE donor_user_id = ? AND response = 'pending'
         AND response_deadline <= UTC_TIMESTAMP()`,
      [req.user.user_id]
    );
    for (const row of expiredRows) {
      await notifyAdditionalMatchingDonors(row.request_id);
    }
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
                   WHEN dr.response = 'expired'
                     OR (dr.response = 'pending' AND dr.response_deadline <= UTC_TIMESTAMP()) THEN 'No Response'
                   WHEN dr.response = 'pending' THEN 'Pending'
                   WHEN dr.response = 'can_help' THEN 'Accepted — Awaiting Contact'
                   WHEN dr.response = 'busy' THEN 'Busy'
                   ELSE 'Declined' END AS response_status,
              CASE
                WHEN d.available = 1 AND d.last_confirmed_at IS NOT NULL
                     AND COALESCE(d.availability_mode, 'general') = 'general'
                     AND d.availability_expires_at > UTC_TIMESTAMP() THEN 'Available'
                WHEN d.available = 1 AND d.last_confirmed_at IS NOT NULL
                     AND COALESCE(d.availability_mode, 'general') = 'selected_dates'
                     AND EXISTS (
                       SELECT 1 FROM donor_availability_dates ad
                       WHERE ad.donor_user_id = d.user_id
                         AND ad.available_date = DATE(r.needed_at)
                         AND ad.status = 'available'
                     ) THEN 'Available on selected date'
                WHEN d.last_confirmed_at IS NULL THEN 'Unconfirmed'
                WHEN d.available = 0 AND d.availability_status = 'temporarily_unavailable' THEN 'Temporarily Unavailable'
                WHEN d.available = 0 AND d.availability_status = 'not_available' THEN 'Not Available'
                ELSE 'Unconfirmed'
              END AS donor_availability_status,
              CASE WHEN d.available = 1 AND d.last_confirmed_at IS NOT NULL
                         AND d.emergency_response_consent = 1
                         AND ${DONOR_ELIGIBILITY_SQL}
                         AND (
                           (COALESCE(d.availability_mode, 'general') = 'general'
                             AND d.availability_expires_at > UTC_TIMESTAMP())
                           OR
                           (COALESCE(d.availability_mode, 'general') = 'selected_dates'
                             AND EXISTS (
                               SELECT 1 FROM donor_availability_dates ad
                               WHERE ad.donor_user_id = d.user_id
                                 AND ad.available_date = DATE(r.needed_at)
                                 AND ad.status = 'available'
                             ))
                         )
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
        !['can_help', 'cannot_help', 'busy', 'declined'].includes(response) ||
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
             ? IN ('busy', 'declined') OR
             d.available = 1
             AND d.last_confirmed_at IS NOT NULL
             AND d.emergency_response_consent = 1
             AND ${DONOR_ELIGIBILITY_SQL}
             AND (
               (COALESCE(d.availability_mode, 'general') = 'general'
                 AND d.availability_expires_at > UTC_TIMESTAMP())
               OR
               (COALESCE(d.availability_mode, 'general') = 'selected_dates'
                 AND EXISTS (
                   SELECT 1 FROM donor_availability_dates ad
                   WHERE ad.donor_user_id = d.user_id
                     AND ad.available_date = DATE(r.needed_at)
                     AND ad.status = 'available'
                 ))
             )
           ))`,
        [response, response === 'can_help' && shareContact ? 1 : 0,
          requestId, req.user.user_id, response, response]
      );
      if (!result.affectedRows) {
        const [matches] = await db.execute(
          `SELECT dr.response, dr.response_deadline <= UTC_TIMESTAMP() AS expired,
                  r.status, d.availability_status, d.available, d.last_confirmed_at,
                  d.emergency_response_consent, d.availability_mode,
                  (
                    COALESCE(d.availability_mode, 'general') = 'general'
                    AND d.availability_expires_at > UTC_TIMESTAMP()
                  ) OR (
                    COALESCE(d.availability_mode, 'general') = 'selected_dates'
                    AND EXISTS (
                      SELECT 1 FROM donor_availability_dates ad
                      WHERE ad.donor_user_id = d.user_id
                        AND ad.available_date = DATE(r.needed_at)
                        AND ad.status = 'available'
                    )
                  ) AS confirmation_current
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
      let patientNotificationFailed = false;
      try {
        await db.execute(
          `INSERT IGNORE INTO in_app_notifications
             (recipient_user_id, title, message, notification_type, related_request_id,
              dedupe_key, created_at)
           SELECT r.user_id, 'Donor response received',
                  CONCAT('A matched donor responded to your request: ',
                    CASE ? WHEN 'can_help' THEN 'available to help'
                      WHEN 'busy' THEN 'busy' ELSE 'unable to help' END, '.'),
                  'donor_response', r.request_id,
                  CONCAT('donor-response:', r.request_id, ':', ?), UTC_TIMESTAMP()
           FROM blood_requests r
           WHERE r.request_id = ?`,
          [response, req.user.user_id, requestId]
        );
      } catch (error) {
        patientNotificationFailed = true;
        console.error('Patient donor-response notification failed:', error.code || error.message);
      }
      let additionalNotifications = 0;
      let additionalMatchingFailed = false;
      if (response !== 'can_help') {
        try {
          additionalNotifications = await notifyAdditionalMatchingDonors(requestId);
        } catch (error) {
          additionalMatchingFailed = true;
          console.error('Additional donor matching failed:', error.code || error.message);
        }
      }
      res.json({
        message: patientNotificationFailed
          ? 'Your response was saved, but the patient notification could not be saved.'
          : response === 'can_help'
            ? 'Your response was saved. The patient must still coordinate with the hospital.'
            : additionalMatchingFailed
            ? 'Your response was saved, but additional donor matching could not be completed.'
            : additionalNotifications
              ? `Your response was saved. ${additionalNotifications} additional matching donor notification(s) were created.`
              : 'Your response was saved.',
        response_status: response === 'can_help'
          ? 'Accepted — Awaiting Contact'
          : response === 'busy' ? 'Busy' : 'Declined',
        contact_shared: response === 'can_help' && shareContact,
        additional_notifications: additionalNotifications
      });
    } catch (error) {
      console.error('Emergency request response failed:', error.code || error.message);
      res.status(500).json({ message: 'Could not save your emergency request response.' });
    }
  });

app.get('/api/my-emergency-responses', requireDatabase, requireSession, async (req, res) => {
  try {
    if (req.user.role !== 'patient') {
      return res.status(403).json({ message: 'Patient accounts can view their own emergency request responses.' });
    }
    const [expiredRows] = await db.execute(
      `SELECT DISTINCT dr.request_id
       FROM donor_request_responses dr
       JOIN blood_requests r ON r.request_id = dr.request_id
       WHERE r.user_id = ? AND dr.response = 'pending'
         AND dr.response_deadline <= UTC_TIMESTAMP()`,
      [req.user.user_id]
    );
    await db.execute(
      `UPDATE donor_request_responses dr
       JOIN blood_requests r ON r.request_id = dr.request_id
       SET dr.response = 'expired'
       WHERE r.user_id = ? AND dr.response = 'pending'
         AND dr.response_deadline <= UTC_TIMESTAMP()`,
      [req.user.user_id]
    );
    for (const row of expiredRows) {
      await notifyAdditionalMatchingDonors(row.request_id);
    }
    const [rows] = await db.execute(
      `SELECT CAST(r.request_id AS CHAR) AS request_id,
              r.blood_group, r.units, r.urgency, r.city, r.district,
              DATE_FORMAT(r.needed_at, '%Y-%m-%dT%H:%i:%sZ') AS needed_at,
              DATE_FORMAT(r.created_at, '%Y-%m-%dT%H:%i:%sZ') AS requested_at,
              r.status AS request_status, dr.response,
              CASE WHEN r.status IN ('Fulfilled', 'Cancelled') THEN 'Request Closed'
                   WHEN dr.response = 'expired'
                     OR (dr.response = 'pending' AND dr.response_deadline <= UTC_TIMESTAMP())
                     OR dr.response IS NULL THEN 'Expired'
                   WHEN dr.response = 'pending' THEN 'Pending'
                   WHEN dr.response = 'can_help' THEN 'Accepted — Awaiting Contact'
                   WHEN dr.response = 'busy' THEN 'Busy'
                   ELSE 'Declined' END AS response_status,
              CASE
                WHEN dr.donor_user_id IS NULL OR d.emergency_response_consent = 0 THEN NULL
                WHEN d.available = 1 AND d.last_confirmed_at IS NOT NULL
                     AND d.availability_expires_at > UTC_TIMESTAMP() THEN 'Available'
                WHEN d.last_confirmed_at IS NULL THEN 'Unconfirmed'
                WHEN d.available = 0 AND d.availability_status = 'temporarily_unavailable' THEN 'Temporarily Unavailable'
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
          counts: { can_help: 0, cannot_help: 0, busy: 0, pending: 0, no_response: 0 },
          donor_responses: []
        });
      }
      const request = requestMap.get(row.request_id);
      if (row.response === 'can_help') request.counts.can_help += 1;
      if (['cannot_help', 'declined'].includes(row.response)) request.counts.cannot_help += 1;
      if (row.response === 'busy') request.counts.busy += 1;
      if (row.response === 'pending' && row.response_status === 'Pending') {
        request.counts.pending += 1;
      }
      if (!row.response || ['Expired', 'No Response'].includes(row.response_status)) request.counts.no_response += 1;
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
        request.status = 'Donor responded — confirmation pending';
      } else if (request.counts.pending) {
        request.status = 'Pending';
      } else if (request.counts.busy && !request.counts.cannot_help) {
        request.status = 'Busy';
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
        ? formatSqlUtcDateTime(new Date(Math.ceil(Date.now() / 1000) * 1000 + AVAILABILITY_HOURS * 60 * 60 * 1000))
        : null;
      const donorValues = [
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
          isAvailable ? formatSqlUtcDateTime(new Date()) : null
        ];
      if (PORTAL_SCHEMA) {
        await connection.execute(
          `INSERT INTO donors
           (user_id, full_name, age, gender, blood_group, phone, city, state, place,
            last_donation_date, available, is_available, public_contact_consent,
            availability_expires_at, available_until, availability_status,
            availability_mode, last_confirmed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            ...donorValues.slice(0, 10),
            isAvailable ? 1 : 0,
            isAvailable ? 1 : 0,
            isAvailable ? 1 : 0,
            availabilityExpiresAt,
            availabilityExpiresAt,
            isAvailable ? 'available' : 'not_available',
            isAvailable ? 'general' : 'unavailable',
            isAvailable ? formatSqlUtcDateTime(new Date()) : null
          ]
        );
      } else {
        await connection.execute(
          `INSERT INTO donors
           (user_id, full_name, age, gender, blood_group, phone, city, state, place,
            last_donation_date, available, public_contact_consent, availability_expires_at,
            availability_status, last_confirmed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          donorValues
        );
      }
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
    const userRole = normalizeUserRole(user.role);
    res.json({
      message: 'Login successful.',
      user: {
        user_id: user.user_id,
        username: user.username,
        full_name: user.full_name,
        email: user.email,
        role: userRole,
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
    const [[countRows], [donors], [patients], [patientRequests], [bloodRequests], [recentDonations]] = await Promise.all([
      db.execute(
        `SELECT
           (SELECT COUNT(*) FROM users WHERE role IN ('donor', 'patient', 'recipient')) AS total_registrations,
           (SELECT COUNT(*) FROM users WHERE role = 'donor') AS donor_count,
           (SELECT COUNT(*) FROM users WHERE role IN ('patient', 'recipient')) AS patient_count,
           ((SELECT COUNT(*) FROM patients) + (SELECT COUNT(*) FROM blood_requests)) AS patient_request_count,
           (SELECT COUNT(*) FROM donors d WHERE (${DONOR_AVAILABILITY_STATUS_SQL}) = 'available') AS available_donor_count,
           (SELECT COUNT(*) FROM donors d WHERE (${DONOR_AVAILABILITY_STATUS_SQL}) = 'unavailable') AS unavailable_donor_count,
           (SELECT COUNT(*) FROM donors d WHERE (${DONOR_AVAILABILITY_STATUS_SQL}) = 'temporarily_unavailable') AS temporarily_unavailable_donor_count,
           (SELECT COUNT(*) FROM donors d WHERE (${DONOR_AVAILABILITY_STATUS_SQL}) = 'unconfirmed') AS unconfirmed_donor_count,
           (SELECT COUNT(*) FROM donors d WHERE (${DONOR_AVAILABILITY_STATUS_SQL}) = 'expired') AS expired_donor_count,
           (SELECT COUNT(*) FROM donors d
            WHERE COALESCE(d.next_eligible_date,
              DATE_ADD(d.last_donation_date, INTERVAL ${DONATION_ELIGIBILITY_MONTHS} MONTH)) > UTC_DATE()) AS donors_in_cooldown,
           (SELECT COUNT(*) FROM donors d
            WHERE d.last_donation_date IS NOT NULL
              AND COALESCE(d.next_eligible_date,
                DATE_ADD(d.last_donation_date, INTERVAL ${DONATION_ELIGIBILITY_MONTHS} MONTH)) <= UTC_DATE()
              AND NOT (${DONOR_ELIGIBILITY_SQL})) AS donors_awaiting_eligibility_review,
           (SELECT COUNT(*) FROM donors d
            WHERE (${DONOR_AVAILABILITY_STATUS_SQL}) = 'expired') AS stale_availability_count,
           (SELECT COUNT(*) FROM blood_requests WHERE status IN ('Pending Verification', 'Under Review')) AS pending_emergency_requests`
      ),
      db.execute(
        `SELECT u.user_id, u.username, u.full_name, u.email, u.age, u.gender, u.blood_group,
                u.phone, u.city, u.state, u.place,
                DATE_FORMAT(u.created_at, '%Y-%m-%dT%H:%i:%sZ') AS registered_at,
                DATE_FORMAT(d.last_donation_date, '%Y-%m-%d') AS last_donation_date,
                DATE_FORMAT(COALESCE(d.next_eligible_date,
                  DATE_ADD(d.last_donation_date, INTERVAL ${DONATION_ELIGIBILITY_MONTHS} MONTH)),
                  '%Y-%m-%d') AS next_eligible_date,
                CASE
                  WHEN COALESCE(d.next_eligible_date,
                    DATE_ADD(d.last_donation_date, INTERVAL ${DONATION_ELIGIBILITY_MONTHS} MONTH)) > UTC_DATE()
                    THEN 'in_cooldown'
                  WHEN (${DONOR_ELIGIBILITY_SQL}) THEN 'eligible'
                  ELSE 'awaiting_review'
                END AS eligibility_status,
                (SELECT er.decision FROM donor_eligibility_reviews er
                 WHERE er.donor_user_id = d.user_id
                 ORDER BY er.reviewed_at DESC, er.review_id DESC LIMIT 1) AS eligibility_review_decision,
                (SELECT reviewer.full_name FROM donor_eligibility_reviews er
                 JOIN users reviewer ON reviewer.user_id = er.reviewed_by_user_id
                 WHERE er.donor_user_id = d.user_id
                 ORDER BY er.reviewed_at DESC, er.review_id DESC LIMIT 1) AS eligibility_reviewed_by,
                (SELECT DATE_FORMAT(er.reviewed_at, '%Y-%m-%dT%H:%i:%sZ')
                 FROM donor_eligibility_reviews er
                 WHERE er.donor_user_id = d.user_id
                 ORDER BY er.reviewed_at DESC, er.review_id DESC LIMIT 1) AS eligibility_reviewed_at,
                DATE_FORMAT(d.last_confirmed_at, '%Y-%m-%dT%H:%i:%sZ') AS availability_confirmed_at,
                ${DONOR_AVAILABILITY_STATUS_SQL} AS availability_status_code,
                CASE ${DONOR_AVAILABILITY_STATUS_SQL}
                  WHEN 'available' THEN 1 ELSE 0
                END AS is_available,
                CASE
                  WHEN (${DONOR_AVAILABILITY_STATUS_SQL}) = 'available' THEN 'Available'
                  WHEN (${DONOR_AVAILABILITY_STATUS_SQL}) = 'temporarily_unavailable' THEN 'Temporarily Unavailable'
                  WHEN (${DONOR_AVAILABILITY_STATUS_SQL}) = 'unavailable' THEN 'Not Available'
                  WHEN (${DONOR_AVAILABILITY_STATUS_SQL}) = 'expired' THEN 'Expired'
                  ELSE 'Unconfirmed'
                END AS availability_status,
                COALESCE(d.availability_mode, 'general') AS availability_mode,
                (SELECT GROUP_CONCAT(
                   CONCAT(DATE_FORMAT(ad.available_date, '%Y-%m-%d'), ': ', ad.status)
                   ORDER BY ad.available_date SEPARATOR ', ')
                 FROM donor_availability_dates ad
                 WHERE ad.donor_user_id = d.user_id
                   AND ad.available_date >= UTC_DATE()) AS availability_dates,
                DATE_FORMAT(d.last_confirmed_at, '%Y-%m-%dT%H:%i:%sZ') AS last_confirmed_at,
                COALESCE(DATE_FORMAT(d.availability_expires_at, '%Y-%m-%dT%H:%i:%sZ'),
                         DATE_FORMAT(d.available_until, '%Y-%m-%dT%H:%i:%sZ')) AS available_until
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
         WHERE u.role IN ('patient', 'recipient')
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
                DATE_FORMAT(needed_at, '%Y-%m-%dT%H:%i:%sZ') AS needed_at,
                (SELECT COUNT(*) FROM donor_request_responses dr
                 WHERE dr.request_id = blood_requests.request_id) AS donors_notified,
                (SELECT COUNT(*) FROM donor_request_responses dr
                 WHERE dr.request_id = blood_requests.request_id AND dr.response = 'can_help') AS donors_accepted,
                (SELECT COUNT(*) FROM donor_request_responses dr
                 WHERE dr.request_id = blood_requests.request_id
                   AND dr.response = 'pending' AND dr.response_deadline > UTC_TIMESTAMP()) AS responses_pending,
                (SELECT COUNT(*) FROM donor_request_responses dr
                 WHERE dr.request_id = blood_requests.request_id
                   AND dr.response IN ('cannot_help', 'declined', 'busy')) AS donors_declined_or_busy,
                (SELECT COUNT(*) FROM donor_request_responses dr
                 WHERE dr.request_id = blood_requests.request_id
                   AND (dr.response = 'expired'
                     OR (dr.response = 'pending' AND dr.response_deadline <= UTC_TIMESTAMP()))) AS responses_no_response
         FROM blood_requests
         ORDER BY created_at DESC, request_id DESC`
      ),
      db.execute(
        `SELECT dh.donation_id, u.full_name, d.blood_group,
                DATE_FORMAT(dh.donation_date, '%Y-%m-%d') AS donation_date,
                DATE_FORMAT(dh.next_eligible_date, '%Y-%m-%d') AS next_eligible_date,
                DATE_FORMAT(dh.verified_at, '%Y-%m-%dT%H:%i:%sZ') AS verified_at
         FROM donor_donation_history dh
         JOIN users u ON u.user_id = dh.donor_user_id
         JOIN donors d ON d.user_id = dh.donor_user_id
         WHERE dh.verification_status = 'verified'
         ORDER BY dh.verified_at DESC, dh.donation_id DESC
         LIMIT 10`
      )
    ]);
    const counts = countRows[0];
    res.json({
      counts: {
        total_registrations: Number(counts.total_registrations),
        donor_count: Number(counts.donor_count),
        patient_count: Number(counts.patient_count),
        patient_request_count: Number(counts.patient_request_count),
        available_donor_count: Number(counts.available_donor_count),
        unavailable_donor_count: Number(counts.unavailable_donor_count),
        temporarily_unavailable_donor_count: Number(counts.temporarily_unavailable_donor_count),
        unconfirmed_donor_count: Number(counts.unconfirmed_donor_count),
        expired_donor_count: Number(counts.expired_donor_count),
        donors_in_cooldown: Number(counts.donors_in_cooldown),
        donors_awaiting_eligibility_review: Number(counts.donors_awaiting_eligibility_review),
        stale_availability_count: Number(counts.stale_availability_count),
        pending_emergency_requests: Number(counts.pending_emergency_requests)
      },
      donors,
      patients,
      patient_requests: patientRequests,
      blood_requests: bloodRequests,
      recent_verified_donations: recentDonations,
      refreshed_at: new Date().toISOString()
    });
  } catch (error) {
    console.error('Admin dashboard lookup failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not load registrations from MySQL.' });
  }
});

app.get('/api/admin/donations', requireDatabase, requireAdminConfigured, requireAdmin, async (req, res) => {
  try {
    const [[donors], [donations], [corrections]] = await Promise.all([
      db.execute(
        `SELECT d.user_id AS donor_user_id, u.full_name, d.blood_group
         FROM donors d JOIN users u ON u.user_id = d.user_id AND u.role = 'donor'
         ORDER BY u.full_name, d.user_id`
      ),
      db.execute(
        `SELECT dh.donation_id, dh.donor_user_id, u.full_name, d.blood_group,
                DATE_FORMAT(dh.donation_date, '%Y-%m-%d') AS donation_date,
                dh.eligibility_interval_months,
                DATE_FORMAT(dh.next_eligible_date, '%Y-%m-%d') AS next_eligible_date,
                dh.verification_status, dh.recorded_by_admin_username,
                dh.verified_by_admin_username,
                DATE_FORMAT(dh.verified_at, '%Y-%m-%dT%H:%i:%sZ') AS verified_at,
                dh.notes
         FROM donor_donation_history dh
         JOIN users u ON u.user_id = dh.donor_user_id
         JOIN donors d ON d.user_id = dh.donor_user_id
         ORDER BY dh.donation_date DESC, dh.donation_id DESC
         LIMIT 500`
      ),
      db.execute(
        `SELECT c.correction_id, c.donation_id, u.full_name,
                DATE_FORMAT(c.previous_donation_date, '%Y-%m-%d') AS previous_donation_date,
                DATE_FORMAT(c.corrected_donation_date, '%Y-%m-%d') AS corrected_donation_date,
                a.username AS corrected_by,
                DATE_FORMAT(c.corrected_at, '%Y-%m-%dT%H:%i:%sZ') AS corrected_at,
                c.correction_note
         FROM donor_donation_history_corrections c
         JOIN users u ON u.user_id = c.donor_user_id
         JOIN admin_users a ON a.admin_id = c.corrected_by_admin_id
         ORDER BY c.corrected_at DESC, c.correction_id DESC
         LIMIT 500`
      )
    ]);
    res.set('Cache-Control', 'no-store');
    res.json({ donors, donations, corrections, eligibility_interval_months: DONATION_ELIGIBILITY_MONTHS });
  } catch (error) {
    console.error('Admin donation history lookup failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not load donation history.' });
  }
});

app.patch('/api/admin/donations/:donationId', requireDatabase, requireAdminConfigured,
  requireAdmin, rateLimit(30, 60 * 60 * 1000), async (req, res) => {
    const donationId = Number(req.params.donationId);
    const donationDate = req.body?.donation_date;
    const correctionNote = typeof req.body?.correction_note === 'string'
      ? req.body.correction_note.trim()
      : '';
    const today = new Date().toISOString().slice(0, 10);
    if (!Number.isSafeInteger(donationId) || donationId < 1 ||
        !isValidDonationDate(donationDate, today) ||
        !correctionNote || correctionNote.length > 500) {
      return res.status(400).json({ message: 'Enter a valid non-future donation date and a correction note under 500 characters.' });
    }
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const [[donation]] = await connection.execute(
        `SELECT donation_id, donor_user_id, donation_date, verification_status
         FROM donor_donation_history WHERE donation_id = ? FOR UPDATE`,
        [donationId]
      );
      if (!donation || donation.verification_status !== 'verified') {
        await connection.rollback();
        return res.status(404).json({ message: 'Verified donation record was not found.' });
      }
      const previousDonationDate = formatDatabaseDateOnly(donation.donation_date);
      if (previousDonationDate === donationDate) {
        await connection.rollback();
        return res.status(400).json({ message: 'The corrected date must differ from the current record.' });
      }
      const nextReviewDate = addCalendarMonths(donationDate, DONATION_ELIGIBILITY_MONTHS);
      await connection.execute(
        `INSERT INTO donor_donation_history_corrections
           (donation_id, donor_user_id, previous_donation_date, corrected_donation_date,
            corrected_by_admin_id, correction_note, corrected_at)
         VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
        [donationId, donation.donor_user_id, previousDonationDate,
          donationDate, req.admin.admin_id, correctionNote]
      );
      await connection.execute(
        `UPDATE donor_donation_history
         SET donation_date = ?, eligibility_interval_months = ?, next_eligible_date = ?,
             verified_by_admin_username = ?, verified_at = UTC_TIMESTAMP()
         WHERE donation_id = ?`,
        [donationDate, DONATION_ELIGIBILITY_MONTHS, nextReviewDate,
          req.admin.username, donationId]
      );
      const [[latestDonation]] = await connection.execute(
        `SELECT donation_date, next_eligible_date FROM donor_donation_history
         WHERE donor_user_id = ? AND verification_status = 'verified'
         ORDER BY donation_date DESC, donation_id DESC LIMIT 1`,
        [donation.donor_user_id]
      );
      await connection.execute(
        `UPDATE donors
         SET last_donation_date = ?, next_eligible_date = ?, available = 0, is_available = 0,
             availability_status = 'not_available', availability_mode = 'unavailable',
             availability_expires_at = NULL, available_until = NULL,
             public_contact_consent = 0, emergency_response_consent = 0
         WHERE user_id = ?`,
        [latestDonation.donation_date, latestDonation.next_eligible_date, donation.donor_user_id]
      );
      if (PORTAL_SCHEMA) {
        await connection.execute(
          `INSERT INTO donor_availability
             (donor_user_id, is_available, confirmed_at, expires_at)
           VALUES (?, 0, UTC_TIMESTAMP(), NULL)
           ON DUPLICATE KEY UPDATE is_available = 0, confirmed_at = UTC_TIMESTAMP(), expires_at = NULL`,
          [donation.donor_user_id]
        );
      }
      await connection.commit();
      res.json({
        donation_id: donationId,
        donation_date: donationDate,
        next_review_date: nextReviewDate,
        message: 'Donation date corrected with an audit record. The donor must complete a new recovery period, medical review, and availability confirmation.'
      });
    } catch (error) {
      await connection.rollback().catch(() => {});
      console.error('Donation correction failed:', error.code || error.message);
      res.status(500).json({ message: 'Could not correct the donation record.' });
    } finally {
      connection.release();
    }
  });

app.get('/api/admin/eligibility-requests', requireDatabase, requireAdminConfigured,
  requireAdmin, async (req, res) => {
    try {
      const [[requests], [reviews]] = await Promise.all([
        db.execute(
        `SELECT r.request_id, r.donor_user_id, u.full_name, d.blood_group,
                DATE_FORMAT(r.requested_at, '%Y-%m-%dT%H:%i:%sZ') AS requested_at,
                r.request_status,
                a.username AS reviewed_by,
                DATE_FORMAT(r.reviewed_at, '%Y-%m-%dT%H:%i:%sZ') AS reviewed_at,
                r.instructions,
                DATE_FORMAT(d.last_donation_date, '%Y-%m-%d') AS last_donation_date,
                DATE_FORMAT(COALESCE(d.next_eligible_date,
                  DATE_ADD(d.last_donation_date, INTERVAL ${DONATION_ELIGIBILITY_MONTHS} MONTH)),
                  '%Y-%m-%d') AS next_review_date,
                (SELECT er.decision FROM donor_eligibility_reviews er
                 WHERE er.donor_user_id = d.user_id
                 ORDER BY er.reviewed_at DESC, er.review_id DESC LIMIT 1) AS latest_staff_decision
         FROM donor_eligibility_review_requests r
         JOIN users u ON u.user_id = r.donor_user_id
         JOIN donors d ON d.user_id = r.donor_user_id
         LEFT JOIN admin_users a ON a.admin_id = r.reviewed_by_admin_id
         ORDER BY CASE WHEN r.request_status = 'pending' THEN 0 ELSE 1 END,
                  r.requested_at DESC
         LIMIT 250`
        ),
        db.execute(
          `SELECT er.review_id, er.donor_user_id, u.full_name, d.blood_group,
                  er.decision, a.full_name AS reviewed_by,
                  DATE_FORMAT(er.reviewed_at, '%Y-%m-%dT%H:%i:%sZ') AS reviewed_at,
                  er.notes
           FROM donor_eligibility_reviews er
           JOIN users u ON u.user_id = er.donor_user_id
           JOIN donors d ON d.user_id = er.donor_user_id
           JOIN users a ON a.user_id = er.reviewed_by_user_id
           ORDER BY er.reviewed_at DESC, er.review_id DESC
           LIMIT 250`
        )
      ]);
      res.set('Cache-Control', 'no-store');
      res.json({ requests, reviews });
    } catch (error) {
      console.error('Admin eligibility request queue lookup failed:', error.code || error.message);
      res.status(500).json({ message: 'Could not load eligibility review requests.' });
    }
  });

app.patch('/api/admin/eligibility-requests/:requestId', requireDatabase,
  requireAdminConfigured, requireAdmin, rateLimit(30, 60 * 60 * 1000), async (req, res) => {
    const requestId = Number(req.params.requestId);
    const decision = req.body?.decision;
    const instructions = typeof req.body?.instructions === 'string' ? req.body.instructions.trim() : '';
    if (!Number.isSafeInteger(requestId) || requestId < 1 ||
        !['approved', 'rejected'].includes(decision) || instructions.length > 500 ||
        (decision === 'rejected' && !instructions)) {
      return res.status(400).json({ message: 'Choose approve or reject and provide instructions for a rejection.' });
    }
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const [[request]] = await connection.execute(
        `SELECT r.request_id, r.donor_user_id, r.request_status,
                COALESCE(d.next_eligible_date,
                  DATE_ADD(d.last_donation_date, INTERVAL ${DONATION_ELIGIBILITY_MONTHS} MONTH)) AS next_review_date
         FROM donor_eligibility_review_requests r
         JOIN donors d ON d.user_id = r.donor_user_id
         WHERE r.request_id = ? FOR UPDATE`,
        [requestId]
      );
      if (!request || request.request_status !== 'pending') {
        await connection.rollback();
        return res.status(404).json({ message: 'Pending eligibility review request was not found.' });
      }
      if (decision === 'approved') {
        const [[screening]] = await connection.execute(
          `SELECT review_status, submitted_at, health_data_consent_at
           FROM donor_health_screenings WHERE donor_user_id = ?
           ORDER BY submitted_at DESC, screening_id DESC LIMIT 1`,
          [request.donor_user_id]
        );
        const [[latestDonation]] = await connection.execute(
          `SELECT MAX(verified_at) AS verified_at
           FROM donor_donation_history
           WHERE donor_user_id = ? AND verification_status = 'verified'`,
          [request.donor_user_id]
        );
        const screenCurrent = screening?.review_status === 'Cleared' &&
          screening.health_data_consent_at &&
          (!latestDonation.verified_at ||
            new Date(screening.submitted_at).getTime() >= new Date(latestDonation.verified_at).getTime());
        if (!screenCurrent || (request.next_review_date &&
            new Date(request.next_review_date).toISOString().slice(0, 10) >
              new Date().toISOString().slice(0, 10))) {
          await connection.rollback();
          return res.status(409).json({ message: 'A current cleared screening and completed recovery period are required to accept this review request.' });
        }
      }
      await connection.execute(
        `UPDATE donor_eligibility_review_requests
         SET request_status = ?, reviewed_by_admin_id = ?, reviewed_at = UTC_TIMESTAMP(),
             instructions = ?
         WHERE request_id = ? AND request_status = 'pending'`,
        [decision, req.admin.admin_id, instructions || null, requestId]
      );
      await connection.commit();
      res.json({
        request_status: decision,
        message: decision === 'approved'
          ? 'Review request accepted and recorded. This is not medical eligibility approval; qualified blood-bank staff must make the eligibility decision.'
          : 'Review request rejected with instructions. The donor remains excluded from matching until a qualified eligibility review is completed.'
      });
    } catch (error) {
      await connection.rollback().catch(() => {});
      console.error('Admin eligibility request review failed:', error.code || error.message);
      res.status(500).json({ message: 'Could not update the eligibility review request.' });
    } finally {
      connection.release();
    }
  });

app.post('/api/admin/donors/:donorId/donations', requireDatabase, requireAdminConfigured,
  requireAdmin, rateLimit(30, 60 * 60 * 1000), async (req, res) => {
    const donorId = Number(req.params.donorId);
    const donationDate = req.body?.donation_date;
    const notes = typeof req.body?.notes === 'string' ? req.body.notes.trim() : '';
    const today = new Date().toISOString().slice(0, 10);
    if (!Number.isSafeInteger(donorId) || donorId < 1 ||
        !isValidDonationDate(donationDate, today) || notes.length > 500) {
      return res.status(400).json({ message: 'Choose a donor, enter a valid donation date that is not in the future, and keep notes under 500 characters.' });
    }
    const nextEligibleDate = addCalendarMonths(donationDate, DONATION_ELIGIBILITY_MONTHS);
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const [[donor]] = await connection.execute(
        `SELECT d.user_id FROM donors d
         JOIN users u ON u.user_id = d.user_id AND u.role = 'donor'
         WHERE d.user_id = ? FOR UPDATE`,
        [donorId]
      );
      if (!donor) {
        await connection.rollback();
        return res.status(404).json({ message: 'Donor profile was not found.' });
      }
      const [result] = await connection.execute(
        `INSERT INTO donor_donation_history
           (donor_user_id, donation_date, eligibility_interval_months, next_eligible_date,
            verification_status, recorded_by_admin_username, verified_by_admin_username,
            verified_at, notes)
         VALUES (?, ?, ?, ?, 'verified', ?, ?, UTC_TIMESTAMP(), ?)`,
        [donorId, donationDate, DONATION_ELIGIBILITY_MONTHS, nextEligibleDate,
          req.admin.username, req.admin.username, notes || null]
      );
      await connection.execute(
        `UPDATE donors
         SET last_donation_date = ?, next_eligible_date = ?, available = 0, is_available = 0,
             availability_status = 'not_available', availability_mode = 'unavailable',
             availability_expires_at = NULL, available_until = NULL,
             public_contact_consent = 0, emergency_response_consent = 0
         WHERE user_id = ?`,
        [donationDate, nextEligibleDate, donorId]
      );
      if (PORTAL_SCHEMA) {
        await connection.execute(
          `INSERT INTO donor_availability
             (donor_user_id, is_available, confirmed_at, expires_at)
           VALUES (?, 0, UTC_TIMESTAMP(), NULL)
           ON DUPLICATE KEY UPDATE is_available = 0, confirmed_at = UTC_TIMESTAMP(), expires_at = NULL`,
          [donorId]
        );
      }
      await connection.commit();
      res.status(201).json({
        donation_id: result.insertId,
        donation_date: donationDate,
        next_eligible_date: nextEligibleDate,
        verification_status: 'verified',
        message: 'Donation recorded and verified. The donor is excluded from matching until the interval passes and qualified staff make a new eligibility decision.'
      });
    } catch (error) {
      await connection.rollback().catch(() => {});
      console.error('Donation record failed:', error.code || error.message);
      res.status(500).json({ message: 'Could not record the completed donation.' });
    } finally {
      connection.release();
    }
  }
);

app.get('/api/admin/blood-stock', requireDatabase, requireAdminConfigured, requireAdmin, async (req, res) => {
  try {
    await syncBloodStockAlerts();
    const [[banks], [stocks], [thresholds], [alerts], [thresholdHistory]] = await Promise.all([
      db.execute(
        `SELECT b.blood_bank_id, b.bank_name, b.address_text, b.phone, b.city, b.district, b.state,
                b.verification_status, b.is_active,
                DATE_FORMAT(b.created_at, '%Y-%m-%dT%H:%i:%sZ') AS registered_at,
                (SELECT MAX(s.last_updated) FROM blood_stock s
                 WHERE s.blood_bank_id = b.blood_bank_id) AS last_update_at,
                EXISTS(SELECT 1 FROM blood_stock s
                 WHERE s.blood_bank_id = b.blood_bank_id
                   AND s.last_updated >= UTC_DATE()
                   AND s.last_updated < DATE_ADD(UTC_DATE(), INTERVAL 1 DAY)) AS update_submitted_today,
                (SELECT COUNT(*) FROM blood_stock s
                 WHERE s.blood_bank_id = b.blood_bank_id
                   AND s.verification_status = 'pending') AS pending_stock_count,
                (SELECT COUNT(*) FROM blood_stock s
                 WHERE s.blood_bank_id = b.blood_bank_id
                   AND s.verification_status = 'rejected') AS rejected_stock_count
         FROM blood_banks b ORDER BY b.bank_name`
      ),
      db.execute(
        `SELECT s.stock_id, s.blood_bank_id, b.bank_name, b.address_text, b.phone, b.email,
                b.city, b.district, b.state, s.blood_group, s.component,
                s.physical_units, s.reserved_units, s.issued_units, s.discarded_units,
                s.total_eligible_units, s.available_units,
                COALESCE(t.low_stock_threshold, s.low_stock_threshold, 0) AS threshold,
                s.verification_status,
                s.reviewed_by_admin_id,
                DATE_FORMAT(s.reviewed_at, '%Y-%m-%dT%H:%i:%sZ') AS reviewed_at,
                DATE_FORMAT(s.last_updated, '%Y-%m-%dT%H:%i:%sZ') AS last_updated
         FROM blood_stock s JOIN blood_banks b ON b.blood_bank_id = s.blood_bank_id
         LEFT JOIN blood_stock_thresholds t ON t.blood_bank_id = s.blood_bank_id
           AND t.blood_group = s.blood_group AND t.component = s.component
         ORDER BY b.bank_name, s.blood_group, s.component`
      ),
      db.execute(
        `SELECT t.blood_bank_id, b.bank_name, t.blood_group, t.component,
                t.low_stock_threshold, t.updated_by_admin_id,
                DATE_FORMAT(t.updated_at, '%Y-%m-%dT%H:%i:%sZ') AS updated_at
         FROM blood_stock_thresholds t JOIN blood_banks b ON b.blood_bank_id = t.blood_bank_id
         ORDER BY b.bank_name, t.blood_group, t.component`
      ),
      db.execute(
        `SELECT a.alert_id, a.blood_bank_id, b.bank_name, a.blood_group, a.component,
                a.alert_type, a.message,
                DATE_FORMAT(a.last_triggered_at, '%Y-%m-%dT%H:%i:%sZ') AS last_triggered_at
         FROM blood_stock_alerts a JOIN blood_banks b ON b.blood_bank_id = a.blood_bank_id
         WHERE a.is_active = 1 ORDER BY a.last_triggered_at DESC LIMIT 500`
      ),
      db.execute(
        `SELECT h.threshold_history_id, h.blood_bank_id, b.bank_name, h.blood_group,
                h.component, h.previous_threshold, h.new_threshold,
                a.username AS admin_username,
                DATE_FORMAT(h.created_at, '%Y-%m-%dT%H:%i:%sZ') AS created_at
         FROM blood_stock_threshold_history h
         JOIN blood_banks b ON b.blood_bank_id = h.blood_bank_id
         JOIN admin_users a ON a.admin_id = h.updated_by_admin_id
         ORDER BY h.created_at DESC LIMIT 100`
      )
    ]);
    res.set('Cache-Control', 'no-store');
    res.json({ banks, stocks: stocks.map(stock => formatBloodStockRow(stock)), thresholds, alerts, threshold_history: thresholdHistory,
      freshness_policy: 'UTC calendar day' });
  } catch (error) {
    console.error('Admin blood-stock dashboard failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not load blood-stock administration data.' });
  }
});

app.patch('/api/admin/blood-stock/:stockId/verification', requireDatabase,
  requireAdminConfigured, requireAdmin, rateLimit(60, 60 * 1000), async (req, res) => {
    const stockId = Number(req.params.stockId);
    const verificationStatus = req.body?.verification_status;
    if (!Number.isSafeInteger(stockId) || stockId < 1 ||
        !['verified', 'rejected'].includes(verificationStatus)) {
      return res.status(400).json({ message: 'Choose a valid stock record and verification decision.' });
    }
    try {
      const [result] = await db.execute(
        `UPDATE blood_stock
         SET verification_status = ?, reviewed_by_admin_id = ?, reviewed_at = UTC_TIMESTAMP(),
             last_updated = last_updated
         WHERE stock_id = ?`,
        [verificationStatus, req.admin.admin_id, stockId]
      );
      if (!result.affectedRows) {
        return res.status(404).json({ message: 'Stock report was not found.' });
      }
      syncBloodStockAlerts().catch(error => {
        console.error('Stock alert refresh after verification failed:', error.code || error.message);
      });
      res.json({ message: `Stock report ${verificationStatus}.`, verification_status: verificationStatus });
    } catch (error) {
      console.error('Blood-stock verification failed:', error.code || error.message);
      res.status(500).json({ message: 'Could not update stock verification.' });
    }
  });

app.get('/api/admin/blood-bank-staff', requireDatabase, requireAdminConfigured, requireAdmin, async (req, res) => {
  try {
    const [staff] = await db.execute(
      `SELECT u.user_id, u.username, u.full_name, u.email, bs.bank_id,
              b.bank_name
       FROM users u
       LEFT JOIN blood_bank_staff bs ON bs.user_id = u.user_id
       LEFT JOIN blood_banks b ON b.blood_bank_id = bs.bank_id
       WHERE u.role = 'blood_bank'
       ORDER BY u.full_name, u.user_id`
    );
    res.set('Cache-Control', 'no-store');
    res.json({ staff });
  } catch (error) {
    console.error('Blood-bank staff list failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not load blood-bank staff accounts.' });
  }
});

app.post('/api/admin/blood-bank-staff', requireDatabase, requireAdminConfigured,
  requireAdmin, rateLimit(30, 60 * 60 * 1000), async (req, res) => {
    const userId = Number(req.body?.user_id);
    const bankId = Number(req.body?.bank_id);
    if (!Number.isSafeInteger(userId) || userId < 1 || !Number.isSafeInteger(bankId) || bankId < 1) {
      return res.status(400).json({ message: 'Choose an existing blood-bank staff account and bank.' });
    }
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const [[staff]] = await connection.execute(
        `SELECT user_id FROM users WHERE user_id = ? AND role = 'blood_bank' FOR UPDATE`,
        [userId]
      );
      const [[bank]] = await connection.execute(
        `SELECT blood_bank_id FROM blood_banks WHERE blood_bank_id = ? AND is_active = 1 FOR UPDATE`,
        [bankId]
      );
      if (!staff || !bank) {
        await connection.rollback();
        return res.status(404).json({ message: 'Active bank or authorized blood-bank user was not found.' });
      }
      await connection.execute(
        `INSERT INTO blood_bank_staff (user_id, bank_id) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE bank_id = VALUES(bank_id)`,
        [userId, bankId]
      );
      await connection.commit();
      res.json({ message: 'Staff account mapped to the selected bank.' });
    } catch (error) {
      await connection.rollback().catch(() => {});
      console.error('Blood-bank staff mapping failed:', error.code || error.message);
      res.status(500).json({ message: 'Could not map this staff account.' });
    } finally {
      connection.release();
    }
  }
);

app.get('/api/admin/blood-stock/history', requireDatabase, requireAdminConfigured, requireAdmin, async (req, res) => {
  const bankId = req.query.bank_id === undefined ? null : Number(req.query.bank_id);
  if (bankId !== null && (!Number.isSafeInteger(bankId) || bankId < 1)) {
    return res.status(400).json({ message: 'Choose a valid bank.' });
  }
  try {
    const [history] = await db.execute(
      `SELECT h.history_id, h.stock_id, h.blood_bank_id, b.bank_name, h.blood_group,
              h.component, h.previous_physical_units, h.physical_units,
              h.previous_reserved_units, h.reserved_units,
              h.previous_issued_units, h.issued_units,
              h.previous_discarded_units, h.discarded_units,
              h.previous_available_units, h.available_units,
              h.transaction_type, h.quantity_changed, h.remarks, u.full_name AS staff_name,
              DATE_FORMAT(h.created_at, '%Y-%m-%dT%H:%i:%sZ') AS created_at
       FROM stock_history h JOIN blood_banks b ON b.blood_bank_id = h.blood_bank_id
       JOIN users u ON u.user_id = h.staff_user_id
       WHERE (? IS NULL OR h.blood_bank_id = ?)
       ORDER BY h.created_at DESC, h.history_id DESC LIMIT 500`,
      [bankId, bankId]
    );
    res.set('Cache-Control', 'no-store');
    res.json({ history });
  } catch (error) {
    console.error('Admin stock history lookup failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not load stock update history.' });
  }
});

app.post('/api/admin/blood-stock/thresholds', requireDatabase, requireAdminConfigured,
  requireAdmin, rateLimit(60, 60 * 60 * 1000), async (req, res) => {
    const bankId = Number(req.body?.blood_bank_id);
    const bloodGroup = normalizeBloodGroup(req.body?.blood_group);
    const component = req.body?.component;
    const threshold = req.body?.low_stock_threshold;
    if (!Number.isSafeInteger(bankId) || bankId < 1 || !BLOOD_GROUPS.has(bloodGroup) ||
        !['whole_blood', 'red_cells', 'platelets', 'plasma'].includes(component) ||
        !Number.isSafeInteger(threshold) || threshold < 0 || threshold > 100000) {
      return res.status(400).json({ message: 'Choose a valid bank, blood group, component, and non-negative threshold.' });
    }
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const [[bank]] = await connection.execute(
        'SELECT blood_bank_id FROM blood_banks WHERE blood_bank_id = ? LIMIT 1 FOR UPDATE',
        [bankId]
      );
      if (!bank) {
        await connection.rollback();
        return res.status(404).json({ message: 'Blood bank was not found.' });
      }
      const [[old]] = await connection.execute(
        `SELECT low_stock_threshold FROM blood_stock_thresholds
         WHERE blood_bank_id = ? AND blood_group = ? AND component = ? FOR UPDATE`,
        [bankId, bloodGroup, component]
      );
      await connection.execute(
        `INSERT INTO blood_stock_thresholds
           (blood_bank_id, blood_group, component, low_stock_threshold, updated_by_admin_id)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE low_stock_threshold = VALUES(low_stock_threshold),
           updated_by_admin_id = VALUES(updated_by_admin_id), updated_at = UTC_TIMESTAMP()`,
        [bankId, bloodGroup, component, threshold, req.admin.admin_id]
      );
      if (!old || Number(old.low_stock_threshold) !== threshold) {
        await connection.execute(
          `INSERT INTO blood_stock_threshold_history
             (blood_bank_id, blood_group, component, previous_threshold,
              new_threshold, updated_by_admin_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [bankId, bloodGroup, component, old ? Number(old.low_stock_threshold) : null,
            threshold, req.admin.admin_id]
        );
      }
      await connection.execute(
        `UPDATE blood_stock SET low_stock_threshold = ?
         WHERE blood_bank_id = ? AND blood_group = ? AND component = ?`,
        [threshold, bankId, bloodGroup, component]
      );
      await connection.commit();
      syncBloodStockAlerts().catch(error => {
        console.error('Stock alert refresh after threshold update failed:', error.code || error.message);
      });
      res.json({ message: 'Low-stock threshold saved and audited.' });
    } catch (error) {
      await connection.rollback().catch(() => {});
      console.error('Blood-stock threshold update failed:', error.code || error.message);
      res.status(500).json({ message: 'Could not save the low-stock threshold.' });
    } finally {
      connection.release();
    }
  }
);

app.patch('/api/admin/blood-banks/:bankId/verification', requireDatabase,
  requireAdminConfigured, requireAdmin, async (req, res) => {
    const bankId = Number(req.params.bankId);
    const verificationStatus = req.body?.verification_status;
    if (!Number.isSafeInteger(bankId) || bankId < 1 ||
        !['pending', 'verified', 'rejected'].includes(verificationStatus)) {
      return res.status(400).json({ message: 'Choose a valid bank and verification state.' });
    }
    try {
      const [result] = await db.execute(
        `UPDATE blood_banks SET verification_status = ?, verified = ?, is_active = ?
         WHERE blood_bank_id = ?`,
        [verificationStatus, verificationStatus === 'verified' ? 1 : 0,
          verificationStatus === 'rejected' ? 0 : 1, bankId]
      );
      if (!result.affectedRows) return res.status(404).json({ message: 'Blood bank was not found.' });
      res.json({ message: `Blood bank status updated to ${verificationStatus}.` });
    } catch (error) {
      console.error('Blood-bank verification update failed:', error.code || error.message);
      res.status(500).json({ message: 'Could not update blood-bank verification.' });
    }
  }
);

app.get('/api/me', requireDatabase, async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) return res.json({ user: null });
  try {
    const [users] = await db.execute(
      'SELECT user_id, username, full_name, email, role, phone, city, state, place FROM users WHERE user_id = ? LIMIT 1',
      [userId]
    );
    if (!users.length) {
      clearSessionCookie(res);
      return res.json({ user: null });
    }
    res.json({ user: { ...users[0], role: normalizeUserRole(users[0].role) } });
  } catch (error) {
    console.error('Session lookup failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not verify your login session.' });
  }
});

app.patch('/api/donor/profile-location', requireDatabase, requireSession, async (req, res) => {
  if (req.user.role !== 'donor') {
    return res.status(403).json({ message: 'Only donor accounts can update a donor profile location.' });
  }
  const city = typeof req.body?.city === 'string' ? req.body.city.trim() : '';
  const state = typeof req.body?.state === 'string' ? req.body.state.trim() : '';
  const place = typeof req.body?.place === 'string' ? req.body.place.trim() : '';
  if (!isNonEmptyString(city, 80) ||
      !isNonEmptyString(state, 80) ||
      !isNonEmptyString(place, 100)) {
    return res.status(400).json({ message: 'Enter a city, state, and area/locality within the allowed lengths.' });
  }
  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();
    const [donorRows] = await connection.execute(
      'SELECT user_id FROM donors WHERE user_id = ? LIMIT 1',
      [req.user.user_id]
    );
    if (!donorRows.length) {
      await connection.rollback();
      return res.status(404).json({ message: 'Donor profile was not found.' });
    }
    await connection.execute(
      'UPDATE users SET city = ?, state = ?, place = ? WHERE user_id = ? AND role = ?',
      [city, state, place, req.user.user_id, 'donor']
    );
    await connection.execute(
      'UPDATE donors SET city = ?, state = ?, place = ? WHERE user_id = ?',
      [city, state, place, req.user.user_id]
    );
    await connection.commit();
    res.json({ message: 'Donor profile location saved.', location: { city, state, place } });
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    console.error('Donor profile location update failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not save your profile location.' });
  } finally {
    if (connection) connection.release();
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
      `SELECT availability_status, availability_mode, available, public_contact_consent,
              public_identity_consent,
              emergency_response_consent,
              DATE_FORMAT(COALESCE(next_eligible_date,
                DATE_ADD(last_donation_date, INTERVAL ${DONATION_ELIGIBILITY_MONTHS} MONTH)),
                '%Y-%m-%d') AS next_eligible_date,
              (${DONOR_ELIGIBILITY_SQL}) AS eligible_for_matching,
              availability_expires_at > UTC_TIMESTAMP() AS confirmation_current,
              COALESCE(DATE_FORMAT(availability_expires_at, '%Y-%m-%dT%H:%i:%sZ'),
                       DATE_FORMAT(available_until, '%Y-%m-%dT%H:%i:%sZ')) AS available_until,
              EXISTS (
                SELECT 1 FROM donor_availability_dates expired_date
                WHERE expired_date.donor_user_id = d.user_id
                  AND expired_date.status = 'available'
                  AND expired_date.available_date < UTC_DATE()
              ) AS has_expired_selected_dates,
              DATE_FORMAT(last_confirmed_at, '%Y-%m-%dT%H:%i:%sZ') AS last_confirmed_at
      FROM donors d
      WHERE d.user_id = ?
       LIMIT 1`,
      [req.user.user_id]
    );
    if (!donors.length) {
      return res.status(404).json({ message: 'No donor profile is linked to this account.' });
    }
    const [dates] = await db.execute(
      `SELECT DATE_FORMAT(available_date, '%Y-%m-%d') AS date, status
       FROM donor_availability_dates
       WHERE donor_user_id = ? AND available_date >= UTC_DATE()
       ORDER BY available_date`,
      [req.user.user_id]
    );
    const hasCurrentSelectedDate = dates.some(date => date.status === 'available');
    const confirmed = Boolean(donors[0].last_confirmed_at);
    const active = donors[0].available === 1 && confirmed &&
      (donors[0].availability_mode === 'selected_dates'
        ? hasCurrentSelectedDate
        : donors[0].availability_mode !== 'unavailable' &&
          donors[0].confirmation_current === 1);
    const status = active
      ? 'Available'
      : donors[0].last_confirmed_at &&
        donors[0].availability_status === 'temporarily_unavailable'
        ? 'Temporarily Unavailable'
      : donors[0].last_confirmed_at &&
        donors[0].available === 0 &&
        donors[0].availability_status === 'not_available'
        ? 'Not Available'
        : donors[0].availability_mode === 'selected_dates' && hasCurrentSelectedDate
          ? 'Available'
        : donors[0].availability_mode === 'selected_dates' &&
          donors[0].has_expired_selected_dates && confirmed
          ? 'Expired'
        : 'Unconfirmed';
    res.json({
      status,
      availability_status: donors[0].availability_status,
      availability_mode: donors[0].availability_mode || 'general',
      is_available: Boolean(active),
      eligible_for_matching: Boolean(donors[0].eligible_for_matching),
      next_eligible_date: donors[0].next_eligible_date,
      available_until: donors[0].available_until,
      last_confirmed_at: donors[0].last_confirmed_at,
      selected_dates: dates,
      public_contact_consent: donors[0].public_contact_consent === 1,
      public_identity_consent: donors[0].public_identity_consent === 1,
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
  const { status: submittedStatus, public_contact_consent: publicContactConsent,
    public_identity_consent: publicIdentityConsent,
    emergency_response_consent: emergencyResponseConsent,
    expires_in_hours: expiresInHours = AVAILABILITY_HOURS,
    mode: submittedMode = 'general',
    selected_dates: submittedDates } = req.body || {};
  const status = normalizeAvailabilityState(submittedStatus);
  const mode = ['general', 'selected_dates', 'unavailable'].includes(submittedMode)
    ? submittedMode
    : '';
  const selectedDates = submittedDates === undefined ? [] : submittedDates;
  if (!status ||
      !mode ||
      typeof publicContactConsent !== 'boolean' ||
      (publicIdentityConsent !== undefined && typeof publicIdentityConsent !== 'boolean') ||
      typeof emergencyResponseConsent !== 'boolean' ||
      !AVAILABILITY_DURATIONS_HOURS.includes(expiresInHours) ||
      !Array.isArray(selectedDates) ||
      selectedDates.length > 100 ||
      (mode === 'selected_dates' && selectedDates.length === 0) ||
      (mode !== 'selected_dates' && selectedDates.length > 0) ||
      (mode === 'unavailable' && !['not_available', 'temporarily_unavailable'].includes(status)) ||
      (mode !== 'unavailable' && status !== 'available')) {
    return res.status(400).json({ message: 'Choose a valid status, a 4-, 12-, or 24-hour duration, and confirm your privacy choices.' });
  }
  const parsedDates = [];
  const today = new Date().toISOString().slice(0, 10);
  for (const item of selectedDates) {
    if (!item || typeof item !== 'object' ||
        !isValidDateOnly(item.date) || item.date <= today ||
        !['available', 'unavailable'].includes(item.status)) {
      return res.status(400).json({ message: 'Selected availability dates must be valid future dates with an available or unavailable status.' });
    }
    parsedDates.push({ date: item.date, status: item.status });
  }
  if (new Set(parsedDates.map(item => item.date)).size !== parsedDates.length ||
      (mode === 'selected_dates' && !parsedDates.some(item => item.status === 'available'))) {
    return res.status(400).json({ message: 'Choose at least one unique future date as available.' });
  }

  try {
    const isAvailable = status === 'available';
    const availableUntil = isAvailable && mode === 'general'
      ? formatSqlUtcDateTime(new Date(Math.ceil(Date.now() / 1000) * 1000 + expiresInHours * 60 * 60 * 1000))
      : null;
    const connection = await db.getConnection();
    let updatedDonor;
    try {
      await connection.beginTransaction();
      await connection.execute(
      `UPDATE donors
       SET availability_status = ?, availability_mode = ?, available = ?, is_available = ?,
           public_contact_consent = ?,
           public_identity_consent = CASE WHEN ? IS NULL THEN public_identity_consent ELSE ? END,
           emergency_response_consent = ?,
           availability_expires_at = ?, available_until = ?,
           last_confirmed_at = UTC_TIMESTAMP()
       WHERE user_id = ?`,
        [status, mode, isAvailable ? 1 : 0, isAvailable ? 1 : 0,
          isAvailable && publicContactConsent ? 1 : 0,
          publicIdentityConsent === undefined ? null : 1,
          isAvailable && publicContactConsent && publicIdentityConsent ? 1 : 0,
          isAvailable && emergencyResponseConsent ? 1 : 0,
          availableUntil, availableUntil, req.user.user_id]
      );
      if (PORTAL_SCHEMA) {
        await connection.execute(
          `INSERT INTO donor_availability
             (donor_user_id, is_available, confirmed_at, expires_at)
           VALUES (?, ?, UTC_TIMESTAMP(), ?)
           ON DUPLICATE KEY UPDATE
             is_available = VALUES(is_available),
             confirmed_at = VALUES(confirmed_at),
             expires_at = VALUES(expires_at)`,
          [req.user.user_id, isAvailable ? 1 : 0, availableUntil]
        );
      }
      if (mode === 'selected_dates') {
        const [savedDates] = await connection.execute(
          `SELECT DATE_FORMAT(available_date, '%Y-%m-%d') AS date, status
           FROM donor_availability_dates
           WHERE donor_user_id = ?`,
          [req.user.user_id]
        );
        const nextDates = new Map(parsedDates.map(item => [item.date, item.status]));
        for (const oldDate of savedDates) {
          if (!nextDates.has(oldDate.date)) {
            await connection.execute(
              `INSERT INTO donor_availability_date_history
                 (donor_user_id, available_date, previous_status, new_status, changed_at)
               VALUES (?, ?, ?, ?, UTC_TIMESTAMP())`,
              [req.user.user_id, oldDate.date, oldDate.status, 'removed']
            );
          }
        }
        for (const selected of parsedDates) {
          const previous = savedDates.find(item => item.date === selected.date)?.status || null;
          if (previous !== selected.status) {
            await connection.execute(
              `INSERT INTO donor_availability_date_history
                 (donor_user_id, available_date, previous_status, new_status, changed_at)
               VALUES (?, ?, ?, ?, UTC_TIMESTAMP())`,
              [req.user.user_id, selected.date, previous, selected.status]
            );
          }
          await connection.execute(
            `INSERT INTO donor_availability_dates
               (donor_user_id, available_date, status, confirmed_at)
             VALUES (?, ?, ?, UTC_TIMESTAMP())
             ON DUPLICATE KEY UPDATE status = VALUES(status), confirmed_at = VALUES(confirmed_at)`,
            [req.user.user_id, selected.date, selected.status]
          );
        }
        const removedDates = savedDates
          .filter(item => !nextDates.has(item.date))
          .map(item => item.date);
        if (removedDates.length) {
          await connection.execute(
            `DELETE FROM donor_availability_dates
             WHERE donor_user_id = ? AND available_date IN (${removedDates.map(() => '?').join(', ')})`,
            [req.user.user_id, ...removedDates]
          );
        }
      }
      const [donors] = await connection.execute(
      `SELECT availability_status, available, public_contact_consent,
              public_identity_consent,
              emergency_response_consent, availability_mode,
              DATE_FORMAT(availability_expires_at, '%Y-%m-%dT%H:%i:%sZ') AS available_until,
              DATE_FORMAT(last_confirmed_at, '%Y-%m-%dT%H:%i:%sZ') AS last_confirmed_at
       FROM donors
       WHERE user_id = ?
       LIMIT 1`,
        [req.user.user_id]
      );
      if (!donors.length) {
        await connection.rollback();
        return res.status(404).json({ message: 'No donor profile is linked to this account.' });
      }
      updatedDonor = donors[0];
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    const [dates] = await db.execute(
      `SELECT DATE_FORMAT(available_date, '%Y-%m-%d') AS date, status
       FROM donor_availability_dates
       WHERE donor_user_id = ? AND available_date >= UTC_DATE()
       ORDER BY available_date`,
      [req.user.user_id]
    );
    res.json({
      status: status === 'temporarily_unavailable'
        ? 'Temporarily Unavailable'
        : mode === 'unavailable' ? 'Not Available' : 'Available',
      availability_status: updatedDonor.availability_status,
      availability_mode: updatedDonor.availability_mode,
      is_available: updatedDonor.available === 1,
      available_until: updatedDonor.available_until,
      last_confirmed_at: updatedDonor.last_confirmed_at,
      selected_dates: dates,
      public_contact_consent: updatedDonor.public_contact_consent === 1,
      public_identity_consent: updatedDonor.public_identity_consent === 1,
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
       FROM donors d
       WHERE d.available = 1
         AND d.public_contact_consent = 1
         AND ${DONOR_ELIGIBILITY_SQL}
         AND d.last_confirmed_at IS NOT NULL
         AND COALESCE(d.availability_mode, 'general') = 'general'
         AND d.availability_expires_at > UTC_TIMESTAMP()`
    );
    res.json({ available_count: Number(rows[0].available_count), checked_at: new Date().toISOString() });
  } catch (error) {
    console.error('Availability count failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not check current donor availability.' });
  }
});

app.get('/api/donor/donation-history', requireDatabase, requireSession, async (req, res) => {
  if (req.user.role !== 'donor') {
    return res.status(403).json({ message: 'Only donor accounts can view donation history.' });
  }
  try {
    const [[summary], [donations]] = await Promise.all([
      db.execute(
        `SELECT DATE_FORMAT(d.last_donation_date, '%Y-%m-%d') AS last_donation_date,
                DATE_FORMAT(COALESCE(d.next_eligible_date,
                  DATE_ADD(d.last_donation_date, INTERVAL ${DONATION_ELIGIBILITY_MONTHS} MONTH)),
                  '%Y-%m-%d') AS next_eligible_date
         FROM donors d WHERE d.user_id = ? LIMIT 1`,
        [req.user.user_id]
      ),
      db.execute(
        `SELECT DATE_FORMAT(donation_date, '%Y-%m-%d') AS donation_date,
                DATE_FORMAT(next_eligible_date, '%Y-%m-%d') AS next_eligible_date,
                verification_status
         FROM donor_donation_history
         WHERE donor_user_id = ?
         ORDER BY donation_date DESC, donation_id DESC
         LIMIT 100`,
        [req.user.user_id]
      )
    ]);
    res.set('Cache-Control', 'no-store');
    res.json({
      summary: summary[0] || { last_donation_date: null, next_eligible_date: null },
      donations,
      eligibility_interval_months: DONATION_ELIGIBILITY_MONTHS,
      eligibility_requires_medical_review: true
    });
  } catch (error) {
    console.error('Donor donation history lookup failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not load your donation history.' });
  }
});

app.get('/api/donor/eligibility-portal', requireDatabase, requireSession, async (req, res) => {
  if (req.user.role !== 'donor') {
    return res.status(403).json({ message: 'Only donor accounts can view the eligibility portal.' });
  }
  try {
    const [[donor], [donations]] = await Promise.all([
      db.execute(
        `SELECT DATE_FORMAT(d.last_donation_date, '%Y-%m-%d') AS last_donation_date,
                DATE_FORMAT(COALESCE(d.next_eligible_date,
                  DATE_ADD(d.last_donation_date, INTERVAL ${DONATION_ELIGIBILITY_MONTHS} MONTH)),
                  '%Y-%m-%d') AS next_review_date,
                d.available,
                d.availability_mode,
                d.public_contact_consent,
                d.public_identity_consent,
                d.last_confirmed_at,
                d.availability_expires_at,
                (SELECT MAX(dh.verified_at) FROM donor_donation_history dh
                 WHERE dh.donor_user_id = d.user_id
                   AND dh.verification_status = 'verified') AS last_donation_verified_at,
                (SELECT er.decision FROM donor_eligibility_reviews er
                 WHERE er.donor_user_id = d.user_id
                 ORDER BY er.reviewed_at DESC, er.review_id DESC LIMIT 1) AS latest_decision,
                (SELECT DATE_FORMAT(er.reviewed_at, '%Y-%m-%dT%H:%i:%sZ')
                 FROM donor_eligibility_reviews er
                 WHERE er.donor_user_id = d.user_id
                 ORDER BY er.reviewed_at DESC, er.review_id DESC LIMIT 1) AS latest_reviewed_at,
                (SELECT er.notes FROM donor_eligibility_reviews er
                 WHERE er.donor_user_id = d.user_id
                 ORDER BY er.reviewed_at DESC, er.review_id DESC LIMIT 1) AS latest_review_instructions,
                (SELECT reviewer.full_name FROM donor_eligibility_reviews er
                 JOIN users reviewer ON reviewer.user_id = er.reviewed_by_user_id
                 WHERE er.donor_user_id = d.user_id
                 ORDER BY er.reviewed_at DESC, er.review_id DESC LIMIT 1) AS latest_reviewed_by,
                (SELECT hs.review_status = 'Cleared' AND hs.health_data_consent_at IS NOT NULL
                 FROM donor_health_screenings hs
                 WHERE hs.donor_user_id = d.user_id
                 ORDER BY hs.submitted_at DESC, hs.screening_id DESC LIMIT 1) AS latest_screening_cleared,
                (SELECT hs.review_status FROM donor_health_screenings hs
                 WHERE hs.donor_user_id = d.user_id
                 ORDER BY hs.submitted_at DESC, hs.screening_id DESC LIMIT 1) AS latest_screening_status,
                (SELECT DATE_FORMAT(hs.submitted_at, '%Y-%m-%dT%H:%i:%sZ')
                 FROM donor_health_screenings hs
                 WHERE hs.donor_user_id = d.user_id
                 ORDER BY hs.submitted_at DESC, hs.screening_id DESC LIMIT 1) AS latest_screening_submitted_at,
                (SELECT hs.submitted_at >= COALESCE(
                   (SELECT MAX(dh.verified_at) FROM donor_donation_history dh
                    WHERE dh.donor_user_id = d.user_id
                      AND dh.verification_status = 'verified'),
                   d.last_donation_date, '1000-01-01 00:00:00')
                 FROM donor_health_screenings hs
                 WHERE hs.donor_user_id = d.user_id
                 ORDER BY hs.submitted_at DESC, hs.screening_id DESC LIMIT 1) AS screening_after_donation,
                (SELECT request_status FROM donor_eligibility_review_requests erq
                 WHERE erq.donor_user_id = d.user_id
                 ORDER BY erq.requested_at DESC, erq.request_id DESC LIMIT 1) AS request_status,
                (SELECT DATE_FORMAT(requested_at, '%Y-%m-%dT%H:%i:%sZ')
                 FROM donor_eligibility_review_requests erq
                 WHERE erq.donor_user_id = d.user_id
                 ORDER BY erq.requested_at DESC, erq.request_id DESC LIMIT 1) AS request_date,
                (SELECT DATE_FORMAT(reviewed_at, '%Y-%m-%dT%H:%i:%sZ')
                 FROM donor_eligibility_review_requests erq
                 WHERE erq.donor_user_id = d.user_id
                 ORDER BY erq.requested_at DESC, erq.request_id DESC LIMIT 1) AS request_reviewed_at,
                (SELECT instructions FROM donor_eligibility_review_requests erq
                 WHERE erq.donor_user_id = d.user_id
                 ORDER BY erq.requested_at DESC, erq.request_id DESC LIMIT 1) AS request_instructions,
                (SELECT a.username FROM donor_eligibility_review_requests erq
                 JOIN admin_users a ON a.admin_id = erq.reviewed_by_admin_id
                 WHERE erq.donor_user_id = d.user_id
                 ORDER BY erq.requested_at DESC, erq.request_id DESC LIMIT 1) AS request_reviewed_by
         FROM donors d
         WHERE d.user_id = ? LIMIT 1`,
        [req.user.user_id]
      ),
      db.execute(
        `SELECT donation_id,
                DATE_FORMAT(donation_date, '%Y-%m-%d') AS donation_date,
                DATE_FORMAT(next_eligible_date, '%Y-%m-%d') AS next_review_date,
                verification_status,
                DATE_FORMAT(verified_at, '%Y-%m-%dT%H:%i:%sZ') AS verified_at
         FROM donor_donation_history
         WHERE donor_user_id = ?
         ORDER BY donation_date DESC, donation_id DESC
         LIMIT 100`,
        [req.user.user_id]
      )
    ]);
    if (!donor) return res.status(404).json({ message: 'No donor profile is linked to this account.' });
    const today = new Date().toISOString().slice(0, 10);
    const decisionAfterDonation = donor.latest_reviewed_at &&
      (!donor.last_donation_verified_at ||
        new Date(donor.latest_reviewed_at).getTime() >= new Date(donor.last_donation_verified_at).getTime());
    const screeningCleared = Boolean(donor.latest_screening_cleared) &&
      Boolean(donor.screening_after_donation);
    const reviewAfterScreening = donor.latest_reviewed_at && donor.latest_screening_submitted_at &&
      new Date(donor.latest_reviewed_at).getTime() >= new Date(donor.latest_screening_submitted_at).getTime();
    const eligibleDecisionCurrent = donor.latest_decision === 'eligible' &&
      Boolean(decisionAfterDonation && reviewAfterScreening && screeningCleared);
    const status = getEligibilityPortalStatus({
      lastDonationDate: donor.last_donation_date,
      nextReviewDate: donor.next_review_date,
      today,
      latestDecision: donor.latest_decision,
      decisionAfterDonation: Boolean(
        donor.latest_decision === 'deferred'
          ? decisionAfterDonation
          : eligibleDecisionCurrent
      ),
      screeningCleared,
      requestStatus: donor.request_status
    });
    const progress = getRecoveryProgress(donor.last_donation_date, donor.next_review_date, today);
    const eligibilityConfirmed = status === 'eligibility_confirmed';
    const availabilityConfirmedAt = donor.last_confirmed_at
      ? new Date(donor.last_confirmed_at).getTime()
      : Number.NaN;
    const availabilityExpiresAt = donor.availability_expires_at
      ? new Date(donor.availability_expires_at).getTime()
      : Number.NaN;
    const matchingEligibilityConfirmed = isMatchingEligibilityConfirmed({
      decision: donor.latest_decision,
      reviewedAt: donor.latest_reviewed_at,
      lastDonationVerifiedAt: donor.last_donation_verified_at,
      lastConfirmedAt: donor.last_confirmed_at
    });
    const canAppearInMatching = eligibilityConfirmed &&
      matchingEligibilityConfirmed &&
      Number(donor.available) === 1 &&
      donor.availability_mode === 'general' &&
      Boolean(donor.public_contact_consent) &&
      Boolean(donor.public_identity_consent) &&
      Number.isFinite(availabilityConfirmedAt) &&
      Number.isFinite(availabilityExpiresAt) &&
      availabilityExpiresAt > Date.now();
    res.set('Cache-Control', 'no-store');
    res.json({
      summary: {
        last_donation_date: donor.last_donation_date,
        next_review_date: donor.next_review_date,
        days_since_last_donation: progress.daysSinceDonation,
        recovery_period_days: progress.totalRecoveryDays,
        recovery_progress_percent: progress.progressPercent,
        status,
        can_appear_in_live_matching: canAppearInMatching,
        can_request_review: canRequestEligibilityReview({
          today,
          nextReviewDate: donor.next_review_date,
          screeningCleared,
          requestStatus: donor.request_status,
          eligibilityConfirmed
        }),
        eligibility_interval_months: DONATION_ELIGIBILITY_MONTHS,
        latest_screening_status: donor.latest_screening_status || 'Not submitted'
      },
      review: {
        request_date: donor.request_date,
        request_status: donor.request_status || 'not_requested',
        request_reviewed_at: donor.request_reviewed_at,
        request_instructions: donor.request_instructions,
        staff_decision: donor.latest_decision,
        staff_reviewed_at: donor.latest_reviewed_at,
        staff_reviewed_by: donor.latest_reviewed_by,
        staff_instructions: donor.latest_review_instructions
      },
      donations,
      checked_at: new Date().toISOString()
    });
  } catch (error) {
    console.error('Donor eligibility portal lookup failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not load your donor eligibility information.' });
  }
});

app.post('/api/donor/eligibility-review-requests', requireDatabase, requireSession,
  rateLimit(5, 60 * 60 * 1000), async (req, res) => {
    if (req.user.role !== 'donor') {
      return res.status(403).json({ message: 'Only donor accounts can request an eligibility review.' });
    }
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const [[donor]] = await connection.execute(
        `SELECT d.user_id,
                DATE_FORMAT(COALESCE(d.next_eligible_date,
                  DATE_ADD(d.last_donation_date, INTERVAL ${DONATION_ELIGIBILITY_MONTHS} MONTH)),
                  '%Y-%m-%d') AS next_review_date,
                COALESCE(d.next_eligible_date,
                  DATE_ADD(d.last_donation_date, INTERVAL ${DONATION_ELIGIBILITY_MONTHS} MONTH)) <= UTC_DATE()
                  AS recovery_complete,
                        d.last_confirmed_at,
                        (SELECT hs.review_status = 'Cleared' AND hs.health_data_consent_at IS NOT NULL
                         FROM donor_health_screenings hs
                         WHERE hs.donor_user_id = d.user_id
                         ORDER BY hs.submitted_at DESC, hs.screening_id DESC LIMIT 1) AS screening_cleared,
                (SELECT hs.submitted_at FROM donor_health_screenings hs
                 WHERE hs.donor_user_id = d.user_id
                 ORDER BY hs.submitted_at DESC, hs.screening_id DESC LIMIT 1) AS screening_submitted_at,
                (SELECT hs.submitted_at >= COALESCE(
                   (SELECT MAX(dh.verified_at) FROM donor_donation_history dh
                    WHERE dh.donor_user_id = d.user_id
                      AND dh.verification_status = 'verified'),
                   d.last_donation_date, '1000-01-01 00:00:00')
                 FROM donor_health_screenings hs
                 WHERE hs.donor_user_id = d.user_id
                 ORDER BY hs.submitted_at DESC, hs.screening_id DESC LIMIT 1) AS screening_after_donation,
                (SELECT er.decision FROM donor_eligibility_reviews er
                 WHERE er.donor_user_id = d.user_id
                 ORDER BY er.reviewed_at DESC, er.review_id DESC LIMIT 1) AS latest_decision,
                (SELECT er.reviewed_at FROM donor_eligibility_reviews er
                 WHERE er.donor_user_id = d.user_id
                 ORDER BY er.reviewed_at DESC, er.review_id DESC LIMIT 1) AS latest_reviewed_at,
                (SELECT MAX(dh.verified_at) FROM donor_donation_history dh
                 WHERE dh.donor_user_id = d.user_id AND dh.verification_status = 'verified')
                   AS last_donation_verified_at
         FROM donors d WHERE d.user_id = ? FOR UPDATE`,
        [req.user.user_id]
      );
      if (!donor) {
        await connection.rollback();
        return res.status(404).json({ message: 'No donor profile is linked to this account.' });
      }
      const [[activeRequest]] = await connection.execute(
        `SELECT request_id, request_status FROM donor_eligibility_review_requests
         WHERE donor_user_id = ? AND request_status IN ('pending', 'approved')
         LIMIT 1 FOR UPDATE`,
        [req.user.user_id]
      );
      const screeningCleared = Boolean(donor.screening_cleared) &&
        Boolean(donor.screening_after_donation);
      const decisionAfterDonation = donor.latest_reviewed_at &&
        (!donor.last_donation_verified_at ||
          new Date(donor.latest_reviewed_at).getTime() >= new Date(donor.last_donation_verified_at).getTime());
      const reviewAfterScreening = donor.latest_reviewed_at && donor.screening_submitted_at &&
        new Date(donor.latest_reviewed_at).getTime() >= new Date(donor.screening_submitted_at).getTime();
      const eligibilityConfirmed = donor.latest_decision === 'eligible' &&
        Boolean(decisionAfterDonation && reviewAfterScreening && screeningCleared);
      if (!canRequestEligibilityReview({
        today: new Date().toISOString().slice(0, 10),
        nextReviewDate: donor.next_review_date,
        screeningCleared,
        requestStatus: activeRequest?.request_status || null,
        eligibilityConfirmed
      })) {
        await connection.rollback();
        return res.status(409).json({
          message: donor.recovery_complete
            ? 'A current cleared screening is required and an eligibility review must still be needed.'
            : 'The configured recovery period must pass before requesting eligibility review.'
        });
      }
      const [result] = await connection.execute(
        `INSERT INTO donor_eligibility_review_requests (donor_user_id, request_status, requested_at)
         VALUES (?, 'pending', UTC_TIMESTAMP())`,
        [req.user.user_id]
      );
      await saveAdminNotifications(connection, {
        title: 'Donor eligibility review requested',
        message: 'A donor eligibility review request is awaiting admin handling.',
        type: 'eligibility_review_request',
        dedupeKey: `eligibility-request:${result.insertId}`
      });
      await connection.commit();
      res.status(201).json({
        request_id: Number(result.insertId),
        request_status: 'pending',
        message: 'Your review request was submitted. Qualified staff must make the eligibility decision.'
      });
    } catch (error) {
      await connection.rollback().catch(() => {});
      console.error('Eligibility review request failed:', error.code || error.message);
      res.status(500).json({ message: 'Could not submit your eligibility review request.' });
    } finally {
      connection.release();
    }
  });

app.get('/api/donor/health-screening', requireDatabase, requireSession, async (req, res) => {
  if (req.user.role !== 'donor') {
    return res.status(403).json({ message: 'Only donor accounts can view donor health screening.' });
  }
  try {
    const [screenings] = await db.execute(
      `SELECT screening_id, responses, review_status,
              DATE_FORMAT(submitted_at, '%Y-%m-%dT%H:%i:%sZ') AS submitted_at,
              DATE_FORMAT(reviewed_at, '%Y-%m-%dT%H:%i:%sZ') AS reviewed_at,
              DATE_FORMAT(health_data_consent_at, '%Y-%m-%dT%H:%i:%sZ') AS health_data_consent_at,
              review_notes
       FROM donor_health_screenings
       WHERE donor_user_id = ?
       ORDER BY submitted_at DESC, screening_id DESC
       LIMIT 1`,
      [req.user.user_id]
    );
    res.set('Cache-Control', 'no-store');
    const screening = screenings[0] || null;
    if (screening) screening.responses = decryptHealthResponses(screening.responses);
    res.json({ screening });
  } catch (error) {
    console.error('Donor health screening lookup failed:', error.code || error.message);
    res.status(error.message.includes('HEALTH_DATA_ENCRYPTION_KEY') ? 503 : 500).json({
      message: error.message.includes('HEALTH_DATA_ENCRYPTION_KEY')
        ? error.message
        : 'Could not load your health screening.'
    });
  }
});

app.post('/api/donor/health-screening', requireDatabase, requireSession, rateLimit(5, 60 * 60 * 1000), async (req, res) => {
  if (req.user.role !== 'donor') {
    return res.status(403).json({ message: 'Only donor accounts can submit donor health screening.' });
  }
  const answers = req.body?.responses;
  const validAnswer = value => ['yes', 'no', 'not_sure'].includes(value);
  const lastDonationDate = typeof answers?.last_donation_date === 'string'
    ? answers.last_donation_date
    : '';
  const weight = typeof answers?.weight_kg === 'string' ? answers.weight_kg.trim() : '';
  const systolic = typeof answers?.blood_pressure_systolic === 'string'
    ? answers.blood_pressure_systolic.trim()
    : '';
  const diastolic = typeof answers?.blood_pressure_diastolic === 'string'
    ? answers.blood_pressure_diastolic.trim()
    : '';
  const medicationName = typeof answers?.medication_name === 'string'
    ? answers.medication_name.trim()
    : '';
  const healthConditions = typeof answers?.health_conditions === 'string'
    ? answers.health_conditions.trim()
    : '';
  const temporaryIllness = typeof answers?.temporary_illness === 'string'
    ? answers.temporary_illness.trim()
    : '';
  const additionalInfo = typeof answers?.additional_info === 'string'
    ? answers.additional_info.trim()
    : '';
  if (!answers || typeof answers !== 'object' || Array.isArray(answers) ||
      !validAnswer(answers.feeling_well) ||
      !validAnswer(answers.recent_illness) ||
      !validAnswer(answers.taking_medication) ||
      !validAnswer(answers.receiving_treatment) ||
      !validAnswer(answers.previously_deferred) ||
      !/^\d{1,4}(?:\.\d{1,2})?$/.test(weight) || Number(weight) <= 0 ||
      !/^\d{1,3}$/.test(systolic) || Number(systolic) < 1 ||
      !/^\d{1,3}$/.test(diastolic) || Number(diastolic) < 1 ||
      medicationName.length > 150 || healthConditions.length > 1000 ||
      temporaryIllness.length > 1000 || additionalInfo.length > 1000 ||
      answers.health_data_consent !== true ||
      (lastDonationDate && (!isValidDateOnly(lastDonationDate) ||
        lastDonationDate > new Date().toISOString().slice(0, 10)))) {
    return res.status(400).json({ message: 'Complete all screening fields, enter valid measurements and a past donation date, and consent to health-data use.' });
  }
  if (!healthDataEncryptionKey) {
    return res.status(503).json({ message: 'Health screening is unavailable until HEALTH_DATA_ENCRYPTION_KEY is configured on the server.' });
  }
  const responses = {
    feeling_well: answers.feeling_well,
    recent_illness: answers.recent_illness,
    taking_medication: answers.taking_medication,
    medication_name: medicationName || null,
    receiving_treatment: answers.receiving_treatment,
    weight_kg: Number(weight),
    blood_pressure_systolic_mmhg: Number(systolic),
    blood_pressure_diastolic_mmhg: Number(diastolic),
    health_conditions: healthConditions || null,
    temporary_illness: temporaryIllness || null,
    additional_info: additionalInfo || null,
    previously_deferred: answers.previously_deferred,
    last_donation_date: lastDonationDate || null
  };
  try {
    const [result] = await db.execute(
      `INSERT INTO donor_health_screenings
        (donor_user_id, responses, review_status, submitted_at,
         health_data_consent_at, form_version)
       VALUES (?, ?, 'Pending Review', UTC_TIMESTAMP(), UTC_TIMESTAMP(), '2')`,
      [req.user.user_id, encryptHealthResponses(responses)]
    );
    res.status(201).json({
      screening: {
        screening_id: result.insertId,
        responses,
        review_status: 'Pending Review',
        submitted_at: new Date().toISOString(),
        reviewed_at: null,
        review_notes: null
      },
      message: 'Your health information was saved privately for authorized review. Self-reported details do not determine eligibility; qualified medical staff make the final decision.'
    });
  } catch (error) {
    console.error('Donor health screening submission failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not save your health screening.' });
  }
});

app.get('/api/blood-bank/health-screenings', requireDatabase, requireSession, requireBloodBankStaff, async (req, res) => {
  try {
    const [screenings] = await db.execute(
      `SELECT hs.screening_id, hs.donor_user_id, u.full_name, u.blood_group,
              hs.responses, hs.review_status,
              DATE_FORMAT(hs.submitted_at, '%Y-%m-%dT%H:%i:%sZ') AS submitted_at,
              hs.review_notes
       FROM donor_health_screenings hs
       JOIN users u ON u.user_id = hs.donor_user_id AND u.role = 'donor'
       WHERE hs.review_status = 'Pending Review'
       ORDER BY hs.submitted_at ASC
       LIMIT 200`
    );
    res.set('Cache-Control', 'no-store');
    res.json({ screenings: screenings.map(screening => ({
      ...screening,
      responses: decryptHealthResponses(screening.responses)
    })) });
  } catch (error) {
    console.error('Blood-bank health screening lookup failed:', error.code || error.message);
    res.status(error.message.includes('HEALTH_DATA_ENCRYPTION_KEY') ? 503 : 500).json({
      message: error.message.includes('HEALTH_DATA_ENCRYPTION_KEY')
        ? error.message
        : 'Could not load pending health screenings.'
    });
  }
});

app.post('/api/blood-bank/health-screenings/:screeningId/review', requireDatabase, requireSession, requireBloodBankStaff, async (req, res) => {
  const screeningId = Number(req.params.screeningId);
  const reviewStatus = req.body?.review_status;
  const reviewNotes = typeof req.body?.review_notes === 'string' ? req.body.review_notes.trim() : '';
  if (!Number.isSafeInteger(screeningId) || screeningId < 1 ||
      !['Cleared', 'Not Cleared'].includes(reviewStatus) || reviewNotes.length > 500) {
    return res.status(400).json({ message: 'Choose a valid review decision and keep notes under 500 characters.' });
  }
  try {
    const [result] = await db.execute(
      `UPDATE donor_health_screenings
       SET review_status = ?, reviewed_at = UTC_TIMESTAMP(),
           reviewed_by_user_id = ?, review_notes = ?
       WHERE screening_id = ? AND review_status = 'Pending Review'`,
      [reviewStatus, req.user.user_id, reviewNotes || null, screeningId]
    );
    if (!result.affectedRows) {
      return res.status(404).json({ message: 'Pending screening not found; it may already have been reviewed.' });
    }
    res.json({ message: `Screening marked ${reviewStatus}. This is a workflow status, not medical clearance for donation.` });
  } catch (error) {
    console.error('Blood-bank health screening review failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not save the screening review.' });
  }
});

app.get('/api/blood-bank/donors/eligibility', requireDatabase, requireSession, requireBloodBankStaff, async (req, res) => {
  try {
    const [donors] = await db.execute(
      `SELECT d.user_id AS donor_user_id, u.full_name, d.blood_group,
              DATE_FORMAT(d.last_donation_date, '%Y-%m-%d') AS last_donation_date,
              DATE_FORMAT(COALESCE(d.next_eligible_date,
                DATE_ADD(d.last_donation_date, INTERVAL ${DONATION_ELIGIBILITY_MONTHS} MONTH)),
                '%Y-%m-%d') AS next_eligible_date,
              (SELECT er.decision FROM donor_eligibility_reviews er
               WHERE er.donor_user_id = d.user_id
               ORDER BY er.reviewed_at DESC, er.review_id DESC LIMIT 1) AS latest_decision
       FROM donors d
       JOIN users u ON u.user_id = d.user_id AND u.role = 'donor'
       JOIN donor_health_screenings hs ON hs.screening_id = (
         SELECT latest_hs.screening_id FROM donor_health_screenings latest_hs
         WHERE latest_hs.donor_user_id = d.user_id
         ORDER BY latest_hs.submitted_at DESC, latest_hs.screening_id DESC LIMIT 1
       )
       WHERE hs.review_status = 'Cleared'
         AND hs.health_data_consent_at IS NOT NULL
         AND hs.submitted_at >= COALESCE(
           (SELECT MAX(dh.verified_at) FROM donor_donation_history dh
            WHERE dh.donor_user_id = d.user_id AND dh.verification_status = 'verified'),
           d.last_donation_date, '1000-01-01 00:00:00'
         )
         AND NOT EXISTS (
           SELECT 1 FROM donor_eligibility_reviews current_review
           WHERE current_review.donor_user_id = d.user_id
             AND current_review.decision = 'eligible'
             AND current_review.reviewed_at >= hs.submitted_at
             AND current_review.reviewed_at >= COALESCE(
               (SELECT MAX(dh.verified_at) FROM donor_donation_history dh
                WHERE dh.donor_user_id = d.user_id AND dh.verification_status = 'verified'),
               d.last_donation_date, '1000-01-01 00:00:00'
             )
             AND NOT EXISTS (
               SELECT 1 FROM donor_eligibility_reviews newer_review
               WHERE newer_review.donor_user_id = d.user_id
                 AND (newer_review.reviewed_at > current_review.reviewed_at
                   OR (newer_review.reviewed_at = current_review.reviewed_at
                     AND newer_review.review_id > current_review.review_id))
             )
         )
       ORDER BY hs.submitted_at ASC
       LIMIT 200`
    );
    res.set('Cache-Control', 'no-store');
    res.json({ donors });
  } catch (error) {
    console.error('Donor eligibility queue lookup failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not load the donor eligibility queue.' });
  }
});

app.post('/api/blood-bank/donors/:donorId/eligibility', requireDatabase, requireSession,
  requireBloodBankStaff, rateLimit(30, 60 * 60 * 1000), async (req, res) => {
    const donorId = Number(req.params.donorId);
    const decision = req.body?.decision;
    const notes = typeof req.body?.notes === 'string' ? req.body.notes.trim() : '';
    if (!Number.isSafeInteger(donorId) || donorId < 1 ||
        !['eligible', 'deferred'].includes(decision) || notes.length > 500) {
      return res.status(400).json({ message: 'Choose an eligible or deferred decision and keep notes under 500 characters.' });
    }
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const [[screening]] = await connection.execute(
        `SELECT screening_id, review_status, submitted_at, health_data_consent_at
         FROM donor_health_screenings
         WHERE donor_user_id = ?
         ORDER BY submitted_at DESC, screening_id DESC LIMIT 1 FOR UPDATE`,
        [donorId]
      );
      if (!screening || screening.review_status !== 'Cleared' || !screening.health_data_consent_at) {
        await connection.rollback();
        return res.status(409).json({ message: 'The donor must have a current screening reviewed by staff before an eligibility decision.' });
      }
      const [[donor]] = await connection.execute(
        `SELECT d.user_id,
                COALESCE(d.next_eligible_date,
                  DATE_ADD(d.last_donation_date, INTERVAL ${DONATION_ELIGIBILITY_MONTHS} MONTH)) AS next_eligible_date,
                COALESCE((SELECT MAX(dh.verified_at) FROM donor_donation_history dh
                          WHERE dh.donor_user_id = d.user_id AND dh.verification_status = 'verified'),
                         d.last_donation_date) AS latest_donation_recorded
         FROM donors d JOIN users u ON u.user_id = d.user_id AND u.role = 'donor'
         WHERE d.user_id = ? FOR UPDATE`,
        [donorId]
      );
      if (!donor) {
        await connection.rollback();
        return res.status(404).json({ message: 'Donor profile was not found.' });
      }
      if (donor.latest_donation_recorded &&
          new Date(screening.submitted_at).getTime() < new Date(donor.latest_donation_recorded).getTime()) {
        await connection.rollback();
        return res.status(409).json({ message: 'A new health screening submitted after the most recent verified donation is required.' });
      }
      if (decision === 'eligible' && donor.next_eligible_date &&
          new Date(donor.next_eligible_date).toISOString().slice(0, 10) > new Date().toISOString().slice(0, 10)) {
        await connection.rollback();
        return res.status(409).json({ message: 'The configured donation interval has not ended; eligibility cannot yet be approved.' });
      }
      await connection.execute(
        `INSERT INTO donor_eligibility_reviews
           (donor_user_id, decision, reviewed_by_user_id, reviewed_at, notes)
         VALUES (?, ?, ?, UTC_TIMESTAMP(), ?)`,
        [donorId, decision, req.user.user_id, notes || null]
      );
      await connection.commit();
      res.json({ message: `Eligibility review recorded as ${decision}. Final decisions remain the responsibility of qualified medical staff.` });
    } catch (error) {
      await connection.rollback().catch(() => {});
      console.error('Donor eligibility review failed:', error.code || error.message);
      res.status(500).json({ message: 'Could not save the donor eligibility review.' });
    } finally {
      connection.release();
    }
  }
);

function formatBloodStockRow(row, requiredUnits = 0, includeStaffReportedQuantities = false) {
  const hasStockRecord = row.stock_id !== null;
  const stale = !hasStockRecord || !isStockFreshForUtcDate(row.last_updated);
  const verified = row.verification_status === 'verified';
  const exposeQuantities = hasStockRecord && (includeStaffReportedQuantities || (verified && !stale));
  const availableUnits = exposeQuantities
    ? Number(row.available_units)
    : null;
  const threshold = Number(row.threshold || 0);
  return {
    stock_id: row.stock_id === null ? null : Number(row.stock_id),
    blood_bank_id: Number(row.blood_bank_id),
    bank_name: row.bank_name,
    address: row.address_text,
    phone: row.phone || null,
    email: row.email || null,
    city: row.city,
    district: row.district,
    state: row.state,
    blood_group: row.blood_group,
    component: row.component,
    physical_units: exposeQuantities ? Number(row.physical_units) : null,
    reserved_units: exposeQuantities ? Number(row.reserved_units) : null,
    issued_units: exposeQuantities ? Number(row.issued_units) : null,
    discarded_units: exposeQuantities ? Number(row.discarded_units) : null,
    total_eligible_units: exposeQuantities ? Number(row.total_eligible_units) : null,
    available_units: availableUnits,
    threshold,
    meets_requested_units: availableUnits !== null && availableUnits >= requiredUnits,
    last_updated: row.last_updated,
    stock_date: row.last_updated ? new Date(row.last_updated).toISOString().slice(0, 10) : null,
    verification_status: row.verification_status || 'pending',
    status: hasStockRecord ? getStockStatus({
      available: availableUnits ?? 0,
      threshold,
      verified,
      stale,
      requiredUnits
    }) : 'No update today',
    is_fresh_today: hasStockRecord && !stale,
    freshness_policy: 'UTC calendar day'
  };
}

async function recordBloodStockUpdate(req, res) {
  const bloodGroup = normalizeBloodGroup(req.body?.blood_group);
  const component = req.body?.component;
  const physical = req.body?.physical_units;
  const reserved = req.body?.reserved_units;
  const issued = req.body?.issued_units;
  const discarded = req.body?.discarded_units;
  const remarks = typeof req.body?.remarks === 'string' ? req.body.remarks.trim() : '';
  const idempotencyKey = typeof req.body?.idempotency_key === 'string'
    ? req.body.idempotency_key.toLowerCase()
    : '';
  const transactionType = req.body?.transaction_type || 'daily_update';
  if (!BLOOD_GROUPS.has(bloodGroup) ||
      !['whole_blood', 'red_cells', 'platelets', 'plasma'].includes(component) ||
      ![physical, reserved, issued, discarded].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 100000) ||
      reserved + issued + discarded > physical || remarks.length > 500 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey) ||
      !['daily_update', 'correction'].includes(transactionType)) {
    return res.status(400).json({ message: 'Enter valid non-negative quantities, ensure reservations/issues/discards do not exceed physical stock, and provide a unique update key.' });
  }
  let calculated;
  try {
    calculated = calculateStock({ physical, reserved, issued, discarded });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [[duplicate]] = await connection.execute(
      `SELECT history_id, stock_id, blood_bank_id, blood_group, component,
              physical_units, reserved_units, issued_units, discarded_units, available_units,
              staff_user_id
       FROM stock_history WHERE idempotency_key = ? LIMIT 1`,
      [idempotencyKey]
    );
    if (duplicate) {
      await connection.rollback();
      if (Number(duplicate.staff_user_id) !== Number(req.user.user_id) ||
          Number(duplicate.blood_bank_id) !== Number(req.bloodBank.bank_id) ||
          duplicate.blood_group !== bloodGroup || duplicate.component !== component) {
        return res.status(409).json({ message: 'This update key was already used for a different stock transaction.' });
      }
      return res.json({
        duplicate: true,
        message: 'This stock update was already saved; no duplicate transaction was processed.',
        stock_id: Number(duplicate.stock_id),
        available_units: Number(duplicate.available_units)
      });
    }
    const [[thresholdRow]] = await connection.execute(
      `SELECT low_stock_threshold FROM blood_stock_thresholds
       WHERE blood_bank_id = ? AND blood_group = ? AND component = ? LIMIT 1`,
      [req.bloodBank.bank_id, bloodGroup, component]
    );
    const lowStockThreshold = Number(thresholdRow?.low_stock_threshold || 0);
    const [[existing]] = await connection.execute(
      `SELECT stock_id, physical_units, reserved_units, issued_units, discarded_units,
              available_units
       FROM blood_stock
       WHERE blood_bank_id = ? AND blood_group = ? AND component = ?
       FOR UPDATE`,
      [req.bloodBank.bank_id, bloodGroup, component]
    );
    const previous = existing || {
      physical_units: 0,
      reserved_units: 0,
      issued_units: 0,
      discarded_units: 0,
      available_units: 0
    };
    if (existing) {
      await connection.execute(
        `UPDATE blood_stock
         SET units_available = ?, physical_units = ?, reserved_units = ?, issued_units = ?,
             discarded_units = ?, total_eligible_units = ?, available_units = ?,
             low_stock_threshold = ?, verification_status = 'pending', updated_by = ?,
             reviewed_by_admin_id = NULL, reviewed_at = NULL,
             last_updated = UTC_TIMESTAMP()
         WHERE stock_id = ?`,
        [calculated.available, physical, reserved, issued, discarded, calculated.eligible,
          calculated.available, lowStockThreshold, req.user.user_id, existing.stock_id]
      );
    } else {
      await connection.execute(
        `INSERT INTO blood_stock
           (blood_bank_id, blood_group, component, units_available, physical_units,
            reserved_units, issued_units, discarded_units, total_eligible_units,
            available_units, low_stock_threshold, verification_status, updated_by, last_updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, UTC_TIMESTAMP())`,
        [req.bloodBank.bank_id, bloodGroup, component, calculated.available, physical,
          reserved, issued, discarded, calculated.eligible, calculated.available,
          lowStockThreshold, req.user.user_id]
      );
    }
    const [[saved]] = await connection.execute(
      `SELECT stock_id, DATE_FORMAT(last_updated, '%Y-%m-%dT%H:%i:%sZ') AS last_updated
       FROM blood_stock WHERE blood_bank_id = ? AND blood_group = ? AND component = ?`,
      [req.bloodBank.bank_id, bloodGroup, component]
    );
    const quantityChanged = calculated.available - Number(previous.available_units || 0);
    await connection.execute(
      `INSERT INTO stock_history
         (stock_id, blood_bank_id, blood_group, component,
          previous_physical_units, physical_units, previous_reserved_units, reserved_units,
          previous_issued_units, issued_units, previous_discarded_units, discarded_units,
          previous_available_units, available_units, transaction_type, quantity_changed,
          idempotency_key, remarks, staff_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [saved.stock_id, req.bloodBank.bank_id, bloodGroup, component,
        Number(previous.physical_units || 0), physical, Number(previous.reserved_units || 0), reserved,
        Number(previous.issued_units || 0), issued, Number(previous.discarded_units || 0), discarded,
        Number(previous.available_units || 0), calculated.available, transactionType,
        quantityChanged, idempotencyKey, remarks || null, req.user.user_id]
    );
    await connection.execute(
      `INSERT INTO blood_bank_audit_logs
         (actor_user_id, bank_id, inventory_id, action, details)
       VALUES (?, ?, NULL, ?, ?)`,
      [req.user.user_id, req.bloodBank.bank_id, 'daily_stock_update', JSON.stringify({
        stock_id: Number(saved.stock_id), blood_group: bloodGroup, component,
        physical_units: physical, reserved_units: reserved, issued_units: issued,
        discarded_units: discarded, total_eligible_units: calculated.eligible,
        available_units: calculated.available, quantity_changed: quantityChanged,
        transaction_type: transactionType, remarks: remarks || null
      })]
    );
    await connection.commit();
    syncBloodStockAlerts().catch(error => {
      console.error('Stock alert refresh after update failed:', error.code || error.message);
    });
    res.status(201).json({
      stock_id: Number(saved.stock_id),
      physical_units: physical,
      reserved_units: reserved,
      issued_units: issued,
      discarded_units: discarded,
      total_eligible_units: calculated.eligible,
      available_units: calculated.available,
      verification_status: 'pending',
      last_updated: saved.last_updated,
      stock_date: saved.last_updated ? new Date(saved.last_updated).toISOString().slice(0, 10) : null,
      status: getStockStatus({
        available: calculated.available,
        threshold: lowStockThreshold,
        verified: false,
        stale: false
      }),
      message: 'Daily stock is saved in MySQL and history, pending admin verification.'
    });
  } catch (error) {
    await connection.rollback().catch(() => {});
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'This stock update was already processed. Refresh the inventory before submitting another update.' });
    }
    console.error('Daily blood-stock update failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not save the daily blood-stock update.' });
  } finally {
    connection.release();
  }
}

app.get('/api/blood-stock', requireDatabase, rateLimit(60, 60 * 1000), async (req, res) => {
  const bloodGroup = normalizeBloodGroup(req.query.blood_group || '');
  const component = typeof req.query.component === 'string' ? req.query.component : '';
  const state = typeof req.query.state === 'string' ? req.query.state.trim() : '';
  const district = typeof req.query.district === 'string' ? req.query.district.trim() : '';
  const city = typeof req.query.city === 'string' ? req.query.city.trim() : '';
  const requiredUnits = req.query.required_units === undefined ? 0 : Number(req.query.required_units);
  if (!BLOOD_GROUPS.has(bloodGroup) ||
      !['whole_blood', 'red_cells', 'platelets', 'plasma'].includes(component) ||
      (state && !isNonEmptyString(state, 80)) ||
      (district && !isNonEmptyString(district, 80)) ||
      (city && !isNonEmptyString(city, 80)) ||
      !Number.isSafeInteger(requiredUnits) || requiredUnits < 0 || requiredUnits > 100000) {
    return res.status(400).json({ message: 'Choose a blood group and component, and valid optional location and unit filters.' });
  }
  try {
    const filters = [
      'b.is_active = 1',
      "(b.verification_status = 'verified' OR b.verified = 1)"
    ];
    const values = [];
    if (state) { filters.push('LOWER(b.state) = LOWER(?)'); values.push(state); }
    if (district) { filters.push('LOWER(b.district) = LOWER(?)'); values.push(district); }
    if (city) { filters.push('LOWER(b.city) = LOWER(?)'); values.push(city); }
    const [rows] = await db.execute(
      `SELECT s.stock_id, b.blood_bank_id, b.bank_name, b.address_text, b.phone, b.email,
              b.city, b.district, b.state, ? AS blood_group, ? AS component,
              s.physical_units, s.reserved_units, s.issued_units, s.discarded_units,
              s.total_eligible_units, s.available_units,
              COALESCE(t.low_stock_threshold, s.low_stock_threshold, 0) AS threshold,
              s.verification_status,
              DATE_FORMAT(s.last_updated, '%Y-%m-%dT%H:%i:%sZ') AS last_updated
       FROM blood_banks b
       LEFT JOIN blood_stock s ON s.blood_bank_id = b.blood_bank_id
         AND s.blood_group = ? AND s.component = ?
       LEFT JOIN blood_stock_thresholds t ON t.blood_bank_id = b.blood_bank_id
         AND t.blood_group = ? AND t.component = ?
       WHERE ${filters.join(' AND ')}
       ORDER BY b.state, b.district, b.city, b.bank_name
       LIMIT 300`,
      [bloodGroup, component, bloodGroup, component, bloodGroup, component, ...values]
    );
    res.json({
      inventory: rows.map(row => formatBloodStockRow(row, requiredUnits)),
      checked_at: new Date().toISOString(),
      required_units: requiredUnits,
      source: 'LifeDrop staff-entered daily stock; not an external live feed or reservation'
    });
  } catch (error) {
    console.error('Daily blood-stock search failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not search daily blood-stock reports.' });
  }
});

app.get(/^\/api\/blood-stock\/([1-9]\d{0,9})$/, requireDatabase, rateLimit(60, 60 * 1000), async (req, res) => {
  const stockId = req.params[0];
  try {
    const [[row]] = await db.execute(
      `SELECT s.stock_id, b.blood_bank_id, b.bank_name, b.address_text, b.phone, b.email,
              b.city, b.district, b.state, s.blood_group, s.component,
              s.physical_units, s.reserved_units, s.issued_units, s.discarded_units,
              s.total_eligible_units, s.available_units,
              COALESCE(t.low_stock_threshold, s.low_stock_threshold, 0) AS threshold,
              s.verification_status,
              DATE_FORMAT(s.last_updated, '%Y-%m-%dT%H:%i:%sZ') AS last_updated
       FROM blood_stock s JOIN blood_banks b ON b.blood_bank_id = s.blood_bank_id
       LEFT JOIN blood_stock_thresholds t ON t.blood_bank_id = s.blood_bank_id
         AND t.blood_group = s.blood_group AND t.component = s.component
       WHERE s.stock_id = ? AND b.is_active = 1
         AND (b.verification_status = 'verified' OR b.verified = 1)
       LIMIT 1`,
      [stockId]
    );
    if (!row) return res.status(404).json({ message: 'Stock record was not found.' });
    res.json({ stock: formatBloodStockRow(row) });
  } catch (error) {
    console.error('Blood-stock detail lookup failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not load this blood-stock record.' });
  }
});

app.get('/api/blood-stock/alerts', requireDatabase, rateLimit(60, 60 * 1000), async (req, res) => {
  try {
    await syncBloodStockAlerts();
    const [alerts] = await db.execute(
      `SELECT a.alert_id, a.blood_bank_id, b.bank_name, b.city, b.district, b.state,
              a.blood_group, a.component, a.alert_type, a.message,
              DATE_FORMAT(a.first_triggered_at, '%Y-%m-%dT%H:%i:%sZ') AS first_triggered_at,
              DATE_FORMAT(a.last_triggered_at, '%Y-%m-%dT%H:%i:%sZ') AS last_triggered_at
       FROM blood_stock_alerts a JOIN blood_banks b ON b.blood_bank_id = a.blood_bank_id
       WHERE a.is_active = 1 AND b.is_active = 1
         AND (b.verification_status = 'verified' OR b.verified = 1)
       ORDER BY a.last_triggered_at DESC, b.bank_name
       LIMIT 500`
    );
    res.json({ alerts, checked_at: new Date().toISOString() });
  } catch (error) {
    console.error('Public stock alert lookup failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not load blood-stock status alerts.' });
  }
});

app.get('/api/blood-banks', requireDatabase, rateLimit(60, 60 * 1000), async (req, res) => {
  const state = typeof req.query.state === 'string' ? req.query.state.trim() : '';
  const district = typeof req.query.district === 'string' ? req.query.district.trim() : '';
  const city = typeof req.query.city === 'string' ? req.query.city.trim() : '';
  if ((state && !isNonEmptyString(state, 80)) ||
      (district && !isNonEmptyString(district, 80)) ||
      (city && !isNonEmptyString(city, 80))) {
    return res.status(400).json({ message: 'Enter valid location filters.' });
  }
  const filters = ['is_active = 1', "(verification_status = 'verified' OR verified = 1)"];
  const values = [];
  for (const [column, value] of [['state', state], ['district', district], ['city', city]]) {
    if (value) { filters.push(`LOWER(${column}) = LOWER(?)`); values.push(value); }
  }
  try {
    const [banks] = await db.execute(
      `SELECT blood_bank_id, bank_name, address_text, phone, email, city, district, state,
              operating_hours, DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%sZ') AS registered_at
       FROM blood_banks WHERE ${filters.join(' AND ')}
       ORDER BY state, district, city, bank_name LIMIT 300`,
      values
    );
    res.json({ banks });
  } catch (error) {
    console.error('Verified blood-bank directory failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not load the verified blood-bank directory.' });
  }
});

app.get('/api/blood-stock/history', requireDatabase, requireSession, requireBloodBankStaff, async (req, res) => {
  try {
    const [history] = await db.execute(
      `SELECT h.history_id, h.stock_id, h.blood_group, h.component,
              h.previous_physical_units, h.physical_units,
              h.previous_reserved_units, h.reserved_units,
              h.previous_issued_units, h.issued_units,
              h.previous_discarded_units, h.discarded_units,
              h.previous_available_units, h.available_units,
              h.transaction_type, h.quantity_changed, h.remarks, u.full_name AS staff_name,
              DATE_FORMAT(h.created_at, '%Y-%m-%dT%H:%i:%sZ') AS created_at
       FROM stock_history h JOIN users u ON u.user_id = h.staff_user_id
       WHERE h.blood_bank_id = ?
       ORDER BY h.created_at DESC, h.history_id DESC LIMIT 200`,
      [req.bloodBank.bank_id]
    );
    res.set('Cache-Control', 'no-store');
    res.json({ history });
  } catch (error) {
    console.error('Blood-stock history lookup failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not load stock update history.' });
  }
});

app.get('/api/blood-bank/alerts', requireDatabase, requireSession, requireBloodBankStaff, async (req, res) => {
  try {
    await syncBloodStockAlerts();
    const [alerts] = await db.execute(
      `SELECT alert_id, blood_group, component, alert_type, message,
              DATE_FORMAT(first_triggered_at, '%Y-%m-%dT%H:%i:%sZ') AS first_triggered_at,
              DATE_FORMAT(last_triggered_at, '%Y-%m-%dT%H:%i:%sZ') AS last_triggered_at
       FROM blood_stock_alerts WHERE blood_bank_id = ? AND is_active = 1
       ORDER BY last_triggered_at DESC LIMIT 100`,
      [req.bloodBank.bank_id]
    );
    res.set('Cache-Control', 'no-store');
    res.json({ alerts, freshness_policy: 'UTC calendar day' });
  } catch (error) {
    console.error('Blood-bank alerts lookup failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not load stock alerts.' });
  }
});

app.post('/api/blood-stock/update', requireDatabase, requireSession,
  requireBloodBankStaff, rateLimit(120, 60 * 60 * 1000), recordBloodStockUpdate);

app.get('/api/blood-banks/inventory', requireDatabase, rateLimit(60, 60 * 1000), async (req, res) => {
  const bloodGroup = req.query.blood_group === undefined
    ? ''
    : normalizeBloodGroup(req.query.blood_group);
  const component = typeof req.query.component === 'string' ? req.query.component : '';
  const city = typeof req.query.city === 'string' ? req.query.city.trim() : '';
  const components = new Set(['whole_blood', 'red_cells', 'platelets', 'plasma']);
  const requiredUnits = req.query.required_units === undefined ? 0 : Number(req.query.required_units);
  if (!BLOOD_GROUPS.has(bloodGroup) || !components.has(component) ||
      (city && !isNonEmptyString(city, 80)) ||
      !Number.isSafeInteger(requiredUnits) || requiredUnits < 0 || requiredUnits > 100000) {
    return res.status(400).json({ message: 'Choose a valid blood group, component, and city filter.' });
  }
  try {
    const filters = ['b.is_active = 1', "(b.verification_status = 'verified' OR b.verified = 1)"];
    const values = [bloodGroup, component, bloodGroup, component];
    if (city) { filters.push('LOWER(b.city) = LOWER(?)'); values.push(city); }
    const [rows] = await db.execute(
      `SELECT s.stock_id, b.blood_bank_id, b.bank_name, b.address_text, b.phone, b.email,
              b.city, b.district, b.state, ? AS blood_group, ? AS component,
              s.physical_units, s.reserved_units, s.issued_units, s.discarded_units,
              s.total_eligible_units, s.available_units,
              COALESCE(t.low_stock_threshold, s.low_stock_threshold, 0) AS threshold,
              s.verification_status,
              DATE_FORMAT(s.last_updated, '%Y-%m-%dT%H:%i:%sZ') AS last_updated
       FROM blood_banks b
       LEFT JOIN blood_stock s ON s.blood_bank_id = b.blood_bank_id
         AND s.blood_group = ? AND s.component = ?
       LEFT JOIN blood_stock_thresholds t ON t.blood_bank_id = b.blood_bank_id
         AND t.blood_group = ? AND t.component = ?
       WHERE ${filters.join(' AND ')}
       ORDER BY b.state, b.city, b.bank_name
       LIMIT 500`,
      [bloodGroup, component, bloodGroup, component, bloodGroup, component, ...values]
    );
    res.json({
      inventory: rows.map(row => formatBloodStockRow(row, requiredUnits)),
      checked_at: new Date().toISOString(),
      source: 'LifeDrop staff-entered daily stock; not an external live feed or reservation'
    });
  } catch (error) {
    console.error('Blood-bank inventory search failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not load blood-bank inventory.' });
  }
});

app.get('/api/blood-bank/inventory', requireDatabase, requireSession,
  requireBloodBankStaff, async (req, res) => {
    try {
      await syncBloodStockAlerts();
      const [[inventory], [history], [alerts], [audit], [notifications]] = await Promise.all([
        db.execute(
          `SELECT s.stock_id, s.blood_group, s.component, s.physical_units,
                  s.reserved_units, s.issued_units, s.discarded_units,
                  s.total_eligible_units, s.available_units,
                  COALESCE(t.low_stock_threshold, s.low_stock_threshold, 0) AS low_stock_threshold,
                  s.verification_status,
                  DATE_FORMAT(last_updated, '%Y-%m-%dT%H:%i:%sZ') AS last_updated
           FROM blood_stock s LEFT JOIN blood_stock_thresholds t
             ON t.blood_bank_id = s.blood_bank_id
            AND t.blood_group = s.blood_group AND t.component = s.component
           WHERE s.blood_bank_id = ? ORDER BY s.last_updated DESC, s.blood_group, s.component LIMIT 500`,
          [req.bloodBank.bank_id]
        ),
        db.execute(
          `SELECT h.history_id, h.stock_id, h.blood_group, h.component,
                  h.previous_physical_units, h.physical_units,
                  h.previous_reserved_units, h.reserved_units,
                  h.previous_issued_units, h.issued_units,
                  h.previous_discarded_units, h.discarded_units,
                  h.previous_available_units, h.available_units,
                  h.transaction_type, h.quantity_changed, h.remarks,
                  u.full_name AS staff_name,
                  DATE_FORMAT(h.created_at, '%Y-%m-%dT%H:%i:%sZ') AS created_at
           FROM stock_history h JOIN users u ON u.user_id = h.staff_user_id
           WHERE h.blood_bank_id = ? ORDER BY h.created_at DESC, h.history_id DESC LIMIT 100`,
          [req.bloodBank.bank_id]
        ),
        db.execute(
          `SELECT alert_id, blood_group, component, alert_type, message,
                  DATE_FORMAT(last_triggered_at, '%Y-%m-%dT%H:%i:%sZ') AS last_triggered_at
           FROM blood_stock_alerts WHERE blood_bank_id = ? AND is_active = 1
           ORDER BY last_triggered_at DESC LIMIT 100`,
          [req.bloodBank.bank_id]
        ),
        db.execute(
          `SELECT audit_id, inventory_id, action, details,
                  DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%sZ') AS created_at
           FROM blood_bank_audit_logs WHERE bank_id = ?
           ORDER BY created_at DESC, audit_id DESC LIMIT 100`,
          [req.bloodBank.bank_id]
        ),
        db.execute(
          `SELECT notification_id, request_id,
                  DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%sZ') AS created_at
           FROM blood_bank_notifications
           WHERE staff_user_id = ? AND read_at IS NULL
           ORDER BY created_at DESC LIMIT 100`,
          [req.user.user_id]
        )
      ]);
      res.set('Cache-Control', 'no-store');
      res.json({
        bank: { ...req.bloodBank, bank_id: req.bloodBank.bank_id },
        inventory: inventory.map(row => formatBloodStockRow(
          { ...row, ...req.bloodBank, blood_bank_id: req.bloodBank.bank_id },
          0,
          true
        )),
        history,
        alerts,
        audit,
        notifications,
        freshness_policy: 'UTC calendar day'
      });
    } catch (error) {
      console.error('Blood-bank inventory dashboard failed:', error.code || error.message);
      res.status(500).json({ message: 'Could not load your blood-bank inventory.' });
    }
  }
);

app.post('/api/blood-bank/inventory', requireDatabase, requireSession,
  requireBloodBankStaff, rateLimit(120, 60 * 60 * 1000), recordBloodStockUpdate);

app.get('/api/donors/search', requireDatabase, requireSession, rateLimit(30, 60 * 1000), async (req, res) => {
  if (req.user.role !== 'patient') {
    return res.status(403).json({ message: 'Patient accounts can search for available donors.' });
  }
  const city = typeof req.query.city === 'string' ? req.query.city.trim() : '';
  const area = typeof req.query.area === 'string' ? req.query.area.trim() : '';
  const state = typeof req.query.state === 'string' ? req.query.state.trim() : '';
  const bloodGroup = normalizeBloodGroup(req.query.blood_group || '');
  const radius = typeof req.query.radius_km === 'string' ? req.query.radius_km : '25';
  const requiredDate = typeof req.query.required_date === 'string' ? req.query.required_date : '';
  const units = req.query.units === undefined ? null : Number(req.query.units);
  const emergency = req.query.emergency === 'true';
  const allowedRadii = new Set(['5', '10', '25', '50', 'wider']);
  const today = new Date().toISOString().slice(0, 10);
  if (!isNonEmptyString(city, 80) ||
      !isNonEmptyString(state, 80) ||
      !BLOOD_GROUPS.has(bloodGroup) ||
      !allowedRadii.has(radius) ||
      (area && !isNonEmptyString(area, 100)) ||
      (requiredDate && (!isValidDateOnly(requiredDate) || requiredDate < today)) ||
      (units !== null && (!Number.isInteger(units) || units < 1 || units > 20)) ||
      (req.query.emergency !== undefined && !['true', 'false'].includes(req.query.emergency))) {
    return res.status(400).json({ message: 'Choose a valid state, city/place, blood group, and optional search details.' });
  }

  try {
    const locationFilter = radius === 'wider'
      ? 'LOWER(d.state) = LOWER(?)'
      : 'LOWER(d.city) = LOWER(?) AND LOWER(d.state) = LOWER(?)';
    const locationValues = radius === 'wider' ? [state] : [city, state];
    const dateAvailabilityFilter = requiredDate
      ? `(
           (COALESCE(d.availability_mode, 'general') = 'general'
             AND d.availability_expires_at > UTC_TIMESTAMP())
           OR
           (COALESCE(d.availability_mode, 'general') = 'selected_dates'
             AND EXISTS (
               SELECT 1 FROM donor_availability_dates ad
               WHERE ad.donor_user_id = d.user_id
                 AND ad.available_date = ?
                 AND ad.status = 'available'
             ))
         )`
      : `COALESCE(d.availability_mode, 'general') = 'general'
         AND d.availability_expires_at > UTC_TIMESTAMP()`;
    const areaFilter = area
      ? "AND LOWER(COALESCE(NULLIF(d.place, ''), NULLIF(u.place, ''), '')) = LOWER(?)"
      : '';
    const [donors] = await db.execute(
      `SELECT u.full_name AS display_name,
              COALESCE(NULLIF(d.place, ''), NULLIF(u.place, '')) AS place,
              d.blood_group, d.city, d.state,
              d.last_confirmed_at IS NOT NULL AS has_confirmation,
              1 AS confirmation_current,
              (${DONOR_ELIGIBILITY_SQL}) AS eligible_for_matching,
              d.public_contact_consent = 1 AS contact_consent,
              d.public_identity_consent = 1 AS identity_consent,
              d.emergency_response_consent = 1 AS emergency_matching_enabled,
              CASE WHEN COALESCE(d.availability_mode, 'general') = 'selected_dates'
                THEN 'Available on selected date' ELSE 'Available' END AS availability_status,
              COALESCE(DATE_FORMAT(d.availability_expires_at, '%Y-%m-%dT%H:%i:%sZ'),
                       DATE_FORMAT(d.available_until, '%Y-%m-%dT%H:%i:%sZ')) AS available_until,
              ? AS matched_date,
              DATE_FORMAT(d.last_confirmed_at, '%Y-%m-%dT%H:%i:%sZ') AS last_confirmed_at,
              COALESCE(d.availability_mode, 'general') AS availability_mode
       FROM donors d
       JOIN users u ON u.user_id = d.user_id AND u.role = 'donor'
       WHERE d.available = 1
         AND d.public_contact_consent = 1
         AND d.public_identity_consent = 1
         AND d.last_confirmed_at IS NOT NULL
         AND ${DONOR_ELIGIBILITY_SQL}
         AND d.blood_group IN (${getCompatibleDonorBloodGroups(bloodGroup).map(() => '?').join(', ')})
         AND ${locationFilter}
         AND ${dateAvailabilityFilter}
         ${areaFilter}
       ORDER BY CASE WHEN ? = 1 THEN d.emergency_response_consent ELSE 0 END DESC,
                d.last_confirmed_at DESC
       LIMIT 50`,
      [requiredDate || null, ...getCompatibleDonorBloodGroups(bloodGroup), ...locationValues,
        ...(requiredDate ? [requiredDate] : []), ...(area ? [area] : []), emergency ? 1 : 0]
    );
    res.json({
      donors: donors
        .filter(donor =>
          areBloodGroupsCompatible(donor.blood_group, bloodGroup) &&
          isAvailabilitySearchEligible({
            state: 'available',
            confirmed: Boolean(donor.has_confirmation),
            current: Boolean(donor.confirmation_current),
            eligible: Boolean(donor.eligible_for_matching),
            contactConsent: Boolean(donor.contact_consent),
            identityConsent: Boolean(donor.identity_consent)
          })
        )
        .map(({
          has_confirmation,
          confirmation_current,
          eligible_for_matching,
          contact_consent,
          identity_consent,
          ...donor
        }) => donor),
      checked_at: new Date().toISOString(),
      search_area: radius === 'wider' ? `${state} (wider search)` : `${city}, ${state}`,
      radius_km: radius === 'wider' ? null : Number(radius),
      required_date: requiredDate || null,
      area: area || null,
      location_precision: 'Matches registered donor city/state; live GPS and calculated distance are not available.',
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
  if (req.user.role !== 'patient') {
    return res.status(403).json({ message: 'Patient accounts can search for available donors.' });
  }
  const city = typeof req.query.city === 'string' ? req.query.city.trim() : '';
  const area = typeof req.query.area === 'string' ? req.query.area.trim() : '';
  const state = typeof req.query.state === 'string' ? req.query.state.trim() : '';
  if (req.query.blood_group !== undefined && typeof req.query.blood_group !== 'string') {
    return res.status(400).json({ message: 'Select a valid blood group.' });
  }
  const bloodGroup = normalizeBloodGroup(req.query.blood_group || '');
  if (
    !isNonEmptyString(city, 80) ||
    city.length < 2 ||
    (area && !isNonEmptyString(area, 100)) ||
    !isNonEmptyString(state, 80) ||
    !BLOOD_GROUPS.has(bloodGroup)
  ) {
    return res.status(400).json({ message: 'Enter a city and state, and select a blood group.' });
  }

  try {
    const filters = [
      'd.available = 1',
      'd.public_contact_consent = 1',
      'd.public_identity_consent = 1',
      'd.last_confirmed_at IS NOT NULL',
      DONOR_ELIGIBILITY_SQL,
      "COALESCE(d.availability_mode, 'general') = 'general'",
      'd.availability_expires_at > UTC_TIMESTAMP()',
      'LOWER(d.city) = LOWER(?)',
      'LOWER(d.state) = LOWER(?)'
    ];
    const values = [city, state];
    if (area) {
      filters.push("LOWER(COALESCE(NULLIF(d.place, ''), NULLIF(u.place, ''), '')) = LOWER(?)");
      values.push(area);
    }
    const compatibleBloodGroups = getCompatibleDonorBloodGroups(bloodGroup);
    filters.push(`d.blood_group IN (${compatibleBloodGroups.map(() => '?').join(', ')})`);
    values.push(...compatibleBloodGroups);
    const [donors] = await db.execute(
      `SELECT u.full_name AS name, d.blood_group, d.city, d.state,
              COALESCE(NULLIF(d.place, ''), NULLIF(u.place, '')) AS place,
              DATE_FORMAT(d.last_confirmed_at, '%Y-%m-%dT%H:%i:%sZ') AS last_confirmed_at,
              DATE_FORMAT(d.availability_expires_at, '%Y-%m-%dT%H:%i:%sZ') AS available_until
       FROM donors d
       JOIN users u ON u.user_id = d.user_id AND u.role = 'donor'
       WHERE ${filters.join(' AND ')}
       ORDER BY d.availability_expires_at DESC
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
