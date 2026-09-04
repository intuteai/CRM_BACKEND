# PDI Reports Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the PDI Generator a persistence layer — create/save/resume/finalize/list/delete a Pre-Dispatch Inspection report, backed by Postgres and Google Drive — so the mobile app (and, later, the migrated web form) has a real backend to build against, per `docs/superpowers/specs/2026-09-04-pdi-mobile-app-persistence-design.md`.

**Architecture:** A new `PdiReports` model/controller/route trio, mounted at `/api/pdi/reports`, sits alongside the existing legacy `pdi.js` model/controller/routes (mounted at `/api/pdi`) without touching them — the legacy flat CRUD keeps serving the current "PDI Records" web dashboard unchanged. Four new nullable/defaulted columns (`data`, `photos`, `template_id`, `drive_file_id`) are added to the existing `pre_dispatch_inspection_reports` table. Finalizing a report reuses the existing `PDIGenerator.generate()` PDF renderer and the existing `services/googleDrive.js` best-effort backup pattern (same shape as `models/hr/invoiceRecords.js`).

**Tech Stack:** Express, PostgreSQL (`pg`), PDFKit (via the existing `PDIGenerator`), Google Drive API (via the existing `services/googleDrive.js`), Jest + Supertest for integration tests against the real dev database (matching `tests/iptKits.test.js`).

---

## File Structure

| File | Responsibility |
|---|---|
| `scripts/migrations/2026-09-04-add-pdi-report-content.js` | One-off, idempotent script that adds the 4 new columns. Not a framework — this repo has no migration tool, so this follows the same "plain script run once" approach as the rest of the codebase. |
| `models/operations/pdiReports.js` | **New.** All DB + PDF + Drive logic for the report lifecycle (`createReport`, `getById`, `patchReport`, `listReports`, `finalizeReport`, `getPdfBuffer`, `deleteReport`). Mirrors `models/hr/invoiceRecords.js`. |
| `controllers/operations/pdiReports.controller.js` | **New.** Thin HTTP layer over `PdiReports` — request parsing, status codes, cache invalidation. |
| `routes/operations/pdiReports.js` | **New.** Routes for `/api/pdi/reports/*`. |
| `controllers/operations/pdi.controller.js` | **Modify.** Add one handler: `getTemplates`. Nothing else changes. |
| `routes/operations/pdi.js` | **Modify.** Add one route: `GET /templates`, registered *before* the existing `GET /:id` so it isn't swallowed by it. |
| `server.js` | **Modify.** Mount the new `/api/pdi/reports` router — *before* the existing `/api/pdi` mount (see Task 2, Step 3 for why the order matters). |
| `tests/pdiReports.test.js` | **New.** Integration tests, grown incrementally task by task, following the exact style of `tests/iptKits.test.js` (real DB, real JWTs, no mocks). |

**Existing files this plan does NOT touch:** `models/operations/pdi.js`, the rest of `controllers/operations/pdi.controller.js`, `models/operations/pdi_generator.js`, `services/googleDrive.js`, `CRM/src/components/admin/PdiPage.jsx`, `CRM/src/components/admin/PDIGeneratorForm.jsx`. The web form migration described in the spec's Section 5 is deliberately out of scope for this plan — it's frontend work with its own testing surface and belongs in a separate plan once this backend is live.

---

## Task 1: Database — add report-content columns

**Files:**
- Create: `scripts/migrations/2026-09-04-add-pdi-report-content.js`

Confirmed via a live schema query that `order_id` and `customer_id` are already nullable — no constraint changes needed, only new columns.

- [ ] **Step 1: Write the migration script**

```js
// scripts/migrations/2026-09-04-add-pdi-report-content.js
require('dotenv').config();
const pool = require('../../config/db');

async function migrate() {
  const statements = [
    `ALTER TABLE pre_dispatch_inspection_reports ADD COLUMN IF NOT EXISTS data JSONB NOT NULL DEFAULT '{}'::jsonb`,
    `ALTER TABLE pre_dispatch_inspection_reports ADD COLUMN IF NOT EXISTS photos JSONB NOT NULL DEFAULT '[]'::jsonb`,
    `ALTER TABLE pre_dispatch_inspection_reports ADD COLUMN IF NOT EXISTS template_id TEXT NOT NULL DEFAULT 'general'`,
    `ALTER TABLE pre_dispatch_inspection_reports ADD COLUMN IF NOT EXISTS drive_file_id TEXT`,
  ];

  for (const sql of statements) {
    console.log('Running:', sql);
    await pool.query(sql);
  }

  console.log('Migration complete.');
  await pool.end();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Run it**

Run: `node scripts/migrations/2026-09-04-add-pdi-report-content.js`
Expected: four `Running: ...` lines followed by `Migration complete.`, no errors.

- [ ] **Step 3: Verify the columns exist**

Run:
```bash
node -e "require('dotenv').config(); const pool=require('./config/db'); pool.query(\"SELECT column_name FROM information_schema.columns WHERE table_name='pre_dispatch_inspection_reports' AND column_name IN ('data','photos','template_id','drive_file_id') ORDER BY column_name\").then(r=>{console.log(r.rows.map(x=>x.column_name)); return pool.end();})"
```
Expected: `[ 'data', 'drive_file_id', 'photos', 'template_id' ]`

- [ ] **Step 4: Commit**

```bash
git add scripts/migrations/2026-09-04-add-pdi-report-content.js
git commit -m "chore: add data/photos/template_id/drive_file_id columns to pre_dispatch_inspection_reports"
```

---

## Task 2: Create a draft report — `POST /api/pdi/reports`

**Files:**
- Create: `models/operations/pdiReports.js`
- Create: `controllers/operations/pdiReports.controller.js`
- Create: `routes/operations/pdiReports.js`
- Modify: `server.js:55` (require), `server.js:177` (mount)
- Create: `tests/pdiReports.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/pdiReports.test.js
const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../server');
const pool = require('../config/db');

