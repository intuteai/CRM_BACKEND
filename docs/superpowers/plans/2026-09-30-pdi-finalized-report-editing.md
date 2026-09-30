# Controlled Editing of Finalized PDI Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a permitted user (existing `PreDispatchInspectionReports` `can_write` permission, unused by any PDI route until now) edit an already-`Completed` PDI report through the existing `PATCH /api/pdi/reports/:id` endpoint, gated by a required `expected_revision` to prevent a silent-overwrite race, with every edit snapshotted for audit and the PDF automatically re-rendered afterward.

**Architecture:** One new column (`revision_no`) and one new table (`pdi_report_revisions`) back the feature. `patchReport`'s existing guarded `UPDATE ... WHERE status <> 'Completed'` stays completely unchanged for the common case (report not yet finalized); a report that IS `Completed` now falls into a second branch that checks permission + `expected_revision`, snapshots the pre-edit `data`, applies the edit with `revision_no` bumped via its own guarded UPDATE (an optimistic-concurrency compare-and-swap on `revision_no` instead of an absolute lock on `status`), and kicks off a background PDF re-render mirroring `finalizeReport`'s own fire-and-forget pattern. A new `hasPermission()` helper factored out of the existing `checkPermission` middleware is what makes the permission check callable from inside this model method instead of only as blanket route middleware.

**Tech Stack:** Node.js/Express, PostgreSQL (`pg`), Jest (fully-mocked DB, no real Postgres in any test).

---

## Spec reference

