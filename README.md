# LifeDrop — Blood Donor, Emergency and Blood Availability Portal

LifeDrop is a student project demo. Donor availability, account profiles, donation-camp interest, and blood requests use a MySQL-backed API.

## Open the website

[**Open LifeDrop on this computer**](http://localhost:3000)

This link works only when the LifeDrop server is running on your computer. It is not a public website URL; others cannot open your computer's `localhost` link. A public URL requires completing the hosting deployment below.

The shared desktop/mobile navigation links to Home, Donor Portal, Donor Eligibility, Blood Bank Portal, Patient Portal, Live Donor Search, Emergency Blood Request, Admin Portal, and Login / Register. Patient Portal and Live Donor Search open the patient dashboard; Emergency Blood Request opens its request form there. Signed-out portal visitors are sent to login and returned to their selected destination after successful login. A signed-in user whose role does not match the selected portal sees an explanation; the patient-required flow offers **Switch to Patient Account**, which logs out the current session before returning to login. Roles are never converted automatically. The Admin Portal uses its separate admin sign-in.

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
8. Set `DONATION_ELIGIBILITY_MONTHS` to the preliminary workflow interval configured for your deployment (default `3`, allowed `1`–`24`). The default is not a universal medical rule; configure this value according to the applicable local guidance and use donor-specific verified dates where they apply. No automated interval grants final eligibility. Blood-stock freshness follows the server/database UTC calendar date and is not configurable by elapsed hours.
9. Run `npm install`, then `npm start`.
10. Open `http://localhost:3000`. Visit `http://localhost:3000/admin` and sign in with `ADMIN_USERNAME` and `ADMIN_PASSWORD`. `localhost` is only your own computer; this is not the public deployed website URL.

On startup, the server detects the portal schema, preserves its existing `recipient` accounts, adds the `patient` role used by the current app, and adapts donor/request fields without deleting records. It creates the date-availability, date-history, private screening, donation-history, eligibility-review, request-event, in-app notification, and (only if absent) blood-bank tables; it reuses existing bank, inventory, and audit records and adds missing compatible columns/indexes. The donation-coordination startup migration adds `blood_requests.target_donor_user_id` and its index only when absent, preserving existing request records. Donor profiles are backfilled without marking them available. Existing `donor_availability` rows are synchronized only when they contain an actual confirmation timestamp. Unknown confirmations stay **Unconfirmed**. The database user needs permission to create/alter tables and indexes. The local health endpoint is `http://localhost:3000/api/health`. Additive migration scripts are in `migrations/006_donation_inventory_coordination.sql` through `migrations/012_donor_availability_window.sql`; migration 010 adds eligibility review-request and donation-correction audit tables, migration 011 adds the in-app notification inbox without replacing existing notification records, and migration 012 adds a UTC start-time column/index for timed donor availability. Startup checks add the column/index and backfill existing confirmed availability if they are absent.

## Donor availability and emergency notifications

- Donors manage **My Donation Availability** at `/donar-dashboard.html` (or `/donor-dashboard.html`) with two choices: **Available** and **Not Available**. No start/end or date-schedule fields are shown. Availability changes are saved in MySQL and reload after refresh or sign-in. An Available confirmation is current for 42 hours, a server-managed interval; donors can confirm again to renew it. **Not Available** opens a private-reason form. Choosing **Recently donated blood** requires a date when none is on record and submits it for authorized verification. The server blocks availability during a pending report or verified cooldown; only a verified completed donation starts the cooldown. The configured interval defaults to three calendar months, is not universal medical guidance, and does not replace qualified staff review. Turning availability off immediately removes the donor from search. Medical eligibility remains separate from the Available/Not Available status.
- Donors can update their registered city, state, and area/locality in the **My Profile Location** section. This is profile-based location, not live GPS. The authenticated `PATCH /api/donor/profile-location` route updates the existing user and donor rows transactionally; no schema change is needed. Patients see the saved area when present and an explicit “Area not provided” label otherwise.
- Units are kept separate by workflow: patients enter **units required** on emergency requests, while blood-bank inventory results report stock units from the existing stock source. Donor availability does not represent a number of units available.
- Donors separately opt into patient search, display of their registered name/area, and in-app emergency matching. These preferences default off for existing donors. Emergency matching consent allows a donor to receive a matching urgent request even while marked Not Available; they must explicitly confirm that specific request, and this does not change their normal availability. Medical clearance, recorded restrictions, and cooldowns still apply, and temporarily unavailable donors are not matched. `/patient-dashboard.html` searches confirmed, opted-in donor records by blood group and normalized registered city/state across all neighbourhoods. Patients may also enter their area/locality; matching donors registered in that locality are prioritized while other valid city-wide matches remain available below them. Name and area appear only when identity-display consent is enabled; otherwise the result is shown without the donor's name or area. Phone numbers are never shown in live-search results; a phone is shared only after the donor accepts a specific request and separately consents to contact sharing. Email, health answers, and exact addresses are never returned in public search. No-match searches log aggregate exclusion counts (blood group/city, availability, confirmation, consent, cooldown, schedule, and medical eligibility) without donor identifiers and return those counts to the patient portal for a useful no-results explanation. The treating blood bank/medical team must confirm compatibility and eligibility.
- The Patient Portal shows the emergency-request form only after a successful live search finds no matching currently available donor; request submission rechecks that condition on the server. Patients must separately consent to secure processing and explicitly confirm the request before it is saved. If a matching donor is found, the portal keeps the emergency-request form unavailable and shows the donor's applicable medical-clearance warning.
- In-app alerts appear from the bell in the signed-in portal header. Notifications are stored in MySQL and polled while the portal is open; opening the panel marks its unread notifications as read. Donors can also open matched emergency requests in the Donor Portal; patients see donor responses under **Responses to your urgent requests** and in the request status list. A patient can select a donor who accepted and consented to contact sharing using **Select Donor for Coordination**. The selection is saved on the request and notifies that donor in-app; it is not clinical approval or a guarantee of donation. The patient can use **Confirm Blood Received** only after blood is actually received; this records the overall request as Fulfilled without changing donor response or coordinator status. Patient confirmation fields are added to the existing `blood_requests` table if absent.
- The Blood Bank Portal shows assigned-bank stock, stock alerts, unread emergency-request notifications, and active emergency requests scoped to that bank's assignment/service area. Authorized staff can update daily stock and record request coordination statuses. The staff review workspace separately provides donor screening and eligibility review. Cross-bank verification, staff mapping, and low-stock threshold configuration remain administrator-only.
- **Donor Health Screening** is separate from availability. It collects consented weight, blood pressure, medication/treatment, medical history, recent illness, and screening answers. New health responses are AES-256-GCM encrypted at rest; legacy questionnaire JSON remains readable under the same authorization checks. Donors and bank-mapped staff can view health answers; patient search and admin donor lists never include them. Screening review and final eligibility are separate professional workflow decisions; no self-reported value or universal threshold automatically approves/rejects a donor.
- **Donation history and eligibility:** Admins can record and verify completed donations from `/admin`. The configurable workflow interval defaults to three calendar months (`DONATION_ELIGIBILITY_MONTHS`, allowed `1`–`24`), with month-end dates clamped to the last calendar day. This default is not universal medical guidance. Configure it for applicable local policy; verified donor-specific dates take precedence. Recording a donation disables availability and records the next interval date. After that date, the donor must submit a new screening, receive authorized staff review and a separate eligible decision, then confirm availability again before matching. No automated interval or screening grants final eligibility.
- **Donor Eligibility Portal:** Donors can open `/donor-eligibility.html` after signing in to see their own verified donation history, recovery-period tracker, current workflow status, matching state, and review-request status. The progress indicator is informational and is not proof of medical recovery. Donors can request professional review after the configured interval and required screening; the admin dashboard can accept a request for staff review or reject it with instructions, but this action is not a medical eligibility decision. Only authorized staff using the existing screening/eligibility workflow can verify eligibility. Donation-date corrections are admin-only, require a reason, preserve an audit record, and return the donor to the required recovery/review flow.
- **Blood-bank inventory:** Authorized staff sign in through the existing login and are directed to the separate `/blood-bank-portal.html`; they must already be mapped to an active bank. The portal shows the assigned bank name, location, contact details and operating hours when recorded; accepts manually entered daily stock by blood group/component; and displays each last-update time and append-only update history. Stock date and update time are server-generated in UTC. Each update is audited and remains pending until an authorized admin verifies or rejects it. Patients can search staff-entered records by state, district, city, area/address, blood group, component, and bank name from the home page; only fresh, verified quantities are confirmed. A report is fresh only for the UTC calendar date of its update. Yesterday's report is stale even if fewer than 24 hours have elapsed; stale reports display **Outdated**, while fresh unverified reports display **Pending Verification** and are not presented to patients as current stock. The admin portal monitors banks that have or have not submitted today, pending/rejected stock verification, and last update timestamps. The portal reuses the existing inventory and history schema from additive migrations `007_daily_blood_stock.sql` and `009_stock_verification_review.sql`; missing blood-bank contact columns are added only when absent, without replacing rows. No sample stock is required. Confirm all reported stock directly with the bank.
- Patients can choose **Request Help** from a live result or submit through the existing request form. An authenticated patient account is required; the backend enforces the role, and the homepage explains when the visitor is logged out or signed in under another role. Request-storage consent is required before the API stores a request. A separate optional consent creates in-app alerts only for matching eligible donors and only for requests marked Urgent; without it, donor alerts are not created. Requests include blood group, component, units, hospital, location, urgency, needed-by time, and contact details. Submission shows the generated request ID and creates an in-app patient record; it is not automatically sent to or accepted by a hospital or government service. Urgent patient escalation adds a record to the matching LifeDrop service-area coordinator queue, not an external dispatch. Mapped bank staff can update the separate coordinator status. The overall request status becomes `Fulfilled` only after the patient explicitly confirms blood receipt; donor responses and coordinator status do not fulfill the request.
- A donor's dashboard notification shows a request ID, blood group, units, hospital name, approximate city/district, request time and response deadline. It does not show the patient's name, address or phone. Donors may **Accept Request**, select **Busy / Cannot Donate Now**, or **Decline Request**. Accepting requires a current matching availability and emergency-matching consent; contact details are shared only when the donor separately consents for that request.
- The donor dashboard keeps unread notifications and response history in MySQL. Responses distinguish **Pending**, **Accepted — Awaiting Contact**, **Busy**, **Declined**, and **No Response**; expired pending rows are recorded as expired without inventing a donor response time. Additional matching is attempted after all current pending/accepted responses are exhausted. The Patient Portal shows each submitted request's donor responses separately from request/coordinator status, using **Donor Confirmed**, **Donor Declined**, and **Waiting for Donor Response**; statuses refresh automatically and can be refreshed manually. Patients can select a consented, eligible donor for coordination; selection does not change overall request status. **Confirm Blood Received** is a separate, explicit patient action that updates the overall request to **Fulfilled** and leaves donor response and coordinator status unchanged. Donor names appear only after that donor explicitly consents to contact sharing for the individual request. A response does not guarantee attendance or donation.
- Administrators can use **Confirm Request** or **Mark Not Confirmed** for pending/confirmed blood requests in the Admin Portal. Both choices are saved in the existing `blood_requests.status`, logged as events, and notify the patient; the Patient Portal displays **Request Confirmed** or **Request Not Confirmed** separately from donor response and receipt. Confirming does not mark the request fulfilled or indicate donor confirmation. Patient status APIs cannot set either admin decision; only the patient receipt-confirmation action sets the request to **Fulfilled**. The `Not Confirmed` value is additive for the native schema and is stored directly in the existing VARCHAR status column in the portal database.
- The legacy external blood-centre search is separate from individual donors and LifeDrop's **Daily Blood Stock** reports. External e-RaktKosh figures are not verified by LifeDrop and must be confirmed directly with the centre. The `/api/blood-stock` and `/api/blood-banks/inventory` routes search LifeDrop staff-entered records and return only today's UTC stock reports from verified banks. LifeDrop does not submit patient requests to e-RaktKosh. Patients can open the [official e-RaktKosh portal](https://eraktkosh.mohfw.gov.in/eraktkoshPortal/) or contact the listed blood bank directly. For emergencies in India, call **112**.
- The response deadline is set when a request is submitted. Configure `DONOR_RESPONSE_WINDOW_MINUTES` in the private `.env` (default `120`; accepted range `1`–`1440`) before starting the server. An unanswered notification becomes **Expired** at its stored deadline; silence is not acceptance or refusal.
- **SMS, email, and browser push are not configured.** There is no service worker, Web Push/VAPID key pair, push subscription endpoint, or Firebase Cloud Messaging configuration/dependency in this project, so LifeDrop does not request browser notification permission or claim to send push alerts. Emergency and status events use the persisted in-app MySQL inbox with polling as a graceful fallback; donors must be signed in with the portal open to receive the updates. A valid phone number does not trigger SMS.
- **In-app notification bell:** Donor, patient, blood-bank staff, and admin pages show an authenticated notification inbox with unread count and per-item read controls. Opening the panel marks the account's unread items as read; ownership-scoped APIs prevent reading another account's notifications. Donor availability changes save a private confirmation notification in the same transaction as the MySQL update. Matching patient searches refresh every 15 seconds while open, and the admin dashboard refreshes its availability view every 15 seconds. Donors receive matched emergency request notices, eligibility reminders before/after the configured review date, a first-confirmation prompt after registration, and reconfirmation reminders after availability expires. Notification actions open the donor availability, eligibility, emergency request, or blood-bank update section as appropriate. Blood-bank staff receive daily-update reminders and confirmation of their own stock submissions; admins receive new emergency request, donor response, request status, notification failure, pending donor review, and missing daily bank stock alerts. Notifications are persisted in MySQL and restricted to their recipient; they do not include donor health answers or contact details. The UI uses polling rather than SSE/WebSockets. Notifications are in-app only and are not delivered while the application is closed.
- **Donor availability:** Sign in and open the Donor dashboard. Use **Confirm availability** in its header to jump to **My Donation Availability**, then select **Available to Donate** or **Not Available**. The page reports the saved status; live matching still requires current eligibility and the donor's sharing consent.
- Donor registration never confirms availability. New donor accounts start as **Not Available** with no confirmation timestamp; donors must explicitly set a status from the Donor Portal after registration.
- For urgent needs, contact the hospital or blood bank immediately. LifeDrop does not verify clinical eligibility, blood inventory, donor arrival or fulfillment.

Do not test emergency matching with requests that could contact real donors. SMS, email, browser push, and automated delivery retries are not configured; in-app request records remain in MySQL.

### Local end-to-end test checklist

Run these checks against a dedicated local test database and test accounts only. Start MySQL, keep the existing `.env` credentials private, then run `npm test`, `npm run check`, and `npm start`. Confirm `http://localhost:3000/api/health` reports a connected database before testing MySQL-backed pages. The server's startup schema checks are additive; back up the database before the first run after schema changes.

1. Open `/`, test every named top-navigation destination, then use a narrow browser viewport to open the Menu and visit the same links. Registration should be reached through **Login / Register** → **Create a donor or patient account**.
2. Register a dedicated donor account and sign in. Confirm the Donor Portal shows the name, blood group, registered location, donation date/review date, eligibility, and availability. A new account must remain unconfirmed until you explicitly choose **Available to Donate** or **Not Available**.
3. Open Donor Eligibility from navigation, check the preliminary status, next date, remaining waiting period, screening status, and reason. Submit health screening from the Donor Portal and confirm the eligibility page shows screening/review state but does not expose detailed answers. Use its **Manage availability** link to return to the donor portal.
4. Save **Available to Donate**, reload the page, and verify the timestamp/status persist. Choose **Not Available** and confirm its success message; then search as a patient and verify the donor is absent. A match requires all eligibility and donor-consent gates, so do not weaken them to make a demo search succeed.
5. For expiry testing, use only the dedicated donor test account: set general availability, then backdate that test donor's expiry with a uniquely scoped local SQL statement, replacing the username with that test account:

   ```sql
   UPDATE donors d
   JOIN users u ON u.user_id = d.user_id
   SET d.availability_expires_at = UTC_TIMESTAMP() - INTERVAL 1 MINUTE
   WHERE u.username = 'your_test_donor_username'
     AND u.role = 'donor'
     AND d.availability_mode = 'general'
     AND d.last_confirmed_at IS NOT NULL;
   ```

   Refresh the notification bell or wait for its polling interval, choose **Reconfirm availability**, and verify it opens the availability section. The expired donor must not appear in search.
6. Sign in with a dedicated patient test account, choose a blood group and registered city/state matching a fully reviewed test donor, and submit a search. Change the donor to Not Available in another tab; confirm the patient results update within the existing 15-second polling interval without a page reload. Search results must not expose phone, email, or health answers.
7. Sign in with an already authorized, active blood-bank staff test account. Confirm assigned bank location/contact details, submit a daily stock update, and verify the stored quantity/time and history. Sign in as an administrator to review it; only a fresh verified stock record should be shown as confirmed patient stock. Existing bank mapping and stock data must not be replaced.
8. To verify MySQL persistence, inspect only your test donor/user and stock rows in Workbench, sign out/in, and repeat the status/profile checks:

   ```sql
   SELECT u.user_id, u.username, u.role, u.full_name, u.blood_group,
          d.city, d.state, d.place, d.available, d.availability_status,
          d.last_confirmed_at, d.availability_expires_at
   FROM users u JOIN donors d ON d.user_id = u.user_id
   WHERE u.username = 'your_test_donor_username' AND u.role = 'donor';
   ```

   Do not delete or alter any pre-existing account, request, or stock row. If you create temporary rows, clean up only the exact rows created for this test after recording the verification result.

Schema changes are tracked under `migrations/`; the new additive donor-phone consent migration is [`migrations/013_donor_live_phone_consent.sql`](./migrations/013_donor_live_phone_consent.sql). Normal startup applies compatible schema checks automatically. Take a verified backup before applying schema changes.

### Availability and request API

- `GET /api/availability/status`, `POST /api/availability/status` — authenticated donor status. The donor portal submits Available/Not Available and sharing-consent choices; new Available confirmations receive a server-generated 42-hour current window. Legacy `selected_dates` API records remain supported and are not deleted. Phone sharing defaults to off and is independent of name/area consent.
- `PATCH /api/donor/profile-location` — authenticated donor-only update for the existing registered city, state, and area fields. The transaction updates the donor's own `users` and `donors` rows; no schema migration is needed. Patient results show this saved profile location, not live GPS.
- `GET /api/donors/search?state=Karnataka&city=Mysuru&area=Vijayanagar&blood_group=O%2B` — patient-session-only search by normalized registered city, optional state and area/locality, and an exact blood-group match. Area is a ranking preference, not a city-wide exclusion. Optional date, units, and urgency are validated; urgent searches prioritize donors who opted into emergency matching after the area preference. Search results require current availability, eligibility, and explicit search consent, and return a short-lived signed contact token rather than a donor ID. Donor contact remains private until the existing response and explicit sharing-consent workflow authorizes it. Search polls every 15 seconds while the patient dashboard is open.
- `GET /api/availability?city=Mysuru&area=Vijayanagar&state=Karnataka&blood_group=O%2B` — patient-only live availability list. Returns donors with a current Available confirmation, explicit search consent, a matching blood group and location, and no active cooldown or recorded medical restriction. Donors awaiting screening or authorized eligibility review are labeled **Available — Medical Clearance Pending** and are not cleared to donate or sent emergency requests. Only donors with current screening and authorized eligibility approval are labeled **Available — Medical Clearance Approved**. Name and area require identity consent, and phone requires separate phone-sharing consent. Area is an optional exact filter. The query uses donor profile values with fallbacks to the linked user profile, including legacy `users.area`. Expired confirmations, donors in cooldown, and donors with a recorded restriction are excluded. The Patient Portal selects the patient's registered blood group and loads results on entry, polls every 15 seconds, and offers manual refresh.
- `GET`, `POST /api/donor/health-screening` — donor-only private questionnaire.
- `GET /api/blood-bank/health-screenings`, `POST /api/blood-bank/health-screenings/:screeningId/review`, `GET/POST /api/blood-bank/inventory`, and `GET/POST /api/blood-bank/emergency-requests` — authenticated blood-bank users must also have an explicit `blood_bank_staff` mapping to an active bank. Health answers and staff inventory are never returned through patient search.
- `GET /api/notifications`, `POST /api/notifications/:notificationId/read` — donor/patient-only personal notification inbox and ownership-scoped read updates.
- `GET /api/admin/notifications`, `POST /api/admin/notifications/:notificationId/read` — admin-session-only alerts and read updates.
- `POST /api/blood-requests` — authenticated, transactional emergency request and donor notification creation. Requires explicit patient confirmation and rejects the request if a matching currently available donor exists for the selected blood group/location. Donor notifications/responses use `GET /api/donor/notifications` and `POST /api/donor/emergency-requests/:requestId/response`; patient request/status tracking uses `GET /api/my-blood-requests`, and urgent per-donor response summaries use `GET /api/my-emergency-responses`. Patient donor selection uses `POST /api/my-emergency-requests/:requestId/confirm-donor`; after actual receipt, `POST /api/blood-requests/:requestId/confirm-received` records the request as fulfilled. Generic patient status updates cannot mark a request fulfilled.
- `PATCH /api/admin/blood-requests/:requestId/confirm` — admin-session-only update of a pending emergency request to **Confirmed** or **Not Confirmed** (`{"status":"Confirmed"}` / `{"status":"Not Confirmed"}`). It persists to the existing request status column without changing donor responses, donor selection, coordinator status, or fulfillment. The Patient Portal displays **Request Confirmed by Administrator**, **Request Not Confirmed by Administrator**, or **Pending Administrator Confirmation** from that saved status.
- `GET /api/admin/dashboard` — protected admin endpoint with actual availability states, confirmation/expiry, saved dates, and request records. The request table shows donor response counts as **Donor Confirmed**, **Waiting for Donor Response**, or **Donor Declined**, separately from the overall request status. Search responses never include donor contact or health information.

Configure `HEALTH_DATA_ENCRYPTION_KEY` as exactly 64 hexadecimal characters generated from 32 random bytes. Keep it private and stable; losing or changing it makes newly encrypted health details unreadable. New health submissions fail with a clear service-unavailable response until it is configured. `DONATION_ELIGIBILITY_MONTHS` defaults to `3`; this is a workflow review interval, not medical guidance or automatic certification. Blood-stock freshness uses the server's UTC calendar date. Existing `DB_*`, `SESSION_SECRET`, `ADMIN_USERNAME`, and `ADMIN_PASSWORD` settings remain required as documented. `DONOR_RESPONSE_WINDOW_MINUTES` is optional (default 120).

Blood-bank roles alone do not grant bank access. A trusted database administrator must verify a staff account, ensure its `users.role` is `blood_bank`, then map it to one active bank in `blood_bank_staff`. The inspected local database currently has two bank records and no staff mappings or inventory rows. Do not assign accounts without organizational authorization. Only in-app request updates are stored by LifeDrop; no SMS or push notification is sent.

### Test and verify the feature

1. In VS Code, run `npm start` and open `http://localhost:3000`. Use a dedicated donor test account at `/login`, then open `/donar-dashboard.html`. In **My Donation Availability**, choose **Generally Available**, set the start/end times, opt into patient search and emergency responses as desired, and click **Available**. Verify status and timestamps, confirm that a future start is not matchable before it begins, refresh the page, and confirm that **Not Available** excludes the donor. The backend rejects a general availability confirmation if explicit valid dates/times are not supplied.
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

- The private dashboard is at `/admin`. It uses its own `admin_users` MySQL table, credentials, rate-limited login endpoint, and HTTP-only admin session cookie; donor/patient login cannot authenticate to it. Dashboard APIs require the separate admin session on the server, so hiding the page in the browser is not the security boundary. The Donor Management Availability column shows only `Available` or `Not Available`: `Available` requires explicit confirmation, a current general window or selected date, patient-search consent, cooldown clearance, and current screening plus qualified-staff eligibility approval. Eligibility status remains in its separate review column; rejecting or revoking availability requires a reason and is stored in the additive `admin_donor_availability_reviews` table. Admin confirmation does not grant medical eligibility; revocation immediately disables search matching. A NULL donor confirmation is treated as unknown, not as an explicit opt-out.
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
- Login is available at `/login`; the authenticated patient dashboard at `/patient-dashboard.html` provides the location/blood-group search and patient request flow. Donors can opt into search and display of their registered name and area; Available confirmations use a server-managed 42-hour current window. Search is restricted to logged-in patients and the API checks authorization.
- Donor search uses registered donor and user rows in MySQL, never sample donor records. The patient live-search form asks for blood group, city, and optional area/state. A donor appears only after confirming current availability, opting into search, and passing cooldown and current eligibility checks. Name and area are returned only with separate identity-display consent; phone is returned only with separate phone-sharing consent. Nonconsented details remain private. Exact home addresses are never exposed.
- Search uses MySQL availability, confirmation, and expiry fields; expired, unconfirmed, unavailable, cooldown-restricted, and ineligible donors are excluded. The donor portal does not ask for availability start/end dates; the server creates the 42-hour confirmation window. No donor latitude/longitude columns exist, so radius filters are approximate city/state matching, and no distance is calculated or fabricated.
- Contact the blood bank to confirm stock, compatibility, and donor availability. Donor listings are not blood-bank inventory, and the application does not determine medical compatibility or donor eligibility.
- Sessions are signed, HTTP-only, same-site cookies and last 12 hours. Without a configured `SESSION_SECRET`, development sessions are invalidated whenever the server restarts.
- Contact information is personal data. This demo does not include email verification, password reset, account/profile editing/deletion, or production-grade identity verification. Do not deploy publicly or enter real personal/medical information until those protections and applicable privacy requirements are addressed.

## Other demo features and limitations

- The existing external Blood Stocks section uses the Government of India's public blood-stock service, with state, district, component, and hospital/blood-centre filters; these reports are separate from LifeDrop staff-entered stock. No sample quantities are fabricated. The dedicated public LifeDrop stock search shows only today's verified stock from verified banks, while pending and historical submissions remain visible to authorized staff and admins.
- Individual donor listings are separate from blood-centre directory listings and are based only on donor-confirmed availability in this application's MySQL database.
- Responsive navigation, browser-validated forms, and illustrative camp listings. Camp-interest submissions collect name, phone, and email after explicit consent, and are stored in the `camp_registrations` MySQL table. A duplicate email cannot register for the same camp twice.
- Camp dates, venues, and organisers are illustrative demo content, not verified event listings. Saving interest does not confirm attendance, and the application does not notify camp organisers.
- Submitting a blood request requires an authenticated patient account; the backend rejects unauthenticated users and other roles. Viewing the shared request board requires login. Request details are stored in the existing `blood_requests` MySQL table and are retrieved from the API across devices. Authenticated users see a limited, non-identifying summary; patient reference, hospital, and contact details are not shown on the board. Only the request owner can update its status. Verification remains server-controlled and requests are not independently verified or sent to hospitals.
- The project provides no medical advice or emergency service. For an emergency, contact the patient's hospital and emergency medical services immediately; do not wait for a website response.
