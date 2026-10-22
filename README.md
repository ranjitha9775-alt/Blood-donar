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

On startup, the server creates the `camp_registrations`, `users`, `admin_users`, and `blood_requests` tables, and creates or migrates the `donors` and `patients` tables. It adds a unique username column to `users` and a nullable user link to `patients`; existing accounts without a username can continue to sign in using their email, while new registrations use usernames. Older patient request rows remain visible separately in the dashboard. The database user needs permission to create/alter tables and create indexes. The local health endpoint is `http://localhost:3000/api/health`.

## Deploy online with Railway

LifeDrop serves its frontend and API from one Express service. The frontend uses relative API URLs, so it does not need a separate API base URL or CORS configuration when deployed this way.

1. Confirm that the GitHub repository `ranjitha9775-alt/Blood-donar` contains the project files (including `server.js`, `package.json`, `package-lock.json`, `admin.html`, `admin.js`, and `index.html`). Commit and push updates from your project folder:

   ```powershell
   git add .gitignore .env.example README.md package.json package-lock.json server.js app.js login.js login.html admin.html admin.js index.html assets
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

- The private dashboard is at `/admin`. It uses its own `admin_users` MySQL table, credentials, rate-limited login endpoint, and HTTP-only admin session cookie; donor/patient login cannot authenticate to it. Dashboard APIs require the separate admin session on the server, so hiding the page in the browser is not the security boundary.
- Only the admin dashboard shows private account information. Its separate Donor Management and Patient Management sections load real registrations from the existing `users`, `donors`, `patients`, and `blood_requests` tables. Each section has a total and live search/filter controls; donor availability is derived from current consented listings, and patient fields include required blood group, location, urgency, and request status. The patient-request total includes registration requests in `patients` and later requests in `blood_requests`; legacy request rows remain visible under Patient Management. New registrations appear on the next 15-second refresh, with a manual refresh option.
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
- Login is available at `/login`. After login, the live availability search automatically checks opted-in donors in the account's registered city and state. Donor accounts can explicitly opt in to display their contact details for 24 hours or turn their listing off from the login page. Users can change the city/state or filter by blood group. This is a city/state match, not GPS-based distance; live search is visible only to logged-in accounts, and the API also enforces authentication.
- A donor appears in search only after opting in to current availability **and** explicitly agreeing to display their name, blood group, city/state/area, and phone number.
- Availability listings automatically expire after 24 hours. Search is limited to a city and state, with an optional blood-group filter. Donor registration and availability are stored in MySQL.
- Contact the donor to confirm availability. Donor listings are not blood-bank inventory, and the application does not determine medical compatibility or donor eligibility.
- Sessions are signed, HTTP-only, same-site cookies and last 12 hours. Without a configured `SESSION_SECRET`, development sessions are invalidated whenever the server restarts.
- Contact information is personal data. This demo does not include email verification, password reset, account/profile editing/deletion, or production-grade identity verification. Do not deploy publicly or enter real personal/medical information until those protections and applicable privacy requirements are addressed.

## Other demo features and limitations

- The Blood Stocks section uses the Government of India's public blood-stock service. Users select a state, district, component, and hospital/blood centre; results show reported units by blood group without hospital name, contact, or address details. The API's centre directory and inventory feed are the source; no sample quantities are fabricated.
- Individual donor listings are separate from blood-centre directory listings and are based only on donor-confirmed availability in this application's MySQL database.
- Responsive navigation, browser-validated forms, and illustrative camp listings. Camp-interest submissions collect name, phone, and email after explicit consent, and are stored in the `camp_registrations` MySQL table. A duplicate email cannot register for the same camp twice.
- Camp dates, venues, and organisers are illustrative demo content, not verified event listings. Saving interest does not confirm attendance, and the application does not notify camp organisers.
- Submitting a blood request and viewing the shared request board require login. Request details are stored in the `blood_requests` MySQL table and are retrieved from the API across devices. Authenticated users see a limited, non-identifying summary; patient reference, hospital, and contact details are not shown on the board. Only the request owner can update its status. Verification remains server-controlled and requests are not independently verified or sent to hospitals.
- The project provides no medical advice or emergency service. For an emergency, contact the patient's hospital and emergency medical services immediately; do not wait for a website response.