Full design: `docs/superpowers/specs/2026-09-30-pdi-finalized-report-editing-design.md`. Read it before starting if anything below is unclear — it has the reasoning for every decision (why `photos` isn't snapshotted, why `revision_no` stays internal-only, why batch-member editing is out of scope, etc).

---

### Task 1: Database migration

**Files:**
- Create: `scripts/migrations/2026-09-30-add-pdi-report-revisions.js`

- [ ] **Step 1: Write the migration script**

```js
require('dotenv').config();
const pool = require('../../config/db');

// Backs docs/superpowers/specs/2026-09-30-pdi-finalized-report-editing-design.md.
// revision_no starts at 1 for every existing report (additive, no backfill
// needed). pdi_report_revisions holds one row per past edit to an
// already-Completed report -- each row's `data` is what the report's own
// `data` column looked like immediately BEFORE that edit (the revision_no
// column on this table names which revision that snapshot WAS, not what it
// became). photos are deliberately not snapshotted here -- see the spec.
// ON DELETE CASCADE matters here: deleteReport does a plain `DELETE FROM
// pre_dispatch_inspection_reports` with no special-casing -- without cascade,
// deleting any report that has ever been edited-while-Completed (i.e. has
// revision history) would fail outright with a foreign-key-violation error.
async function migrate() {
  const statements = [
    `ALTER TABLE pre_dispatch_inspection_reports ADD COLUMN IF NOT EXISTS revision_no INTEGER NOT NULL DEFAULT 1`,
    `CREATE TABLE IF NOT EXISTS pdi_report_revisions (
      revision_id SERIAL PRIMARY KEY,
      report_id INTEGER NOT NULL REFERENCES pre_dispatch_inspection_reports(report_id) ON DELETE CASCADE,
      revision_no INTEGER NOT NULL,
      data JSONB NOT NULL,
      edited_by INTEGER REFERENCES users(user_id),
      edited_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
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

- [ ] **Step 2: Run it against the dev database (same connection every other migration this session used)**

Run: `node scripts/migrations/2026-09-30-add-pdi-report-revisions.js`
Expected: prints both `Running: ...` lines, then `Migration complete.`, exit code 0.

- [ ] **Step 3: Verify the schema landed**

Run:
```bash
node -e "
const pool = require('./config/db');
(async () => {
  const cols = await pool.query(\"SELECT column_name FROM information_schema.columns WHERE table_name='pre_dispatch_inspection_reports' AND column_name='revision_no'\");
  console.log('revision_no column:', cols.rows);
  const tbl = await pool.query(\"SELECT column_name, data_type FROM information_schema.columns WHERE table_name='pdi_report_revisions' ORDER BY ordinal_position\");
  console.log('pdi_report_revisions columns:', tbl.rows);
  await pool.end();
})();
"
```
Expected: `revision_no column: [ { column_name: 'revision_no' } ]` and the 6 expected columns (`revision_id, report_id, revision_no, data, edited_by, edited_at`) listed for `pdi_report_revisions`.

- [ ] **Step 4: Commit**

```bash
git add scripts/migrations/2026-09-30-add-pdi-report-revisions.js
git commit -m "feat: add pdi_report_revisions table and revision_no column"
```

---

### Task 2: `hasPermission` helper (middleware refactor)

**Files:**
- Modify: `middleware/auth.js`
- Test: `tests/auth_permission.test.js` (new)

This task is independent of Task 1 — it touches a completely different file and has no dependency on the new schema.

- [ ] **Step 1: Write the failing tests**

Create `tests/auth_permission.test.js`:

```js
// hasPermission (extracted from checkPermission so a model method can call it
// directly, not just use it as route middleware -- see
// docs/superpowers/specs/2026-09-30-pdi-finalized-report-editing-design.md)
// and confirmation that checkPermission's own existing route-middleware
// behavior is completely unchanged. The database is mocked, so this touches
// no real data.
const mockQuery = jest.fn();
jest.mock('../config/db', () => ({ query: (...a) => mockQuery(...a) }));

const { hasPermission, checkPermission } = require('../middleware/auth');

describe('hasPermission', () => {
  beforeEach(() => mockQuery.mockClear());

  it('returns true when the role has the permission', async () => {
    mockQuery.mockResolvedValue({ rows: [{ can_write: true }] });
    await expect(hasPermission(1, 'PreDispatchInspectionReports', 'can_write')).resolves.toBe(true);
    expect(mockQuery).toHaveBeenCalledWith(
      'SELECT can_write FROM permissions WHERE role_id = $1 AND module = $2',
      [1, 'PreDispatchInspectionReports']
    );
  });

  it('returns false when no permission row exists for the role/module', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await expect(hasPermission(99, 'PreDispatchInspectionReports', 'can_write')).resolves.toBe(false);
  });

  it('returns false when the row exists but the flag itself is false', async () => {
    mockQuery.mockResolvedValue({ rows: [{ can_write: false }] });
    await expect(hasPermission(2, 'PreDispatchInspectionReports', 'can_write')).resolves.toBe(false);
  });

  it('maps can_create to can_write, same column mapping checkPermission already had', async () => {
    mockQuery.mockResolvedValue({ rows: [{ can_write: true }] });
    await expect(hasPermission(1, 'Orders', 'can_create')).resolves.toBe(true);
    expect(mockQuery).toHaveBeenCalledWith(
      'SELECT can_write FROM permissions WHERE role_id = $1 AND module = $2',
      [1, 'Orders']
    );
  });
});

describe('checkPermission middleware (behavior unchanged by the refactor)', () => {
  function mockRes() {
    const res = {};
    res.status = jest.fn(() => res);
    res.json = jest.fn(() => res);
    return res;
  }

  beforeEach(() => mockQuery.mockClear());

  it('calls next() when the role has the permission', async () => {
    mockQuery.mockResolvedValue({ rows: [{ can_write: true }] });
    const req = { user: { role_id: 1 } };
    const res = mockRes();
    const next = jest.fn();
    await checkPermission('PreDispatchInspectionReports', 'can_write')(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('responds 403 PERM_DENIED when the role lacks the permission', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const req = { user: { role_id: 99 } };
    const res = mockRes();
    const next = jest.fn();
    await checkPermission('PreDispatchInspectionReports', 'can_write')(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Permission denied', code: 'PERM_DENIED' });
  });

  it('responds 403 PERM_DENIED when req.user is missing, without querying the database', async () => {
    const res = mockRes();
    const next = jest.fn();
    await checkPermission('PreDispatchInspectionReports', 'can_write')({}, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('responds 500 PERM_CHECK_FAILED when the permission query itself fails', async () => {
    mockQuery.mockRejectedValue(new Error('connection lost'));
    const req = { user: { role_id: 1 } };
    const res = mockRes();
    const next = jest.fn();
    await checkPermission('PreDispatchInspectionReports', 'can_write')(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest tests/auth_permission.test.js`
Expected: FAIL — `hasPermission` is not exported yet (`TypeError: hasPermission is not a function` or similar).

- [ ] **Step 3: Refactor `middleware/auth.js`**

Read the current file first (`middleware/auth.js`) — `checkPermission` is a factory returning route middleware; its body does the permission lookup inline. Change:

```js
const checkPermission = (module, action) => {
  return async (req, res, next) => {
    // defensive: ensure req.user exists and contains role_id
    if (!req.user || typeof req.user.role_id === 'undefined') {
      return res.status(403).json({ error: 'Permission denied (no user)', code: 'PERM_DENIED' });
    }

    const { role_id } = req.user;
    const dbAction = action === 'can_create' ? 'can_write' : action;
    const query = `SELECT ${dbAction} FROM permissions WHERE role_id = $1 AND module = $2`;

    try {
      const result = await pool.query(query, [role_id, module]);
      if (result.rows.length > 0 && result.rows[0][dbAction]) {
        next();
      } else {
        res.status(403).json({ error: 'Permission denied', code: 'PERM_DENIED' });
      }
    } catch (error) {
      console.error('Permission check failed:', error);
      res.status(500).json({ error: `Permission check failed: ${error.message}`, code: 'PERM_CHECK_FAILED' });
    }
  };
};

module.exports = { authenticateToken, checkPermission };
```

to:

```js
// Plain, directly-callable permission lookup -- the same query
// checkPermission (route middleware, below) already ran, just usable from
// anywhere, not only as an Express middleware. Added so a model method
// (PdiReports.patchReport, editing an already-Completed report) can gate one
// specific action without needing blanket route middleware on every PDI
// edit -- see docs/superpowers/specs/2026-09-30-pdi-finalized-report-editing-design.md.
async function hasPermission(role_id, module, action) {
  const dbAction = action === 'can_create' ? 'can_write' : action;
  const result = await pool.query(
    `SELECT ${dbAction} FROM permissions WHERE role_id = $1 AND module = $2`,
    [role_id, module]
  );
  return result.rows.length > 0 && !!result.rows[0][dbAction];
}

const checkPermission = (module, action) => {
  return async (req, res, next) => {
    // defensive: ensure req.user exists and contains role_id
    if (!req.user || typeof req.user.role_id === 'undefined') {
      return res.status(403).json({ error: 'Permission denied (no user)', code: 'PERM_DENIED' });
    }

    try {
      const allowed = await hasPermission(req.user.role_id, module, action);
      if (allowed) {
        next();
      } else {
        res.status(403).json({ error: 'Permission denied', code: 'PERM_DENIED' });
      }
    } catch (error) {
      console.error('Permission check failed:', error);
      res.status(500).json({ error: `Permission check failed: ${error.message}`, code: 'PERM_CHECK_FAILED' });
    }
  };
};

module.exports = { authenticateToken, checkPermission, hasPermission };
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx jest tests/auth_permission.test.js`
Expected: PASS, 9 tests.

- [ ] **Step 5: Run the full suite once to confirm nothing else that uses `checkPermission` broke**

Run: `npx jest`
Expected: same pass/fail counts as before this task (this repo has a couple of pre-existing unrelated failures in `tests/auth.test.js` and `tests/pdiReports.test.js` from stale test data / flakiness — confirm you're not adding any NEW failures, not that the suite is 100% green).

- [ ] **Step 6: Commit**

```bash
git add middleware/auth.js tests/auth_permission.test.js
git commit -m "feat: extract hasPermission from checkPermission for direct (non-middleware) use"
```

---

### Task 3: `patchReport` branching, `getRevisions`, background re-render

**Files:**
- Modify: `models/operations/pdiReports.js`
- Modify: `models/operations/pdi/pdfCache.js:8-11` (one stale comment)
- Modify: `tests/pdi_inspection_date.test.js` (existing test's mock needs to account for a new query — see Step 1)
- Test: `tests/pdi_finalized_edit.test.js` (new)

**Depends on Task 1** (needs `revision_no`/`pdi_report_revisions` to exist conceptually — though since all tests mock the DB, this dependency is really about the *code* needing `hasPermission` from Task 2, not the live schema) **and Task 2** (`hasPermission`).

This is the core of the feature — read `models/operations/pdiReports.js`'s current `patchReport` (around line 230), `finalizeReport` (around line 440), and `#backupPdfToDrive` (around line 518) in full before starting. The new code below mirrors `finalizeReport`'s background-work pattern closely.

- [ ] **Step 1: Fix the existing `tests/pdi_inspection_date.test.js` mock for the new query `patchReport` will issue**

This step must land BEFORE Step 3's `patchReport` rewrite breaks it. `patchReport` will gain one new `pool.query` call (a pre-read of the report's current `status`/`revision_no`/`data`) issued right before the guarded UPDATE it issues today. The existing mock only recognizes queries containing `RETURNING`, so the new pre-read (which doesn't) currently falls through to `{ rows: [] }` — read as "report not found" and breaking every test in this file that expects `patchReport` to succeed.

Change `tests/pdi_inspection_date.test.js`:

```js
const mockQuery = jest.fn(async (sql) => {
  if (/RETURNING/.test(sql)) {
    return {
      rows: [{
        report_id: 1, sr_no: 1, customer_id: null, order_id: null, status: 'Pending',
        inspected_by: null, inspection_date: null, template_id: 'general', template_version: 1,
        drive_file_id: null, prepared_by: null, approved_by: null, data: {}, photos: [], created_at: new Date(),
      }],
    };
  }
  return { rows: [] };
});
```

to:

```js
const mockQuery = jest.fn(async (sql) => {
  // patchReport's pre-read of the report's current status/revision_no/data,
  // now issued before the guarded UPDATE (see the design spec) -- these
  // tests are about date parsing, not the Completed-report edit path, so
  // 'Pending' keeps every one of them on the same normal-edit branch they
  // exercised before this query existed.
  if (/SELECT status, revision_no, data FROM/.test(sql)) {
    return { rows: [{ status: 'Pending', revision_no: 1, data: {} }] };
  }
  if (/RETURNING/.test(sql)) {
    return {
      rows: [{
        report_id: 1, sr_no: 1, customer_id: null, order_id: null, status: 'Pending',
        inspected_by: null, inspection_date: null, template_id: 'general', template_version: 1,
        drive_file_id: null, prepared_by: null, approved_by: null, revision_no: 1, data: {}, photos: [], created_at: new Date(),
      }],
    };
  }
  return { rows: [] };
});
```

And update the two assertions that read `mockQuery.mock.calls[0][1]` (the pre-read is now call `[0]`; the actual `UPDATE` is call `[1]`):

Change:
```js
  it('still accepts a normal ISO date', async () => {
    await PdiReports.patchReport(1, { inspection_date: '2026-09-22' });
    const values = mockQuery.mock.calls[0][1];
    expect(values).toContain(new Date('2026-09-22').toISOString());
  });

  it('treats an empty date as no date, not an error', async () => {
    await expect(
      PdiReports.patchReport(1, { inspection_date: '' })
    ).resolves.toBeDefined();
    const values = mockQuery.mock.calls[0][1];
    expect(values).toContain(null);
  });
```
to:
```js
  it('still accepts a normal ISO date', async () => {
    await PdiReports.patchReport(1, { inspection_date: '2026-09-22' });
    // [0] is the new pre-read; [1] is the actual UPDATE.
    const values = mockQuery.mock.calls[1][1];
    expect(values).toContain(new Date('2026-09-22').toISOString());
  });

  it('treats an empty date as no date, not an error', async () => {
    await expect(
      PdiReports.patchReport(1, { inspection_date: '' })
    ).resolves.toBeDefined();
    const values = mockQuery.mock.calls[1][1];
    expect(values).toContain(null);
  });
```

The first test in this file (`'rejects an unparseable date with a clear error, not a crash'`, asserting `expect(mockQuery).not.toHaveBeenCalled()`) needs NO change — `toIsoDateOrNull` still runs, and can still throw, before the new pre-read query in Step 3's rewrite (see the ordering note in Step 3).

Run: `npx jest tests/pdi_inspection_date.test.js`
Expected at this point: still PASS (nothing in `pdiReports.js` has changed yet — this step only updates the test file to match the query `patchReport` is *about to* gain in Step 3; confirm the file itself has no syntax errors).

- [ ] **Step 2: Write the failing tests for the new behavior**

Create `tests/pdi_finalized_edit.test.js`:

```js
// Controlled editing of finalized PDI reports
// (docs/superpowers/specs/2026-09-30-pdi-finalized-report-editing-design.md).
// The database and Google Drive are mocked, matching every other PDI model
// test in this repo -- see tests/pdi_finalize_pdf.test.js for the established
// pattern this extends.
const mockState = {
  preReadRow: null,     // status/revision_no/data as patchReport's pre-read sees it
  permissionRows: [],   // hasPermission's own SELECT
  updateRows: [],        // RETURNING rows from whichever guarded UPDATE actually runs
  fullReportRow: null,  // the reportColumns()-shaped row getById (used by the background re-render) returns
  queries: [],
};
const mockQuery = jest.fn(async (sql, params) => {
  mockState.queries.push({ sql, params });
  if (/SELECT can_write FROM permissions/.test(sql)) return { rows: mockState.permissionRows };
  if (/SELECT status, revision_no, data FROM/.test(sql)) return { rows: mockState.preReadRow ? [mockState.preReadRow] : [] };
  if (/INSERT INTO pdi_report_revisions/.test(sql)) return { rows: [], rowCount: 1 };
  if (/status = 'Completed' AND revision_no = /.test(sql)) return { rows: mockState.updateRows, rowCount: mockState.updateRows.length };
  if (/WHERE report_id = \$\d+ AND status <> 'Completed'/.test(sql)) return { rows: mockState.updateRows, rowCount: mockState.updateRows.length };
  if (/SET drive_file_id/.test(sql)) return { rows: [], rowCount: 1 };
  if (/report_id, sr_no, customer_id[\s\S]*FROM pre_dispatch_inspection_reports WHERE report_id/.test(sql)) {
    return { rows: mockState.fullReportRow ? [mockState.fullReportRow] : [] };
  }
  return { rows: [], rowCount: 0 };
});
const mockUpload = jest.fn(async () => ({ id: 'drive-new' }));
const mockDeleteDrive = jest.fn(async () => undefined);
jest.mock('../config/db', () => ({ query: (...a) => mockQuery(...a) }));
jest.mock('../services/googleDrive', () => ({
  uploadBufferToDrivePrivate: (...a) => mockUpload(...a),
  deleteDriveFile: (...a) => mockDeleteDrive(...a),
}));

const PdiReports = require('../models/operations/pdiReports');

beforeEach(() => {
  mockQuery.mockClear(); mockUpload.mockClear(); mockDeleteDrive.mockClear();
  mockState.preReadRow = { status: 'Completed', revision_no: 3, data: { pdi_no: 'PDI-EDIT-1', customer_name: 'Old Name' } };
  mockState.permissionRows = [{ can_write: true }];
  mockState.updateRows = [{
    report_id: 7, sr_no: 7, customer_id: null, order_id: null, status: 'Completed',
    inspected_by: null, inspection_date: null, template_id: 'general', template_version: null,
    drive_file_id: 'drive-old', revision_no: 4, data: { pdi_no: 'PDI-EDIT-1', customer_name: 'New Name' }, photos: [],
  }];
  mockState.fullReportRow = {
    report_id: 7, sr_no: 7, customer_id: null, order_id: null, status: 'Completed',
    inspected_by: null, inspection_date: null, template_id: 'general', template_version: null,
    drive_file_id: 'drive-old', revision_no: 4, data: { pdi_no: 'PDI-EDIT-1', customer_name: 'New Name' }, photos: [],
  };
  mockState.queries = [];
});

describe('patchReport editing an already-Completed report', () => {
  it('permitted edit with the correct expected_revision succeeds: bumps revision_no, snapshots the pre-edit data, and re-renders in the background', async () => {
    const result = await PdiReports.patchReport(
      7, { data: { pdi_no: 'PDI-EDIT-1', customer_name: 'New Name' } }, null,
      { role_id: 1, expected_revision: 3 }
    );

    expect(result.revision_no).toBe(4);
    expect(result.status).toBe('Completed');

    const snapshotInsert = mockState.queries.find((q) => /INSERT INTO pdi_report_revisions/.test(q.sql));
    expect(snapshotInsert.params).toEqual([7, 3, JSON.stringify({ pdi_no: 'PDI-EDIT-1', customer_name: 'Old Name' }), 1]);

    await result.background;
    expect(mockUpload).toHaveBeenCalledTimes(1);
    const driveUpdate = mockState.queries.find((q) => /SET drive_file_id/.test(q.sql));
    expect(driveUpdate.params).toEqual(['drive-new', 7]);
    // the superseded Drive file (from before this edit) gets cleaned up, not left orphaned
    expect(mockDeleteDrive).toHaveBeenCalledWith('drive-old');
  });

  it('does not leak the background promise into the JSON response shape', async () => {
    const result = await PdiReports.patchReport(
      7, { data: { pdi_no: 'PDI-EDIT-1' } }, null, { role_id: 1, expected_revision: 3 }
    );
    expect(JSON.stringify(result)).not.toMatch(/background/);
    await result.background;
  });

  it('rejects with FINALIZED_REPORT_FORBIDDEN when the role lacks can_write on PreDispatchInspectionReports, writing nothing', async () => {
    mockState.permissionRows = [];
    await expect(
      PdiReports.patchReport(7, { data: { pdi_no: 'PDI-EDIT-1' } }, null, { role_id: 99, expected_revision: 3 })
    ).rejects.toMatchObject({ code: 'FINALIZED_REPORT_FORBIDDEN' });
    expect(mockState.queries.some((q) => /INSERT INTO pdi_report_revisions/.test(q.sql))).toBe(false);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('rejects with REPORT_VERSION_CONFLICT when expected_revision is missing', async () => {
    await expect(
      PdiReports.patchReport(7, { data: { pdi_no: 'PDI-EDIT-1' } }, null, { role_id: 1 })
    ).rejects.toMatchObject({ code: 'REPORT_VERSION_CONFLICT' });
    expect(mockState.queries.some((q) => /INSERT INTO pdi_report_revisions/.test(q.sql))).toBe(false);
  });

  it('rejects with REPORT_VERSION_CONFLICT when expected_revision is stale', async () => {
    await expect(
      PdiReports.patchReport(7, { data: { pdi_no: 'PDI-EDIT-1' } }, null, { role_id: 1, expected_revision: 2 })
    ).rejects.toMatchObject({ code: 'REPORT_VERSION_CONFLICT' });
    expect(mockState.queries.some((q) => /INSERT INTO pdi_report_revisions/.test(q.sql))).toBe(false);
  });

  it('rejects with REPORT_VERSION_CONFLICT when a concurrent edit wins the race (the guarded UPDATE matches no row)', async () => {
    mockState.updateRows = []; // permission + pre-check both passed, but the UPDATE itself found no matching row
    await expect(
      PdiReports.patchReport(7, { data: { pdi_no: 'PDI-EDIT-1' } }, null, { role_id: 1, expected_revision: 3 })
    ).rejects.toMatchObject({ code: 'REPORT_VERSION_CONFLICT' });
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('never lets `status` change through this path, even if the caller sends one', async () => {
    await PdiReports.patchReport(
      7, { status: 'Pending', data: { pdi_no: 'PDI-EDIT-1' } }, null, { role_id: 1, expected_revision: 3 }
    );
    const finalUpdate = mockState.queries.find((q) => /status = 'Completed' AND revision_no = /.test(q.sql));
    expect(finalUpdate.sql).not.toMatch(/status = \$/);
  });

  it('does not touch permission/revision/snapshot machinery for a report that is NOT Completed (unchanged existing behavior)', async () => {
    mockState.preReadRow = { status: 'Pending', revision_no: 1, data: {} };
    mockState.updateRows = [{
      report_id: 7, sr_no: 7, customer_id: null, order_id: null, status: 'Pending',
      inspected_by: null, inspection_date: null, template_id: 'general', template_version: null,
      drive_file_id: null, revision_no: 1, data: { pdi_no: 'X' }, photos: [],
    }];
    const result = await PdiReports.patchReport(7, { data: { pdi_no: 'X' } }, null, {});
    expect(result.status).toBe('Pending');
    expect(mockState.queries.some((q) => /SELECT can_write FROM permissions/.test(q.sql))).toBe(false);
    expect(mockState.queries.some((q) => /INSERT INTO pdi_report_revisions/.test(q.sql))).toBe(false);
  });
});

describe('getRevisions', () => {
  it('returns snapshots newest-first', async () => {
    mockState.reportExists = true;
    mockState.revisionsRows = [
      { revision_no: 3, edited_by: 2, edited_at: new Date('2026-09-30T02:00:00Z'), data: { customer_name: 'B' } },
      { revision_no: 2, edited_by: 1, edited_at: new Date('2026-09-29T02:00:00Z'), data: { customer_name: 'A' } },
    ];
    const rows = await PdiReports.getRevisions(7);
    expect(rows).toEqual(mockState.revisionsRows);
  });

  it('throws "Report not found" for a report that does not exist', async () => {
    mockState.reportExists = false;
    await expect(PdiReports.getRevisions(999)).rejects.toThrow('Report not found');
  });
});
```

This test file's mock needs two more query patterns added for `getRevisions` (the existence check and the actual revisions SELECT) — these are added to `pdiReports.js` in Step 3 below, so add the corresponding mock branches now:

```js
  if (/SELECT 1 FROM pre_dispatch_inspection_reports WHERE report_id/.test(sql)) return { rows: mockState.reportExists ? [{ '?column?': 1 }] : [] };
  if (/FROM pdi_report_revisions WHERE report_id/.test(sql)) return { rows: mockState.revisionsRows || [] };
```

(Insert these two lines into the `mockQuery` implementation above, anywhere before the final catch-all `return { rows: [], rowCount: 0 };`.)

- [ ] **Step 3: Run the new test file to verify it fails**

Run: `npx jest tests/pdi_finalized_edit.test.js`
Expected: FAIL — `patchReport` doesn't know about `role_id`/`expected_revision` yet, and `PdiReports.getRevisions` doesn't exist.

- [ ] **Step 4: Implement the model changes**

In `models/operations/pdiReports.js`:

**4a. Import `hasPermission`.** Change the top of the file:
```js
const pool = require('../../config/db');
const logger = require('../../utils/logger');
const PDIGenerator = require('./pdi_generator');
const { uploadBufferToDrivePrivate, deleteDriveFile } = require('../../services/googleDrive');
const templates = require('./pdi/templates');
const AuthoredTemplates = require('./pdi/authoredTemplates');
const pdfCache = require('./pdi/pdfCache');
```
to:
```js
const pool = require('../../config/db');
const logger = require('../../utils/logger');
const PDIGenerator = require('./pdi_generator');
const { uploadBufferToDrivePrivate, deleteDriveFile } = require('../../services/googleDrive');
const { hasPermission } = require('../../middleware/auth');
const templates = require('./pdi/templates');
const AuthoredTemplates = require('./pdi/authoredTemplates');
const pdfCache = require('./pdi/pdfCache');
```

**4b. Add `revision_no` to the columns every read already selects.** Change:
```js
function reportColumns(prefix = '', { photosSummary = false } = {}) {
  const p = prefix ? `${prefix}.` : '';
  return `
    ${p}report_id, ${p}sr_no, ${p}customer_id, ${p}order_id, ${p}status,
    ${p}inspected_by, ${p}inspection_date, ${p}template_id, ${p}template_version, ${p}drive_file_id,
    ${p}data, ${photosSummary ? photosSummarySql(p) : `${p}photos`}
  `;
}
```
to:
```js
function reportColumns(prefix = '', { photosSummary = false } = {}) {
  const p = prefix ? `${prefix}.` : '';
  return `
    ${p}report_id, ${p}sr_no, ${p}customer_id, ${p}order_id, ${p}status,
    ${p}inspected_by, ${p}inspection_date, ${p}template_id, ${p}template_version, ${p}drive_file_id,
    ${p}revision_no,
    ${p}data, ${photosSummary ? photosSummarySql(p) : `${p}photos`}
  `;
}
```

**4c. Return `revision_no` in every payload.** Change `#toPayload`:
```js
  static #toPayload(row) {
    return {
      report_id: row.report_id,
      sr_no: row.sr_no,
      status: row.status,
      template_id: row.template_id,
      template_version: row.template_version,
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
```
to:
```js
  static #toPayload(row) {
    return {
      report_id: row.report_id,
      sr_no: row.sr_no,
      status: row.status,
      template_id: row.template_id,
      template_version: row.template_version,
      customer_id: row.customer_id,
      order_id: row.order_id,
      inspected_by: row.inspected_by,
      inspection_date: row.inspection_date,
      report_link: `/api/pdi/reports/${row.report_id}/pdf`,
      drive_file_id: row.drive_file_id,
      revision_no: row.revision_no,
      data: row.data,
      photos: row.photos,
    };
  }
```

**4d. Rewrite `patchReport`.** Change:
```js
  static async patchReport(reportId, fields, io, { photosSummary = false } = {}) {
    const _id = Number(reportId);
    if (!Number.isFinite(_id)) throw new Error('Report not found');

    const sets = [];
    const values = [];
    let i = 1;

    if (fields.status !== undefined) { sets.push(`status = $${i++}`); values.push(fields.status); }
    if (fields.inspected_by !== undefined) { sets.push(`inspected_by = $${i++}`); values.push(fields.inspected_by || null); }
    if (fields.inspection_date !== undefined) {
      sets.push(`inspection_date = $${i++}`);
      values.push(toIsoDateOrNull(fields.inspection_date));
    }
    if (fields.customer_id !== undefined) { sets.push(`customer_id = $${i++}`); values.push(fields.customer_id || null); }
    if (fields.order_id !== undefined) { sets.push(`order_id = $${i++}`); values.push(fields.order_id || null); }
    if (fields.data !== undefined) {
      sets.push(`data = $${i++}`);
      values.push(JSON.stringify(fields.data));
      // Keep the denormalized signer columns in sync with data on every write
      // that touches it -- these two columns can never legitimately drift
      // from what data actually contains.
      const { prepared_by, approved_by } = extractSignerNames(fields.data);
      sets.push(`prepared_by = $${i++}`); values.push(prepared_by);
      sets.push(`approved_by = $${i++}`); values.push(approved_by);
    }
    if (fields.photos !== undefined) {
      // Clients (notably the mobile app) re-send the whole photo set on every
      // save, even when only electrical/mechanical data changed. Writing a
      // multi-MB jsonb value costs seconds of TOAST/WAL work each time, and a
      // retried save queues behind the previous one on the same row. When the
      // incoming photos equal what's stored, keep the existing value: `photos`
      // in the THEN branch is the stored datum itself, so Postgres reuses its
      // TOAST pointer instead of rewriting it.
      sets.push(`photos = CASE WHEN photos = $${i}::jsonb THEN photos ELSE $${i}::jsonb END`);
      values.push(JSON.stringify(fields.photos));
      i++;
    }

    if (sets.length === 0) return this.getById(_id, { photosSummary });

    values.push(_id);
    // AND status <> 'Completed' -- a finalized report is locked against
    // further writes. Without this, a stale save-draft request from a
    // second device/tab that hasn't caught up with another device's
    // finalize (exactly the kind of delayed/retried write the client-side
    // timeout and retry work elsewhere is meant to tolerate) can silently
    // overwrite a Completed report's data/photos with older content and
    // even revert its status -- reproduced directly against this endpoint
    // during the investigation that led to this guard. No error, no trace,
    // just a "disappeared" finalized report. If a finalized report genuinely
    // needs correcting, Duplicate it into a new report instead of editing
    // the finalized one in place.
    const result = await pool.query(`
      UPDATE pre_dispatch_inspection_reports
      SET ${sets.join(', ')}
      WHERE report_id = $${i} AND status <> 'Completed'
      RETURNING ${reportColumns('', { photosSummary })}
    `, values);

    if (result.rows.length === 0) {
      // Only asking "does it exist?" -- never worth loading its photos for.
      const existing = await this.getById(_id, { photosSummary: true }).catch(() => null);
      if (!existing) throw new Error('Report not found');
      const lockedError = new Error('This report is already finalized and can no longer be edited. Duplicate it to make changes.');
      lockedError.code = 'REPORT_LOCKED';
      throw lockedError;
    }

    const payload = this.#toPayload(result.rows[0]);
    if (io?.emit) io.emit('pdiReportUpdate', { report_id: payload.report_id, status: payload.status });
    return payload;
  }
```

to:

```js
  static async patchReport(reportId, fields, io, { photosSummary = false, role_id = null, expected_revision } = {}) {
    const _id = Number(reportId);
    if (!Number.isFinite(_id)) throw new Error('Report not found');

    const sets = [];
    const values = [];
    let i = 1;

    if (fields.status !== undefined) { sets.push(`status = $${i++}`); values.push(fields.status); }
    if (fields.inspected_by !== undefined) { sets.push(`inspected_by = $${i++}`); values.push(fields.inspected_by || null); }
    if (fields.inspection_date !== undefined) {
      sets.push(`inspection_date = $${i++}`);
      values.push(toIsoDateOrNull(fields.inspection_date));
    }
    if (fields.customer_id !== undefined) { sets.push(`customer_id = $${i++}`); values.push(fields.customer_id || null); }
    if (fields.order_id !== undefined) { sets.push(`order_id = $${i++}`); values.push(fields.order_id || null); }
    if (fields.data !== undefined) {
      sets.push(`data = $${i++}`);
      values.push(JSON.stringify(fields.data));
      // Keep the denormalized signer columns in sync with data on every write
      // that touches it -- these two columns can never legitimately drift
      // from what data actually contains.
      const { prepared_by, approved_by } = extractSignerNames(fields.data);
      sets.push(`prepared_by = $${i++}`); values.push(prepared_by);
      sets.push(`approved_by = $${i++}`); values.push(approved_by);
    }
    if (fields.photos !== undefined) {
      // Clients (notably the mobile app) re-send the whole photo set on every
      // save, even when only electrical/mechanical data changed. Writing a
      // multi-MB jsonb value costs seconds of TOAST/WAL work each time, and a
      // retried save queues behind the previous one on the same row. When the
      // incoming photos equal what's stored, keep the existing value: `photos`
      // in the THEN branch is the stored datum itself, so Postgres reuses its
      // TOAST pointer instead of rewriting it.
      sets.push(`photos = CASE WHEN photos = $${i}::jsonb THEN photos ELSE $${i}::jsonb END`);
      values.push(JSON.stringify(fields.photos));
      i++;
    }

    // toIsoDateOrNull above can already have thrown INVALID_INSPECTION_DATE --
    // deliberately before any query, so a malformed date never even reaches
    // the database (this ordering predates this feature; keep it that way).
    if (sets.length === 0) return this.getById(_id, { photosSummary });

    // A report currently Completed needs a different guard (permission +
    // expected_revision, see the design spec) than a normal draft edit, and
    // must never have its `status` changed through this path once Completed
    // (that would silently un-finalize it -- finalizeReport's job, not this
    // one) -- so its current status/revision_no/data has to be known before
    // deciding which UPDATE to issue.
    const current = await pool.query(
      `SELECT status, revision_no, data FROM pre_dispatch_inspection_reports WHERE report_id = $1`,
      [_id]
    );
    if (current.rows.length === 0) throw new Error('Report not found');
    const { status: currentStatus, revision_no: currentRevision, data: currentData } = current.rows[0];

    if (currentStatus !== 'Completed') {
      // Unchanged from before this feature existed: a normal in-progress
      // report, no permission or revision requirement. AND status <>
      // 'Completed' is what originally made this a hard, unconditional lock
      // -- added after a stale save-draft request from a second device/tab
      // that hadn't caught up with another device's finalize (exactly the
      // kind of delayed/retried write the client-side timeout and retry work
      // elsewhere is meant to tolerate) was reproduced silently overwriting a
      // Completed report's data/photos with older content, with no error and
      // no trace. It still guards the same race here (now also covering the
      // rarer case of a concurrent finalize landing between the read above
      // and this UPDATE); a *permitted* edit to an already-Completed report
      // is a new, deliberate, gated path below, not a change to this guard.
      values.push(_id);
      const result = await pool.query(`
        UPDATE pre_dispatch_inspection_reports
        SET ${sets.join(', ')}
        WHERE report_id = $${i} AND status <> 'Completed'
        RETURNING ${reportColumns('', { photosSummary })}
      `, values);

      if (result.rows.length === 0) {
        const lockedError = new Error('This report is already finalized and can no longer be edited. Duplicate it to make changes.');
        lockedError.code = 'REPORT_LOCKED';
        throw lockedError;
      }

      const payload = this.#toPayload(result.rows[0]);
      if (io?.emit) io.emit('pdiReportUpdate', { report_id: payload.report_id, status: payload.status });
      return payload;
    }

    // Editing an already-Completed report -- gated by the permission this
    // module has always had in the `permissions` table but no PDI route has
    // ever checked until now, plus an optimistic-concurrency revision check.
    if (!(await hasPermission(role_id, 'PreDispatchInspectionReports', 'can_write'))) {
      const forbidden = new Error('Editing a finalized report requires PDI write permission.');
      forbidden.code = 'FINALIZED_REPORT_FORBIDDEN';
      throw forbidden;
    }
    if (expected_revision === undefined || expected_revision === null || Number(expected_revision) !== currentRevision) {
      const conflict = new Error('This report has been edited since you last loaded it. Reload and try again.');
      conflict.code = 'REPORT_VERSION_CONFLICT';
      throw conflict;
    }

    // `status` never changes through this path once a report is Completed --
    // that would silently un-finalize it, which is finalizeReport's job, not
    // this one. Drop it from the SET clause text; its value (if `fields.status`
    // was sent) stays harmlessly unreferenced in `values` -- Postgres doesn't
    // require every bound parameter to be used by the query text, only that
    // every $N IN the text has a value at that position.
    const finalizedSets = sets.filter((s) => !s.startsWith('status = $'));
    if (finalizedSets.length === 0) {
      // Only `status` was being sent (excluded above) -- nothing left to apply.
      return this.getById(_id, { photosSummary });
    }

    await pool.query(
      `INSERT INTO pdi_report_revisions (report_id, revision_no, data, edited_by) VALUES ($1, $2, $3, $4)`,
      [_id, currentRevision, JSON.stringify(currentData || {}), role_id || null]
    );

    finalizedSets.push('revision_no = revision_no + 1');
    values.push(_id, currentRevision);
    const result = await pool.query(`
      UPDATE pre_dispatch_inspection_reports
      SET ${finalizedSets.join(', ')}
      WHERE report_id = $${i} AND status = 'Completed' AND revision_no = $${i + 1}
      RETURNING ${reportColumns('', { photosSummary })}
    `, values);

    if (result.rows.length === 0) {
      // Another edit won the race between the read above and this UPDATE --
      // the snapshot row just inserted still accurately describes what
      // revision_no=`currentRevision` contained, so it's left in place.
      const conflict = new Error('This report was edited by someone else first. Reload and try again.');
      conflict.code = 'REPORT_VERSION_CONFLICT';
      throw conflict;
    }

    const payload = this.#toPayload(result.rows[0]);
    if (io?.emit) io.emit('pdiReportUpdate', { report_id: payload.report_id, status: payload.status });
    // Non-enumerable so `res.json(payload)` / JSON.stringify never leaks a
    // Promise into the API response -- callers that want to await it (tests,
    // same as finalizeReport's own `background`) still can.
    Object.defineProperty(payload, 'background', {
      value: this.#reRenderFinalizedReport(_id).catch(() => {}),
      enumerable: false,
    });
    return payload;
  }
```

**4e. Add `#reRenderFinalizedReport` (place it right after `#backupPdfToDrive`, which it closely mirrors).** Add this new private method:

```js
  // Fire-and-forget, same pattern as finalizeReport's own #backupPdfToDrive:
  // re-renders the PDF after a successful edit to an already-Completed
  // report (the one case where stored data can change after the PDF was
  // first built), refreshes the disk cache, and replaces the Drive backup --
  // deleting the superseded Drive file so edits don't leak storage. Never
  // throws: the edit itself already committed, so a failure here only means
  // the next GET /pdf falls back to rendering from the now-current data,
  // exactly like any other cache miss already does.
  static async #reRenderFinalizedReport(reportId) {
    const startedAt = Date.now();
    try {
      const report = await this.getById(reportId);
      const previousDriveFileId = report.drive_file_id; // the edit UPDATE never touches this column
      const pdfBuffer = await bufferPdf(await PDIGenerator.generate(
        report.template_id, report.template_version,
        { ...(report.data || {}), photos: report.photos || [] },
      ));
      await pdfCache.write(reportId, pdfBuffer);

      const safeNo = String(report.data?.pdi_no || reportId).replace(/[^a-zA-Z0-9_-]/g, '_');
      const uploaded = await uploadBufferToDrivePrivate(pdfBuffer, 'application/pdf', `PDI_${safeNo}.pdf`);
      const res = await pool.query(
        'UPDATE pre_dispatch_inspection_reports SET drive_file_id = $1 WHERE report_id = $2',
        [uploaded.id, reportId]
      );
      if (res.rowCount === 0) {
        // The report was deleted while this was uploading.
        await deleteDriveFile(uploaded.id).catch((e) => logger.warn(`Drive cleanup failed for deleted PDI report ${reportId}: ${e.message}`));
        return;
      }
      if (previousDriveFileId) {
        await deleteDriveFile(previousDriveFileId).catch((e) => logger.warn(`Failed to delete superseded Drive file for PDI report ${reportId}: ${e.message}`));
      }
      logger.info(`PDI report re-rendered after finalized edit: report ${reportId}, ${Date.now() - startedAt}ms, ${pdfBuffer.length} bytes`);
    } catch (e) {
      logger.warn(`Re-render after finalized edit failed for PDI report ${reportId}: ${e.message}`);
    }
  }
```

**4f. Add `getRevisions`.** Add this new public method, right after `patchReport`:

```js
  // Newest-first audit trail for an already-Completed report's edits -- see
  // the design spec. No permission gate on this read, matching every other
  // PDI GET today; only the write path (editing a Completed report) is gated.
  static async getRevisions(reportId) {
    const _id = Number(reportId);
    if (!Number.isFinite(_id)) throw new Error('Report not found');

    const exists = await pool.query('SELECT 1 FROM pre_dispatch_inspection_reports WHERE report_id = $1', [_id]);
    if (exists.rows.length === 0) throw new Error('Report not found');

    const result = await pool.query(
      `SELECT revision_no, edited_by, edited_at, data FROM pdi_report_revisions WHERE report_id = $1 ORDER BY revision_no DESC`,
      [_id]
    );
    return result.rows;
  }
```

- [ ] **Step 5: Update the stale `pdfCache.js` comment**

In `models/operations/pdi/pdfCache.js`, change:
```js
// A finished (Completed) PDI report is locked against edits, so the PDF built
// when it was finalized is the PDF it will always have -- there is nothing to
// gain by rendering it again on every "View PDF" / recovery request. This keeps
// the last MAX_FILES of them on the server's disk and serves them straight back.
```
to:
```js
// A finished (Completed) PDI report is locked against ordinary edits, so most
// of the time the PDF built when it was finalized is the PDF it will always
// have -- there is nothing to gain by rendering it again on every "View PDF" /
// recovery request. The one exception is a permission-gated edit to an
// already-Completed report (see pdiReports.js's patchReport and
// docs/superpowers/specs/2026-09-30-pdi-finalized-report-editing-design.md),
// which explicitly overwrites this cache entry after re-rendering. This keeps
// the last MAX_FILES of them on the server's disk and serves them straight back.
```

- [ ] **Step 6: Run both test files to verify they pass**

Run: `npx jest tests/pdi_finalized_edit.test.js tests/pdi_inspection_date.test.js`
Expected: PASS, all tests in both files.

- [ ] **Step 7: Run the full suite**

Run: `npx jest`
Expected: no NEW failures versus Task 2's Step 5 baseline.

- [ ] **Step 8: Commit**

```bash
git add models/operations/pdiReports.js models/operations/pdi/pdfCache.js tests/pdi_finalized_edit.test.js tests/pdi_inspection_date.test.js
git commit -m "feat: gate editing an already-Completed PDI report on permission + revision, with an audit trail"
```

---

### Task 4: Controller and route wiring

**Files:**
- Modify: `controllers/operations/pdiReports.controller.js`
- Modify: `routes/operations/pdiReports.js`

**Depends on Task 3** (`PdiReports.getRevisions` and `patchReport`'s new options must exist).

- [ ] **Step 1: Wire `req.user.role_id`/`expected_revision` through `patchReport`, and map the two new error codes**

Change:
```js
exports.patchReport = async (req, res) => {
  // Saves carry the whole report including base64 photos, so size and duration
  // are the first things needed to diagnose a failed or slow save.
  const started = Date.now();
  const bytes = req.headers['content-length'] || 'unknown';
  try {
    const report = await PdiReports.patchReport(req.params.id, req.body || {}, req.io, { photosSummary: wantsPhotosSummary(req) });
    await invalidateCache();
    const ms = Date.now() - started;
    if (ms > 5000) logger.warn(`Slow PDI report save: report ${req.params.id}, ${ms}ms, ${bytes} bytes`);
    res.json(report);
  } catch (error) {
    if (error.message === 'Report not found') return res.status(404).json({ error: error.message });
    if (error.code === 'REPORT_LOCKED') return res.status(409).json({ error: error.message, code: error.code });
    if (error.code === 'INVALID_INSPECTION_DATE') return res.status(400).json({ error: error.message, code: error.code });
    logger.error(`Error updating PDI report ${req.params.id} (${Date.now() - started}ms, ${bytes} bytes): ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};
```
to:
```js
exports.patchReport = async (req, res) => {
  // Saves carry the whole report including base64 photos, so size and duration
  // are the first things needed to diagnose a failed or slow save.
  const started = Date.now();
  const bytes = req.headers['content-length'] || 'unknown';
  try {
    const report = await PdiReports.patchReport(req.params.id, req.body || {}, req.io, {
      photosSummary: wantsPhotosSummary(req),
      role_id: req.user.role_id,
      expected_revision: req.body?.expected_revision,
    });
    await invalidateCache();
    const ms = Date.now() - started;
    if (ms > 5000) logger.warn(`Slow PDI report save: report ${req.params.id}, ${ms}ms, ${bytes} bytes`);
    res.json(report);
  } catch (error) {
    if (error.message === 'Report not found') return res.status(404).json({ error: error.message });
    if (error.code === 'REPORT_LOCKED') return res.status(409).json({ error: error.message, code: error.code });
    if (error.code === 'FINALIZED_REPORT_FORBIDDEN') return res.status(403).json({ error: error.message, code: error.code });
    if (error.code === 'REPORT_VERSION_CONFLICT') return res.status(409).json({ error: error.message, code: error.code });
    if (error.code === 'INVALID_INSPECTION_DATE') return res.status(400).json({ error: error.message, code: error.code });
    logger.error(`Error updating PDI report ${req.params.id} (${Date.now() - started}ms, ${bytes} bytes): ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};
```

- [ ] **Step 2: Add the `getRevisions` handler**

Add this new export, right after `exports.patchReport` (before `exports.finalizeReport`):

```js
exports.getRevisions = async (req, res) => {
  try {
    const revisions = await PdiReports.getRevisions(req.params.id);
    res.json(revisions);
  } catch (error) {
    if (error.message === 'Report not found') return res.status(404).json({ error: error.message });
    logger.error(`Error fetching PDI report revisions ${req.params.id}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};
```

- [ ] **Step 3: Mount the new route**

In `routes/operations/pdiReports.js`, change:
```js
router.patch('/:id', authenticateToken, controller.patchReport);
router.post('/:id/duplicate', authenticateToken, controller.duplicateReport);
router.post('/:id/finalize', authenticateToken, controller.finalizeReport);
router.get('/:id/pdf', authenticateToken, controller.downloadPdf);
router.delete('/:id', authenticateToken, controller.deleteReport);
```
to:
```js
router.patch('/:id', authenticateToken, controller.patchReport);
router.get('/:id/revisions', authenticateToken, controller.getRevisions);
router.post('/:id/duplicate', authenticateToken, controller.duplicateReport);
router.post('/:id/finalize', authenticateToken, controller.finalizeReport);
router.get('/:id/pdf', authenticateToken, controller.downloadPdf);
router.delete('/:id', authenticateToken, controller.deleteReport);
```

- [ ] **Step 4: Sanity-check the app still boots and the route is registered**

Run: `node -e "const app = require('./server'); const routes = app._router.stack.flatMap(l => l.route ? [l.route] : (l.handle?.stack || []).map(r => r.route)).filter(Boolean); console.log(routes.some(r => r.path === '/:id/revisions'))"`
Expected: prints `true`, no errors (requiring `server.js` does not start listening unless run as the main module — see its own guard — so this is safe to run repeatedly).

- [ ] **Step 5: Run the full suite one more time**

Run: `npx jest`
Expected: no NEW failures versus Task 3's baseline.

- [ ] **Step 6: Commit**

```bash
git add controllers/operations/pdiReports.controller.js routes/operations/pdiReports.js
git commit -m "feat: wire finalized-report editing and GET .../revisions into the PDI controller/routes"
```

---

### Task 5: Live verification (controller-personal, NOT a subagent)

No code changes in this task — pure verification against the real dev server and production RDS, same safety pattern used every prior round this session (clearly-named throwaway data, deleted afterward, nothing pushed).

- [ ] **Step 1:** Start the local dev server (`node server.js`, `FRONTEND_URL` override as usual) and confirm it boots clean.

- [ ] **Step 2:** Find (or create) a test user whose role has `can_write` on `PreDispatchInspectionReports` today (`Admin` or `Production` — confirmed live earlier this session) and one whose role does NOT (e.g. `Sales`), and get an auth token for each.

- [ ] **Step 3:** Create a real throwaway PDI report (clearly named, e.g. `pdi_no: "FINALIZE-EDIT-VERIFY-001"`), fill in the minimum required fields, and finalize it (`POST /api/pdi/reports/:id/finalize`). Note its `report_id`, and `GET` it back to confirm `revision_no: 1` is now present in the response.

- [ ] **Step 4:** As the PERMITTED role, `PATCH` the finalized report with a changed field and `expected_revision: 1`. Confirm: `200`, the response's `revision_no` is now `2`, and the changed field is reflected. Wait a couple of seconds (background re-render), then `GET /api/pdi/reports/:id/pdf` and confirm the PDF reflects the new value (render to PNG and eyeball it, or at minimum confirm the byte length changed from the pre-edit PDF).

- [ ] **Step 5:** `GET /api/pdi/reports/:id/revisions` and confirm exactly one snapshot is returned, with `revision_no: 1` and `data` matching the report's state from Step 3 (before the Step 4 edit).

- [ ] **Step 6:** As the UNPERMITTED role, attempt the same kind of `PATCH` with `expected_revision: 2` (the report's current revision after Step 4). Confirm `403 FINALIZED_REPORT_FORBIDDEN`.

- [ ] **Step 7:** As the PERMITTED role again, attempt a `PATCH` with a deliberately stale `expected_revision: 1` (the report is now at revision `2`). Confirm `409 REPORT_VERSION_CONFLICT`.

- [ ] **Step 8:** Confirm a completely ordinary (never-finalized) report's `PATCH` is totally unaffected: create a second throwaway `Pending` report, `PATCH` it with NO `expected_revision` in the body, using a token for the UNPERMITTED role, and confirm it still succeeds exactly as before this feature (no permission error).

- [ ] **Step 9: Clean up, and confirm the cascade delete actually works.** Delete the edited throwaway report from Steps 3-7 (`DELETE /api/pdi/reports/:id`) — this is the one with `pdi_report_revisions` rows (Task 1's migration added `ON DELETE CASCADE` specifically so this works without a foreign-key-violation error). Confirm the delete returns `200`, then confirm directly against the DB that its `pdi_report_revisions` rows are gone too (`SELECT COUNT(*) FROM pdi_report_revisions WHERE report_id = <id>` should be `0`). Delete the second (Step 8) throwaway report too.

- [ ] **Step 10:** Stop the local dev server. Run `git log origin/main..HEAD --oneline` and report the full list of unpushed commits to the user. Do not push anything without being asked.
