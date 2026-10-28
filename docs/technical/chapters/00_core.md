# System Overview

## Purpose and scope

The Intute ERP is a role-based enterprise resource planning and CRM platform. It runs the whole business cycle for two companies that share one installation:

- **Compage**: the manufacturing business. It covers the sales pipeline, design, manufacturing and work orders, stores, dispatch, accounts, service and repair, and HR and attendance for Compage staff.
- **Intute AI (IA)**: a separate people-and-orders space with its own roles (`ia_employee`, `ia_hr`). It covers IA activities, IA orders, IA invoices and payslips.

This document describes the system as implemented in source code and in the live database schema on the date shown on the cover. It covers the backend API, the PostgreSQL data model, the web CRM, the PDI mobile app, the integrations, the background jobs, security, and deployment.

## Applications

| Application | Repository folder | Technology | Role |
|---|---|---|---|
| ERP Backend API | `CRM_BACKEND` | Node.js 22, Express 4, PostgreSQL, Redis, Socket.IO | The REST API and real-time hub used by all clients |
| Web CRM | `CRM` | React 19, Vite 6, Redux Toolkit, React Router 7, Tailwind CSS | Browser front end for all 14 roles |
| PDI Mobile App | `pdi-erp-app` | React Native 0.87, React Navigation, AsyncStorage | On-site Pre-Dispatch Inspection capture for production technicians |

## Technology stack

| Layer | Technology | Notes |
|---|---|---|
| Runtime | Node.js 22.17 (Docker `node:22.17.0-alpine`) | Pinned because nodemailer 10 and sanitize-html need Node 20 or later |
| Web framework | Express 4.19 | `helmet`, `cors`, `cookie-parser`, 40 MB JSON body limit |
| Database | PostgreSQL on AWS RDS | Accessed through `pg` Pool (max 20 connections, TLS, 10 s connect timeout) |
| Cache | Redis 4 client | `REDIS_URL`; custom `delPattern()` helper for wildcard invalidation |
| Real-time | Socket.IO 4.8 | Path `/socket.io`; CORS restricted to `FRONTEND_URL` |
| Authentication | JWT (`jsonwebtoken`) + `bcryptjs` | 1 h token for the web, 12 h for the mobile app |
| Validation | `express-validator`, `sanitize-html` | Per-route validators |
| Documents | PDFKit 0.17, `svg-to-pdfkit`, `sharp` | Roboto fonts in `assets/fonts` |
| Email | Nodemailer 10 (Gmail SMTP) | HTML templates in `utils/emailTemplates.js` |
| File storage | Google Drive API (service account) | Photos, invoices, attachments |
| Scheduling | `node-cron` 4 | All jobs run on the Asia/Kolkata time zone |
| Logging | Winston 3 | `logs/error.log`, `logs/combined.log`, console |
| Uploads | `multer` 2 | In-memory storage, then sent to Drive |
| Testing | Jest 29 + Supertest 7 | `tests/` (about 28 suites, mostly PDI) |
| Front end | React 19, Redux Toolkit 2, Axios, socket.io-client, Tailwind 3, Bootstrap 5, lucide-react, react-select, xlsx, qrcode | Built with Vite |
| Mobile | React Native 0.87, @react-navigation/native-stack, AsyncStorage, react-native-image-crop-picker, react-native-blob-util | Android-first field app |

# Architecture

## Logical architecture

All three clients talk to one Express process. That process owns all business rules and is the only component that reaches the database.

```
 +-------------------+     +---------------------+
 |  Web CRM (React)  |     | PDI Mobile App (RN) |
 +---------+---------+     +----------+----------+
           | HTTPS REST + WebSocket   | HTTPS REST (X-App-Version)
           v                          v
 +------------------------------------------------+
 |  nginx reverse proxy (AWS EC2)                 |
 +------------------------------------------------+
 |  Express API (Docker: intuteai/erp-backend)    |
 |  helmet > cors > cookieParser > json(40mb)     |
 |  > rateLimit > req.io > routers > errorHandler |
 |  routes -> controllers -> models (SQL)         |
 |  Socket.IO server   |   node-cron jobs         |
 +------+----------------+---------------+--------+
        |                |               |
        v                v               v
  PostgreSQL (RDS)    Redis cache    Google Drive / Gmail SMTP
```

## Backend layering

The code follows a strict three-layer layout, and each business domain gets the same folder name in every layer:

- **routes/<domain>/** declares the endpoints and wires up middleware: `authenticateToken`, `checkPermission(module, action)`, validators, `multer`, and role guards.
- **controllers/<domain>/** handles HTTP. It parses requests, applies business rules, emits Socket.IO events, and maps errors to status codes.
- **models/<domain>/** holds the SQL access through the shared `pg` pool. Multi-step writes run inside `BEGIN/COMMIT` transactions on a single client.

The domain folders are `core`, `sales`, `manufacturing`, `invoicing`, `dispatch`, `hr`, `operations` and `service`. A separate `chatbot/` tree has its own routes, services, models, and intent and formatter utilities.

## Request pipeline

These steps run for every request, in order (see `server.js`):

1. `app.set('trust proxy', 1)` makes `req.ip` the real client address behind nginx, so the IP-keyed rate limiter works.
2. `helmet()` sets the security headers.
3. `cors({ origin: FRONTEND_URL, credentials: true })`.
4. `cookieParser()` and `express.json({ limit: '40mb' })`. The large limit exists because the PDI generator sends base64 photos.
5. The global rate limiter (`middleware/rateLimit.js`) allows 5,000 requests per 10 minutes, keyed by user id when known and by IP otherwise. When exceeded it returns `429` with `RATE_LIMIT_EXCEEDED`. The inventory router adds its own tighter limit of 100 requests per 15 minutes.
6. `req.io` is attached so controllers can emit real-time events.
7. The domain routers run.
8. The global `errorHandler` returns `{ error, code }` with `err.status` or 500.

## Startup sequence

`initializeServer()` does the following:

1. Runs `SELECT 1` to check the database connection.
2. Recovers PDI lots stuck in the `Finalizing` state (left there if a previous process died mid-render) by setting them back to `In Progress`.
3. Connects Redis.
4. Starts listening on `PORT` (default 8000).

The cron jobs are loaded only when `server.js` is the main module. Tests can `require('../server')` for Supertest without binding a port or starting timers. On `SIGTERM` the HTTP server closes gracefully.

## Real-time messaging

A single Socket.IO server is created in `server.js` and exposed as `app.get('io')` and as `req.io`. Controllers broadcast mutation events, such as stock updates after an order dispatches and record changes for enquiries, queries and orders, so open dashboards refresh live. The web client connects with `auth: { token }`, uses WebSocket with polling fallback, and retries up to 5 times with a 2 s delay. Its connection status is kept in Redux (`socketStatus`).

## Caching strategy

Redis caches read-heavy, expensive list queries, such as part drawings, inventory, queries and enquiry templates. Keys are built from the query parameters (limit, offset, search, user and role). Entries normally expire after 300 s, and every write invalidates them through `redisClient.delPattern()`. A Redis outage is logged but does not stop startup.

# Security and Access Control

## Authentication

- `POST /api/auth/login` checks the email and bcrypt password hash. It returns `{ role, token, name, user_id }`. The role string comes from `ROLE_MAP` in `controllers/auth.controller.js`, keyed by `role_id`.
- The JWT payload carries `user_id`. Tokens last **1 hour** by default. Requests that send an `X-App-Version` header (the PDI mobile app does) get a **12-hour** token, so a long on-site inspection is not interrupted.
- `authenticateToken` (`middleware/auth.js`) reads `Authorization: Bearer <token>`, verifies it, and **re-reads the user and role from the database on every request**. A role change therefore takes effect immediately.
- Error contract: `401 AUTH_NO_TOKEN`; `403 AUTH_INVALID_TOKEN`, `AUTH_INVALID_USER` or `AUTH_INVALID_TOKEN` for a bad payload. If the database lookup fails, the response is `503 AUTH_UNAVAILABLE`. The clients do not log the user out on a 503.

## Authorisation model

The backend enforces access in three ways:

1. **Permission matrix (RBAC).** `checkPermission(module, action)` looks up the `permissions` table (`role_id`, `module`, `can_read`, `can_write`, `can_delete`); `can_create` maps to `can_write`. A denied request gets `403 PERM_DENIED`. `hasPermission()` offers the same check to model code, for example the rule for editing a finalized PDI report.
2. **Role allow-lists.** `requirePdiAccess` (`middleware/pdiAccess.js`) admits only `admin` and `production`. It accepts either `roles.role_name` or the `ROLE_MAP` name, and is deliberately independent of the permissions table. The PDI template administration routes are admin-only (`role_id === 1`). Activities are limited to role ids 9, 10, 11 and 12 (Compage and IA people roles).
3. **Authenticated-only routes.** Some document generators and utility routes need only a valid token. These are listed as "Any authenticated" in the API catalogue.

The web CRM adds a client-side gate on top: `routeConfig.jsx` gives every route an `allowedRoles` list, and `App.jsx` redirects users to their role dashboard when they open a path their role does not allow. This gate only improves navigation. The API remains the source of truth.

## Roles

| role_id | DB role_name | Client role key | Company | Landing route |
|---|---|---|---|---|
| 1 | Admin | admin | Compage | /admin-dashboard |
| 2 | Customer | customer | External | /customer-dashboard |
| 3 | Sales | sales | Compage | /sales-dashboard |
| 4 | Design | design | Compage | /design-dashboard |
| 5 | Production | production | Compage | /production-dashboard |
| 6 | store | store | Compage | /store-dashboard |
| 7 | Dispatch | dispatch | Compage | /dispatch-dashboard |
| 8 | Accounts | accounts | Compage | /accounts-dashboard |
| 9 | employee | employee | Compage | /employee-dashboard |
| 10 | hr | hr | Compage | /hr-dashboard |
| 11 | IA_employee | ia_employee | Intute AI | /ia-employee-dashboard |
| 12 | IA_HR | ia_hr | Intute AI | /ia-hr-dashboard |
| 13 | service_repair | service_repair | Compage | /service-repair-dashboard |
| 15 | representative | representative | Compage (field sales) | /representative-dashboard |

## Other protections

- `helmet` sets the security headers. CORS allows only `FRONTEND_URL` (credentials enabled).
- All SQL uses parameterised queries (`$1..$n`).
- Rich text is cleaned with `sanitize-html`.
- Secrets are read from `.env` and `secrets/` (the Google service account). Both are kept out of git, but the Dockerfile copies `.env` into the image.
- Rate limiting is global and per router.
- The logs keep error stacks, while client responses carry only a message and a code.

# Deployment and Operations

## Environments and configuration

| Variable | Purpose |
|---|---|
| DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME | PostgreSQL (AWS RDS, TLS) |
| JWT_SECRET | JWT signing key |
| REDIS_URL | Redis connection (default `redis://localhost:6379`) |
| EMAIL_USER, EMAIL_PASS | Gmail SMTP sender (app password) |
| FRONTEND_URL | CORS and Socket.IO origin |
| PORT | HTTP port (default 8000) |
| GOOGLE_SERVICE_ACCOUNT_PATH, GOOGLE_DRIVE_FOLDER_ID | Google Drive uploads |
| MANAGER_DAILY_REPORT_EMAIL | Recipient of daily task and attendance digests |
| VITE_BACKEND_URL (web) | API and Socket.IO base URL for the React build |

## Backend build and release

- **Container:** `Dockerfile` starts from `node:22.17.0-alpine`, runs `npm ci --omit=dev`, copies the source and `.env`, exposes 8000, and starts with `node server.js`.
- **CI/CD:** `.github/workflows/backend-erp.yml` runs **only on manual trigger** (`workflow_dispatch`). It builds and pushes `intuteai/erp-backend:latest` to Docker Hub, then connects to the EC2 host over SSH and runs `docker-compose down`, removes the old image, runs `docker-compose pull erp-backend`, and runs `docker-compose up -d`.
- Only one container runs at a time; the old one stops before the new one starts. This is why the PDI startup recovery can safely reset lots stuck in `Finalizing`.
- **Web CRM:** every push to `main` triggers a GitHub Actions workflow in the CRM repository. It runs the Vite build to `dist/`, syncs the output to S3 and serves it through CloudFront. `railway.json` and the Railway dev proxy in `vite.config.js` are left over from the old hosting.
- **PDI mobile app:** a plain React Native (non-Expo) Android build, signed with Gradle using `keystore.properties` and distributed as an APK.

## Database migrations

Schema changes are plain Node scripts in `scripts/migrations/`, named by date and run by hand against the database. Recent examples are PDI report content, PDI templates, the representative role and its seed user, PDI report batches and their shared fields, PDI report revisions, the AutoNXT spec-display fix, and PDI batch indexes.

## Logging and monitoring

Winston writes JSON lines with timestamps to `logs/error.log` (errors only), `logs/combined.log` (all levels) and the console. Rate-limit hits, logins, cron runs, PDI recovery and pool errors are all logged.

## Development workflow

```
npm install        # install dependencies
npm run dev        # nodemon auto-reload
npm start          # production start
npm test           # Jest + Supertest
npm run lint       # ESLint
npm run format     # Prettier
```

Feature work is designed and planned in `docs/superpowers/specs` and `docs/superpowers/plans`; that folder holds about 22 design specs and plans, most of them for the PDI subsystem. Test files (`*.test.js`) match a `.gitignore` rule even though they are tracked, so a new test file must be added with `git add -f`.
