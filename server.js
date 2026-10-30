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
const {
  isAvailabilitySearchEligible,
  getAdminAvailabilityConfirmationBlocker,
  getDefaultAvailabilityWindow,
  isValidAvailabilityConfirmationHours,
  isValidUnavailabilityReason,
  parseExpectedAvailability,
  parseAvailabilityWindow,
  normalizeAvailabilityState
} = require('./availability-utils');
const { calculateStock, getStockStatus, isStockFreshForUtcDate } = require('./stock-utils');
const {
  canRequestEligibilityReview,
  getDaysBetweenDates,
  getEligibilityPortalStatus,
  getRecoveryProgress,
  isMatchingEligibilityConfirmed
} = require('./eligibility-portal-utils');
const {
  createNotificationPayload,
  getAvailabilityNotificationCopy,
  isValidNotificationId
} = require('./notification-utils');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATABASE_NAME = process.env.DB_NAME || 'lifedrop';
const PORTAL_SCHEMA = DATABASE_NAME === 'blood_donar_portal';
const DONOR_CITY_SQL = "COALESCE(NULLIF(TRIM(d.city), ''), NULLIF(TRIM(u.city), ''))";
const DONOR_STATE_SQL = "COALESCE(NULLIF(TRIM(d.state), ''), NULLIF(TRIM(u.state), ''))";
const USER_AREA_SQL = PORTAL_SCHEMA
  ? "COALESCE(NULLIF(TRIM(u.place), ''), NULLIF(TRIM(u.area), ''))"
  : "NULLIF(TRIM(u.place), '')";
const DONOR_AREA_SQL = `COALESCE(NULLIF(TRIM(d.place), ''), ${USER_AREA_SQL})`;
const DONOR_NAME_SQL = "COALESCE(NULLIF(TRIM(u.full_name), ''), NULLIF(TRIM(d.full_name), ''))";
const DONOR_PHONE_SQL = "COALESCE(NULLIF(TRIM(u.phone), ''), NULLIF(TRIM(d.phone), ''))";
const AVAILABILITY_HOURS = 42;
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

async function reportNotificationFailure(context, requestId, error) {
  const errorCode = error.code || 'ERROR';
  console.error(`${context} notification delivery failed:`, errorCode);
  try {
    await saveAdminNotifications(db, {
      title: 'Notification delivery failed',
      message: `LifeDrop could not complete the ${context} notification workflow${requestId ? ` for request ${requestId}` : ''} (${errorCode}). Check the server logs.`,
      type: 'notification_failure',
      relatedRequestId: requestId === null ? null : Number(requestId),
      dedupeKey: `notification-failure:${context}:${requestId || crypto.randomUUID()}`
    });
  } catch (reportError) {
    console.error('Admin notification-failure alert could not be saved:', reportError.code || reportError.message);
  }
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
const REQUEST_STATUSES = new Set(['Pending Verification', 'Under Review', 'Cancelled']);
const PHONE_PATTERN = /^[+0-9 ()-]{7,20}$/;
const SESSION_COOKIE = 'lifedrop_session';
const BLOOD_STOCK_API = 'https://eraktkosh.mohfw.gov.in/eraktkoshPortal/eraktkosh';
const DONOR_COOLDOWN_CLEAR_SQL = `(
  COALESCE(d.next_eligible_date,
    DATE_ADD(d.last_donation_date, INTERVAL ${DONATION_ELIGIBILITY_MONTHS} MONTH)) IS NULL
  OR COALESCE(d.next_eligible_date,
    DATE_ADD(d.last_donation_date, INTERVAL ${DONATION_ELIGIBILITY_MONTHS} MONTH)) <= UTC_DATE()
)`;
const DONOR_POST_COOLDOWN_CONFIRMATION_SQL = `(
  d.last_donation_date IS NULL
  OR d.last_confirmed_at >= COALESCE(
    d.next_eligible_date,
    DATE_ADD(d.last_donation_date, INTERVAL ${DONATION_ELIGIBILITY_MONTHS} MONTH)
  )
)`;
const DONOR_MEDICAL_RESTRICTION_SQL = `(
  EXISTS (
    SELECT 1 FROM donor_health_screenings latest_screening
    WHERE latest_screening.donor_user_id = d.user_id
      AND latest_screening.screening_id = (
        SELECT screening.screening_id
        FROM donor_health_screenings screening
        WHERE screening.donor_user_id = d.user_id
        ORDER BY screening.submitted_at DESC, screening.screening_id DESC
        LIMIT 1
      )
      AND latest_screening.review_status = 'Not Cleared'
  )
  OR EXISTS (
    SELECT 1 FROM donor_eligibility_reviews latest_review
    WHERE latest_review.donor_user_id = d.user_id
      AND latest_review.decision = 'deferred'
      AND NOT EXISTS (
        SELECT 1 FROM donor_eligibility_reviews newer_review
        WHERE newer_review.donor_user_id = latest_review.donor_user_id
          AND (newer_review.reviewed_at > latest_review.reviewed_at
            OR (newer_review.reviewed_at = latest_review.reviewed_at
              AND newer_review.review_id > latest_review.review_id))
      )
  )
  OR EXISTS (
    SELECT 1 FROM donor_reported_donations report
    WHERE report.donor_user_id = d.user_id
      AND report.report_status = 'pending'
  )
)`;
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
const DONOR_EMERGENCY_RESPONSE_ELIGIBILITY_SQL = `(
  d.emergency_response_consent = 1
  AND d.last_confirmed_at IS NOT NULL
  AND ${DONOR_ELIGIBILITY_SQL}
  AND NOT (${DONOR_MEDICAL_RESTRICTION_SQL})
  AND (
    (
      d.available = 1
      AND (
        (COALESCE(d.availability_mode, 'general') = 'general'
          AND COALESCE(d.availability_starts_at, d.last_confirmed_at) <= UTC_TIMESTAMP()
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
    )
    OR
    (
      d.available = 0
      AND d.availability_status = 'not_available'
      AND COALESCE(d.availability_unavailable_reason, '') NOT IN ('health_reasons', 'recently_donated')
    )
  )
)`;
const DONOR_ADMIN_CONFIRM_ELIGIBILITY_SQL = DONOR_ELIGIBILITY_SQL
  .replaceAll('d.last_confirmed_at >=', 'UTC_TIMESTAMP() >=');
const DONOR_AVAILABILITY_STATUS_SQL = `CASE
  WHEN d.available = 1
       AND d.last_confirmed_at IS NOT NULL
       AND COALESCE(d.availability_mode, 'general') = 'selected_dates'
       AND EXISTS (
         SELECT 1 FROM donor_availability_dates ad
         WHERE ad.donor_user_id = d.user_id
           AND ad.status = 'available'
           AND ad.available_date >= UTC_DATE()
       ) THEN 'available'
  WHEN d.available = 1
       AND d.last_confirmed_at IS NOT NULL
       AND COALESCE(d.availability_mode, 'general') = 'general'
      AND COALESCE(d.availability_starts_at, d.last_confirmed_at) <= UTC_TIMESTAMP()
      AND d.availability_expires_at > UTC_TIMESTAMP() THEN 'available'
  WHEN d.available = 1
      AND d.last_confirmed_at IS NOT NULL
      AND COALESCE(d.availability_mode, 'general') = 'general'
      AND d.availability_starts_at > UTC_TIMESTAMP()
      AND d.availability_expires_at > UTC_TIMESTAMP() THEN 'scheduled'
  WHEN d.available = 1
       AND d.last_confirmed_at IS NOT NULL
       AND COALESCE(d.availability_mode, 'general') = 'general'
       AND COALESCE(d.availability_starts_at, d.last_confirmed_at) <= UTC_TIMESTAMP()
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
const DONOR_ADMIN_DISPLAY_AVAILABILITY_SQL = `CASE
  WHEN d.available = 1
       AND d.last_confirmed_at IS NOT NULL
       AND (
         (COALESCE(d.availability_mode, 'general') = 'general'
           AND COALESCE(d.availability_starts_at, d.last_confirmed_at) <= UTC_TIMESTAMP()
           AND d.availability_expires_at > UTC_TIMESTAMP())
         OR
         (COALESCE(d.availability_mode, 'general') = 'selected_dates'
           AND EXISTS (
             SELECT 1 FROM donor_availability_dates ad
             WHERE ad.donor_user_id = d.user_id
               AND ad.available_date = UTC_DATE()
               AND ad.status = 'available'
           ))
       )
    THEN 'available'
  ELSE 'not_available'
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

app.get('/notification-center.css', (req, res) => {
  res.sendFile(path.join(__dirname, 'notification-center.css'));
});

app.get('/notification-center.js', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'notification-center.js'));
});
app.get('/portal-nav.css', (req, res) => {
  res.sendFile(path.join(__dirname, 'portal-nav.css'));
});
app.get('/portal-nav.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'portal-nav.js'));
});

app.get('/assets/blood-donation-hero.jpg', (req, res) => {
  res.sendFile(path.join(__dirname, 'assets', 'blood-donation-hero.jpg'));
});

function isNonEmptyString(value, maxLength) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maxLength;
}

