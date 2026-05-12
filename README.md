# Intute ERP — Backend API

A full-featured Enterprise Resource Planning (ERP) and CRM backend built with Node.js and Express. Covers the complete business lifecycle: sales pipeline, manufacturing, invoicing, dispatch, HR, operations, and after-sales service/repair — with real-time updates, automated email reports, PDF generation, and an AI order chatbot.

---

## Table of Contents

- [Tech Stack](#tech-stack)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [Project Structure](#project-structure)
- [API Modules](#api-modules)
  - [Authentication](#authentication----apiauth)
  - [Core](#core)
  - [Sales](#sales)
  - [Manufacturing](#manufacturing)
  - [Invoicing](#invoicing)
  - [Dispatch](#dispatch)
  - [HR](#hr)
  - [Operations](#operations)
  - [Service](#service)
  - [Chatbot](#chatbot)
- [Order Status Lifecycle](#order-status-lifecycle)
- [Authentication & Authorization](#authentication--authorization)
- [Cron Jobs](#cron-jobs)
- [Caching](#caching)
- [PDF Generation](#pdf-generation)
- [Email Service](#email-service)
- [Real-time (Socket.IO)](#real-time-socketio)
- [Logging](#logging)
- [Scripts](#scripts)

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js + Express.js |
| Database | PostgreSQL (`pg`) |
| Cache | Redis (`redis@4`) |
| Real-time | Socket.IO |
| Authentication | JWT + bcrypt |
| Email | Nodemailer (Gmail SMTP) |
| PDF | PDFKit |
| File Storage | Google Drive API (service account) |
| Scheduling | node-cron |
| Logging | Winston |
| Security | Helmet, express-rate-limit, CORS |
| Validation | express-validator |
| Testing | Jest + Supertest |
| Deployment | AWS |

---

## Getting Started

### Prerequisites

- Node.js 18+
- PostgreSQL
- Redis

### Installation

```bash
git clone <repo-url>
cd CRM_BACKEND
npm install
```

### Development

```bash
npm run dev
```

### Production

```bash
npm start
```

---

## Environment Variables

Create a `.env` file in the project root:

```env
# Database
DB_HOST=your-db-host
DB_PORT=5432
DB_USER=your-db-user
DB_PASSWORD=your-db-password
DB_NAME=your-db-name

# Auth
JWT_SECRET=your_jwt_secret_minimum_32_chars

# Redis
REDIS_URL=redis://127.0.0.1:6379

# Email (Gmail SMTP)
EMAIL_USER=your@gmail.com
EMAIL_PASS=your-app-password

# Frontend
FRONTEND_URL=http://localhost:5173
PORT=8000

# Google Drive
GOOGLE_SERVICE_ACCOUNT_PATH=secrets/drive-sa.json
GOOGLE_DRIVE_FOLDER_ID=your-folder-id

# Reports
MANAGER_DAILY_REPORT_EMAIL=manager@example.com
```

---

## Project Structure

```
CRM_BACKEND/
├── server.js                   # App entry point
├── config/
│   ├── db.js                   # PostgreSQL pool
│   ├── redis.js                # Redis client
│   └── socket.js               # Socket.IO initialisation
├── routes/
│   ├── auth.js
│   ├── core/                   # customers, orders, inventory, stock, users, reports, dashboard
│   ├── sales/                  # enquiry, quotation, proforma, price-list
│   ├── manufacturing/          # bom, parts, part-drawings, motor-recipes, process
│   ├── invoicing/              # customer-invoices, purchase-invoices
│   ├── dispatch/               # dispatch-tracking, delivery-challan, ia-orders
│   ├── hr/                     # attendance, employee-details, payslip
│   ├── operations/             # queries, activities, problems, pdi
│   └── service/                # service-repair records + photo uploads
├── controllers/                # Business logic (mirrors routes/)
├── models/                     # Database queries (mirrors routes/)
├── middleware/
│   ├── auth.js                 # JWT authentication + RBAC
│   ├── error.js                # Global error handler
│   ├── rateLimit.js            # Request rate limiter
│   └── validate.js             # Input validation rules
├── jobs/
│   ├── daily-due-reminders.js  # 11:00 AM — task due-tomorrow reminders
│   ├── daily-task-summaries.js # 9:00 AM & 6:30 PM — team task reports
│   └── attendanceSummary.js    # 10:00 AM & 7:30 PM — attendance reports
├── services/
│   ├── email.js                # Nodemailer wrapper
│   └── googleDrive.js          # Google Drive upload
├── chatbot/                    # AI chatbots (orders, customers, invoices, inventory, stock, BOM)
├── utils/
│   ├── logger.js               # Winston logger
│   └── emailTemplates.js       # HTML email template generators
├── assets/
│   └── fonts/                  # Roboto fonts for PDF generation
├── secrets/
│   └── drive-sa.json           # Google service account (gitignored)
├── tests/
│   └── auth.test.js            # Jest + Supertest test suite
├── Dockerfile                  # Docker container image
└── logs/
    ├── error.log
    └── combined.log
```

---

## API Modules

### Authentication — `/api/auth`

| Method | Endpoint | Description |
|---|---|---|
| POST | `/login` | Login with email + password, returns JWT |
| GET | `/verify-token` | Verify JWT validity |
| GET | `/user` | Get current authenticated user |
| POST | `/logout` | Logout (clears cookie) |
| PUT | `/update-password` | Update user password |

---

### Core

| Prefix | Description |
|---|---|
| `/api/customers` | Customer CRUD |
| `/api/orders` | Order management (see [Order Status Lifecycle](#order-status-lifecycle)) |
| `/api/inventory` | Inventory tracking |
| `/api/stock` | Stock management |
| `/api/users` | User management |
| `/api/reports` | Business reports |
| `/api/dashboard` | Dashboard summary data |

#### `/api/orders` key endpoints

| Method | Endpoint | Description |
|---|---|---|
| GET | `/` | List orders (paginated, role-scoped) |
| POST | `/` | Create order |
| PUT | `/:id/update` | Update order fields, status, payment status, status reason |
| POST | `/:id/cancel` | Cancel order (enforces goods-returned gate for delivered orders) |
| GET | `/export` | Download all orders as CSV (includes Status Reason column) |
| POST | `/chatbot` | Natural language order queries |

---

### Sales

| Prefix | Description |
|---|---|
| `/api/enquiry` | Enquiry pipeline (CRUD, assignees, comments, stage transitions, follow-up, mark-done) |
| `/api/enquiry-requirements` | Linked requirements per enquiry |
| `/api/quotation` | Quotation generation and PDF export |
| `/api/proforma` | Proforma invoice generation and PDF export |
| `/api/purchase-order` | Purchase order generation and PDF export |
| `/api/price-list` | Product price list management |

---

### Manufacturing

| Prefix | Description |
|---|---|
| `/api/bom` | Bill of Materials (CRUD) |
| `/api/parts` | Part master data |
| `/api/part-drawings` | Part drawing documents |
| `/api/part-drawings-raw` | Raw material drawings |
| `/api/motor-recipes` | Motor formulation recipes |
| `/api/process` | Manufacturing process definitions |

---

### Invoicing

| Prefix | Description |
|---|---|
| `/api/customer-invoices` | Customer invoice generation and management |
| `/api/purchase-invoices` | Purchase (vendor) invoice management |

---

### Dispatch

| Prefix | Description |
|---|---|
| `/api/dispatch-tracking` | Shipment tracking (status synced bidirectionally with orders via DB trigger) |
| `/api/delivery-challan` | Delivery challan generation and PDF export |
| `/api/ia-orders` | Inter-company / IA orders |

---

### HR

| Prefix | Description |
|---|---|
| `/api/attendance` | Employee attendance (check-in / check-out) |
| `/api/employee-details` | Employee profiles and details |
| `/api/payslip` | Payslip generation and PDF export |

---

### Operations

| Prefix | Description |
|---|---|
| `/api/activities` | Task and activity management |
| `/api/queries` | Customer and internal queries |
| `/api/problems` | Issue / problem tracking |
| `/api/pdi` | Pre-dispatch inspection records |

---

### Service

| Prefix | Description |
|---|---|
| `/api/service-repair` | Service and repair record management with multi-photo uploads per stage |

#### `/api/service-repair` endpoints

| Method | Endpoint | Description |
|---|---|---|
| GET | `/` | List all records (paginated: `limit`, `offset`) |
| GET | `/:id` | Get a single record |
| POST | `/` | Create a new record |
| PUT | `/:id` | Update record fields |
| DELETE | `/:id` | Delete a record |
| POST | `/:id/chalan-photo` | Append a chalan / received photo (image or PDF, max 10 MB) |
| POST | `/:id/delivery-challan-photo` | Append a delivery challan photo (image or PDF, max 10 MB) |
| POST | `/:id/fault-photo` | Append a fault / query photo |
| POST | `/:id/actual-issue-photo` | Append an actual issue photo |
| POST | `/:id/repaired-photo` | Append a repaired-item photo |
| DELETE | `/:id/photo` | Remove a photo URL from any array field (`{ field, url }` in body) |

**Photo array fields:** `chalan_photos_urls`, `delivery_challan_photos_urls`, `fault_photos_urls`, `actual_issue_photos_urls`, `repaired_photos_urls`

All photo uploads are stored in Google Drive. Allowed types: JPEG, PNG, WebP, GIF, PDF (challan fields only).

All endpoints require the `ServiceRepair` permission (`can_read` / `can_write` / `can_delete`).

---

### Chatbot

All chatbot endpoints accept `POST` with `{ "message": "<natural language query>" }` and require authentication.

| Endpoint | Domain |
|---|---|
| `POST /api/orders/chatbot` | Order queries |
| `POST /api/customer-invoices/chatbot` | Customer invoice queries |
| `POST /api/customers/chatbot` | Customer queries |
| `POST /api/inventory/chatbot` | Inventory queries |
| `POST /api/stock/chatbot` | Raw material / stock queries |
| `POST /api/bom/chatbot` | Bill of Materials queries |

**Supported order chatbot commands:**
`show all orders`, `show recent orders`, `show pending orders`, `show processing orders`, `show testing orders`, `show ready for shipment orders`, `show shipped orders`, `show partially delivered orders`, `show delivered orders`, `show cancelled orders`, `count orders by status`

---

## Order Status Lifecycle

The `order_status` PostgreSQL enum defines the canonical status progression:

```
Pending → Processing → Testing → Ready for Shipment → Shipped → Partially Delivered → Delivered
                                                               ↘ (can skip to Delivered directly)
```

| Status | Rank | Notes |
|---|---|---|
| Pending | 0 | Initial state on creation |
| Processing | 1 | |
| Testing | 2 | |
| Ready for Shipment | 3 | |
| Shipped | 4 | **Dispatch threshold** — inventory deducted, holds released |
| Partially Delivered | 5 | `status_reason` required |
| Delivered | 6 | Final state |
| Cancelled | — | Terminal side-exit via `POST /:id/cancel` |

**Inventory deduction** fires the first time an order crosses rank ≥ 4 (Shipped), regardless of whether intermediate statuses were used. This handles direct jumps like Testing → Delivered.

**`status_reason`** (`text`, nullable) stores a free-text explanation for the current status. Required when setting `Partially Delivered`. Always editable independently of status.

**`payment_status`** (`Pending` | `Paid`) is editable at any lifecycle stage, including after delivery.

**Status transitions** are forward-only (no downgrade). The `dispatch_tracking_details` table stays in sync via a bidirectional PostgreSQL trigger (`sync_orders_status` ↔ `sync_dispatch_status`) with a loop guard.

---

## Authentication & Authorization

All protected routes use **JWT Bearer tokens** (also accepted via HTTP-only cookie).

- Tokens are verified in `middleware/auth.js`
- User record is validated against the database on every request
- **Role-based access control (RBAC)** is enforced at the module+action level via a `permissions` table

**Supported roles:** `admin`, `sales`, `design`, `production`, `store`, `dispatch`, `accounts`, `employee`, `hr`, `ia_employee`, `ia_hr`, `customer`, `service_repair`

---

## Cron Jobs

All jobs run in **Asia/Kolkata (IST)** timezone via `node-cron`.

| Job | Schedule | Description |
|---|---|---|
| Due-tomorrow reminders | 11:00 AM daily | Emails each assignee their tasks due the next day |
| Morning task summary | 9:00 AM Mon–Sat | Sends pending task report to team + manager |
| Evening task summary | 6:30 PM Mon–Sat | Sends pending + completed-today report to team + manager |
| Attendance check-in | 10:00 AM Mon–Sat | Emails manager a check-in summary for the day |
| Attendance check-out | 7:30 PM Mon–Sat | Emails manager a check-out summary with hours worked |

---

## Caching

Redis is used to cache frequently read, expensive queries.

- **Part drawings** — cached per `(limit, offset, search)` combination
- **Inventory** — cached per `(limit, offset)` combination
- **Queries** — cached per `(userId, roleId, limit, offset)` combination
- Cache is invalidated on write operations and cleared on server startup
- TTL: 300 seconds (5 minutes) per entry
- Custom `redis.delPattern(pattern)` helper for wildcard key invalidation

---

## PDF Generation

PDFs are generated server-side using **PDFKit** with custom Roboto fonts from `assets/fonts/`.

Documents that support PDF export:

| Document | Route |
|---|---|
| Quotation | `POST /api/quotation/generate` |
| Proforma Invoice | `POST /api/proforma/generate` |
| Purchase Order | `POST /api/purchase-order/generate` |
| Delivery Challan | `POST /api/delivery-challan/generate` |
| Payslip | `POST /api/payslip/generate` |

Generated PDFs can optionally be uploaded to Google Drive via the `googleDrive` service.

---

## Email Service

Emails are sent via **Gmail SMTP** using Nodemailer (`services/email.js`).

```js
await sendEmail({ to, subject, text, html });
```

- Validates recipient, subject, and body before sending
- Logs message ID on success, error on failure
- Automated reports use HTML templates from `utils/emailTemplates.js`:
  - `generateDueTomorrowReminderHtml()`
  - `generateDailyTaskSummaryHtml()`
  - `generateAttendanceCheckInSummaryHtml()`
  - `generateAttendanceCheckOutSummaryHtml()`

---

## Real-time (Socket.IO)

A Socket.IO server runs alongside the HTTP server.

- CORS-restricted to `FRONTEND_URL`
- `io` is accessible on `app.get('io')` and injected into every request as `req.io`
- Controllers emit events on data mutations for live UI updates
- Stock update events (`stockUpdate`) broadcast after inventory deduction on order dispatch

---

## Logging

Winston logs are written to:

| File | Content |
|---|---|
| `logs/error.log` | Errors only |
| `logs/combined.log` | All log levels |

Console output is enabled in all environments. All entries are JSON-formatted with timestamps.

```json
{"level":"info","message":"Server running on port 8000","timestamp":"2026-04-24T11:40:31.498Z"}
```

---

## Scripts

```bash
npm run dev      # Start with nodemon (auto-reload)
npm start        # Start in production
npm test         # Run Jest test suite
npm run lint     # ESLint check
npm run format   # Prettier format
```

---

## License

Private — Intute AI. All rights reserved.