describe('PDI Reports API', () => {
  let adminToken, adminUserId;
  const createdReportIds = [];

  beforeAll(async () => {
    const admin = await pool.query(
      `INSERT INTO users (name, email, password_hash, role_id) VALUES ($1, $2, 'x', 1) RETURNING user_id`,
      ['PDI Reports Test Admin', `pdi-reports-test-admin-${Date.now()}@example.com`]
    );
    adminUserId = admin.rows[0].user_id;
    adminToken = jwt.sign({ user_id: adminUserId }, process.env.JWT_SECRET, { expiresIn: '1h' });
  });

  afterAll(async () => {
    if (createdReportIds.length) {
      await pool.query('DELETE FROM pre_dispatch_inspection_reports WHERE report_id = ANY($1::int[])', [createdReportIds]);
    }
    await pool.query('DELETE FROM users WHERE user_id = $1', [adminUserId]);
    await pool.end();
  });

  it('creates a near-empty draft report and returns a report_id', async () => {
    const res = await request(app)
      .post('/api/pdi/reports')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ data: { customer_name: 'ABC Industries', pdi_no: 'PDI-TEST-001' } });

    expect(res.statusCode).toBe(201);
    expect(res.body.report_id).toEqual(expect.any(Number));
    expect(res.body.status).toBe('Pending');
    expect(res.body.template_id).toBe('general');
    expect(res.body.data.customer_name).toBe('ABC Industries');
    expect(res.body.photos).toEqual([]);
    createdReportIds.push(res.body.report_id);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/pdiReports.test.js --verbose --forceExit`
Expected: FAIL — `Cannot find module '../models/operations/pdiReports'` (or a 404, once routes resolve but the module doesn't exist yet) — either way, not the expected 201.

- [ ] **Step 3: Write the model**

```js
// models/operations/pdiReports.js
const pool = require('../../config/db');

function reportColumns(prefix = '') {
  const p = prefix ? `${prefix}.` : '';
  return `
    ${p}report_id, ${p}sr_no, ${p}customer_id, ${p}order_id, ${p}status,
    ${p}inspected_by, ${p}inspection_date, ${p}template_id, ${p}drive_file_id,
    ${p}data, ${p}photos
  `;
}

class PdiReports {
  static #toPayload(row) {
    return {
      report_id: row.report_id,
      sr_no: row.sr_no,
      status: row.status,
      template_id: row.template_id,
      customer_id: row.customer_id,
      order_id: row.order_id,
      inspected_by: row.inspected_by,
      inspection_date: row.inspection_date,
      report_link: `/api/pdi/reports/${row.report_id}/pdf`,
      drive_file_id: row.drive_file_id,
      data: row.data,
      photos: row.photos,
    };
  }

  static async createReport({ customer_id, order_id, inspected_by, inspection_date, data, photos }, io) {
    const result = await pool.query(`
      INSERT INTO pre_dispatch_inspection_reports
        (customer_id, order_id, status, inspected_by, inspection_date, template_id, data, photos)
      VALUES ($1, $2, 'Pending', $3, $4, 'general', $5, $6)
      RETURNING ${reportColumns()}
    `, [
      customer_id || null,
      order_id || null,
      inspected_by || null,
      inspection_date ? new Date(inspection_date).toISOString() : null,
      JSON.stringify(data || {}),
      JSON.stringify(photos || []),
    ]);

    const payload = this.#toPayload(result.rows[0]);
    if (io?.emit) io.emit('pdiReportUpdate', { report_id: payload.report_id, status: payload.status });
    return payload;
  }
}

module.exports = PdiReports;
```

- [ ] **Step 4: Write the controller**

```js
// controllers/operations/pdiReports.controller.js
const PdiReports = require('../../models/operations/pdiReports');
const redis = require('../../config/redis');
const logger = require('../../utils/logger');

// Shared with the legacy pdi.controller.js cache keys (pdi_list_*, pdi_report_*)
// so a report created/changed here doesn't leave the legacy dashboard's cache stale.
async function invalidateCache() {
  const keys = await redis.keys('pdi_*');
  if (keys.length > 0) await redis.del(keys);
}

exports.createReport = async (req, res) => {
  try {
    const { customer_id, order_id, inspected_by, inspection_date, data, photos } = req.body || {};
    const report = await PdiReports.createReport({
      customer_id, order_id, inspected_by: inspected_by || req.user.name, inspection_date, data, photos,
    }, req.io);
    await invalidateCache();
    logger.info(`PDI report draft created: ${report.report_id} by ${req.user.user_id}`);
    res.status(201).json(report);
  } catch (error) {
    logger.error(`Error creating PDI report: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};
```

- [ ] **Step 5: Write the routes**

```js
// routes/operations/pdiReports.js
const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth');
const controller = require('../../controllers/operations/pdiReports.controller');

router.post('/', authenticateToken, controller.createReport);

module.exports = router;
```

- [ ] **Step 6: Mount the new router in server.js, before the legacy `/api/pdi` mount**

Add the require near the other operations routes (`server.js:55`, right after the existing `pdiRoutes` require):

```js
const pdiRoutes              = require('./routes/operations/pdi');
const pdiReportsRoutes       = require('./routes/operations/pdiReports');
```

Then mount it **before** `app.use('/api/pdi', pdiRoutes)` (`server.js:177`):

```js
// Operations
app.use('/api/queries',     queriesRoutes);
app.use('/api/activities',  activitiesRoutes);
app.use('/api/problems',    problemsRoutes);
app.use('/api/pdi/reports', pdiReportsRoutes);
app.use('/api/pdi',         pdiRoutes);
```

Order matters here: Express tries mounts in registration order. If `/api/pdi` were mounted first, a request to `GET /api/pdi/reports` would be handed to the legacy router with remainder path `/reports`, which matches the legacy router's `GET /:id` route (treating `"reports"` as an id) before ever reaching the new router — a real collision, not a hypothetical one. Mounting the more specific `/api/pdi/reports` prefix first means it claims every request under that prefix, and only paths that don't start with `/api/pdi/reports` fall through to the legacy mount.

- [ ] **Step 7: Run test to verify it passes**

Run: `npx jest tests/pdiReports.test.js --verbose --forceExit`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add models/operations/pdiReports.js controllers/operations/pdiReports.controller.js routes/operations/pdiReports.js server.js tests/pdiReports.test.js
git commit -m "feat: add POST /api/pdi/reports to create a draft PDI report"
```

---

## Task 3: Fetch a report — `GET /api/pdi/reports/:id`

**Files:**
- Modify: `models/operations/pdiReports.js` (add `getById`)
- Modify: `controllers/operations/pdiReports.controller.js` (add `getReport`)
- Modify: `routes/operations/pdiReports.js` (add route)
- Modify: `tests/pdiReports.test.js` (add tests)

- [ ] **Step 1: Write the failing tests**

Add inside the `describe` block, after the existing `it`:

```js
  it('fetches a report by id, resuming its full saved state', async () => {
    const created = await request(app)
      .post('/api/pdi/reports')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ data: { customer_name: 'Kesari Auto', pdi_no: 'PDI-TEST-003' } });
    createdReportIds.push(created.body.report_id);

    const fetched = await request(app)
      .get(`/api/pdi/reports/${created.body.report_id}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(fetched.statusCode).toBe(200);
    expect(fetched.body.report_id).toBe(created.body.report_id);
    expect(fetched.body.data.customer_name).toBe('Kesari Auto');
  });

  it('returns 404 for a report id that does not exist', async () => {
    const res = await request(app)
      .get('/api/pdi/reports/999999999')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(404);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/pdiReports.test.js --verbose --forceExit`
Expected: FAIL — no `GET /:id` route exists yet, so both requests 404 for the wrong reason (route not found rather than "report not found"), but the second test happens to pass by accident while the first fails on `fetched.body.report_id` being `undefined`. Confirm the first new test fails.

- [ ] **Step 3: Add `getById` to the model**

Insert into `models/operations/pdiReports.js`, inside the `PdiReports` class, after `createReport`:

```js
  static async getById(reportId) {
    const _id = Number(reportId);
    if (!Number.isFinite(_id)) throw new Error('Report not found');
    const result = await pool.query(`SELECT ${reportColumns()} FROM pre_dispatch_inspection_reports WHERE report_id = $1`, [_id]);
    if (result.rows.length === 0) throw new Error('Report not found');
    return this.#toPayload(result.rows[0]);
  }
```

- [ ] **Step 4: Add `getReport` to the controller**

Append to `controllers/operations/pdiReports.controller.js`:

```js
exports.getReport = async (req, res) => {
  try {
    const report = await PdiReports.getById(req.params.id);
    res.json(report);
  } catch (error) {
    if (error.message === 'Report not found') return res.status(404).json({ error: error.message });
    logger.error(`Error fetching PDI report ${req.params.id}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};
```

- [ ] **Step 5: Add the route**

In `routes/operations/pdiReports.js`, add after the `POST '/'` line:

```js
router.get('/:id', authenticateToken, controller.getReport);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx jest tests/pdiReports.test.js --verbose --forceExit`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add models/operations/pdiReports.js controllers/operations/pdiReports.controller.js routes/operations/pdiReports.js tests/pdiReports.test.js
git commit -m "feat: add GET /api/pdi/reports/:id to fetch a report"
```

---

## Task 4: Save progress — `PATCH /api/pdi/reports/:id`

**Files:**
- Modify: `models/operations/pdiReports.js` (add `patchReport`)
- Modify: `controllers/operations/pdiReports.controller.js` (add `patchReport`)
- Modify: `routes/operations/pdiReports.js` (add route)
- Modify: `tests/pdiReports.test.js` (add test)

- [ ] **Step 1: Write the failing test**

```js
  it('saves progress on a draft via PATCH without requiring every field', async () => {
    const created = await request(app)
      .post('/api/pdi/reports')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ data: { customer_name: 'Voltrix Motors', pdi_no: 'PDI-TEST-002' } });
    createdReportIds.push(created.body.report_id);

    const patched = await request(app)
      .patch(`/api/pdi/reports/${created.body.report_id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'In Progress', data: { ...created.body.data, product_id: '125-M' } });

    expect(patched.statusCode).toBe(200);
    expect(patched.body.status).toBe('In Progress');
    expect(patched.body.data.product_id).toBe('125-M');
    expect(patched.body.data.customer_name).toBe('Voltrix Motors');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/pdiReports.test.js --verbose --forceExit`
Expected: FAIL — no `PATCH /:id` route exists yet (404).

- [ ] **Step 3: Add `patchReport` to the model**

Insert into `models/operations/pdiReports.js`, after `getById`:

```js
  static async patchReport(reportId, fields, io) {
    const _id = Number(reportId);
    if (!Number.isFinite(_id)) throw new Error('Report not found');

    const sets = [];
    const values = [];
    let i = 1;

    if (fields.status !== undefined) { sets.push(`status = $${i++}`); values.push(fields.status); }
    if (fields.inspected_by !== undefined) { sets.push(`inspected_by = $${i++}`); values.push(fields.inspected_by || null); }
    if (fields.inspection_date !== undefined) {
      sets.push(`inspection_date = $${i++}`);
      values.push(fields.inspection_date ? new Date(fields.inspection_date).toISOString() : null);
    }
    if (fields.customer_id !== undefined) { sets.push(`customer_id = $${i++}`); values.push(fields.customer_id || null); }
    if (fields.order_id !== undefined) { sets.push(`order_id = $${i++}`); values.push(fields.order_id || null); }
    if (fields.data !== undefined) { sets.push(`data = $${i++}`); values.push(JSON.stringify(fields.data)); }
    if (fields.photos !== undefined) { sets.push(`photos = $${i++}`); values.push(JSON.stringify(fields.photos)); }

    if (sets.length === 0) return this.getById(_id);

    values.push(_id);
    const result = await pool.query(`
      UPDATE pre_dispatch_inspection_reports
      SET ${sets.join(', ')}
      WHERE report_id = $${i}
      RETURNING ${reportColumns()}
    `, values);
    if (result.rows.length === 0) throw new Error('Report not found');

    const payload = this.#toPayload(result.rows[0]);
    if (io?.emit) io.emit('pdiReportUpdate', { report_id: payload.report_id, status: payload.status });
    return payload;
  }
```

- [ ] **Step 4: Add `patchReport` to the controller**

Append to `controllers/operations/pdiReports.controller.js`:

```js
exports.patchReport = async (req, res) => {
  try {
    const report = await PdiReports.patchReport(req.params.id, req.body || {}, req.io);
    await invalidateCache();
    res.json(report);
  } catch (error) {
    if (error.message === 'Report not found') return res.status(404).json({ error: error.message });
    logger.error(`Error updating PDI report ${req.params.id}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};
```

- [ ] **Step 5: Add the route**

In `routes/operations/pdiReports.js`, add after `GET '/:id'`:

```js
router.patch('/:id', authenticateToken, controller.patchReport);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx jest tests/pdiReports.test.js --verbose --forceExit`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add models/operations/pdiReports.js controllers/operations/pdiReports.controller.js routes/operations/pdiReports.js tests/pdiReports.test.js
git commit -m "feat: add PATCH /api/pdi/reports/:id to save progress on a draft"
```

---

## Task 5: List reports — `GET /api/pdi/reports`

**Files:**
- Modify: `models/operations/pdiReports.js` (add `listReports`)
- Modify: `controllers/operations/pdiReports.controller.js` (add `listReports`)
- Modify: `routes/operations/pdiReports.js` (add route)
- Modify: `tests/pdiReports.test.js` (add test)

- [ ] **Step 1: Write the failing test**

```js
  it('lists reports filtered by status', async () => {
    const created = await request(app)
      .post('/api/pdi/reports')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ data: { customer_name: 'R.K. Traders', pdi_no: 'PDI-TEST-LIST-1' } });
    createdReportIds.push(created.body.report_id);
    await request(app)
      .patch(`/api/pdi/reports/${created.body.report_id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'Failed' });

    const list = await request(app)
      .get('/api/pdi/reports?status=Failed&limit=50')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(list.statusCode).toBe(200);
    expect(list.body.data.some((r) => r.report_id === created.body.report_id)).toBe(true);
    expect(list.body.data.every((r) => r.status === 'Failed')).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/pdiReports.test.js --verbose --forceExit`
Expected: FAIL — no `GET /` route exists yet on the reports router (falls through to legacy `GET /` list, whose rows won't have the new report's status filtered the same way — either a 404-shaped mismatch or a body without the expected fields).

- [ ] **Step 3: Add `listReports` to the model**

Insert into `models/operations/pdiReports.js`, after `patchReport`:

```js
  static async listReports({ limit = 10, cursor = null, status = null } = {}) {
    const _limit = Math.min(Math.max(Number(limit) || 10, 1), 100);

    let cursorReportId = null;
    let cursorSortKey = null;
    if (cursor) {
      const sepIdx = String(cursor).indexOf(':');
      if (sepIdx > 0) {
        const parsedId = parseInt(String(cursor).slice(0, sepIdx), 10);
        if (!isNaN(parsedId)) {
          cursorReportId = parsedId;
          cursorSortKey = String(cursor).slice(sepIdx + 1);
        }
      }
    }

    const query = `
      SELECT
        pdi.report_id, pdi.sr_no, pdi.customer_id, pdi.order_id, pdi.status,
        pdi.inspected_by, pdi.inspection_date, pdi.template_id,
        u.name AS customer_name,
        COALESCE(pdi.inspection_date, 'infinity'::timestamp)::text AS sort_key
      FROM pre_dispatch_inspection_reports pdi
      LEFT JOIN customers c ON pdi.customer_id = c.customer_id
      LEFT JOIN users u ON c.user_id = u.user_id
      WHERE (
        $1::text IS NULL
        OR COALESCE(pdi.inspection_date, 'infinity'::timestamp) < $1::timestamp
        OR (COALESCE(pdi.inspection_date, 'infinity'::timestamp) = $1::timestamp AND pdi.report_id < $2)
      )
      AND ($4::text IS NULL OR pdi.status = $4)
      ORDER BY COALESCE(pdi.inspection_date, 'infinity'::timestamp) DESC, pdi.report_id DESC
      LIMIT $3
    `;
    const values = [cursorSortKey, cursorReportId, _limit + 1, status || null];
    const countQuery = `SELECT COUNT(*)::int AS count FROM pre_dispatch_inspection_reports WHERE ($1::text IS NULL OR status = $1)`;

    const [result, totalResult] = await Promise.all([
      pool.query(query, values),
      pool.query(countQuery, [status || null]),
    ]);

    const hasMore = result.rows.length > _limit;
    const rows = hasMore ? result.rows.slice(0, _limit) : result.rows;
    const nextCursor = hasMore ? `${rows[rows.length - 1].report_id}:${rows[rows.length - 1].sort_key}` : null;

    return {
      data: rows.map((row) => ({
        report_id: row.report_id,
        sr_no: row.sr_no,
        status: row.status,
        template_id: row.template_id,
        customer_id: row.customer_id,
        order_id: row.order_id,
        customer_name: row.customer_name,
        inspected_by: row.inspected_by,
        inspection_date: row.inspection_date,
        report_link: `/api/pdi/reports/${row.report_id}/pdf`,
      })),
      total: totalResult.rows[0].count,
      cursor: nextCursor,
    };
  }
```

- [ ] **Step 4: Add `listReports` to the controller**

Append to `controllers/operations/pdiReports.controller.js`:

```js
exports.listReports = async (req, res) => {
  try {
    const { limit = 10, cursor, status } = req.query;
    const result = await PdiReports.listReports({ limit, cursor, status });
    res.json(result);
  } catch (error) {
    logger.error(`Error listing PDI reports: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};
```

- [ ] **Step 5: Add the route**

In `routes/operations/pdiReports.js`, add **before** `router.get('/:id', ...)` — a bare `GET '/'` and `GET '/:id'` don't collide (different segment counts), but keeping list-before-detail matches the reading order of the file:

```js
router.get('/', authenticateToken, controller.listReports);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx jest tests/pdiReports.test.js --verbose --forceExit`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add models/operations/pdiReports.js controllers/operations/pdiReports.controller.js routes/operations/pdiReports.js tests/pdiReports.test.js
git commit -m "feat: add GET /api/pdi/reports with cursor pagination and status filter"
```

---

## Task 6: Finalize a report — `POST /api/pdi/reports/:id/finalize`

**Files:**
- Modify: `models/operations/pdiReports.js` (add `finalizeReport`)
- Modify: `controllers/operations/pdiReports.controller.js` (add `finalizeReport`)
- Modify: `routes/operations/pdiReports.js` (add route)
- Modify: `tests/pdiReports.test.js` (add tests)

- [ ] **Step 1: Write the failing tests**

```js
  it('finalizes a report: generates a real PDF and marks it Completed', async () => {
    const created = await request(app)
      .post('/api/pdi/reports')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ data: { customer_name: 'Finalize Test Co.', pdi_no: 'PDI-TEST-FINAL-1' } });
    createdReportIds.push(created.body.report_id);

    const finalized = await request(app)
      .post(`/api/pdi/reports/${created.body.report_id}/finalize`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(finalized.statusCode).toBe(200);
    expect(finalized.headers['content-type']).toBe('application/pdf');
    expect(finalized.body.slice(0, 5).toString('ascii')).toBe('%PDF-');

    const fetched = await request(app)
      .get(`/api/pdi/reports/${created.body.report_id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(fetched.body.status).toBe('Completed');
  });

  it('rejects finalizing a report with no pdi_no', async () => {
    const created = await request(app)
      .post('/api/pdi/reports')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ data: { customer_name: 'No PDI No Co.' } });
    createdReportIds.push(created.body.report_id);

    const finalized = await request(app)
      .post(`/api/pdi/reports/${created.body.report_id}/finalize`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(finalized.statusCode).toBe(400);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/pdiReports.test.js --verbose --forceExit`
Expected: FAIL — no `POST /:id/finalize` route exists yet (404).

- [ ] **Step 3: Add `finalizeReport` to the model**

This is the first method that needs to render a PDF and talk to Drive, so first add the three new imports and the `bufferPdf` helper to the top of `models/operations/pdiReports.js`, right after the existing `const pool = require('../../config/db');` line:

```js
const pool = require('../../config/db');
const logger = require('../../utils/logger');
const PDIGenerator = require('./pdi_generator');
const { uploadBufferToDrivePrivate } = require('../../services/googleDrive');

// Collects a PDFKit document's output into a single Buffer.
function bufferPdf(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}
```

Then add `finalizeReport` itself, inside the `PdiReports` class, after `listReports`:

```js
  static async finalizeReport(reportId, io) {
    const report = await this.getById(reportId);
    const pdfBuffer = await bufferPdf(PDIGenerator.generate(report.data || {}));

    // Best-effort Drive backup — same reasoning as InvoiceRecords.create: a
    // "generated" report can always be regenerated from its stored data, so a
    // Drive outage shouldn't block finalizing.
    let driveFileId = report.drive_file_id || null;
    try {
      const safeNo = String(report.data?.pdi_no || report.report_id).replace(/[^a-zA-Z0-9_-]/g, '_');
      const uploaded = await uploadBufferToDrivePrivate(pdfBuffer, 'application/pdf', `PDI_${safeNo}.pdf`);
      driveFileId = uploaded.id;
    } catch (e) {
      logger.warn(`Drive backup failed for PDI report ${reportId}: ${e.message}`);
    }

    const result = await pool.query(`
      UPDATE pre_dispatch_inspection_reports
      SET status = 'Completed', drive_file_id = COALESCE($1, drive_file_id)
      WHERE report_id = $2
      RETURNING ${reportColumns()}
    `, [driveFileId, Number(reportId)]);

    const payload = this.#toPayload(result.rows[0]);
    if (io?.emit) io.emit('pdiReportUpdate', { report_id: payload.report_id, status: payload.status });
    return { payload, pdfBuffer };
  }
```

- [ ] **Step 4: Add `finalizeReport` to the controller**

Append to `controllers/operations/pdiReports.controller.js`:

```js
exports.finalizeReport = async (req, res) => {
  try {
    const existing = await PdiReports.getById(req.params.id);
    if (!existing.data?.pdi_no) return res.status(400).json({ error: 'pdi_no required before finalizing' });

    const { payload, pdfBuffer } = await PdiReports.finalizeReport(req.params.id, req.io);
    await invalidateCache();

    const safeName = String(payload.data?.pdi_no || payload.report_id).replace(/[^a-zA-Z0-9_-]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="PDI_${safeName}.pdf"`);
    logger.info(`PDI report finalized: ${payload.report_id} by ${req.user.user_id}`);
    res.send(pdfBuffer);
  } catch (error) {
    if (error.message === 'Report not found') return res.status(404).json({ error: error.message });
    logger.error(`Error finalizing PDI report ${req.params.id}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};
```

- [ ] **Step 5: Add the route**

In `routes/operations/pdiReports.js`, add after `PATCH '/:id'`:

```js
router.post('/:id/finalize', authenticateToken, controller.finalizeReport);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx jest tests/pdiReports.test.js --verbose --forceExit`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add models/operations/pdiReports.js controllers/operations/pdiReports.controller.js routes/operations/pdiReports.js tests/pdiReports.test.js
git commit -m "feat: add POST /api/pdi/reports/:id/finalize to generate the PDF and back it up to Drive"
```

---

## Task 7: Regenerate the PDF on demand — `GET /api/pdi/reports/:id/pdf`

**Files:**
- Modify: `models/operations/pdiReports.js` (add `getPdfBuffer`)
- Modify: `controllers/operations/pdiReports.controller.js` (add `downloadPdf`)
- Modify: `routes/operations/pdiReports.js` (add route)
- Modify: `tests/pdiReports.test.js` (add test)

- [ ] **Step 1: Write the failing test**

```js
  it('regenerates a PDF on demand for an unfinished draft', async () => {
    const created = await request(app)
      .post('/api/pdi/reports')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ data: { customer_name: 'Draft PDF Co.', pdi_no: 'PDI-TEST-PDF-1' } });
    createdReportIds.push(created.body.report_id);

    const pdf = await request(app)
      .get(`/api/pdi/reports/${created.body.report_id}/pdf`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.body.slice(0, 5).toString('ascii')).toBe('%PDF-');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/pdiReports.test.js --verbose --forceExit`
Expected: FAIL — no `GET /:id/pdf` route exists yet (404).

- [ ] **Step 3: Add `getPdfBuffer` to the model**

Insert into `models/operations/pdiReports.js`, after `finalizeReport`:

```js
  static async getPdfBuffer(reportId) {
    const report = await this.getById(reportId);
    return bufferPdf(PDIGenerator.generate(report.data || {}));
  }
```

- [ ] **Step 4: Add `downloadPdf` to the controller**

Append to `controllers/operations/pdiReports.controller.js`:

```js
exports.downloadPdf = async (req, res) => {
  try {
    const report = await PdiReports.getById(req.params.id);
    if (!report.data?.pdi_no) return res.status(400).json({ error: 'pdi_no required to generate a PDF' });

    const pdfBuffer = await PdiReports.getPdfBuffer(req.params.id);
    const safeName = String(report.data.pdi_no).replace(/[^a-zA-Z0-9_-]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="PDI_${safeName}.pdf"`);
    res.send(pdfBuffer);
  } catch (error) {
    if (error.message === 'Report not found') return res.status(404).json({ error: error.message });
    logger.error(`Error generating PDI PDF ${req.params.id}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};
```

- [ ] **Step 5: Add the route**

In `routes/operations/pdiReports.js`, add after `POST '/:id/finalize'`:

```js
router.get('/:id/pdf', authenticateToken, controller.downloadPdf);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx jest tests/pdiReports.test.js --verbose --forceExit`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add models/operations/pdiReports.js controllers/operations/pdiReports.controller.js routes/operations/pdiReports.js tests/pdiReports.test.js
git commit -m "feat: add GET /api/pdi/reports/:id/pdf to regenerate a report's PDF on demand"
```

---

## Task 8: Delete a report — `DELETE /api/pdi/reports/:id`

**Files:**
- Modify: `models/operations/pdiReports.js` (add `deleteReport`)
- Modify: `controllers/operations/pdiReports.controller.js` (add `deleteReport`)
- Modify: `routes/operations/pdiReports.js` (add route)
- Modify: `tests/pdiReports.test.js` (add test)

- [ ] **Step 1: Write the failing test**

```js
  it('deletes a report', async () => {
    const created = await request(app)
      .post('/api/pdi/reports')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ data: { customer_name: 'Delete Test Co.', pdi_no: 'PDI-TEST-DEL-1' } });

    const del = await request(app)
      .delete(`/api/pdi/reports/${created.body.report_id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(del.statusCode).toBe(200);

    const fetched = await request(app)
      .get(`/api/pdi/reports/${created.body.report_id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(fetched.statusCode).toBe(404);
  });
```

Note this test does not push into `createdReportIds` — the row is expected to already be gone by the time `afterAll` runs, so there's nothing left to clean up.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/pdiReports.test.js --verbose --forceExit`
Expected: FAIL — no `DELETE /:id` route exists yet (404 on the delete call itself, or an unexpected status).

- [ ] **Step 3: Add `deleteReport` to the model**

`deleteReport` is the first method that needs to trash a Drive file, so first widen the existing Drive import at the top of `models/operations/pdiReports.js`:

```js
const { uploadBufferToDrivePrivate, deleteDriveFile } = require('../../services/googleDrive');
```

(replacing the Task 6 line that only imported `uploadBufferToDrivePrivate`).

Then add `deleteReport` itself, inside the `PdiReports` class, after `getPdfBuffer`:

```js
  static async deleteReport(reportId, io) {
    const _id = Number(reportId);
    if (!Number.isFinite(_id)) throw new Error('Report not found');
    const result = await pool.query(
      'DELETE FROM pre_dispatch_inspection_reports WHERE report_id = $1 RETURNING report_id, drive_file_id',
      [_id]
    );
    if (result.rows.length === 0) throw new Error('Report not found');

    const driveFileId = result.rows[0].drive_file_id;
    if (driveFileId) {
      try { await deleteDriveFile(driveFileId); }
      catch (e) { logger.warn(`Drive cleanup failed for PDI report ${_id} (file ${driveFileId}): ${e.message}`); }
    }

    if (io?.emit) io.emit('pdiReportUpdate', { report_id: _id, status: 'Deleted' });
    return { report_id: _id };
  }
```

- [ ] **Step 4: Add `deleteReport` to the controller**

Append to `controllers/operations/pdiReports.controller.js`:

```js
exports.deleteReport = async (req, res) => {
  try {
    const result = await PdiReports.deleteReport(req.params.id, req.io);
    await invalidateCache();
    res.json(result);
  } catch (error) {
    if (error.message === 'Report not found') return res.status(404).json({ error: error.message });
    logger.error(`Error deleting PDI report ${req.params.id}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};
```

- [ ] **Step 5: Add the route**

In `routes/operations/pdiReports.js`, add after `GET '/:id/pdf'`:

```js
router.delete('/:id', authenticateToken, controller.deleteReport);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx jest tests/pdiReports.test.js --verbose --forceExit`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add models/operations/pdiReports.js controllers/operations/pdiReports.controller.js routes/operations/pdiReports.js tests/pdiReports.test.js
git commit -m "feat: add DELETE /api/pdi/reports/:id, trashing any Drive-backed PDF"
```

---

## Task 9: Templates list — `GET /api/pdi/templates`

**Files:**
- Modify: `controllers/operations/pdi.controller.js` (add `getTemplates`)
- Modify: `routes/operations/pdi.js` (add route, before `/:id`)
- Modify: `tests/pdiReports.test.js` (add test)

This one lives on the **legacy** router (`routes/operations/pdi.js`, mounted at `/api/pdi`), not the new reports router — the path is `/api/pdi/templates`, a sibling of `/api/pdi/reports`, not nested under it.

- [ ] **Step 1: Write the failing test**

```js
  it('lists the general template', async () => {
    const res = await request(app)
      .get('/api/pdi/templates')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual([{ id: 'general', name: 'General', version: 1 }]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/pdiReports.test.js --verbose --forceExit`
Expected: FAIL — `GET /api/pdi/templates` currently falls through to the legacy `GET /:id` route (treating `"templates"` as an id), which will error trying to query `pre_dispatch_inspection_reports` with a non-numeric id.

- [ ] **Step 3: Add `getTemplates` to the legacy controller**

Append to `controllers/operations/pdi.controller.js`:

```js
exports.getTemplates = async (req, res) => {
  res.json([{ id: 'general', name: 'General', version: 1 }]);
};
```

- [ ] **Step 4: Add the route, before `GET /:id`**

In `routes/operations/pdi.js`, the file currently reads:

```js
router.post('/generate', authenticateToken, controller.generate);
router.post('/', authenticateToken, controller.create);
router.get('/', authenticateToken, controller.getAll);
router.get('/:id', authenticateToken, controller.getOne);
router.put('/:id', authenticateToken, controller.update);
router.delete('/:id', authenticateToken, controller.delete);
```

Change it to insert `GET /templates` immediately before `GET /:id`, so it's matched first:

```js
router.post('/generate', authenticateToken, controller.generate);
router.post('/', authenticateToken, controller.create);
router.get('/', authenticateToken, controller.getAll);
router.get('/templates', authenticateToken, controller.getTemplates);
router.get('/:id', authenticateToken, controller.getOne);
router.put('/:id', authenticateToken, controller.update);
router.delete('/:id', authenticateToken, controller.delete);
```

Express matches routes within a router in registration order, so `GET /templates` must come before `GET /:id` or the single-segment `:id` pattern will greedily match `"templates"` first.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest tests/pdiReports.test.js --verbose --forceExit`
Expected: PASS — all tests in the file green.

- [ ] **Step 6: Commit**

```bash
git add controllers/operations/pdi.controller.js routes/operations/pdi.js tests/pdiReports.test.js
git commit -m "feat: add GET /api/pdi/templates, currently just the hardcoded general template"
```

---

## Task 10: Full regression pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full backend test suite**

Run: `npx jest`
Expected: `tests/pdiReports.test.js` fully green, and `tests/iptKits.test.js` / `tests/auth.test.js` show no new failures beyond whatever pre-existing flakiness already exists on `main` (the auth suite's SMTP-dependent tests are known-flaky independent of this change — confirm any failures there are identical to a clean `main` checkout, not new).

- [ ] **Step 2: Manually sanity-check the new endpoints end-to-end**

With the dev server running (`npm run dev`) and a valid token:

```bash
curl -s -X POST http://localhost:8000/api/pdi/reports \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"data":{"customer_name":"Smoke Test Co.","pdi_no":"PDI-SMOKE-1"}}'
```

Expected: `201` with a `report_id`. Then `finalize` that id and confirm a real PDF downloads:

```bash
curl -s -o /tmp/smoke.pdf -X POST http://localhost:8000/api/pdi/reports/<id>/finalize \
  -H "Authorization: Bearer $TOKEN"
file /tmp/smoke.pdf
```

Expected: `PDF document, version 1.x`.

- [ ] **Step 3: Confirm the legacy dashboard is unaffected**

```bash
curl -s "http://localhost:8000/api/pdi?limit=5" -H "Authorization: Bearer $TOKEN"
```

Expected: same shape and behavior as before this plan — this endpoint's code was never touched.