function normalizeLocationName(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function normalizedLocationSql(column) {
  let expression = column;
  for (let pass = 0; pass < 8; pass += 1) {
    expression = `REPLACE(${expression}, '  ', ' ')`;
  }
  return `LOWER(TRIM(${expression}))`;
}

function createDonorContactToken(donorUserId, patientUserId) {
  const payload = Buffer.from(JSON.stringify({
    donorUserId: String(donorUserId),
    patientUserId: String(patientUserId),
    expiresAt: Date.now() + 10 * 60 * 1000
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', signingSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function getDonorContactTokenUserId(token, patientUserId) {
  if (typeof token !== 'string' || token.length > 512) return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = crypto.createHmac('sha256', signingSecret).update(payload).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return typeof data.donorUserId === 'string' && /^[1-9]\d{0,19}$/.test(data.donorUserId) &&
      data.patientUserId === String(patientUserId) &&
      Number.isSafeInteger(data.expiresAt) && data.expiresAt > Date.now()
      ? data.donorUserId
      : null;
  } catch {
    return null;
  }
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

function requirePatientSession(req, res, next) {
  if (!getSessionUserId(req)) {
    return res.status(401).json({ message: 'Log in with a patient account to submit an emergency blood request.' });
  }
  return requireSession(req, res, next);
}

async function requireBloodBankStaff(req, res, next) {
  if (req.user?.role !== 'blood_bank') {
    return res.status(403).json({ message: 'Authorized blood-bank staff access is required.' });
  }
  try {
    const [staffRows] = await db.execute(
      `SELECT s.bank_id, b.bank_name, b.phone, b.email, b.address_text,
              b.operating_hours, b.city, b.district, b.state, b.is_active
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
      return res.redirect(
        `/login?next=${encodeURIComponent(req.originalUrl)}&required_role=${encodeURIComponent(role)}`
      );
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
  res.set('Cache-Control', 'no-store');
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
  await ensureColumn('donors', 'last_donation_date', 'DATE NULL');
  await ensureColumn('donors', 'next_eligible_date', 'DATE NULL');
  await ensureColumn('donors', 'availability_unavailable_reason', 'VARCHAR(32) NULL AFTER availability_status');
  await ensureColumn('donors', 'availability_return_at', 'DATETIME NULL AFTER availability_unavailable_reason');
  await ensureColumn('donor_health_screenings', 'health_data_consent_at', 'DATETIME NULL AFTER review_notes');
  await ensureColumn('donor_health_screenings', 'form_version', 'VARCHAR(20) NULL AFTER health_data_consent_at');
  await ensureColumn('blood_requests', 'component', "ENUM('whole_blood', 'red_cells', 'platelets', 'plasma') NOT NULL DEFAULT 'whole_blood' AFTER blood_group");
  if (!PORTAL_SCHEMA) {
    await db.query(
      `ALTER TABLE blood_requests MODIFY COLUMN status
       ENUM('Pending Verification', 'Under Review', 'Confirmed', 'Not Confirmed', 'Fulfilled', 'Cancelled')
       NOT NULL DEFAULT 'Pending Verification'`
    );
  }
  await ensureColumn('blood_requests', 'coordination_status', "ENUM('Pending', 'Under Review', 'Accepted', 'Rejected', 'In Progress', 'Fulfilled', 'Cancelled') NOT NULL DEFAULT 'Pending' AFTER status");
  await ensureColumn('blood_requests', 'selected_donor_user_id', `${userIdType} NULL AFTER coordination_status`);
  await ensureColumn('blood_requests', 'selected_donor_confirmed_at', 'DATETIME NULL AFTER selected_donor_user_id');
  await ensureColumn('blood_requests', 'target_donor_user_id', `${userIdType} NULL AFTER selected_donor_confirmed_at`);
  const [requestIndexes] = await db.query('SHOW INDEX FROM blood_requests');
  if (!requestIndexes.some(index => index.Key_name === 'idx_blood_requests_target_donor')) {
    await db.query('CREATE INDEX idx_blood_requests_target_donor ON blood_requests (target_donor_user_id)');
  }
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
    `CREATE TABLE IF NOT EXISTS admin_donor_availability_reviews (
      review_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      donor_user_id ${userIdType} NOT NULL,
      admin_id TINYINT UNSIGNED NOT NULL,
      action ENUM('confirmed', 'rejected', 'revoked') NOT NULL,
      reason VARCHAR(500) NULL,
      reviewed_at DATETIME NOT NULL,
      PRIMARY KEY (review_id),
      KEY idx_admin_availability_review_donor (donor_user_id, reviewed_at),
      CONSTRAINT fk_admin_availability_review_donor FOREIGN KEY (donor_user_id)
        REFERENCES users (user_id) ON DELETE RESTRICT,
      CONSTRAINT fk_admin_availability_review_admin FOREIGN KEY (admin_id)
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
    `CREATE TABLE IF NOT EXISTS donor_reported_donations (
      report_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      donor_user_id ${userIdType} NOT NULL,
      donation_date DATE NOT NULL,
      report_status ENUM('pending', 'verified', 'rejected') NOT NULL DEFAULT 'pending',
      reported_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reviewed_by_admin_id TINYINT UNSIGNED NULL,
      reviewed_at DATETIME NULL,
      review_note VARCHAR(500) NULL,
      PRIMARY KEY (report_id),
      KEY idx_reported_donations_status (report_status, reported_at),
      KEY idx_reported_donations_donor (donor_user_id, report_status),
      CONSTRAINT fk_reported_donations_donor FOREIGN KEY (donor_user_id)
        REFERENCES users (user_id) ON DELETE RESTRICT,
      CONSTRAINT fk_reported_donations_admin FOREIGN KEY (reviewed_by_admin_id)
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
  await ensureColumn('blood_banks', 'phone', 'VARCHAR(20) NULL');
  await ensureColumn('blood_banks', 'email', 'VARCHAR(150) NULL');
  await ensureColumn('blood_banks', 'address_text', "VARCHAR(255) NOT NULL DEFAULT ''");
  await ensureColumn('blood_banks', 'operating_hours', 'VARCHAR(120) NULL');
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
    ['is_available', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['public_contact_consent', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['public_identity_consent', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['public_phone_consent', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['availability_expires_at', 'DATETIME NULL'],
    ['available_until', 'DATETIME NULL'],
    ['availability_starts_at', 'DATETIME NULL'],
    ["availability_status", "ENUM('available', 'not_available') NOT NULL DEFAULT 'not_available'"],
    ['last_confirmed_at', 'DATETIME NULL'],
    ['availability_updated_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'],
    ['emergency_response_consent', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ["availability_mode", "ENUM('selected_dates', 'general', 'unavailable') NOT NULL DEFAULT 'unavailable'"]
  ]) {
    await ensureColumn('donors', name, definition);
  }
  await ensureColumn('donors', 'last_donation_date', 'DATE NULL');
  await ensureColumn('donors', 'next_eligible_date', 'DATE NULL');
  await ensureTemporaryUnavailableStatus();
  await db.execute(
    `UPDATE donors
     SET availability_starts_at = last_confirmed_at
     WHERE availability_starts_at IS NULL
       AND last_confirmed_at IS NOT NULL
       AND availability_expires_at IS NOT NULL`
  );

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
      status ENUM('Pending Verification', 'Under Review', 'Confirmed', 'Not Confirmed', 'Fulfilled', 'Cancelled') NOT NULL DEFAULT 'Pending Verification',
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
      public_phone_consent TINYINT(1) NOT NULL DEFAULT 0,
      availability_expires_at DATETIME NULL,
      availability_starts_at DATETIME NULL,
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
    ['public_phone_consent', 'ALTER TABLE donors ADD COLUMN public_phone_consent TINYINT(1) NOT NULL DEFAULT 0 AFTER public_identity_consent'],
    ['availability_expires_at', 'ALTER TABLE donors ADD COLUMN availability_expires_at DATETIME NULL AFTER public_contact_consent'],
    ['available_until', 'ALTER TABLE donors ADD COLUMN available_until DATETIME NULL AFTER availability_expires_at'],
    ['availability_mode', "ALTER TABLE donors ADD COLUMN availability_mode ENUM('selected_dates', 'general', 'unavailable') NOT NULL DEFAULT 'general' AFTER availability_expires_at"],
    ['availability_status', "ALTER TABLE donors ADD COLUMN availability_status ENUM('available', 'not_available') NOT NULL DEFAULT 'not_available' AFTER availability_expires_at"],
    ['last_confirmed_at', 'ALTER TABLE donors ADD COLUMN last_confirmed_at DATETIME NULL AFTER availability_status'],
    ['availability_starts_at', 'ALTER TABLE donors ADD COLUMN availability_starts_at DATETIME NULL AFTER last_confirmed_at'],
    ['availability_updated_at', 'ALTER TABLE donors ADD COLUMN availability_updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER last_confirmed_at'],
    ['emergency_response_consent', 'ALTER TABLE donors ADD COLUMN emergency_response_consent TINYINT(1) NOT NULL DEFAULT 0 AFTER availability_updated_at'],
    ['user_id', 'ALTER TABLE donors ADD COLUMN user_id BIGINT UNSIGNED NULL AFTER id']
  ];
  for (const [columnName, statement] of migrations) {
    if (!columnNames.has(columnName)) await db.query(statement);
  }
  await ensureTemporaryUnavailableStatus();
  await db.execute(
    `UPDATE donors
     SET availability_starts_at = last_confirmed_at
     WHERE availability_starts_at IS NULL
       AND last_confirmed_at IS NOT NULL
       AND availability_expires_at IS NOT NULL`
  );
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
  if (!indexes.some(index => index.Key_name === 'idx_donors_availability_window')) {
    await db.query(
      'CREATE INDEX idx_donors_availability_window ON donors (blood_group, state, city, availability_starts_at, availability_expires_at)'
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

app.post('/api/blood-requests', rateLimit(5, 15 * 60 * 1000), requireDatabase, requirePatientSession, async (req, res) => {
  if (req.user.role !== 'patient') {
    return res.status(403).json({ message: 'A patient account is required to submit an emergency blood request. Please log out and sign in with a patient account.' });
  }
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
  const city = normalizeLocationName(req.body?.city);
  const state = normalizeLocationName(typeof req.body?.state === 'string' ? req.body.state : req.user.state);
  const availabilitySearchArea = typeof req.body?.availability_search_area === 'string'
    ? normalizeLocationName(req.body.availability_search_area)
    : '';
  const district = typeof req.body?.district === 'string' ? req.body.district.trim() : '';
  const targetDonorToken = req.body?.target_donor_token;
  const targetDonorUserId = targetDonorToken == null || targetDonorToken === ''
    ? null
    : getDonorContactTokenUserId(targetDonorToken, req.user.user_id);
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
      (req.body.match_donors && urgency !== 'Urgent') ||
      (req.body.match_donors && !hasSeparateHospitalName)) {
    return res.status(400).json({
      message: req.body.match_donors && urgency !== 'Urgent'
        ? 'Donor notification consent is available only for requests marked Urgent.'
        : 'Choose whether to create donor notifications. Matching requires a separate hospital name so private address details are never shared.'
    });
  }
  if (req.body?.confirm_request !== true) {
    return res.status(400).json({
      message: 'Review the request details and explicitly confirm before submitting.'
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
      (req.body?.availability_search_area !== undefined &&
        typeof req.body.availability_search_area !== 'string') ||
      (availabilitySearchArea && !isNonEmptyString(availabilitySearchArea, 100)) ||
      !isNonEmptyString(district, 80) ||
      (targetDonorToken != null && targetDonorToken !== '' && !targetDonorUserId) ||
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
  let notificationContext = null;
  let createdRequestId = null;
  try {
    const sqlNeededAt = new Date(neededAtTimestamp).toISOString().slice(0, 19).replace('T', ' ');
    connection = await db.getConnection();
    await connection.beginTransaction();
    const compatibleBloodGroups = getCompatibleDonorBloodGroups(bloodGroup);
    const availabilityAreaFilter = availabilitySearchArea
      ? `AND ${normalizedLocationSql(DONOR_AREA_SQL)} = LOWER(?)`
      : '';
    const [availableDonors] = await connection.execute(
      `SELECT d.user_id
       FROM donors d
       JOIN users available_user ON available_user.user_id = d.user_id AND available_user.role = 'donor'
       WHERE d.available = 1
         AND d.availability_status = 'available'
         AND d.public_contact_consent = 1
         AND d.last_confirmed_at IS NOT NULL
         AND ${DONOR_COOLDOWN_CLEAR_SQL}
         AND ${DONOR_POST_COOLDOWN_CONFIRMATION_SQL}
         AND NOT ${DONOR_MEDICAL_RESTRICTION_SQL}
         AND (
           (COALESCE(d.availability_mode, 'general') = 'general'
             AND COALESCE(d.availability_starts_at, d.last_confirmed_at) <= UTC_TIMESTAMP()
             AND d.availability_expires_at > UTC_TIMESTAMP())
           OR
           (COALESCE(d.availability_mode, 'general') = 'selected_dates'
             AND EXISTS (
               SELECT 1 FROM donor_availability_dates ad
               WHERE ad.donor_user_id = d.user_id
                 AND ad.available_date = UTC_DATE()
                 AND ad.status = 'available'
             ))
         )
         AND d.blood_group IN (${compatibleBloodGroups.map(() => '?').join(', ')})
         AND ${normalizedLocationSql(DONOR_CITY_SQL)} = LOWER(?)
         AND ${normalizedLocationSql(DONOR_STATE_SQL)} = LOWER(?)
         ${availabilityAreaFilter}
       LIMIT 1`,
      [...compatibleBloodGroups, city, state,
        ...(availabilitySearchArea ? [availabilitySearchArea] : [])]
    );
    if (availableDonors.length) {
      await connection.rollback();
      return res.status(409).json({
        message: 'A matching available donor was found. Refresh Live Donor Availability; an emergency request is available only when no matching available donor is found.'
      });
    }
    if (targetDonorUserId) {
      const [[targetDonor]] = await connection.execute(
        `SELECT d.user_id
         FROM donors d
         JOIN users u ON u.user_id = d.user_id AND u.role = 'donor'
         WHERE d.user_id = ?
           AND d.available = 1
           AND d.last_confirmed_at IS NOT NULL
           AND d.public_contact_consent = 1
           AND d.emergency_response_consent = 1
           AND ${DONOR_ELIGIBILITY_SQL}
           AND d.blood_group IN (${compatibleBloodGroups.map(() => '?').join(', ')})
           AND ${normalizedLocationSql(DONOR_CITY_SQL)} = LOWER(?)
           AND ${normalizedLocationSql(DONOR_STATE_SQL)} = LOWER(?)
           AND (
             (COALESCE(d.availability_mode, 'general') = 'general'
               AND COALESCE(d.availability_starts_at, d.last_confirmed_at) <= UTC_TIMESTAMP()
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
         LIMIT 1
         FOR UPDATE`,
        [targetDonorUserId, ...compatibleBloodGroups, city, state, sqlNeededAt]
      );
      if (!targetDonor) {
        await connection.rollback();
        return res.status(409).json({
          message: 'This donor is no longer available for a contact request. Refresh Live Donor Search and try again.'
        });
      }
    }
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
        sqlNeededAt,
        targetDonorUserId
      ];
    const [result] = PORTAL_SCHEMA
      ? await connection.execute(
        `INSERT INTO blood_requests
            (requester_user_id, patient_name, blood_group, component, units_needed, hospital_name,
            hospital_address, contact_phone, urgency, needed_by, status,
            user_id, patient_reference, units, hospital_details, city, state, district,
            contact_name, needed_at, target_donor_user_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          sqlNeededAt,
          targetDonorUserId
        ]
      )
      : await connection.execute(
        `INSERT INTO blood_requests
           (user_id, patient_reference, blood_group, component, units, urgency, hospital_details, hospital_name,
            city, state, district, contact_name, contact_phone, needed_at, target_donor_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        requestValues
      );
    createdRequestId = Number(result.insertId);
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
         SELECT r.request_id, d.user_id, 'pending', UTC_TIMESTAMP(), ?
         FROM blood_requests r
         JOIN donors d ON 1 = 1
         JOIN users matched_user ON matched_user.user_id = d.user_id AND matched_user.role = 'donor'
         WHERE r.request_id = ?
           AND ${DONOR_EMERGENCY_RESPONSE_ELIGIBILITY_SQL}
           AND d.blood_group IN (${getCompatibleDonorBloodGroups(bloodGroup).map(() => '?').join(', ')})
           AND ${normalizedLocationSql(DONOR_CITY_SQL)} = LOWER(?)
           AND ${normalizedLocationSql(DONOR_STATE_SQL)} = LOWER(?)
           AND (? IS NULL OR d.user_id = ?)
           AND d.user_id <> ?`,
        [responseDeadline, result.insertId,
          ...getCompatibleDonorBloodGroups(bloodGroup), city, state,
          targetDonorUserId, targetDonorUserId, req.user.user_id]
      );
      matchedDonorCount = matches.affectedRows;
    }
    notificationContext = 'emergency request';
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
              CONCAT('Request LD-', r.request_id, ': ', r.blood_group, ' blood is needed at ',
                     COALESCE(NULLIF(r.hospital_name, ''), 'a hospital'), ' in ', r.city,
                     '. Sign in to review the request. Patient name, phone, and address are not shared.'),
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
          ? 'Blood request saved. No eligible, available, opted-in donors matched the compatible blood group and location; no donor notification was created.'
          : 'Blood request saved. Donor notifications were not requested; no email, SMS, or push notification was sent.',
      request_id: String(result.insertId),
      status: 'Pending Verification',
      matched_donor_count: matchedDonorCount,
      donor_notifications_requested: urgency === 'Urgent' && req.body.match_donors,
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
    if (notificationContext) {
      await reportNotificationFailure(
        createdRequestId ? `${notificationContext} for request ${createdRequestId}` : notificationContext,
        null,
        error
      );
    }
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
              CAST(selected_donor_user_id AS CHAR) AS selected_donor_user_id,
              DATE_FORMAT(selected_donor_confirmed_at, '%Y-%m-%dT%H:%i:%sZ') AS selected_donor_confirmed_at,
              DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%sZ') AS submitted_at,
              DATE_FORMAT(needed_at, '%Y-%m-%dT%H:%i:%sZ') AS needed_at
       FROM blood_requests WHERE user_id = ?
       ORDER BY created_at DESC, request_id DESC LIMIT 100`,
      [req.user.user_id]
    );
    const [donorResponses] = requests.length
      ? await db.execute(
        `SELECT CAST(dr.request_id AS CHAR) AS request_id,
                CASE
                  WHEN dr.response = 'can_help' THEN 'Donor Confirmed'
                  WHEN dr.response IN ('cannot_help', 'busy', 'declined') THEN 'Donor Declined'
                  WHEN dr.response = 'pending' AND dr.response_deadline > UTC_TIMESTAMP()
                    THEN 'Waiting for Donor Response'
                  ELSE 'Waiting for Donor Response'
                END AS status,
                CASE WHEN dr.response = 'can_help' AND dr.contact_sharing_consent = 1
                     THEN COALESCE(NULLIF(TRIM(donor.full_name), ''), NULLIF(TRIM(d.full_name), ''))
                     ELSE NULL END AS donor_name,
                CASE WHEN dr.response = 'can_help' AND dr.contact_sharing_consent = 1
                     THEN CAST(dr.donor_user_id AS CHAR) ELSE NULL END AS consenting_donor_user_id,
                (r.selected_donor_user_id = dr.donor_user_id) AS patient_selected,
                (dr.response = 'can_help'
                  AND dr.contact_sharing_consent = 1
                  AND r.status NOT IN ('Fulfilled', 'Cancelled')
                  AND r.selected_donor_user_id IS NULL
                  AND ${DONOR_EMERGENCY_RESPONSE_ELIGIBILITY_SQL}
                ) AS can_select
         FROM donor_request_responses dr
         JOIN blood_requests r ON r.request_id = dr.request_id
         LEFT JOIN donors d ON d.user_id = dr.donor_user_id
         LEFT JOIN users donor ON donor.user_id = dr.donor_user_id
         WHERE r.user_id = ?
         ORDER BY r.created_at DESC, dr.matched_at, dr.donor_user_id`,
        [req.user.user_id]
      )
      : [[]];
    const responsesByRequest = new Map();
    for (const response of donorResponses) {
      if (!responsesByRequest.has(response.request_id)) {
        responsesByRequest.set(response.request_id, []);
      }
      responsesByRequest.get(response.request_id).push({
        status: response.status,
        donor_name: response.donor_name,
        donor_response_id: response.can_select ? response.consenting_donor_user_id : null,
        can_select: response.can_select === 1,
        patient_selected: response.patient_selected === 1
      });
    }
    const [events] = requests.length
      ? await db.execute(
        `SELECT CAST(e.request_id AS CHAR) AS request_id, e.event_type,
                e.previous_status, e.new_status,
                DATE_FORMAT(e.created_at, '%Y-%m-%dT%H:%i:%sZ') AS created_at
         FROM blood_request_events e
         JOIN blood_requests r ON r.request_id = e.request_id
         WHERE r.user_id = ? AND e.event_type IN
           ('request_submitted', 'request_escalated', 'coordination_status',
            'request_status_self_reported', 'admin_request_confirmed',
            'admin_request_not_confirmed',
            'patient_confirmed_blood_received')
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
      donor_responses: responsesByRequest.get(request.request_id) || [],
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
    'SELECT blood_group, target_donor_user_id FROM blood_requests WHERE request_id = ? LIMIT 1',
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
       AND ${DONOR_EMERGENCY_RESPONSE_ELIGIBILITY_SQL}
       AND ${normalizedLocationSql(DONOR_CITY_SQL)} = ${normalizedLocationSql('r.city')}
       AND ${normalizedLocationSql(DONOR_STATE_SQL)} = ${normalizedLocationSql('r.state')}
       AND (r.target_donor_user_id IS NULL OR r.target_donor_user_id = d.user_id)
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
              CONCAT('Request LD-', r.request_id, ': ', r.blood_group,
                     ' blood is needed at ', COALESCE(NULLIF(r.hospital_name, ''), 'a hospital'),
                     ' in ', r.city,
                     '. Patient name, phone, and address are not shared.'),
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
     SELECT d.user_id, 'Please confirm your availability',
            'Registration does not confirm donor availability. Open your Donor Portal to explicitly choose Available or Not Available.',
            'availability_confirmation_required',
            CONCAT('availability-confirmation-required:', d.user_id),
            UTC_TIMESTAMP()
     FROM donors d
     WHERE d.user_id = ? AND d.last_confirmed_at IS NULL`,
    [userId]
  );
  await db.execute(
    `INSERT IGNORE INTO in_app_notifications
       (recipient_user_id, title, message, notification_type, dedupe_key, created_at)
     SELECT d.user_id, 'Eligibility review is approaching',
            'Your configured recovery interval is approaching its review date. This reminder is informational; qualified staff must determine eligibility.',
            'eligibility_review_approaching',
            CONCAT('eligibility-review-upcoming:', d.user_id, ':',
              DATE_FORMAT(COALESCE(d.next_eligible_date,
                DATE_ADD(d.last_donation_date, INTERVAL ${DONATION_ELIGIBILITY_MONTHS} MONTH)), '%Y-%m-%d')),
            UTC_TIMESTAMP()
     FROM donors d
     WHERE d.user_id = ?
       AND d.last_donation_date IS NOT NULL
       AND COALESCE(d.next_eligible_date,
         DATE_ADD(d.last_donation_date, INTERVAL ${DONATION_ELIGIBILITY_MONTHS} MONTH)) > UTC_DATE()
       AND COALESCE(d.next_eligible_date,
         DATE_ADD(d.last_donation_date, INTERVAL ${DONATION_ELIGIBILITY_MONTHS} MONTH))
           <= DATE_ADD(UTC_DATE(), INTERVAL 7 DAY)
       AND NOT (${DONOR_ELIGIBILITY_SQL})`,
    [userId]
  );
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
           AND COALESCE(d.availability_starts_at, d.last_confirmed_at) <= UTC_TIMESTAMP()
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

async function createBloodBankStockReminderNotifications(userId) {
  await db.execute(
    `INSERT IGNORE INTO in_app_notifications
       (recipient_user_id, title, message, notification_type, dedupe_key, created_at)
     SELECT staff.user_id, 'Daily blood-stock update is due',
            CONCAT('Submit the daily stock update for ', bank.bank_name,
                   '. Stock without a fresh verified update is not shown as current.'),
            'blood_stock_update_due',
            CONCAT('blood-stock-update-due:', bank.blood_bank_id, ':',
                   DATE_FORMAT(UTC_DATE(), '%Y-%m-%d')),
            UTC_TIMESTAMP()
     FROM blood_bank_staff staff
     JOIN blood_banks bank ON bank.blood_bank_id = staff.bank_id
     WHERE staff.user_id = ?
       AND bank.is_active = 1
       AND (bank.verification_status = 'verified' OR bank.verified = 1)
       AND NOT EXISTS (
         SELECT 1 FROM blood_stock stock
         WHERE stock.blood_bank_id = bank.blood_bank_id
           AND stock.last_updated >= UTC_DATE()
           AND stock.last_updated < DATE_ADD(UTC_DATE(), INTERVAL 1 DAY)
       )`,
    [userId]
  );
}

app.get('/api/notifications', requireDatabase, requireSession, async (req, res) => {
  if (!['donor', 'patient', 'blood_bank'].includes(req.user.role)) {
    return res.status(403).json({ message: 'Notifications are not available for this account.' });
  }
  try {
    if (req.user.role === 'donor') {
      await createDonorReminderNotifications(req.user.user_id);
    } else if (req.user.role === 'blood_bank') {
      await createBloodBankStockReminderNotifications(req.user.user_id);
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
    if (!['donor', 'patient', 'blood_bank'].includes(req.user.role)) {
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

app.post('/api/notifications/read-all', requireDatabase, requireSession,
  rateLimit(30, 60 * 60 * 1000), async (req, res) => {
    if (!['donor', 'patient', 'blood_bank'].includes(req.user.role)) {
      return res.status(403).json({ message: 'Notifications are not available for this account.' });
    }
    try {
      const [result] = await db.execute(
        `UPDATE in_app_notifications
         SET read_at = UTC_TIMESTAMP()
         WHERE recipient_user_id = ? AND read_at IS NULL`,
        [req.user.user_id]
      );
      res.json({ marked_read: result.affectedRows });
    } catch (error) {
      console.error('In-app notification bulk read update failed:', error.code || error.message);
      res.status(500).json({ message: 'Could not mark your notifications as read.' });
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

app.post('/api/admin/notifications/read-all', requireDatabase,
  requireAdminConfigured, requireAdmin, rateLimit(30, 60 * 60 * 1000), async (req, res) => {
    try {
      const [result] = await db.execute(
        `UPDATE in_app_notifications
         SET read_at = UTC_TIMESTAMP()
         WHERE recipient_admin_id = ? AND read_at IS NULL`,
        [req.admin.admin_id]
      );
      res.json({ marked_read: result.affectedRows });
    } catch (error) {
      console.error('Admin notification bulk read update failed:', error.code || error.message);
      res.status(500).json({ message: 'Could not mark admin notifications as read.' });
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
              r.status AS request_status,
              (r.selected_donor_user_id = dr.donor_user_id) AS patient_selected,
              dr.response,
              CASE WHEN r.status IN ('Fulfilled', 'Cancelled') THEN 'Request Closed'
                   WHEN dr.response = 'expired'
                     OR (dr.response = 'pending' AND dr.response_deadline <= UTC_TIMESTAMP()) THEN 'No Response'
                   WHEN dr.response = 'pending' THEN 'Pending'
                   WHEN dr.response = 'can_help' AND r.selected_donor_user_id = dr.donor_user_id
                     THEN 'Patient selected you for coordination'
                   WHEN dr.response = 'can_help' THEN 'Accepted — Awaiting Contact'
                   WHEN dr.response = 'busy' THEN 'Busy'
                   ELSE 'Declined' END AS response_status,
              CASE
                WHEN d.available = 1 AND d.last_confirmed_at IS NOT NULL
                     AND COALESCE(d.availability_mode, 'general') = 'general'
                     AND COALESCE(d.availability_starts_at, d.last_confirmed_at) <= UTC_TIMESTAMP()
                     AND d.availability_expires_at > UTC_TIMESTAMP() THEN 'Available'
                WHEN d.available = 1 AND d.last_confirmed_at IS NOT NULL
                     AND COALESCE(d.availability_mode, 'general') = 'general'
                     AND d.availability_starts_at > UTC_TIMESTAMP()
                     AND d.availability_expires_at > UTC_TIMESTAMP() THEN 'Scheduled'
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
              CASE WHEN ${DONOR_EMERGENCY_RESPONSE_ELIGIBILITY_SQL}
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
             ${DONOR_EMERGENCY_RESPONSE_ELIGIBILITY_SQL}
           ))`,
        [response, response === 'can_help' && shareContact ? 1 : 0,
          requestId, req.user.user_id, response, response]
      );
      if (!result.affectedRows) {
        const [matches] = await db.execute(
          `SELECT dr.response, dr.response_deadline <= UTC_TIMESTAMP() AS expired,
                  r.status,
                  CASE WHEN ${DONOR_EMERGENCY_RESPONSE_ELIGIBILITY_SQL}
                       THEN 1 ELSE 0 END AS can_offer_help
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
        if (response === 'can_help' && matches[0].can_offer_help !== 1) {
          return res.status(409).json({
            message: 'Your emergency-request opt-in, current medical eligibility, cooldown, or availability rules no longer allow you to accept this request.'
          });
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
        await reportNotificationFailure('patient donor-response', requestId, error);
      }
      let adminNotificationFailed = false;
      try {
        await saveAdminNotifications(db, {
          title: 'Donor response received',
          message: `A matched donor responded to emergency request ${requestId}: ${response === 'can_help' ? 'available to help' : response === 'busy' ? 'busy' : 'unable to help'}.`,
          type: 'admin_donor_response',
          relatedRequestId: Number(requestId),
          dedupeKey: `admin-donor-response:${requestId}:${req.user.user_id}`
        });
      } catch (error) {
        adminNotificationFailed = true;
        await reportNotificationFailure('admin donor-response', requestId, error);
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
          : adminNotificationFailed
            ? 'Your response was saved and the patient was notified, but the admin alert could not be saved.'
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
        additional_notifications: additionalNotifications,
        admin_notification_failed: adminNotificationFailed
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
              r.selected_donor_user_id,
              DATE_FORMAT(r.selected_donor_confirmed_at, '%Y-%m-%dT%H:%i:%sZ') AS selected_donor_confirmed_at,
              r.blood_group, r.units, r.urgency, r.city, r.district,
              DATE_FORMAT(r.needed_at, '%Y-%m-%dT%H:%i:%sZ') AS needed_at,
              DATE_FORMAT(r.created_at, '%Y-%m-%dT%H:%i:%sZ') AS requested_at,
              r.status AS request_status, dr.response, dr.donor_user_id,
              dr.contact_sharing_consent,
              CASE WHEN r.status IN ('Fulfilled', 'Cancelled') THEN 'Request Closed'
                   WHEN dr.response = 'expired'
                     OR (dr.response = 'pending' AND dr.response_deadline <= UTC_TIMESTAMP())
                     OR dr.response IS NULL THEN 'Expired'
                   WHEN dr.response = 'pending' THEN 'Pending'
                   WHEN dr.response = 'can_help' AND r.selected_donor_user_id = dr.donor_user_id
                     THEN 'Selected by patient for coordination'
                   WHEN dr.response = 'can_help' THEN 'Accepted — Awaiting Contact'
                   WHEN dr.response = 'busy' THEN 'Busy'
                   ELSE 'Declined' END AS response_status,
              CASE
                WHEN dr.response = 'can_help' THEN 'Donor Confirmed'
                WHEN dr.response IN ('cannot_help', 'busy', 'declined') THEN 'Donor Declined'
                WHEN dr.response = 'pending' AND dr.response_deadline > UTC_TIMESTAMP()
                  THEN 'Waiting for Donor Response'
                ELSE 'Waiting for Donor Response'
              END AS patient_response_status,
              CASE
                WHEN dr.donor_user_id IS NULL OR d.emergency_response_consent = 0 THEN NULL
                WHEN d.available = 1 AND d.last_confirmed_at IS NOT NULL
                     AND COALESCE(d.availability_starts_at, d.last_confirmed_at) <= UTC_TIMESTAMP()
                     AND d.availability_expires_at > UTC_TIMESTAMP() THEN 'Available'
                WHEN d.available = 1 AND d.last_confirmed_at IS NOT NULL
                     AND d.availability_starts_at > UTC_TIMESTAMP()
                     AND d.availability_expires_at > UTC_TIMESTAMP() THEN 'Scheduled'
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
                   THEN matched_user.phone ELSE NULL END AS consenting_donor_phone,
              CASE WHEN dr.response = 'can_help'
                         AND dr.contact_sharing_consent = 1
                         AND r.selected_donor_user_id IS NULL
                         AND r.status NOT IN ('Fulfilled', 'Cancelled')
                         AND ${DONOR_EMERGENCY_RESPONSE_ELIGIBILITY_SQL}
                   THEN 1 ELSE 0 END AS can_select
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
          has_selected_donor: row.selected_donor_user_id !== null,
          selected_donor_confirmed_at: row.selected_donor_confirmed_at,
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
          status: row.patient_response_status,
          donor_response_id: row.response === 'can_help' && row.contact_sharing_consent === 1
            ? String(row.donor_user_id)
            : null,
          can_select: row.can_select === 1,
          patient_selected: String(row.selected_donor_user_id) === String(row.donor_user_id),
          availability_status: row.donor_availability_status,
          last_confirmed_at: row.donor_last_confirmed_at,
          donor_name: row.consenting_donor_name,
          donor_phone: row.consenting_donor_phone
        });
      }
    }
    const requests = [...requestMap.values()].map(request => {
      if (['Fulfilled', 'Cancelled'].includes(request.request_status)) {
        request.status = request.request_status;
      } else if (request.donor_responses.some(response => response.patient_selected)) {
        request.status = 'Donor Selected — Coordination Pending';
      } else if (request.counts.can_help) {
        request.status = 'Donor Confirmed';
      } else if (request.counts.pending) {
        request.status = 'Waiting for Donor Response';
      } else if (request.counts.busy && !request.counts.cannot_help) {
        request.status = 'Donor Declined';
      } else if (request.counts.cannot_help) {
        request.status = 'Donor Declined';
      } else if (request.donor_responses.length) {
        request.status = 'Waiting for Donor Response';
      } else {
        request.status = 'Waiting for Donor Response';
      }
      return request;
    });
    res.json({ requests });
  } catch (error) {
    console.error('Emergency response summary lookup failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not load responses to your requests.' });
  }
});

app.post('/api/my-emergency-requests/:requestId/confirm-donor', requireDatabase, requireSession,
  rateLimit(20, 60 * 1000), async (req, res) => {
    if (req.user.role !== 'patient') {
      return res.status(403).json({ message: 'Only the patient who created the request can select a responding donor.' });
    }
    const requestId = typeof req.params.requestId === 'string' ? req.params.requestId : '';
    const donorUserId = String(req.body?.donor_user_id ?? '');
    if (!/^[1-9]\d{0,19}$/.test(requestId) || !/^[1-9]\d{0,19}$/.test(donorUserId)) {
      return res.status(400).json({ message: 'Choose a valid request and donor response.' });
    }

    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const [[request]] = await connection.execute(
        `SELECT request_id, needed_at, status, selected_donor_user_id
         FROM blood_requests
         WHERE request_id = ? AND user_id = ?
         FOR UPDATE`,
        [requestId, req.user.user_id]
      );
      if (!request) {
        await connection.rollback();
        return res.status(404).json({ message: 'Request not found or you do not have permission to update it.' });
      }
      if (['Fulfilled', 'Cancelled'].includes(request.status)) {
        await connection.rollback();
        return res.status(409).json({ message: 'This request is closed and can no longer select a donor.' });
      }
      if (request.selected_donor_user_id !== null &&
          String(request.selected_donor_user_id) !== donorUserId) {
        await connection.rollback();
        return res.status(409).json({ message: 'A donor is already selected for this request. Coordinate with the hospital or blood bank if the selection needs to change.' });
      }

      const [[candidate]] = await connection.execute(
        `SELECT dr.donor_user_id
         FROM donor_request_responses dr
         JOIN blood_requests r ON r.request_id = dr.request_id
         JOIN donors d ON d.user_id = dr.donor_user_id
         JOIN users matched_user ON matched_user.user_id = dr.donor_user_id
           AND matched_user.role = 'donor'
         WHERE dr.request_id = ? AND dr.donor_user_id = ?
           AND dr.response = 'can_help'
           AND dr.contact_sharing_consent = 1
           AND ${DONOR_EMERGENCY_RESPONSE_ELIGIBILITY_SQL}
         LIMIT 1`,
        [requestId, donorUserId]
      );
      if (!candidate) {
        await connection.rollback();
        return res.status(409).json({
          message: 'This donor is no longer eligible for selection, has not accepted, or has not consented to share contact details.'
        });
      }

      await connection.execute(
        `UPDATE blood_requests
         SET selected_donor_user_id = ?, selected_donor_confirmed_at = UTC_TIMESTAMP()
         WHERE request_id = ? AND user_id = ?`,
        [donorUserId, requestId, req.user.user_id]
      );
      await connection.execute(
        `INSERT IGNORE INTO in_app_notifications
           (recipient_user_id, title, message, notification_type, related_request_id,
            dedupe_key, created_at)
         VALUES (?, 'Patient selected you for coordination',
           'The patient selected you for coordination on an emergency request. They may contact you using the details you consented to share. Coordinate through the patient''s hospital or blood bank.',
           'patient_selected_donor', ?, ?, UTC_TIMESTAMP())`,
        [donorUserId, requestId, `patient-selected-donor:${requestId}:${donorUserId}`]
      );
      await connection.commit();
      res.json({
        request_id: requestId,
        message: 'Donor selected for coordination. This is not medical approval or a guarantee of donation; coordinate with the hospital or blood bank.'
      });
    } catch (error) {
      await connection.rollback().catch(() => {});
      console.error('Patient donor selection failed:', error.code || error.message);
      res.status(500).json({ message: 'Could not select this donor for coordination.' });
    } finally {
      connection.release();
    }
  });

app.post('/api/blood-requests/:requestId/confirm-received', requireDatabase, requireSession,
  rateLimit(10, 60 * 60 * 1000), async (req, res) => {
    if (req.user.role !== 'patient') {
      return res.status(403).json({ message: 'Only the patient who created the request can confirm blood was received.' });
    }
    const requestId = typeof req.params.requestId === 'string' ? req.params.requestId : '';
    if (!/^[1-9]\d{0,19}$/.test(requestId) || req.body?.received !== true) {
      return res.status(400).json({ message: 'Explicitly confirm that the requested blood was received.' });
    }

    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const [[request]] = await connection.execute(
        `SELECT request_id, status
         FROM blood_requests
         WHERE request_id = ? AND user_id = ?
         FOR UPDATE`,
        [requestId, req.user.user_id]
      );
      if (!request) {
        await connection.rollback();
        return res.status(404).json({ message: 'Request not found or you do not have permission to update it.' });
      }
      if (request.status === 'Fulfilled') {
        await connection.rollback();
        return res.status(409).json({ message: 'Blood receipt was already confirmed for this request.' });
      }
      if (request.status === 'Cancelled') {
        await connection.rollback();
        return res.status(409).json({ message: 'A cancelled request cannot be marked fulfilled.' });
      }

      await connection.execute(
        `UPDATE blood_requests
         SET status = 'Fulfilled'
         WHERE request_id = ? AND user_id = ?`,
        [requestId, req.user.user_id]
      );
      const [eventResult] = await connection.execute(
        `INSERT INTO blood_request_events
           (request_id, actor_user_id, event_type, previous_status, new_status, details)
         VALUES (?, ?, 'patient_confirmed_blood_received', ?, 'Fulfilled', ?)`,
        [requestId, req.user.user_id, request.status,
          JSON.stringify({ source: 'patient confirmation', blood_received: true })]
      );
      await saveAdminNotifications(connection, {
        title: 'Patient confirmed blood received',
        message: `The patient confirmed blood receipt for emergency request ${requestId}.`,
        type: 'admin_request_status',
        relatedRequestId: Number(requestId),
        dedupeKey: `patient-blood-received:${eventResult.insertId}`
      });
      await connection.commit();
      res.json({
        request_id: requestId,
        request_status: 'Fulfilled',
        coordination_status_unchanged: true,
        message: 'Blood receipt confirmed. The request status is Fulfilled; donor response and coordination status remain separate.'
      });
    } catch (error) {
      await connection.rollback().catch(() => {});
      console.error('Patient blood-received confirmation failed:', error.code || error.message);
      res.status(500).json({ message: 'Could not confirm blood receipt for this request.' });
    } finally {
      connection.release();
    }
  });

app.patch('/api/blood-requests/:requestId/status', requireDatabase, requireSession, rateLimit(30, 60 * 1000), async (req, res) => {
  const requestId = typeof req.params.requestId === 'string' ? req.params.requestId : '';
  const status = typeof req.body?.status === 'string' ? req.body.status : '';
  if (req.user.role !== 'patient') {
    return res.status(403).json({ message: 'Only patient accounts can update their own request status.' });
  }
  if (!/^[1-9]\d{0,19}$/.test(requestId) || !REQUEST_STATUSES.has(status)) {
    return res.status(400).json({
      message: status === 'Fulfilled'
        ? 'Use Confirm Blood Received after the patient has actually received blood.'
        : 'Choose a valid request and status.'
    });
  }
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [[request]] = await connection.execute(
      `SELECT request_id, status FROM blood_requests
       WHERE request_id = ? AND user_id = ? FOR UPDATE`,
      [requestId, req.user.user_id]
    );
    if (!request) {
      await connection.rollback();
      return res.status(404).json({ message: 'Request not found or you do not have permission to update it.' });
    }
    if (request.status !== status) {
      await connection.execute(
        'UPDATE blood_requests SET status = ? WHERE request_id = ? AND user_id = ?',
        [status, requestId, req.user.user_id]
      );
      const [eventResult] = await connection.execute(
        `INSERT INTO blood_request_events
           (request_id, actor_user_id, event_type, previous_status, new_status, details)
         VALUES (?, ?, 'request_status_self_reported', ?, ?, ?)`,
        [requestId, req.user.user_id, request.status, status,
          JSON.stringify({ source: 'patient request board', status_is_self_reported: true })]
      );
      await saveInAppNotification(connection, {
        recipientUserId: req.user.user_id,
        title: 'Your request status changed',
        message: `Your self-reported request status is now ${status}. This status is not independently verified.`,
        type: 'request_status',
        relatedRequestId: Number(requestId),
        dedupeKey: `request-status-event:${eventResult.insertId}`
      });
      await saveAdminNotifications(connection, {
        title: 'Patient request status changed',
        message: `A patient self-reported request ${requestId} as ${status}.`,
        type: 'admin_request_status',
        relatedRequestId: Number(requestId),
        dedupeKey: `request-status-self-reported:${eventResult.insertId}`
      });
    }
    await connection.commit();
    res.json({ message: 'Request status updated.', request_id: requestId, status });
  } catch (error) {
    await connection.rollback().catch(() => {});
    console.error('Blood-request status update failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not update the blood-request status.' });
  } finally {
    connection.release();
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
    typeof publicContactConsent !== 'boolean' ||
    consent !== true
  ) {
    return res.status(400).json({ message: 'Check the account details, password, and consent.' });
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
        0,
        publicContactConsent ? 1 : 0,
        null,
        'not_available',
        null
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
             0,
             0,
             publicContactConsent ? 1 : 0,
             null,
             null,
             'not_available',
             'unavailable',
             null
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

app.patch('/api/admin/blood-requests/:requestId/confirm', requireDatabase,
  requireAdminConfigured, requireAdmin, rateLimit(30, 60 * 1000), async (req, res) => {
    const requestId = typeof req.params.requestId === 'string' ? req.params.requestId : '';
    const status = req.body?.status ?? 'Confirmed';
    if (!/^[1-9]\d{0,19}$/.test(requestId) ||
        !['Confirmed', 'Not Confirmed'].includes(status)) {
      return res.status(400).json({ message: 'Choose a valid request and select Confirmed or Not Confirmed.' });
    }

    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const [[request]] = await connection.execute(
        `SELECT request_id, status, user_id
         FROM blood_requests
         WHERE request_id = ?
         FOR UPDATE`,
        [requestId]
      );
      if (!request) {
        await connection.rollback();
        return res.status(404).json({ message: 'Emergency blood request was not found.' });
      }
      if (request.status === status) {
        await connection.rollback();
        return res.json({
          request_id: requestId,
          request_status: status,
          message: `This request is already ${status === 'Confirmed' ? 'confirmed' : 'marked not confirmed'}.`
        });
      }
      if (!['pending', 'pending verification', 'under review', 'open', 'confirmed', 'not confirmed'].includes(
        String(request.status || '').toLowerCase()
      )) {
        await connection.rollback();
        return res.status(409).json({
          message: `A request with status "${request.status}" cannot be changed to ${status}.`
        });
      }

      await connection.execute(
        `UPDATE blood_requests
         SET status = ?
         WHERE request_id = ?`,
        [status, requestId]
      );
      const eventType = status === 'Confirmed'
        ? 'admin_request_confirmed'
        : 'admin_request_not_confirmed';
      const title = status === 'Confirmed'
        ? 'Emergency request confirmed'
        : 'Emergency request marked not confirmed';
      const [eventResult] = await connection.execute(
        `INSERT INTO blood_request_events
           (request_id, actor_user_id, event_type, previous_status, new_status, details)
         VALUES (?, NULL, ?, ?, ?, ?)`,
        [requestId, eventType, request.status, status, JSON.stringify({
          admin_id: req.admin.admin_id,
          admin_username: req.admin.username
        })]
      );
      await saveInAppNotification(connection, {
        recipientUserId: request.user_id,
        title,
        message: status === 'Confirmed'
          ? `An administrator confirmed emergency request ${requestId}. Donor responses and blood receipt status are separate.`
          : `An administrator marked emergency request ${requestId} as not confirmed. Donor responses and blood receipt status are separate.`,
        type: 'request_status',
        relatedRequestId: Number(requestId),
        dedupeKey: `admin-request-status:${eventResult.insertId}`
      });
      await connection.commit();
      res.json({
        request_id: requestId,
        request_status: status,
        message: status === 'Confirmed'
          ? 'Request confirmed. This does not confirm a donor response or that blood was received.'
          : 'Request marked not confirmed. Donor responses and blood receipt status were not changed.'
      });
    } catch (error) {
      await connection.rollback().catch(() => {});
      console.error('Admin blood-request status update failed:', error.code || error.message);
      res.status(500).json({ message: 'Could not update this emergency request status.' });
    } finally {
      connection.release();
    }
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
           (SELECT COUNT(*) FROM donors d
            WHERE (${DONOR_ADMIN_DISPLAY_AVAILABILITY_SQL}) = 'available') AS available_donor_count,
           (SELECT COUNT(*) FROM donors d
            WHERE (${DONOR_ADMIN_DISPLAY_AVAILABILITY_SQL}) = 'not_available') AS unavailable_donor_count,
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
                  WHEN (${DONOR_ADMIN_CONFIRM_ELIGIBILITY_SQL}) THEN 'eligible'
                  ELSE 'awaiting_review'
                END AS eligibility_status,
                d.public_contact_consent AS availability_search_consent,
                CASE WHEN d.public_contact_consent = 1
                  AND (${DONOR_ADMIN_CONFIRM_ELIGIBILITY_SQL})
                  AND (
                    (COALESCE(d.availability_mode, 'general') = 'general'
                      AND d.availability_starts_at IS NOT NULL
                      AND d.availability_expires_at > UTC_TIMESTAMP()
                      AND d.availability_expires_at > d.availability_starts_at
                      AND d.availability_expires_at
                        <= DATE_ADD(d.availability_starts_at, INTERVAL 366 DAY))
                    OR
                    (COALESCE(d.availability_mode, 'general') = 'selected_dates'
                      AND EXISTS (
                        SELECT 1 FROM donor_availability_dates confirm_date
                        WHERE confirm_date.donor_user_id = d.user_id
                          AND confirm_date.status = 'available'
                          AND confirm_date.available_date >= UTC_DATE()
                      ))
                  )
                  THEN 1 ELSE 0 END AS can_admin_confirm_availability,
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
                ${DONOR_ADMIN_DISPLAY_AVAILABILITY_SQL} AS availability_display_status,
                CASE ${DONOR_AVAILABILITY_STATUS_SQL}
                  WHEN 'available' THEN 1 ELSE 0
                END AS is_available,
                d.available AS availability_flag,
                CASE ${DONOR_ADMIN_DISPLAY_AVAILABILITY_SQL}
                  WHEN 'available' THEN 'Available'
                  ELSE 'Not Available'
                END AS availability_status,
                COALESCE(d.availability_mode, 'general') AS availability_mode,
                (SELECT GROUP_CONCAT(
                   CONCAT(DATE_FORMAT(ad.available_date, '%Y-%m-%d'), ': ', ad.status)
                   ORDER BY ad.available_date SEPARATOR ', ')
                 FROM donor_availability_dates ad
                 WHERE ad.donor_user_id = d.user_id
                   AND ad.available_date >= UTC_DATE()) AS availability_dates,
                DATE_FORMAT(d.last_confirmed_at, '%Y-%m-%dT%H:%i:%sZ') AS last_confirmed_at,
                DATE_FORMAT(d.availability_starts_at, '%Y-%m-%dT%H:%i:%sZ') AS availability_starts_at,
                COALESCE(DATE_FORMAT(d.availability_expires_at, '%Y-%m-%dT%H:%i:%sZ'),
                         DATE_FORMAT(d.available_until, '%Y-%m-%dT%H:%i:%sZ')) AS available_until,
                (SELECT review.action FROM admin_donor_availability_reviews review
                 WHERE review.donor_user_id = d.user_id
                 ORDER BY review.reviewed_at DESC, review.review_id DESC LIMIT 1) AS admin_availability_action,
                (SELECT review.reason FROM admin_donor_availability_reviews review
                 WHERE review.donor_user_id = d.user_id
                 ORDER BY review.reviewed_at DESC, review.review_id DESC LIMIT 1) AS admin_availability_reason,
                (SELECT DATE_FORMAT(review.reviewed_at, '%Y-%m-%dT%H:%i:%sZ')
                 FROM admin_donor_availability_reviews review
                 WHERE review.donor_user_id = d.user_id
                 ORDER BY review.reviewed_at DESC, review.review_id DESC LIMIT 1) AS admin_availability_reviewed_at
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
                CASE
                  WHEN selected_donor_user_id IS NOT NULL
                    THEN 'Patient confirmed donor for coordination'
                  WHEN EXISTS (
                    SELECT 1 FROM donor_request_responses confirmed_response
                    WHERE confirmed_response.request_id = blood_requests.request_id
                      AND confirmed_response.response = 'can_help'
                  ) THEN 'Awaiting patient confirmation'
                  ELSE 'Not confirmed'
                END AS patient_confirmation_status,
                DATE_FORMAT(selected_donor_confirmed_at, '%Y-%m-%dT%H:%i:%sZ')
                  AS patient_confirmed_at,
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

app.patch('/api/admin/donors/:donorId/availability', requireDatabase, requireAdminConfigured,
  requireAdmin, rateLimit(30, 60 * 60 * 1000), async (req, res) => {
    const donorId = Number(req.params.donorId);
    const action = req.body?.action;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (!Number.isSafeInteger(donorId) || donorId < 1 ||
        !['confirm', 'reject', 'revoke'].includes(action) ||
        reason.length > 500 ||
        (action !== 'confirm' && !reason)) {
      return res.status(400).json({
        message: 'Choose a valid availability action and provide a reason for rejection or revocation (500 characters maximum).'
      });
    }

    let connection;
    try {
      connection = await db.getConnection();
      await connection.beginTransaction();
      const [[donor]] = await connection.execute(
        `SELECT d.user_id, d.public_contact_consent, d.availability_mode,
                d.last_confirmed_at, d.available,
                (${DONOR_AVAILABILITY_STATUS_SQL}) AS current_availability_status,
                (COALESCE(d.next_eligible_date,
                  DATE_ADD(d.last_donation_date, INTERVAL ${DONATION_ELIGIBILITY_MONTHS} MONTH))
                  IS NULL
                  OR COALESCE(d.next_eligible_date,
                    DATE_ADD(d.last_donation_date, INTERVAL ${DONATION_ELIGIBILITY_MONTHS} MONTH))
                    <= UTC_DATE()) AS cooldown_clear,
                (${DONOR_ADMIN_CONFIRM_ELIGIBILITY_SQL}) AS medically_eligible,
                (COALESCE(d.availability_mode, 'general') = 'general'
                  AND d.availability_starts_at IS NOT NULL
                  AND d.availability_expires_at > UTC_TIMESTAMP()
                  AND d.availability_expires_at > d.availability_starts_at
                  AND d.availability_expires_at
                    <= DATE_ADD(d.availability_starts_at, INTERVAL 366 DAY)) AS valid_general_window,
                (COALESCE(d.availability_mode, 'general') = 'selected_dates'
                  AND EXISTS (
                    SELECT 1 FROM donor_availability_dates ad
                    WHERE ad.donor_user_id = d.user_id
                      AND ad.status = 'available'
                      AND ad.available_date >= UTC_DATE()
                  )) AS valid_selected_dates
         FROM donors d
         JOIN users u ON u.user_id = d.user_id AND u.role = 'donor'
         WHERE d.user_id = ?
         FOR UPDATE`,
        [donorId]
      );
      if (!donor) {
        await connection.rollback();
        return res.status(404).json({ message: 'Donor account was not found.' });
      }

      if (action === 'confirm') {
        const blocker = getAdminAvailabilityConfirmationBlocker({
          availabilityState: donor.current_availability_status,
          searchConsent: donor.public_contact_consent === 1,
          cooldownClear: donor.cooldown_clear === 1,
          medicallyEligible: donor.medically_eligible === 1,
          mode: donor.availability_mode,
          validGeneralWindow: donor.valid_general_window === 1,
          validSelectedDates: donor.valid_selected_dates === 1
        });
        if (blocker) {
          await connection.rollback();
          return res.status(409).json({ message: blocker });
        }
        await connection.execute(
          `UPDATE donors
           SET available = 1, is_available = 1, availability_status = 'available',
               last_confirmed_at = UTC_TIMESTAMP()
           WHERE user_id = ?`,
          [donorId]
        );
      } else {
        if (action === 'reject' && donor.current_availability_status !== 'unconfirmed') {
          await connection.rollback();
          return res.status(409).json({ message: 'Only availability awaiting confirmation can be rejected.' });
        }
        if (action === 'reject' &&
            ['available', 'scheduled'].includes(donor.current_availability_status)) {
          await connection.rollback();
          return res.status(409).json({ message: 'This donor has a current confirmation. Use revoke to withdraw it.' });
        }
        if (action === 'revoke' && !(donor.available === 1 && donor.last_confirmed_at)) {
          await connection.rollback();
          return res.status(409).json({ message: 'There is no active donor availability confirmation to revoke.' });
        }
        await connection.execute(
          `UPDATE donors
           SET available = 0, is_available = 0, availability_status = 'not_available',
               availability_mode = 'unavailable'
           WHERE user_id = ?`,
          [donorId]
        );
      }

      await connection.execute(
        `INSERT INTO admin_donor_availability_reviews
           (donor_user_id, admin_id, action, reason, reviewed_at)
         VALUES (?, ?, ?, ?, UTC_TIMESTAMP())`,
        [donorId, req.admin.admin_id, action === 'confirm' ? 'confirmed' : action === 'reject' ? 'rejected' : 'revoked',
          reason || null]
      );
      await connection.commit();
      res.json({
        message: action === 'confirm'
          ? 'Donor availability confirmed. Matching still requires the donor to meet current eligibility and consent checks.'
          : action === 'reject'
            ? 'Donor availability was rejected and the reason was recorded.'
            : 'Donor availability was revoked and removed from patient search.'
      });
    } catch (error) {
      if (connection) await connection.rollback().catch(() => {});
      console.error('Admin donor availability review failed:', error.code || error.message);
      res.status(500).json({ message: 'Could not update donor availability.' });
    } finally {
      if (connection) connection.release();
    }
  });

app.get('/api/admin/donations', requireDatabase, requireAdminConfigured, requireAdmin, async (req, res) => {
  try {
    const [[donors], [donations], [corrections], [reportedDonations]] = await Promise.all([
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
      ),
      db.execute(
        `SELECT r.report_id, r.donor_user_id, u.full_name, d.blood_group,
                DATE_FORMAT(r.donation_date, '%Y-%m-%d') AS donation_date,
                DATE_FORMAT(r.reported_at, '%Y-%m-%dT%H:%i:%sZ') AS reported_at
         FROM donor_reported_donations r
         JOIN users u ON u.user_id = r.donor_user_id AND u.role = 'donor'
         JOIN donors d ON d.user_id = r.donor_user_id
         WHERE r.report_status = 'pending'
         ORDER BY r.reported_at, r.report_id
         LIMIT 200`
      )
    ]);
    res.set('Cache-Control', 'no-store');
    res.json({
      donors, donations, corrections, reported_donations: reportedDonations,
      eligibility_interval_months: DONATION_ELIGIBILITY_MONTHS
    });
  } catch (error) {
    console.error('Admin donation history lookup failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not load donation history.' });
  }
});

app.patch('/api/admin/donation-reports/:reportId', requireDatabase, requireAdminConfigured,
  requireAdmin, rateLimit(30, 60 * 60 * 1000), async (req, res) => {
    const reportId = Number(req.params.reportId);
    const decision = req.body?.decision;
    const reviewNote = typeof req.body?.review_note === 'string'
      ? req.body.review_note.trim()
      : '';
    if (!Number.isSafeInteger(reportId) || reportId < 1 ||
        decision !== 'rejected' || reviewNote.length > 500) {
      return res.status(400).json({ message: 'Choose a valid rejection decision and keep the note under 500 characters.' });
    }
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const [[report]] = await connection.execute(
        `SELECT report_id, donor_user_id, donation_date
         FROM donor_reported_donations
         WHERE report_id = ? AND report_status = 'pending'
         FOR UPDATE`,
        [reportId]
      );
      if (!report) {
        await connection.rollback();
        return res.status(404).json({ message: 'Pending donor-reported donation was not found.' });
      }
      await connection.execute(
        `UPDATE donor_reported_donations
         SET report_status = 'rejected', reviewed_by_admin_id = ?, reviewed_at = UTC_TIMESTAMP(),
             review_note = ?
         WHERE report_id = ?`,
        [req.admin.admin_id, reviewNote || null, reportId]
      );
      await saveInAppNotification(connection, {
        recipientUserId: report.donor_user_id,
        title: 'Reported donation date reviewed',
        message: 'An administrator reviewed your reported donation date. Check your availability and eligibility information.',
        type: 'donation_report_review',
        dedupeKey: `donation-report-rejected:${reportId}`
      });
      await connection.commit();
      res.json({ message: 'The reported donation date was rejected. No verified donation history was added.' });
    } catch (error) {
      await connection.rollback().catch(() => {});
      console.error('Donor-reported donation review failed:', error.code || error.message);
      res.status(500).json({ message: 'Could not review the donor-reported donation.' });
    } finally {
      connection.release();
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
             availability_starts_at = NULL, availability_expires_at = NULL, available_until = NULL,
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
             availability_starts_at = NULL, availability_expires_at = NULL, available_until = NULL,
             public_contact_consent = 0, emergency_response_consent = 0
         WHERE user_id = ?`,
        [donationDate, nextEligibleDate, donorId]
      );
      const [verifiedReports] = await connection.execute(
        `UPDATE donor_reported_donations
         SET report_status = 'verified', reviewed_by_admin_id = ?, reviewed_at = UTC_TIMESTAMP(),
             review_note = 'Verified against the administrator-recorded donation history.'
         WHERE donor_user_id = ? AND donation_date = ? AND report_status = 'pending'`,
        [req.admin.admin_id, donorId, donationDate]
      );
      if (verifiedReports.affectedRows) {
        await saveInAppNotification(connection, {
          recipientUserId: donorId,
          title: 'Reported donation date verified',
          message: `Your donation dated ${donationDate} was verified and recorded. Your eligibility review date is ${nextEligibleDate}.`,
          type: 'donation_report_review',
          dedupeKey: `donation-report-verified:${donorId}:${donationDate}`
        });
      }
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
      `SELECT u.user_id, u.username, u.full_name, u.email, u.role, u.phone, u.city, u.state,
              ${USER_AREA_SQL} AS place,
              CASE WHEN u.role = 'donor' THEN u.blood_group
                   WHEN u.role = 'patient' THEN COALESCE(
                     (SELECT p.blood_group FROM patients p
                      WHERE p.user_id = u.user_id
                      ORDER BY p.patient_id DESC LIMIT 1),
                     u.blood_group
                   )
                   ELSE NULL END AS blood_group
       FROM users u WHERE u.user_id = ? LIMIT 1`,
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
              public_identity_consent, public_phone_consent,
              emergency_response_consent,
                availability_unavailable_reason,
                DATE_FORMAT(availability_return_at, '%Y-%m-%dT%H:%i:%sZ') AS expected_available_at,
                DATE_FORMAT(last_donation_date, '%Y-%m-%d') AS recorded_last_donation_date,
                DATE_FORMAT((SELECT MAX(dh.donation_date) FROM donor_donation_history dh
                  WHERE dh.donor_user_id = d.user_id AND dh.verification_status = 'verified'),
                  '%Y-%m-%d') AS verified_last_donation_date,
                DATE_FORMAT(COALESCE(next_eligible_date,
                  DATE_ADD(last_donation_date, INTERVAL ${DONATION_ELIGIBILITY_MONTHS} MONTH)),
                '%Y-%m-%d') AS next_eligible_date,
              (${DONOR_ELIGIBILITY_SQL}) AS eligible_for_matching,
              COALESCE(availability_starts_at, last_confirmed_at) <= UTC_TIMESTAMP()
                AND availability_expires_at > UTC_TIMESTAMP() AS confirmation_current,
              DATE_FORMAT(availability_starts_at, '%Y-%m-%dT%H:%i:%sZ') AS availability_starts_at,
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
    const [pendingReports] = await db.execute(
      `SELECT report_id, DATE_FORMAT(donation_date, '%Y-%m-%d') AS donation_date
       FROM donor_reported_donations
       WHERE donor_user_id = ? AND report_status = 'pending'
       ORDER BY reported_at DESC, report_id DESC
       LIMIT 1`,
      [req.user.user_id]
    );
    const hasCurrentSelectedDate = dates.some(date => date.status === 'available');
    const confirmed = Boolean(donors[0].last_confirmed_at);
    const active = donors[0].available === 1 && confirmed &&
      (donors[0].availability_mode === 'selected_dates'
        ? hasCurrentSelectedDate
        : donors[0].availability_mode !== 'unavailable' &&
          donors[0].confirmation_current === 1);
    const scheduled = donors[0].available === 1 && confirmed &&
      donors[0].availability_mode !== 'selected_dates' &&
      Date.parse(donors[0].availability_starts_at) > Date.now() &&
      Date.parse(donors[0].available_until) > Date.now();
    const status = active
      ? 'Available'
      : scheduled
        ? 'Scheduled'
      : donors[0].last_confirmed_at &&
        donors[0].availability_status === 'temporarily_unavailable'
        ? 'Temporarily Unavailable'
      : donors[0].last_confirmed_at &&
        donors[0].available === 0 &&
        donors[0].availability_status === 'not_available'
        ? 'Not Available'
        : donors[0].availability_mode === 'selected_dates' &&
          donors[0].has_expired_selected_dates && confirmed
          ? 'Expired'
        : donors[0].availability_mode === 'selected_dates' && confirmed
          ? 'Not Available'
        : 'Unconfirmed';
    res.json({
      status,
      availability_status: donors[0].availability_status,
      availability_mode: donors[0].availability_mode || 'general',
      is_available: Boolean(active),
      eligible_for_matching: Boolean(donors[0].eligible_for_matching),
      next_eligible_date: donors[0].next_eligible_date,
      recorded_last_donation_date: donors[0].recorded_last_donation_date,
      verified_last_donation_date: donors[0].verified_last_donation_date,
      pending_donation_report: pendingReports[0] || null,
      unavailability_reason: donors[0].availability_unavailable_reason,
      expected_available_at: donors[0].expected_available_at,
      availability_starts_at: donors[0].availability_starts_at,
      available_until: donors[0].available_until,
      last_confirmed_at: donors[0].last_confirmed_at,
      selected_dates: dates,
      public_contact_consent: donors[0].public_contact_consent === 1,
      public_identity_consent: donors[0].public_identity_consent === 1,
      public_phone_consent: donors[0].public_phone_consent === 1,
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
    public_phone_consent: publicPhoneConsent,
    emergency_response_consent: emergencyResponseConsent,
    expires_in_hours: expiresInHours = AVAILABILITY_HOURS,
    starts_at: submittedStartsAt,
    ends_at: submittedEndsAt,
    unavailability_reason: unavailabilityReason,
    expected_available_at: submittedExpectedAvailableAt,
    reported_donation_date: submittedReportedDonationDate,
    mode: submittedMode = 'general',
    selected_dates: submittedDates } = req.body || {};
  const parsedExpectedAvailableAt = submittedExpectedAvailableAt == null || submittedExpectedAvailableAt === ''
    ? null
    : parseExpectedAvailability(submittedExpectedAvailableAt);
  const status = normalizeAvailabilityState(submittedStatus);
  const mode = ['general', 'selected_dates', 'unavailable'].includes(submittedMode)
    ? submittedMode
    : '';
  const isAvailable = status === 'available';
  const selectedDates = submittedDates === undefined ? [] : submittedDates;
  if (!status ||
      !mode ||
      typeof publicContactConsent !== 'boolean' ||
      (publicIdentityConsent !== undefined && typeof publicIdentityConsent !== 'boolean') ||
      (publicPhoneConsent !== undefined && typeof publicPhoneConsent !== 'boolean') ||
      typeof emergencyResponseConsent !== 'boolean' ||
      !isValidAvailabilityConfirmationHours(expiresInHours) ||
      !Array.isArray(selectedDates) ||
      selectedDates.length > 100 ||
      (mode === 'selected_dates' && isAvailable && selectedDates.length === 0) ||
      (mode !== 'selected_dates' && selectedDates.length > 0) ||
      (mode === 'unavailable' && !['not_available', 'temporarily_unavailable'].includes(status)) ||
      (mode === 'selected_dates' && !['available', 'not_available'].includes(status)) ||
      (mode === 'general' && !['available', 'not_available'].includes(status)) ||
      (status === 'not_available' && mode === 'unavailable' &&
        !isValidUnavailabilityReason(unavailabilityReason)) ||
      (unavailabilityReason !== undefined && !isValidUnavailabilityReason(unavailabilityReason)) ||
      (status !== 'not_available' && unavailabilityReason !== undefined) ||
      (submittedExpectedAvailableAt != null && submittedExpectedAvailableAt !== '' &&
        !parsedExpectedAvailableAt) ||
      (submittedReportedDonationDate !== undefined &&
        (!isValidDateOnly(submittedReportedDonationDate) ||
         submittedReportedDonationDate > new Date().toISOString().slice(0, 10) ||
         unavailabilityReason !== 'recently_donated'))) {
    return res.status(400).json({ message: 'Choose a valid availability status and confirm your privacy choices.' });
  }
  const preserveUnavailableDetails = status === 'not_available' &&
    mode === 'general' && unavailabilityReason === undefined;
  const hasGeneralWindow = mode === 'general' &&
    (isAvailable || submittedStartsAt !== undefined || submittedEndsAt !== undefined);
  let availabilityWindow = null;
  if (hasGeneralWindow) {
    availabilityWindow = submittedStartsAt === undefined && submittedEndsAt === undefined
      ? getDefaultAvailabilityWindow()
      : parseAvailabilityWindow(submittedStartsAt, submittedEndsAt);
    if (!availabilityWindow) {
      return res.status(400).json({
        message: 'Enter a future availability start and a later end time. The availability window cannot exceed 366 days.'
      });
    }
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
      (isAvailable && mode === 'selected_dates' &&
        !parsedDates.some(item => item.status === 'available'))) {
    return res.status(400).json({ message: 'Choose at least one unique future date as available.' });
  }

  try {
    const connection = await db.getConnection();
    let updatedDonor;
    let updatedDates = [];
    let donationReportStatus = null;
    let reportedDonationDate = null;
    try {
      await connection.beginTransaction();
      const [[donorBeforeUpdate]] = await connection.execute(
        `SELECT d.user_id,
                DATE_FORMAT(COALESCE(
                  (SELECT MAX(dh.donation_date) FROM donor_donation_history dh
                   WHERE dh.donor_user_id = d.user_id AND dh.verification_status = 'verified'),
                  d.last_donation_date), '%Y-%m-%d') AS recorded_donation_date,
                DATE_FORMAT(COALESCE(
                  (SELECT MAX(dh.next_eligible_date) FROM donor_donation_history dh
                   WHERE dh.donor_user_id = d.user_id AND dh.verification_status = 'verified'),
                  d.next_eligible_date,
                  DATE_ADD(d.last_donation_date, INTERVAL ${DONATION_ELIGIBILITY_MONTHS} MONTH)),
                  '%Y-%m-%d') AS next_eligible_date,
                COALESCE(
                  (SELECT MAX(dh.next_eligible_date) FROM donor_donation_history dh
                   WHERE dh.donor_user_id = d.user_id AND dh.verification_status = 'verified'),
                  d.next_eligible_date,
                  DATE_ADD(d.last_donation_date, INTERVAL ${DONATION_ELIGIBILITY_MONTHS} MONTH)) > UTC_DATE()
                  AS in_cooldown
         FROM donors d WHERE d.user_id = ? FOR UPDATE`,
        [req.user.user_id]
      );
      if (!donorBeforeUpdate) {
        await connection.rollback();
        return res.status(404).json({ message: 'No donor profile is linked to this account.' });
      }
      const [[pendingReport]] = await connection.execute(
        `SELECT report_id, donation_date FROM donor_reported_donations
         WHERE donor_user_id = ? AND report_status = 'pending'
         ORDER BY reported_at DESC, report_id DESC LIMIT 1 FOR UPDATE`,
        [req.user.user_id]
      );
      if (isAvailable && pendingReport) {
        await connection.rollback();
        return res.status(409).json({
          message: `Your reported donation date (${formatDatabaseDateOnly(pendingReport.donation_date)}) is awaiting authorized verification. Availability cannot be restored until staff reviews it.`
        });
      }
      if (isAvailable && donorBeforeUpdate.in_cooldown) {
        await connection.rollback();
        return res.status(409).json({
          message: `Your donation cooldown is active until ${donorBeforeUpdate.next_eligible_date}. You cannot confirm availability before that date.`
        });
      }
      if (status === 'not_available' && unavailabilityReason === 'recently_donated') {
        if (donorBeforeUpdate.recorded_donation_date) {
          if (submittedReportedDonationDate &&
              submittedReportedDonationDate !== donorBeforeUpdate.recorded_donation_date) {
            await connection.rollback();
            return res.status(400).json({
              message: `The donation date on file is ${donorBeforeUpdate.recorded_donation_date}. Ask an administrator to correct it if needed.`
            });
          }
        } else {
          if (!submittedReportedDonationDate) {
            await connection.rollback();
            return res.status(400).json({
              message: 'Enter the last donation date so authorized staff can verify it.'
            });
          }
          if (pendingReport) {
            await connection.rollback();
            return res.status(409).json({
              message: `Your previously reported donation date (${formatDatabaseDateOnly(pendingReport.donation_date)}) is still awaiting authorized verification.`
            });
          }
          const [reportResult] = await connection.execute(
            `INSERT INTO donor_reported_donations (donor_user_id, donation_date, report_status, reported_at)
             VALUES (?, ?, 'pending', UTC_TIMESTAMP())`,
            [req.user.user_id, submittedReportedDonationDate]
          );
          await saveAdminNotifications(connection, {
            title: 'Donor-reported donation needs verification',
            message: `A donor submitted a donation date for verification (report ${reportResult.insertId}).`,
            type: 'donation_report',
            dedupeKey: `donation-report:${reportResult.insertId}`
          });
          donationReportStatus = 'pending';
          reportedDonationDate = submittedReportedDonationDate;
        }
      }
      await connection.execute(
      `UPDATE donors
       SET availability_status = ?, availability_mode = ?, available = ?, is_available = ?,
           availability_unavailable_reason = CASE WHEN ? = 1
             THEN availability_unavailable_reason ELSE ? END,
           availability_return_at = CASE WHEN ? = 1
             THEN availability_return_at ELSE ? END,
           public_contact_consent = ?,
           public_identity_consent = CASE WHEN ? IS NULL THEN public_identity_consent ELSE ? END,
           public_phone_consent = CASE WHEN ? IS NULL THEN public_phone_consent ELSE ? END,
           emergency_response_consent = ?,
           availability_starts_at = CASE WHEN ? = 1 THEN ? ELSE NULL END,
           availability_expires_at = CASE WHEN ? = 1
             THEN ? ELSE NULL END,
           available_until = CASE WHEN ? = 1
             THEN ? ELSE NULL END,
           last_confirmed_at = UTC_TIMESTAMP()
       WHERE user_id = ?`,
        [status, mode, isAvailable ? 1 : 0, isAvailable ? 1 : 0,
           preserveUnavailableDetails ? 1 : 0,
           preserveUnavailableDetails
             ? null
             : status === 'not_available' ? unavailabilityReason : null,
           preserveUnavailableDetails ? 1 : 0,
           status === 'not_available' ? parsedExpectedAvailableAt : null,
          isAvailable && publicContactConsent ? 1 : 0,
          publicIdentityConsent === undefined ? null : 1,
          isAvailable && publicContactConsent && publicIdentityConsent ? 1 : 0,
          publicPhoneConsent === undefined ? null : 1,
          publicPhoneConsent === undefined
            ? null
            : isAvailable && publicContactConsent && publicPhoneConsent ? 1 : 0,
          emergencyResponseConsent ? 1 : 0,
          hasGeneralWindow ? 1 : 0,
          availabilityWindow?.startsAt || null,
          hasGeneralWindow ? 1 : 0,
          availabilityWindow?.endsAt || null,
          hasGeneralWindow ? 1 : 0,
          availabilityWindow?.endsAt || null,
          req.user.user_id]
      );
      if (PORTAL_SCHEMA) {
        await connection.execute(
          `INSERT INTO donor_availability
             (donor_user_id, is_available, confirmed_at, expires_at)
           SELECT user_id, ?, UTC_TIMESTAMP(), availability_expires_at
           FROM donors
           WHERE user_id = ?
           ON DUPLICATE KEY UPDATE
             is_available = VALUES(is_available),
             confirmed_at = VALUES(confirmed_at),
             expires_at = VALUES(expires_at)`,
          [isAvailable ? 1 : 0, req.user.user_id]
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
              public_identity_consent, public_phone_consent,
              emergency_response_consent, availability_mode,
              (${DONOR_ELIGIBILITY_SQL}) AS eligible_for_matching,
              DATE_FORMAT(availability_starts_at, '%Y-%m-%dT%H:%i:%sZ') AS availability_starts_at,
              DATE_FORMAT(availability_expires_at, '%Y-%m-%dT%H:%i:%sZ') AS available_until,
              DATE_FORMAT(last_confirmed_at, '%Y-%m-%dT%H:%i:%sZ') AS last_confirmed_at
       FROM donors d
       WHERE d.user_id = ?
       LIMIT 1`,
        [req.user.user_id]
      );
      if (!donors.length) {
        await connection.rollback();
        return res.status(404).json({ message: 'No donor profile is linked to this account.' });
      }
      updatedDonor = donors[0];
      const notification = getAvailabilityNotificationCopy(
        status,
        updatedDonor.eligible_for_matching === 1
      );
      if (!notification) {
        throw new Error('Could not create an availability notification for the selected status.');
      }
      await saveInAppNotification(connection, {
        recipientUserId: req.user.user_id,
        title: notification.title,
        message: notification.message,
        type: 'availability_changed',
        dedupeKey: `availability-change:${req.user.user_id}:${crypto.randomUUID()}`
      });
      const [dates] = await connection.execute(
        `SELECT DATE_FORMAT(available_date, '%Y-%m-%d') AS date, status
         FROM donor_availability_dates
         WHERE donor_user_id = ? AND available_date >= UTC_DATE()
         ORDER BY available_date`,
        [req.user.user_id]
      );
      updatedDates = dates;
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    const responseStatus = status === 'temporarily_unavailable'
      ? 'Temporarily Unavailable'
      : !isAvailable
        ? 'Not Available'
        : mode === 'selected_dates'
          ? 'Available'
          : Date.parse(updatedDonor.availability_starts_at || '') > Date.now()
            ? 'Scheduled'
            : 'Available';
    res.json({
      status: responseStatus,
      availability_status: updatedDonor.availability_status,
      availability_mode: updatedDonor.availability_mode,
      is_available: updatedDonor.available === 1 &&
        (mode === 'selected_dates'
          ? updatedDates.some(date => date.status === 'available')
          : Date.parse(updatedDonor.availability_starts_at || updatedDonor.last_confirmed_at) <= Date.now() &&
            Date.parse(updatedDonor.available_until || '') > Date.now()),
      availability_starts_at: updatedDonor.availability_starts_at,
      available_until: updatedDonor.available_until,
      last_confirmed_at: updatedDonor.last_confirmed_at,
      selected_dates: updatedDates,
      public_contact_consent: updatedDonor.public_contact_consent === 1,
      public_identity_consent: updatedDonor.public_identity_consent === 1,
      public_phone_consent: updatedDonor.public_phone_consent === 1,
      emergency_response_consent: updatedDonor.emergency_response_consent === 1,
      donation_report_status: donationReportStatus,
      reported_donation_date: reportedDonationDate
    });
  } catch (error) {
    console.error(
      'Donor availability status update failed:',
      error.code || 'ERROR',
      error.sqlMessage || error.message
    );
    res.status(500).json({
      message: 'Could not save your availability. No changes were saved. Please try again; if the problem continues, contact support.'
    });
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
         AND COALESCE(d.availability_starts_at, d.last_confirmed_at) <= UTC_TIMESTAMP()
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
        `SELECT u.full_name AS donor_name, d.blood_group,
                DATE_FORMAT(d.last_donation_date, '%Y-%m-%d') AS last_donation_date,
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
         JOIN users u ON u.user_id = d.user_id AND u.role = 'donor'
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
    const remainingWaitingDays = donor.next_review_date
      ? Math.max(0, getDaysBetweenDates(today, donor.next_review_date) ?? 0)
      : null;
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
      Number.isFinite(availabilityConfirmedAt) &&
      Number.isFinite(availabilityExpiresAt) &&
      availabilityExpiresAt > Date.now();
    const eligibilityReason = status === 'recovery_period_in_progress'
      ? `The configured recovery interval remains in effect until ${donor.next_review_date}. This is a preliminary date, not medical approval.`
      : status === 'temporarily_ineligible'
        ? donor.latest_review_instructions || 'An authorized reviewer recorded a temporary deferral. Contact the reviewing blood bank for next steps.'
        : status === 'awaiting_eligibility_review'
          ? 'Your information is awaiting review by authorized staff; a submitted request is not an eligibility decision.'
          : status === 'eligible_for_review'
            ? 'The configured recovery interval has elapsed and screening is cleared. Qualified staff must still complete the eligibility review.'
            : status === 'eligibility_confirmed'
              ? 'A qualified staff member has confirmed eligibility based on the latest screening and donation record.'
              : 'A current health screening and qualified staff review are required before eligibility can be confirmed.';
    res.set('Cache-Control', 'no-store');
    res.json({
      summary: {
        donor_name: donor.donor_name,
        blood_group: donor.blood_group,
        last_donation_date: donor.last_donation_date,
        next_review_date: donor.next_review_date,
        remaining_waiting_days: remainingWaitingDays,
        eligibility_reason: eligibilityReason,
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
  const stockDate = req.body?.stock_date;
  const remarks = typeof req.body?.remarks === 'string' ? req.body.remarks.trim() : '';
  const idempotencyKey = typeof req.body?.idempotency_key === 'string'
    ? req.body.idempotency_key.toLowerCase()
    : '';
  const transactionType = req.body?.transaction_type || 'daily_update';
  if (!BLOOD_GROUPS.has(bloodGroup) ||
      !['whole_blood', 'red_cells', 'platelets', 'plasma'].includes(component) ||
      ![physical, reserved, issued, discarded].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 100000) ||
      reserved + issued + discarded > physical || remarks.length > 500 ||
      (stockDate !== undefined &&
        (!isValidDateOnly(stockDate) || stockDate !== new Date().toISOString().slice(0, 10))) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey) ||
      !['daily_update', 'correction'].includes(transactionType)) {
    return res.status(400).json({ message: 'Enter today’s UTC stock date, valid non-negative quantities, ensure reservations/issues/discards do not exceed physical stock, and provide a unique update key.' });
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
    await saveInAppNotification(connection, {
      recipientUserId: req.user.user_id,
      title: 'Blood stock update saved',
      message: `${bloodGroup} ${component.replaceAll('_', ' ')} stock was saved for ${req.bloodBank.bank_name} and is pending admin verification.`,
      type: 'blood_stock_updated',
      dedupeKey: `blood-stock-update:${idempotencyKey}`
    });
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
  const area = typeof req.query.area === 'string' ? req.query.area.trim() : '';
  const bankName = typeof req.query.bank_name === 'string' ? req.query.bank_name.trim() : '';
  const requiredUnits = req.query.required_units === undefined ? 0 : Number(req.query.required_units);
  if (!BLOOD_GROUPS.has(bloodGroup) ||
      !['whole_blood', 'red_cells', 'platelets', 'plasma'].includes(component) ||
      (state && !isNonEmptyString(state, 80)) ||
      (district && !isNonEmptyString(district, 80)) ||
      (city && !isNonEmptyString(city, 80)) ||
      (area && !isNonEmptyString(area, 120)) ||
      (bankName && !isNonEmptyString(bankName, 150)) ||
      !Number.isSafeInteger(requiredUnits) || requiredUnits < 0 || requiredUnits > 100000) {
    return res.status(400).json({ message: 'Choose a blood group and component, and valid optional location and unit filters.' });
  }
  try {
    const filters = [
      'b.is_active = 1',
      "(b.verification_status = 'verified' OR b.verified = 1)"
    ];
    const values = [bloodGroup, component, bloodGroup, component, bloodGroup, component];
    if (state) { filters.push('LOWER(b.state) = LOWER(?)'); values.push(state); }
    if (district) { filters.push('LOWER(b.district) = LOWER(?)'); values.push(district); }
    if (city) { filters.push('LOWER(b.city) = LOWER(?)'); values.push(city); }
    if (area) { filters.push('LOWER(b.address_text) LIKE LOWER(?)'); values.push(`%${area}%`); }
    if (bankName) { filters.push('LOWER(b.bank_name) LIKE LOWER(?)'); values.push(`%${bankName}%`); }
    filters.push('s.stock_id IS NOT NULL');
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
         AND s.verification_status = 'verified'
         AND s.last_updated >= UTC_DATE()
         AND s.last_updated < DATE_ADD(UTC_DATE(), INTERVAL 1 DAY)
       LEFT JOIN blood_stock_thresholds t ON t.blood_bank_id = b.blood_bank_id
         AND t.blood_group = ? AND t.component = ?
       WHERE ${filters.join(' AND ')}
       ORDER BY b.state, b.district, b.city, b.bank_name
       LIMIT 300`,
      values
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
         AND s.verification_status = 'verified'
         AND s.last_updated >= UTC_DATE()
         AND s.last_updated < DATE_ADD(UTC_DATE(), INTERVAL 1 DAY)
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
    const values = [bloodGroup, component, bloodGroup, component, bloodGroup, component];
    if (city) { filters.push('LOWER(b.city) = LOWER(?)'); values.push(city); }
    filters.push('s.stock_id IS NOT NULL');
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
         AND s.verification_status = 'verified'
         AND s.last_updated >= UTC_DATE()
         AND s.last_updated < DATE_ADD(UTC_DATE(), INTERVAL 1 DAY)
       LEFT JOIN blood_stock_thresholds t ON t.blood_bank_id = b.blood_bank_id
         AND t.blood_group = ? AND t.component = ?
       WHERE ${filters.join(' AND ')}
       ORDER BY b.state, b.city, b.bank_name
       LIMIT 500`,
      values
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
  const city = normalizeLocationName(req.query.city);
  const searchArea = normalizeLocationName(req.query.area);
  const state = normalizeLocationName(req.query.state);
  const bloodGroup = normalizeBloodGroup(req.query.blood_group || '');
  const requiredDate = typeof req.query.required_date === 'string' ? req.query.required_date : '';
  const urgency = typeof req.query.urgency === 'string' ? req.query.urgency : '';
  const units = req.query.units === undefined ? null : Number(req.query.units);
  const emergency = urgency === 'Urgent' || req.query.emergency === 'true';
  const today = new Date().toISOString().slice(0, 10);
  if ((req.query.area !== undefined && typeof req.query.area !== 'string') ||
      (req.query.state !== undefined && typeof req.query.state !== 'string') ||
      !isNonEmptyString(city, 80) ||
      (searchArea && !isNonEmptyString(searchArea, 100)) ||
      (state && !isNonEmptyString(state, 80)) ||
      !BLOOD_GROUPS.has(bloodGroup) ||
      (requiredDate && (!isValidDateOnly(requiredDate) || requiredDate < today)) ||
      (units !== null && (!Number.isInteger(units) || units < 1 || units > 20)) ||
      (urgency && !REQUEST_URGENCIES.has(urgency)) ||
      (req.query.emergency !== undefined && !['true', 'false'].includes(req.query.emergency))) {
    return res.status(400).json({ message: 'Choose a valid state, city/place, blood group, and optional search details.' });
  }

  try {
    const stateFilter = state ? `AND ${normalizedLocationSql(DONOR_STATE_SQL)} = LOWER(?)` : '';
    const dateAvailabilityFilter = requiredDate
      ? `(
           (COALESCE(d.availability_mode, 'general') = 'general'
             AND COALESCE(d.availability_starts_at, d.last_confirmed_at) <= UTC_TIMESTAMP()
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
         AND COALESCE(d.availability_starts_at, d.last_confirmed_at) <= UTC_TIMESTAMP()
         AND d.availability_expires_at > UTC_TIMESTAMP()`;
    const [donors] = await db.execute(
      `SELECT CAST(d.user_id AS CHAR) AS donor_user_id,
              CASE WHEN d.public_identity_consent = 1 THEN ${DONOR_NAME_SQL} ELSE NULL END AS display_name,
              CASE WHEN d.public_identity_consent = 1
                THEN ${DONOR_AREA_SQL}
                ELSE NULL END AS place,
              d.blood_group, ${DONOR_CITY_SQL} AS city, ${DONOR_STATE_SQL} AS state,
              d.last_confirmed_at IS NOT NULL AS has_confirmation,
              1 AS confirmation_current,
              (${DONOR_ELIGIBILITY_SQL}) AS eligible_for_matching,
              d.public_contact_consent = 1 AS contact_consent,
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
         AND d.last_confirmed_at IS NOT NULL
         AND ${DONOR_ELIGIBILITY_SQL}
         AND d.blood_group IN (${getCompatibleDonorBloodGroups(bloodGroup).map(() => '?').join(', ')})
         AND ${normalizedLocationSql(DONOR_CITY_SQL)} = LOWER(?)
         ${stateFilter}
         AND ${dateAvailabilityFilter}
       ORDER BY CASE
                  WHEN ? = '' THEN 1
                  WHEN ${normalizedLocationSql(DONOR_AREA_SQL)} = LOWER(?)
                    THEN 0
                  ELSE 1
                END,
                CASE WHEN ? = 1 THEN d.emergency_response_consent ELSE 0 END DESC,
                d.last_confirmed_at DESC
       LIMIT 50`,
      [requiredDate || null, ...getCompatibleDonorBloodGroups(bloodGroup), city,
        ...(state ? [state] : []), ...(requiredDate ? [requiredDate] : []),
        searchArea, searchArea, emergency ? 1 : 0]
    );
    const matchingDonors = donors.filter(donor =>
      areBloodGroupsCompatible(donor.blood_group, bloodGroup) &&
      isAvailabilitySearchEligible({
        state: 'available',
        confirmed: Boolean(donor.has_confirmation),
        current: Boolean(donor.confirmation_current),
        eligible: Boolean(donor.eligible_for_matching),
        contactConsent: Boolean(donor.contact_consent)
      })
    );
    let searchDiagnostics = null;
    if (matchingDonors.length === 0) {
      try {
        const [diagnostics] = await db.execute(
          `SELECT COUNT(*) AS location_and_blood_group_matches,
                  COALESCE(SUM(d.available = 1), 0) AS marked_available,
                  COALESCE(SUM(d.last_confirmed_at IS NOT NULL), 0) AS confirmed,
                  COALESCE(SUM(d.public_contact_consent = 1), 0) AS search_consent,
                  COALESCE(SUM(d.public_identity_consent = 1), 0) AS identity_display_consent,
                  COALESCE(SUM(
                    COALESCE(d.next_eligible_date,
                      DATE_ADD(d.last_donation_date, INTERVAL ${DONATION_ELIGIBILITY_MONTHS} MONTH)) IS NULL
                    OR COALESCE(d.next_eligible_date,
                      DATE_ADD(d.last_donation_date, INTERVAL ${DONATION_ELIGIBILITY_MONTHS} MONTH)) <= UTC_DATE()
                  ), 0) AS cooldown_clear,
                  COALESCE(SUM(${DONOR_ELIGIBILITY_SQL}), 0) AS medically_eligible,
                  COALESCE(SUM(${dateAvailabilityFilter}), 0) AS requested_schedule_matches,
                  COALESCE(SUM(
                    d.available = 1
                    AND d.last_confirmed_at IS NOT NULL
                    AND d.public_contact_consent = 1
                    AND (
                      COALESCE(d.next_eligible_date,
                        DATE_ADD(d.last_donation_date, INTERVAL ${DONATION_ELIGIBILITY_MONTHS} MONTH)) IS NULL
                      OR COALESCE(d.next_eligible_date,
                        DATE_ADD(d.last_donation_date, INTERVAL ${DONATION_ELIGIBILITY_MONTHS} MONTH)) <= UTC_DATE()
                    )
                    AND (${dateAvailabilityFilter})
                  ), 0) AS confirmed_searchable_cooldown_matches
           FROM donors d
           JOIN users u ON u.user_id = d.user_id AND u.role = 'donor'
           WHERE d.blood_group IN (${getCompatibleDonorBloodGroups(bloodGroup).map(() => '?').join(', ')})
             AND ${normalizedLocationSql(DONOR_CITY_SQL)} = LOWER(?)
             ${stateFilter}`,
          [...(requiredDate ? [requiredDate, requiredDate] : []),
            ...getCompatibleDonorBloodGroups(bloodGroup), city,
            ...(state ? [state] : [])]
        );
        searchDiagnostics = Object.fromEntries(
          Object.entries(diagnostics[0]).map(([key, value]) => [key, Number(value)])
        );
        console.warn('Patient donor search returned no matches:', JSON.stringify({
          city,
          state: state || null,
          blood_group: bloodGroup,
          required_date: requiredDate || null,
          exclusions: searchDiagnostics
        }));
      } catch (diagnosticError) {
        console.error('Patient donor search exclusion diagnostics failed:',
          diagnosticError.code || diagnosticError.message);
      }
    }
    res.json({
      donors: matchingDonors
        .map(({
          donor_user_id,
          has_confirmation,
          confirmation_current,
          eligible_for_matching,
          contact_consent,
          ...donor
        }) => ({
          ...donor,
          contact_token: createDonorContactToken(donor_user_id, req.user.user_id)
        })),
      checked_at: new Date().toISOString(),
      search_area: [city, state, searchArea].filter(Boolean).join(', '),
      radius_km: null,
      required_date: requiredDate || null,
      search_diagnostics: searchDiagnostics,
      urgency: urgency || null,
      location_precision: 'Matches normalized registered city names across all neighbourhoods and prioritizes exact registered area when supplied; no live GPS or calculated distance is used.',
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
  const city = normalizeLocationName(req.query.city);
  const area = normalizeLocationName(req.query.area);
  const state = normalizeLocationName(req.query.state);
  if ((req.query.blood_group !== undefined && typeof req.query.blood_group !== 'string') ||
      (req.query.area !== undefined && typeof req.query.area !== 'string') ||
      (req.query.state !== undefined && typeof req.query.state !== 'string')) {
    return res.status(400).json({ message: 'Select a valid blood group.' });
  }
  const bloodGroup = normalizeBloodGroup(req.query.blood_group || '');
  if (
    !isNonEmptyString(city, 80) ||
    city.length < 2 ||
    (area && !isNonEmptyString(area, 100)) ||
    (state && !isNonEmptyString(state, 80)) ||
    !BLOOD_GROUPS.has(bloodGroup)
  ) {
    return res.status(400).json({ message: 'Enter a city and state, and select a blood group.' });
  }

  try {
    const compatibleBloodGroups = getCompatibleDonorBloodGroups(bloodGroup);
    const filters = [
      'd.available = 1',
      "d.availability_status = 'available'",
      'd.public_contact_consent = 1',
      'd.last_confirmed_at IS NOT NULL',
      `${DONOR_COOLDOWN_CLEAR_SQL}`,
      `${DONOR_POST_COOLDOWN_CONFIRMATION_SQL}`,
      `NOT ${DONOR_MEDICAL_RESTRICTION_SQL}`,
      `(
        (COALESCE(d.availability_mode, 'general') = 'general'
          AND COALESCE(d.availability_starts_at, d.last_confirmed_at) <= UTC_TIMESTAMP()
          AND d.availability_expires_at > UTC_TIMESTAMP())
        OR
        (COALESCE(d.availability_mode, 'general') = 'selected_dates'
          AND EXISTS (
            SELECT 1 FROM donor_availability_dates ad
            WHERE ad.donor_user_id = d.user_id
              AND ad.available_date = UTC_DATE()
              AND ad.status = 'available'
          ))
      )`,
      `${normalizedLocationSql(DONOR_CITY_SQL)} = LOWER(?)`
    ];
    const values = [city];
    if (state) {
      filters.push(`${normalizedLocationSql(DONOR_STATE_SQL)} = LOWER(?)`);
      values.push(state);
    }
    if (area) {
      filters.push(`${normalizedLocationSql(DONOR_AREA_SQL)} = LOWER(?)`);
      values.push(area);
    }
    filters.push(`d.blood_group IN (${compatibleBloodGroups.map(() => '?').join(', ')})`);
    values.push(...compatibleBloodGroups);
    const [donors] = await db.execute(
      `SELECT CASE WHEN d.public_identity_consent = 1
                THEN ${DONOR_NAME_SQL}
                ELSE NULL END AS name,
              CASE WHEN d.public_identity_consent = 1 THEN 1 ELSE 0 END AS identity_consent,
              CASE WHEN d.public_phone_consent = 1
                THEN ${DONOR_PHONE_SQL}
                ELSE NULL END AS phone,
              d.blood_group,
              ${DONOR_CITY_SQL} AS city,
              ${DONOR_STATE_SQL} AS state,
              CASE WHEN d.public_identity_consent = 1
                THEN ${DONOR_AREA_SQL}
                ELSE NULL END AS place,
              CASE WHEN d.available = 1 AND d.availability_status = 'available'
                THEN 'Available' ELSE 'Not Available' END AS availability_status,
              CASE WHEN ${DONOR_ELIGIBILITY_SQL}
                THEN 'Medical Clearance Approved'
                ELSE 'Medical Clearance Pending'
              END AS medical_clearance_status,
              CASE WHEN ${DONOR_ELIGIBILITY_SQL}
                THEN 'Available — Medical Clearance Approved'
                ELSE 'Available — Medical Clearance Pending'
              END AS patient_availability_status,
              DATE_FORMAT(d.last_confirmed_at, '%Y-%m-%dT%H:%i:%sZ') AS last_confirmed_at,
              COALESCE(DATE_FORMAT(d.availability_expires_at, '%Y-%m-%dT%H:%i:%sZ'),
                       DATE_FORMAT(d.available_until, '%Y-%m-%dT%H:%i:%sZ')) AS available_until
       FROM donors d
       JOIN users u ON u.user_id = d.user_id AND u.role = 'donor'
       WHERE ${filters.join(' AND ')}
       ORDER BY d.last_confirmed_at DESC
       LIMIT 25`,
      values
    );
    res.set('Cache-Control', 'no-store');
    let searchDiagnostics = null;
    if (!donors.length) {
      const stateFilter = state
        ? `AND ${normalizedLocationSql(DONOR_STATE_SQL)} = LOWER(?)`
        : '';
      const areaFilter = area
        ? `AND ${normalizedLocationSql(DONOR_AREA_SQL)} = LOWER(?)`
        : '';
      const [diagnostics] = await db.execute(
        `SELECT COUNT(*) AS location_and_blood_group_matches,
                COALESCE(SUM(d.available = 1), 0) AS marked_available,
                COALESCE(SUM(d.last_confirmed_at IS NOT NULL), 0) AS confirmed,
                COALESCE(SUM(d.public_contact_consent = 1), 0) AS search_consent,
                COALESCE(SUM(
                  COALESCE(d.next_eligible_date,
                    DATE_ADD(d.last_donation_date, INTERVAL ${DONATION_ELIGIBILITY_MONTHS} MONTH)) IS NULL
                  OR COALESCE(d.next_eligible_date,
                    DATE_ADD(d.last_donation_date, INTERVAL ${DONATION_ELIGIBILITY_MONTHS} MONTH)) <= UTC_DATE()
                ), 0) AS cooldown_clear,
                COALESCE(SUM(${DONOR_ELIGIBILITY_SQL}), 0) AS medically_eligible,
                COALESCE(SUM(
                  (COALESCE(d.availability_mode, 'general') = 'general'
                    AND COALESCE(d.availability_starts_at, d.last_confirmed_at) <= UTC_TIMESTAMP()
                    AND d.availability_expires_at > UTC_TIMESTAMP())
                  OR (COALESCE(d.availability_mode, 'general') = 'selected_dates'
                    AND EXISTS (
                      SELECT 1 FROM donor_availability_dates ad
                      WHERE ad.donor_user_id = d.user_id
                        AND ad.available_date = UTC_DATE()
                        AND ad.status = 'available'
                    ))
                ), 0) AS current_confirmation,
                COALESCE(SUM(
                  d.available = 1
                  AND d.last_confirmed_at IS NOT NULL
                  AND d.public_contact_consent = 1
                  AND (
                    COALESCE(d.next_eligible_date,
                      DATE_ADD(d.last_donation_date, INTERVAL ${DONATION_ELIGIBILITY_MONTHS} MONTH)) IS NULL
                    OR COALESCE(d.next_eligible_date,
                      DATE_ADD(d.last_donation_date, INTERVAL ${DONATION_ELIGIBILITY_MONTHS} MONTH)) <= UTC_DATE()
                  )
                  AND (
                    (COALESCE(d.availability_mode, 'general') = 'general'
                      AND COALESCE(d.availability_starts_at, d.last_confirmed_at) <= UTC_TIMESTAMP()
                      AND d.availability_expires_at > UTC_TIMESTAMP())
                    OR (COALESCE(d.availability_mode, 'general') = 'selected_dates'
                      AND EXISTS (
                        SELECT 1 FROM donor_availability_dates ad
                        WHERE ad.donor_user_id = d.user_id
                          AND ad.available_date = UTC_DATE()
                          AND ad.status = 'available'
                      ))
                  )
                ), 0) AS otherwise_searchable
         FROM donors d
         JOIN users u ON u.user_id = d.user_id AND u.role = 'donor'
         WHERE d.blood_group IN (${compatibleBloodGroups.map(() => '?').join(', ')})
           AND ${normalizedLocationSql(DONOR_CITY_SQL)} = LOWER(?)
           ${stateFilter}
           ${areaFilter}`,
        [...compatibleBloodGroups, city, ...(state ? [state] : []), ...(area ? [area] : [])]
      );
      searchDiagnostics = Object.fromEntries(
        Object.entries(diagnostics[0]).map(([key, value]) => [key, Number(value)])
      );
    }
    res.json({ donors, checked_at: new Date().toISOString(), search_diagnostics: searchDiagnostics });
  } catch (error) {
    console.error('Live availability search failed:', error.code || error.message);
    res.status(500).json({ message: 'Could not search live donor availability.' });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.use((error, req, res, next) => {
  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({ message: 'Request body must be valid JSON.' });
  }
  next(error);
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
