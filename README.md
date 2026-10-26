# LifeDrop — Blood Donor, Emergency and Blood Availability Portal

LifeDrop is a student project demo. Donor availability, account profiles, donation-camp interest, and blood requests use a MySQL-backed API.

## Open the website

[**Open LifeDrop on this computer**](http://localhost:3000)

This link works only when the LifeDrop server is running on your computer. It is not a public website URL; others cannot open your computer's `localhost` link. A public URL requires completing the hosting deployment below.

The home page's **Choose your portal** section links to the separate [Donor Portal](http://localhost:3000/donor-dashboard.html), [Donor Eligibility Portal](http://localhost:3000/donor-eligibility.html), [Patient Portal](http://localhost:3000/patient-dashboard.html), and [Admin Portal](http://localhost:3000/admin). Donor and patient pages send signed-out visitors to login and return them to the selected portal after successful login. The Admin Portal uses its separate admin sign-in.

## Run the application

1. Install Node.js and MySQL.
2. Use the existing `blood_donar_portal` database. The application does not drop, recreate, or replace it.
3. If you do not already have a `.env` file, create one from the example in PowerShell:

   ```powershell
   Copy-Item .env.example .env
   ```

   If `.env` already exists, keep its credentials and set `DB_NAME=blood_donar_portal`.
4. Configure the database connection and private admin credentials in `.env`:

   ```env
   PORT=3000
   DB_HOST=localhost
   DB_PORT=3306
   DB_USER=your_mysql_user
   DB_PASSWORD=your_mysql_password
   DB_NAME=blood_donar_portal
   ADMIN_USERNAME=choose_a_private_admin_username
   ADMIN_PASSWORD=use_a_unique_password_of_at_least_12_characters
   ```

5. Set a private admin username and a unique password of at least 12 characters in `.env`. These are separate from donor/patient accounts; there is no public admin registration form. The server creates or updates the single admin account from these environment variables on startup and stores only a bcrypt password hash in MySQL. Do not use the example text as a real password or commit `.env`.
6. Configure a stable, random `SESSION_SECRET` in `.env` (at least 32 characters). For example, generate one with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` and copy it into `.env`.
7. Generate a separate health encryption key with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Set the 64-character output as `HEALTH_DATA_ENCRYPTION_KEY` in `.env`; keep it private, stable, and backed up securely.
8. Optionally set `DONATION_ELIGIBILITY_MONTHS=3` in `.env` to the workflow interval approved for your deployment. Blood-stock freshness follows the server/database UTC calendar date and is not configurable by elapsed hours.
9. Run `npm install`, then `npm start`.
10. Open `http://localhost:3000`. Visit `http://localhost:3000/admin` and sign in with `ADMIN_USERNAME` and `ADMIN_PASSWORD`. `localhost` is only your own computer; this is not the public deployed website URL.

On startup, the server detects the portal schema, preserves its existing `recipient` accounts, adds the `patient` role used by the current app, and adapts donor/request fields without deleting records. It creates the date-availability, date-history, private screening, donation-history, eligibility-review, request-event, in-app notification, and (only if absent) blood-bank tables; it reuses existing bank, inventory, and audit records and adds missing compatible columns/indexes. Donor profiles are backfilled without marking them available. Existing `donor_availability` rows are synchronized only when they contain an actual confirmation timestamp. Unknown confirmations stay **Unconfirmed**. The database user needs permission to create/alter tables and indexes. The local health endpoint is `http://localhost:3000/api/health`. Additive migration scripts are in `migrations/006_donation_inventory_coordination.sql` through `migrations/011_in_app_notifications.sql`; migration 010 adds eligibility review-request and donation-correction audit tables, and migration 011 adds the in-app notification inbox without replacing existing notification records.

## Donor availability and emergency notifications

- Donors manage **My Donation Availability** at `/donar-dashboard.html` (or `/donor-dashboard.html`). Choose **Generally Available**, **Available on Selected Dates**, **Not Available**, or **Temporarily Unavailable**. Temporary unavailability remains non-matchable until the donor explicitly reconfirms. In selected-date mode, choose future dates, add them, then click **Save selected dates**; those saved dates appear in the Admin Dashboard. General availability requires a 4-, 12-, or 24-hour confirmation; MySQL records server-generated `last_confirmed_at` and the expiry. Date availability stores each future date separately, including per-date unavailable overrides; a selected date never implies availability on another date. Expired general confirmations and elapsed selected dates are excluded by server queries. Unknown confirmations remain **Unconfirmed**. The admin dashboard separates the availability states and expired confirmations. Donors never enter blood-unit quantities.
- Donors can update their registered city, state, and area/locality in the **My Profile Location** section. This is profile-based location, not live GPS. The authenticated `PATCH /api/donor/profile-location` route updates the existing user and donor rows transactionally; no schema change is needed. Patients see the saved area when present and an explicit “Area not provided” label otherwise.
- Units are kept separate by workflow: patients enter **units required** on emergency requests, while blood-bank inventory results report stock units from the existing stock source. Donor availability does not represent a number of units available.
- Donors separately opt into patient search, display of their registered name, and in-app emergency matching. These preferences default off for existing donors. `/patient-dashboard.html` searches confirmed, opted-in donor records by blood group and the selected registered city/state. Results show the donor's registered name and city/state, not live GPS or an exact address. Phone numbers are never shown in live-search results; a phone is shared only after the donor accepts a specific request and separately consents to contact sharing. Email, health answers, and exact addresses are never returned in public search. The treating blood bank/medical team must confirm compatibility and eligibility.
- **Donor Health Screening** is separate from availability. It collects consented weight, blood pressure, medication/treatment, medical history, recent illness, and screening answers. New health responses are AES-256-GCM encrypted at rest; legacy questionnaire JSON remains readable under the same authorization checks. Donors and bank-mapped staff can view health answers; patient search and admin donor lists never include them. Screening review and final eligibility are separate professional workflow decisions; no self-reported value or universal threshold automatically approves/rejects a donor.
- **Donation history and eligibility:** Admins can record and verify completed donations from `/admin`. The initial configurable interval is three calendar months (`DONATION_ELIGIBILITY_MONTHS`, default `3`, allowed `1`–`24`), with month-end dates clamped to the last calendar day. Recording a donation disables availability and records the next interval date. After that date, the donor must submit a new screening, receive authorized staff review and a separate eligible decision, then confirm availability again before matching. This is workflow configuration only, not medical guidance; current local medical and blood-bank policies govern actual eligibility.
- **Donor Eligibility Portal:** Donors can open `/donor-eligibility.html` after signing in to see their own verified donation history, recovery-period tracker, current workflow status, matching state, and review-request status. The progress indicator is informational and is not proof of medical recovery. Donors can request professional review after the configured interval and required screening; the admin dashboard can accept a request for staff review or reject it with instructions, but this action is not a medical eligibility decision. Only authorized staff using the existing screening/eligibility workflow can verify eligibility. Donation-date corrections are admin-only, require a reason, preserve an audit record, and return the donor to the required recovery/review flow.
- **Blood-bank inventory:** Authorized staff sign in through the existing login and are directed to the separate `/blood-bank-portal.html`; they must already be mapped to an active bank. The portal shows the assigned bank identity, accepts daily stock by blood group/component, and displays the current inventory and append-only update history. Stock date and update time are server-generated in UTC. Each update is audited and remains pending until an authorized admin verifies or rejects it. Patients can search staff-entered records by state, district, city, area/address, blood group, component, and bank name from the home page; only fresh, verified quantities are confirmed. A report is fresh only for the UTC calendar date of its update. Yesterday's report is stale even if fewer than 24 hours have elapsed; stale reports display **Outdated**, while fresh unverified reports display **Pending Verification** and are not presented to patients as current stock. The admin portal monitors banks that have or have not submitted today, pending/rejected stock verification, and last update timestamps. The portal reuses the existing inventory and history schema from additive migrations `007_daily_blood_stock.sql` and `009_stock_verification_review.sql`; no new database migration or sample stock is required. Confirm all reported stock directly with the bank.
- Patients can choose **Request Help** from a live result or submit through the existing request form. Requests include blood group, component, units, hospital, location, urgency, needed-by time, and contact details. Submission creates an in-app patient record; it is not automatically sent to or accepted by a hospital or government service. Urgent patient escalation adds a record to the matching LifeDrop service-area coordinator queue, not an external dispatch. Mapped bank staff can accept, reject, progress, cancel, or explicitly mark fulfilled; the patient dashboard polls database events for updates. `Fulfilled` requires an explicit staff confirmation and is distinct from donor responses or coordinator acceptance.
- A donor's dashboard notification shows a request ID, blood group, units, hospital name, approximate city/district, request time and response deadline. It does not show the patient's name, address or phone. Donors may **Accept Request**, select **Busy / Cannot Donate Now**, or **Decline Request**. Accepting requires a current matching availability and emergency-matching consent; contact details are shared only when the donor separately consents for that request.
- The donor dashboard keeps unread notifications and response history in MySQL. Responses distinguish **Pending**, **Accepted — Awaiting Contact**, **Busy**, **Declined**, and **No Response**; expired pending rows are recorded as expired without inventing a donor response time. Additional matching is attempted after all current pending/accepted responses are exhausted. The patient dashboard shows response totals and per-donor status. Silence or **Accepted** does not guarantee attendance or donation. Patients receive a donor name/phone only after that donor explicitly consents to contact sharing for the individual request.
- The blood-bank search is separate from individual donors. LifeDrop's existing blood-stock route queries the e-RaktKosh portal and displays reported stock when returned; results are not verified inventory and must be confirmed directly with the blood bank. The official portal describes blood-availability search, a blood-centre directory, and separate centre login; no authorized third-party emergency-request submission API was identified in the public portal information checked. LifeDrop does not submit patient requests to e-RaktKosh. Patients can open the [official e-RaktKosh portal](https://eraktkosh.mohfw.gov.in/eraktkoshPortal/) or contact the listed blood bank directly. For emergencies in India, call **112**.
- The response deadline is set when a request is submitted. Configure `DONOR_RESPONSE_WINDOW_MINUTES` in the private `.env` (default `120`; accepted range `1`–`1440`) before starting the server. An unanswered notification becomes **Expired** at its stored deadline; silence is not acceptance or refusal.
- **SMS and external push/email are not supported.** Emergency requests continue to create the existing in-app MySQL notifications for donors who meet the existing matching rules. Donors must sign in to review and respond to a request. A valid phone number does not trigger SMS.
- **In-app notification bell:** Donor, patient, blood-bank staff, and admin pages show an authenticated notification inbox with unread count and per-item read controls. Donor availability changes save a private confirmation notification in the same transaction as the MySQL update. Matching patient searches refresh every 15 seconds while open, and the admin dashboard refreshes its availability view every 15 seconds. Donors receive matched emergency request notices, eligibility reminders before/after the configured review date, and availability reconfirmation reminders. Blood-bank staff receive daily-update reminders and confirmation of their own stock submissions; admins receive new emergency request, pending donor review, and missing daily bank stock alerts. Notifications are persisted in MySQL and restricted to their recipient; they do not include donor health answers or contact details. The UI uses 15/30-second polling rather than SSE/WebSockets.
- **Donor availability:** Sign in and open the Donor dashboard. Use **Confirm availability** in its header to jump to **My Donation Availability**, then select **Available to Donate** or **Not Available**. The page reports the saved status; live matching still requires current eligibility and the donor's sharing consent.
- For urgent needs, contact the hospital or blood bank immediately. LifeDrop does not verify clinical eligibility, blood inventory, donor arrival or fulfillment.

Do not test emergency matching with requests that could contact real donors. SMS, email, browser push, and automated delivery retries are not configured; in-app request records remain in MySQL.

The additive migrations are [`migrations/001_donor_availability_confirmation.sql`](./migrations/001_donor_availability_confirmation.sql), [`migrations/002_emergency_in_app_notifications.sql`](./migrations/002_emergency_in_app_notifications.sql), [`migrations/003_blood_request_state.sql`](./migrations/003_blood_request_state.sql), [`migrations/004_portal_availability_and_screening.sql`](./migrations/004_portal_availability_and_screening.sql), [`migrations/005_donor_search_identity_consent.sql`](./migrations/005_donor_search_identity_consent.sql), and [`migrations/006_donation_inventory_coordination.sql`](./migrations/006_donation_inventory_coordination.sql). Normal startup applies compatible schema checks automatically. Take a verified backup before applying schema changes.

### Availability and request API

- `GET /api/availability/status`, `POST /api/availability/status` — authenticated donor status. POST accepts `status`, `mode` (`general`, `selected_dates`, `unavailable`), `selected_dates`, `public_contact_consent`, `public_identity_consent`, `emergency_response_consent`, and a 4/12/24-hour confirmation duration. Timestamps are generated server-side.
- `PATCH /api/donor/profile-location` — authenticated donor-only update for the existing registered city, state, and area fields. The transaction updates the donor's own `users` and `donors` rows; no schema migration is needed. Patient results show this saved profile location, not live GPS.
- `GET /api/donors/search?state=Karnataka&city=Mysuru&blood_group=O%2B` — patient-session-only search by registered state, city/place, and exact blood group. Optional fields still support area, radius choice, required date, units, and emergency priority for compatible clients; distance is not calculated without reliable coordinates.
- `GET`, `POST /api/donor/health-screening` — donor-only private questionnaire.
- `GET /api/blood-bank/health-screenings`, `POST /api/blood-bank/health-screenings/:screeningId/review`, `GET/POST /api/blood-bank/inventory`, and `GET/POST /api/blood-bank/emergency-requests` — authenticated blood-bank users must also have an explicit `blood_bank_staff` mapping to an active bank. Health answers and staff inventory are never returned through patient search.
- `GET /api/notifications`, `POST /api/notifications/:notificationId/read` — donor/patient-only personal notification inbox and ownership-scoped read updates.
- `GET /api/admin/notifications`, `POST /api/admin/notifications/:notificationId/read` — admin-session-only alerts and read updates.
- `POST /api/blood-requests` — authenticated, transactional emergency request and donor notification creation. Donor notifications/responses use `GET /api/donor/notifications` and `POST /api/donor/emergency-requests/:requestId/response`; patient response tracking uses `GET /api/my-emergency-responses`.
- `GET /api/admin/dashboard` — protected admin endpoint with actual availability states, confirmation/expiry, saved dates, and request records. Search responses never include donor contact or health information.

Configure `HEALTH_DATA_ENCRYPTION_KEY` as exactly 64 hexadecimal characters generated from 32 random bytes. Keep it private and stable; losing or changing it makes newly encrypted health details unreadable. New health submissions fail with a clear service-unavailable response until it is configured. `DONATION_ELIGIBILITY_MONTHS` defaults to `3`; this is a workflow review interval, not medical guidance or automatic certification. Blood-stock freshness uses the server's UTC calendar date. Existing `DB_*`, `SESSION_SECRET`, `ADMIN_USERNAME`, and `ADMIN_PASSWORD` settings remain required as documented. `DONOR_RESPONSE_WINDOW_MINUTES` is optional (default 120).

Blood-bank roles alone do not grant bank access. A trusted database administrator must verify a staff account, ensure its `users.role` is `blood_bank`, then map it to one active bank in `blood_bank_staff`. The inspected local database currently has two bank records and no staff mappings or inventory rows. Do not assign accounts without organizational authorization. Only in-app request updates are stored by LifeDrop; no SMS or push notification is sent.

### Test and verify the feature

1. In VS Code, run `npm start` and open `http://localhost:3000`. Use a dedicated donor test account at `/login`, then open `/donar-dashboard.html`. In **My Donation Availability**, choose **Generally Available**, opt into patient search and emergency responses as desired, choose a confirmation duration, and click **Available to Donate**. Verify status and timestamps, refresh the page, and confirm that **Not Available** excludes the donor.
2. Choose **Available on Selected Dates**, add at least two future dates, save them, then mark one date unavailable and save again. Verify the list persists after a refresh. Ensure that a patient search for one saved date can match while an adjacent unselected date does not.
3. Submit a health screening from the donor dashboard. It should display **Pending Review**, remain separate from availability, and never appear in patient search. A valid blood-bank staff account can use `/blood-bank-review.html`; patient and ordinary admin sessions must receive a 403 from the private screening API.
4. In MySQL Workbench, inspect test-donor confirmation and date records:

   ```sql
   SELECT d.user_id, d.availability_status, d.availability_mode,
          d.available, d.last_confirmed_at, d.availability_expires_at,
          d.available_until, ad.available_date, ad.status AS date_status,
          ad.confirmed_at
   FROM donors d
   LEFT JOIN donor_availability_dates ad ON ad.donor_user_id = d.user_id
   WHERE d.user_id = (
     SELECT user_id FROM users
     WHERE username = 'your_test_donor_username' AND role = 'donor'
   )
   ORDER BY ad.available_date;
   ```

5. Log in as a test patient at `/patient-dashboard.html`; select a blood group and search by registered city/place and state. Verify that only exact matches who are currently confirmed and opted into name display appear, and that no phone, email, exact address, or health details are returned. Check the separate blood-bank/e-RaktKosh option when there are no matches.
6. Submit an urgent request with units required and a future needed-by date. Verify it appears in MySQL and creates in-app notifications only for opted-in, matching donors. Log in as a notified donor, accept, mark busy, or decline, and verify the patient sees the response. Confirm duplicate responses and late responses are rejected; contact details are disclosed only after per-request consent.
7. Sign in to `/admin`. Verify All Donors shows every registration, and the Available, Not Available, Unconfirmed, and Expired filters/counts reflect database data. Confirm the saved dates, last confirmation, expiry, patient requests, and response progress. The dashboard refreshes every 15 seconds.
8. To test general-availability expiry immediately, use a **dedicated test donor only**. This changes only that test donor's confirmation; never run it for a real donor:

   ```sql
   UPDATE donors
   SET availability_expires_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE),
       available_until = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE)
   WHERE user_id = (
     SELECT user_id FROM users
     WHERE username = 'your_test_donor_username' AND role = 'donor'
   );
   ```

   The dashboard should classify this donor as **Expired** and patient search/new requests must exclude them. Remove only temporary test records created for your own test after verification; never delete existing users or requests.

Blood-bank staff accounts are not self-registered through the portal; an administrator must authorize and map each existing `blood_bank` account to an active bank. Coordinate urgent care directly with the hospital or blood bank; a donor response does not guarantee donation.

## Deploy online with Railway

LifeDrop serves its frontend and API from one Express service. The frontend uses relative API URLs, so it does not need a separate API base URL or CORS configuration when deployed this way.

1. Confirm that the GitHub repository `ranjitha9775-alt/Blood-donar` contains the project files (including `server.js`, `package.json`, `package-lock.json`, `admin.html`, `admin.js`, and `index.html`). Commit and push updates from your project folder:

   ```powershell
   git add .gitignore .env.example README.md package.json package-lock.json server.js app.js login.js login.html admin.html admin.js index.html assets dashboard.js blood-bank-review.html blood-bank-review.js donar-dashboard.html patient-dashboard.html migrations
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
- Login is available at `/login`; the authenticated patient dashboard at `/patient-dashboard.html` provides the location/blood-group search and patient request flow. Donors can opt into search and display of their registered name and area, then set a confirmation duration of 4, 12, or 24 hours. Search is restricted to logged-in patients and the API checks authorization.
- Donor search uses registered donor and user rows in MySQL, never sample donor records. The patient live-search form asks only for blood group, city/place, and state. A donor appears only after confirming current availability and separately opting into search and name display, and only when those filters match. Results return the donor's registered name and city/state, but never the phone number, email, or address. A phone is released only after the donor accepts a specific request and checks per-request contact-sharing consent. Exact home addresses are never exposed.
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
