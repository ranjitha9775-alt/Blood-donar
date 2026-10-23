# LifeDrop — Blood Donor, Emergency and Blood Availability Portal

LifeDrop is a student project demo. Donor availability, account profiles, donation-camp interest, and blood requests use a MySQL-backed API.

## Open the website

[**Open LifeDrop on this computer**](http://localhost:3000)

This link works only when the LifeDrop server is running on your computer. It is not a public website URL; others cannot open your computer's `localhost` link. A public URL requires completing the hosting deployment below.

## Run the application

1. Install Node.js and MySQL.
2. Create the database named in `DB_NAME` (defaults to `lifedrop`).
3. If you do not already have a `.env` file, create one from the example in PowerShell:

   ```powershell
   Copy-Item .env.example .env
   ```

   If `.env` already exists, keep it and edit it without overwriting its database settings.
4. Configure the database connection and private admin credentials in `.env`:

   ```env
   PORT=3000
   DB_HOST=localhost
   DB_PORT=3306
   DB_USER=your_mysql_user
   DB_PASSWORD=your_mysql_password
   DB_NAME=lifedrop
   ADMIN_USERNAME=choose_a_private_admin_username
   ADMIN_PASSWORD=use_a_unique_password_of_at_least_12_characters
   ```

5. Set a private admin username and a unique password of at least 12 characters in `.env`. These are separate from donor/patient accounts; there is no public admin registration form. The server creates or updates the single admin account from these environment variables on startup and stores only a bcrypt password hash in MySQL. Do not use the example text as a real password or commit `.env`.
6. Configure a stable, random `SESSION_SECRET` in `.env` (at least 32 characters). For example, generate one with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` and copy it into `.env`.
7. Run `npm install`, then `npm start`.
8. Open `http://localhost:3000`. Visit `http://localhost:3000/admin` and sign in with `ADMIN_USERNAME` and `ADMIN_PASSWORD`. `localhost` is only your own computer; this is not the public deployed website URL.

On startup, the server creates the `camp_registrations`, `users`, `admin_users`, `blood_requests`, and `donor_request_responses` tables, and creates or migrates the `donors` and `patients` tables. It adds donor availability confirmation and consent columns, a unique username column to `users`, a nullable user link to `patients`, and a state field to blood requests; existing accounts and requests are preserved. Existing accounts without a username can continue to sign in using their email, while new registrations use usernames. Donors whose records have no confirmation are **Unconfirmed**, not assumed available or explicitly unavailable. The database user needs permission to create/alter tables and create indexes. The local health endpoint is `http://localhost:3000/api/health`.

## Donor availability and emergency notifications

- Donors manage availability in **My Donation Availability** at `/donar-dashboard.html` (or `/donor-dashboard.html`). Choose **Available to donate** or **Not available** to save immediately. Available confirmations expire after the selected 4, 12, or 24 hours. MySQL records the donor-selected status, database-generated `last_confirmed_at`, and `availability_expires_at`; unavailable selections are excluded from search and matching. Unknown or expired confirmations are **Unconfirmed** and are not renewed automatically. Searches also expire stale rows in MySQL and exclude them. The donor dashboard refreshes its saved status after each update; an open admin dashboard in the same browser refreshes immediately, and admin dashboard data otherwise refreshes every 15 seconds.
- Donors separately opt into privacy-safe patient search and in-app emergency matching. Both preferences default off for existing and newly registered donors. `/patient-dashboard.html` searches confirmed, opted-in donors by blood group and Karnataka location. The patient view returns only a generic donor label, blood group, city/state, current status, confirmation time, and expiry; it never returns donor email, phone, name, or exact area. Donor coordinates are not stored, so 5/10/25/50 km choices use approximate city-level matching and do not show fabricated distances. **Wider search** searches across Karnataka. Search refreshes when submitted; donor confirmations are checked against MySQL expiry on every search.
- Patients can choose **Request Help** from a live result or submit through the existing request form. The app saves blood group, hospital, city/state/district, units, urgency, request time, and status in MySQL. For an **Urgent** request with matching enabled, it creates durable in-app notifications for donors who opted in to emergency matching and have a current confirmation in the same blood group, city, and state. This is a conservative exact-group match, **not a medical compatibility determination**; the treating blood bank or medical team must confirm compatibility before transfusion.
- A donor's dashboard notification shows a request ID, blood group, units, hospital name, approximate city/district, request time and response deadline. It does not show the patient's name, address or phone. Donors may respond **Available** or **Not available**. They must confirm before submission; an Available response also requires a still-current availability confirmation and emergency-matching consent. A donor's name/phone are shared with the patient only if that donor separately checks the per-request contact-sharing consent before choosing Available.
- The donor dashboard keeps unread notifications and response history in MySQL. Donor responses display **Pending**, **Accepted**, **Declined**, or **Expired** (plus closed requests); the patient dashboard shows response totals and per-donor status. Silence or **Accepted** does not guarantee attendance or donation. Patients receive a donor name/phone only after that donor explicitly consents to contact sharing for the individual request.
- The blood-bank search is separate from individual donors. LifeDrop's existing blood-stock route queries the e-RaktKosh portal and displays reported stock when returned; results are not verified inventory and must be confirmed directly with the blood bank. Patients can also open the [official e-RaktKosh portal](https://eraktkosh.mohfw.gov.in/eraktkoshPortal/). For emergencies in India, call **112**.
- The response deadline is set when a request is submitted. Configure `DONOR_RESPONSE_WINDOW_MINUTES` in the private `.env` (default `120`; accepted range `1`–`1440`) before starting the server. An unanswered notification becomes **Expired** at its stored deadline; silence is not acceptance or refusal.
- **External delivery is not configured.** This release sends no email, SMS or push notification; its notification is an in-app MySQL record available when a donor logs in. Providing a valid phone number does not trigger SMS. There are no credentials to add for this feature. To add a provider later, configure its credentials as private server-side environment variables, integrate its delivery API, and report delivery only after the provider confirms success. Reminder sending is also not enabled.
- For urgent needs, contact the hospital or blood bank immediately. LifeDrop does not verify clinical eligibility, blood inventory, donor arrival or fulfillment.

The additive migrations are [`migrations/001_donor_availability_confirmation.sql`](./migrations/001_donor_availability_confirmation.sql), [`migrations/002_emergency_in_app_notifications.sql`](./migrations/002_emergency_in_app_notifications.sql), and [`migrations/003_blood_request_state.sql`](./migrations/003_blood_request_state.sql). Normal app startup checks for the state column and adds it if missing; it creates the response table without deleting existing records. The configured database for this project is `lifedrop`; the separate `blood_donar_portal` database has a different schema and is not used by this app. For a manual migration, take a verified backup and apply only the migration(s) missing from that database, once, before starting the app; don't manually re-run a migration already applied.

### Availability and request API

- `GET /api/availability/status` and `POST /api/availability/status` — donor-only current status and confirmation. POST accepts `status`, `public_contact_consent`, `emergency_response_consent`, and optional `expires_in_hours` (`4`, `12`, or `24`).
- `GET /api/donors/search?state=Karnataka&city=Mysuru&blood_group=O%2B&radius_km=25&units=1&emergency=true` — patient-session-only, privacy-safe results from MySQL; `radius_km` accepts `5`, `10`, `25`, `50`, or `wider`. The kilometer options cannot calculate real radii without donor coordinates; they use approximate city matching, while `wider` searches statewide.
- `POST /api/blood-requests` — authenticated request create; writes request data and matching donor-response notification rows transactionally. `GET /api/donor/notifications` and `POST /api/donor/emergency-requests/:requestId/response` serve donor notifications/responses; `GET /api/my-emergency-responses` serves the signed-in patient's own request responses.
- `GET /api/admin/dashboard` — admin-session-only; donor status is calculated from actual confirmation and expiry fields. No search route returns donor phone or email.

No new environment variables are required. Keep the existing `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, and `DB_NAME`; `SESSION_SECRET`, `ADMIN_USERNAME`, and `ADMIN_PASSWORD` retain their current requirements. `DONOR_RESPONSE_WINDOW_MINUTES` remains optional (default 120). No SMS provider credentials are configured or needed; notifications are in-app only.

### Test and verify the feature

1. In the VS Code terminal, from the project folder, run `npm start`. Sign in with a donor test account at `http://localhost:3000/login`, then open `http://localhost:3000/donar-dashboard.html`. Select **Available to Donate**, opt in to emergency matching, and click **Confirm My Availability**. Verify the saved status and timestamp appear. Refresh the page to verify they reload from MySQL.
2. In MySQL Workbench, inspect the persisted confirmation (adjust the limit as needed):

   ```sql
   SELECT user_id, availability_status,
          CASE
            WHEN available = 1 AND last_confirmed_at IS NOT NULL
                 AND availability_expires_at > UTC_TIMESTAMP() THEN 'Available'
            WHEN last_confirmed_at IS NULL THEN 'Unconfirmed'
            WHEN available = 0 AND availability_status = 'not_available' THEN 'Not Available'
            ELSE 'Unconfirmed'
          END AS current_status,
          last_confirmed_at, availability_expires_at, availability_updated_at
   FROM donors
   ORDER BY user_id DESC
   LIMIT 10;
   ```

3. To test expiry immediately, use a **dedicated test donor only** and substitute that account's username. This changes only that test donor's expiry; do not run it for real donors:

   ```sql
   UPDATE donors
   SET availability_expires_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE)
   WHERE user_id = (
     SELECT user_id FROM users
     WHERE username = 'your_test_donor_username' AND role = 'donor'
   );
   ```

   Refresh the donor dashboard and run a donor search. It should show **Unconfirmed**, and the expired donor must not appear in patient search or new matches. Click confirm again only if using the test account.
4. Use a separate patient test account at `http://localhost:3000/patient-dashboard.html`. Search `Karnataka`, `Mysuru`, `O+`, then use **Request Help** and submit an **Urgent** request with matching enabled. Exact blood group/city/state matches with current confirmation and emergency-matching consent receive an in-app notification; no external message is sent. Confirm a different blood group/city, opted-out donor and expired donor are not matched. With no matching record, verify **No currently confirmed donors found**, **Search wider area**, and the separate blood-bank links.
5. Sign in as the donor, open the unread notification with **View Request**, and choose **Available** or **Not available**. The browser asks for confirmation. Optionally check the donor contact-sharing box before choosing Available. The patient dashboard refreshes with response status/counts; contact details appear only when explicitly shared.
6. Repeat with both response choices, click twice (the second response must be rejected), and test a non-matching donor/unauthorized session (must not view or respond to another donor's notification). Close a test request from the existing request board and verify it shows **Request Closed**. For timeout testing, set `DONOR_RESPONSE_WINDOW_MINUTES=1` in `.env`, restart `npm start`, submit a fresh test request and wait one minute; the patient should see **Expired** and a late donor response must be rejected.

   To inspect response state without exposing patient contact details:

   ```sql
   SELECT request_id, donor_user_id, response, matched_at,
          response_deadline, responded_at, read_at,
          contact_sharing_consent, updated_at
   FROM donor_request_responses
   ORDER BY matched_at DESC
   LIMIT 20;
   ```

   Use test accounts and remove only their test requests/accounts after verification. A response never guarantees donor arrival or blood availability; coordinate urgent care with the hospital or blood bank.

## Deploy online with Railway

LifeDrop serves its frontend and API from one Express service. The frontend uses relative API URLs, so it does not need a separate API base URL or CORS configuration when deployed this way.

1. Confirm that the GitHub repository `ranjitha9775-alt/Blood-donar` contains the project files (including `server.js`, `package.json`, `package-lock.json`, `admin.html`, `admin.js`, and `index.html`). Commit and push updates from your project folder:

   ```powershell
   git add .gitignore .env.example README.md package.json package-lock.json server.js app.js login.js login.html admin.html admin.js index.html assets dashboard.js donar-dashboard.html patient-dashboard.html migrations
   git commit -m "Prepare LifeDrop for deployment"
   git push origin main
   ```

   If your branch is named `master`, use `git push origin master` instead. Never add `.env`, `node_modules`, database dumps, or credentials. `.gitignore` excludes local environment files and installed packages.

2. Open [Railway](https://railway.com), sign in with GitHub, choose **New Project** → **Deploy from GitHub repo**, authorize Railway to access `Blood-donar`, and select that repository. Keep the service root at the repository root. The project already provides the production commands `npm ci` (install) and `npm start` (start); Node.js 20 or newer is required.
3. In the Railway project, choose **New** → **Database** → **MySQL**. Wait until the database service reports that it is running. In that service's **Backups** settings, enable recurring backups/point-in-time recovery if available on your plan, and verify the retention and restore process.
4. In the Node service's **Variables** settings, add the following. Replace `MySQL` in each reference with the exact display name of your Railway MySQL service if it is named differently. Railway supplies the referenced values; do not type your actual database password into source files.

   ```text
   NODE_ENV=production
   SESSION_SECRET=<generate a unique random secret locally>
   ADMIN_USERNAME=<choose a private admin username>
   ADMIN_PASSWORD=<set a unique password of at least 12 characters>
   DB_HOST=${{MySQL.MYSQLHOST}}
   DB_PORT=${{MySQL.MYSQLPORT}}
   DB_USER=${{MySQL.MYSQLUSER}}
   DB_PASSWORD=${{MySQL.MYSQLPASSWORD}}
   DB_NAME=${{MySQL.MYSQLDATABASE}}
   ```

   Enter these values manually; do not bulk-import `.env.example`, whose values are examples only.

   Generate a session secret in PowerShell with:

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
   ```

   Paste its output directly into the Railway `SESSION_SECRET` variable. Keep it private and stable; do not commit it or send it in chat.
5. In the Node service settings, set the health-check path to `/api/health` if the dashboard offers that setting, then deploy/redeploy after saving variables. The API health endpoint reports success only after the MySQL connection and startup schema initialization succeed.
6. In the Node service's **Networking** settings, generate a public domain. Open that HTTPS URL to use LifeDrop. The frontend and API share the same origin, and Railway provides the `PORT` environment variable.
7. Confirm the deployed URL and open `https://YOUR-DOMAIN/api/health`. Expect JSON with `"server":"running"` and `"database":"connected"`. Also register a test account, sign out/in, create a test camp registration and blood request, confirm the request appears on the board, then sign in from another browser/session to confirm persisted access. Remove test data only by identifying the exact test account and records.

Railway and database service availability/pricing may change; check the dashboard's current plan and charges before creating services. Do not enter real patient or donor personal information until you have considered consent, privacy, retention, account recovery, and applicable legal requirements.

### Existing local database data

The hosted MySQL database is separate from local MySQL; the app does not copy local records automatically. First make a verified backup and inspect the local schema and records. The app uses `CREATE TABLE IF NOT EXISTS` for its managed tables and checks/migrates the donor table at startup, so do not manually create a second set of app tables in the same database.

For a data migration, provision a fresh/empty hosted database, make and verify a local backup, compare the local schema with the current application schema, and import only after confirming the mapping and restore procedure for the selected MySQL provider. Keep the app stopped until the restore is complete, and take a provider snapshot before importing into any non-empty database. Never commit or upload a database dump to GitHub. If the data or schema does not match, do not import it blindly; use a tested migration on a separate database first.

The app creates its tables on startup. The MySQL user needs permission to create and alter tables and indexes. A successful health check tests database connectivity and initialization, not the completeness of any manual data migration.

## Admin dashboard

- The private dashboard is at `/admin`. It uses its own `admin_users` MySQL table, credentials, rate-limited login endpoint, and HTTP-only admin session cookie; donor/patient login cannot authenticate to it. Dashboard APIs require the separate admin session on the server, so hiding the page in the browser is not the security boundary. Donor availability shows `Available`, `Not Available`, or `Unconfirmed`, plus the last confirmation and stored expiry when present. A NULL confirmation is treated as unknown, not as an explicit opt-out.
- Only the admin dashboard shows private account information. Its separate Donor Management and Patient Management sections load real registrations from the existing `users`, `donors`, `patients`, and `blood_requests` tables. The dashboard shows a live count of currently available donors, their status and confirmation expiry, and refreshes every 15 seconds while open; manual refresh is also available. Patient fields include required blood group, location, urgency, and request status. The patient-request total includes registration requests in `patients` and later requests in `blood_requests`; legacy request rows remain visible under Patient Management.
- To change the admin username or password, update `ADMIN_USERNAME` / `ADMIN_PASSWORD` in the private environment configuration and restart the server. The app re-hashes and applies those credentials on startup. If either value is missing or invalid, admin login is disabled; donor and patient registration remain available. Never use a shared or reused password.

## Accounts and live donor availability

- Donors and patients create accounts with a unique username, email address, and password. Usernames are unique and case-insensitive; use 3–32 letters, numbers, dots, underscores, or hyphens. Passwords are bcrypt-hashed before storage and are never included in dashboard responses. Donor account/profile creation is transactional across `users` and `donors`. Patient registration also collects hospital, units, and urgency, then transactionally saves the account in `users` and its initial `Pending` blood request in `patients`. New users sign in with username and password; accounts created before usernames were introduced can continue signing in with their email and password. After registration, the home page stays open and users may select Login when they are ready to sign in. Registration clears any existing session, so the new account is not logged in automatically.
- To verify patient blood requests in MySQL Workbench, select the `lifedrop` schema and run:

  ```sql
  SELECT patient_id, patient_name, age, gender, blood_group, hospital_name,
         city, area, contact_number, units_required, urgency, request_status, request_date
  FROM patients
  ORDER BY patient_id DESC;
  ```

  Patient accounts remain in `users`; only new patient registrations that provide request details create a corresponding row in `patients`. Existing account records are not automatically converted into requests because their hospital, unit, and urgency details were not collected.
- Login is available at `/login`; the authenticated patient dashboard at `/patient-dashboard.html` provides the location/blood-group search and patient request flow. Donors can opt into privacy-safe search and set a confirmation duration of 4, 12, or 24 hours. Search is restricted to logged-in patients and the API checks authorization.
- A donor appears in patient search only after confirming current availability and opting into public search. Results use a generic donor identifier; donor contact data is not returned by either search API. Contact details are released only after the donor checks per-request contact-sharing consent.
- Confirmations expire after the donor-selected duration (maximum 24 hours). Search uses MySQL availability and expiry fields; stale records are disabled when a search runs. No donor latitude/longitude columns exist, so radius filters are approximate city/state matching, and no distance is calculated or fabricated.
- Contact the blood bank to confirm stock, compatibility, and donor availability. Donor listings are not blood-bank inventory, and the application does not determine medical compatibility or donor eligibility.
- Sessions are signed, HTTP-only, same-site cookies and last 12 hours. Without a configured `SESSION_SECRET`, development sessions are invalidated whenever the server restarts.
- Contact information is personal data. This demo does not include email verification, password reset, account/profile editing/deletion, or production-grade identity verification. Do not deploy publicly or enter real personal/medical information until those protections and applicable privacy requirements are addressed.

## Other demo features and limitations

- The Blood Stocks section uses the Government of India's public blood-stock service. Users select a state, district, component, and hospital/blood centre; results show reported units by blood group without hospital name, contact, or address details. The API's centre directory and inventory feed are the source; no sample quantities are fabricated.
- Individual donor listings are separate from blood-centre directory listings and are based only on donor-confirmed availability in this application's MySQL database.
- Responsive navigation, browser-validated forms, and illustrative camp listings. Camp-interest submissions collect name, phone, and email after explicit consent, and are stored in the `camp_registrations` MySQL table. A duplicate email cannot register for the same camp twice.
- Camp dates, venues, and organisers are illustrative demo content, not verified event listings. Saving interest does not confirm attendance, and the application does not notify camp organisers.
- Submitting a blood request and viewing the shared request board require login. Request details are stored in the `blood_requests` MySQL table and are retrieved from the API across devices. Authenticated users see a limited, non-identifying summary; patient reference, hospital, and contact details are not shown on the board. Only the request owner can update its status. Verification remains server-controlled and requests are not independently verified or sent to hospitals.
- The project provides no medical advice or emergency service. For an emergency, contact the patient's hospital and emergency medical services immediately; do not wait for a website response.
