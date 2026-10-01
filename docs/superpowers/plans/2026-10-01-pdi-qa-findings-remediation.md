# PDI QA Findings Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every bug found in a rugged, adversarial QA pass across three PDI features (lot/batch reports, finalized-report editing, tolerance parity) — 4 Critical bugs plus an audit-trail gap, a completeness check, a Drive-file race, data-merge semantics, and two missing web UI capabilities.

**Architecture:** Backend fixes are all in `CRM_BACKEND/models/operations/pdiReports.js` and `pdiReportBatches.js`, plus one new small leaf module (`models/operations/pdi/batchOverrides.js`) to share override logic between them without a circular `require`. Web fixes add revision-tracking to all 3 existing generator forms and one new batch-creation flow for AutoNXT, reusing the existing single-report form for per-member editing rather than duplicating it.

**Tech Stack:** Node.js/Express/`pg` (CRM_BACKEND), React/axios (CRM). No test framework in either repo beyond existing mocked-`pool.query` Jest tests in CRM_BACKEND — new verification follows that same pattern plus live checks against the local dev server (already running, connected to production RDS).

**Spec:** `docs/superpowers/specs/2026-10-01-pdi-qa-findings-remediation-design.md` (this repo). Read it first for full rationale.

---

### Task 1: `patchReport` — fix the 500 crash, the audit-trail scope gap, and data-replace semantics

**Files:**
- Modify: `CRM_BACKEND/models/operations/pdiReports.js:233-320` (`patchReport`)
- Modify: `CRM_BACKEND/tests/pdi_finalized_edit.test.js`
- Modify: `CRM_BACKEND/tests/pdi_inspection_date.test.js`

The current function (read it yourself first to confirm nothing's changed since this plan was written):

```js
static async patchReport(reportId, fields, io, { photosSummary = false, role_id = null, edited_by = null, expected_revision } = {}) {
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
    const { prepared_by, approved_by } = extractSignerNames(fields.data);
    sets.push(`prepared_by = $${i++}`); values.push(prepared_by);
    sets.push(`approved_by = $${i++}`); values.push(approved_by);
  }
  if (fields.photos !== undefined) {
    sets.push(`photos = CASE WHEN photos = $${i}::jsonb THEN photos ELSE $${i}::jsonb END`);
    values.push(JSON.stringify(fields.photos));
    i++;
  }

  if (sets.length === 0) return this.getById(_id, { photosSummary });

  const current = await pool.query(
    `SELECT status, revision_no, data FROM pre_dispatch_inspection_reports WHERE report_id = $1`,
    [_id]
  );
  if (current.rows.length === 0) throw new Error('Report not found');
  const { status: currentStatus, revision_no: currentRevision, data: currentData } = current.rows[0];

  if (currentStatus !== 'Completed') {
    values.push(_id);
    const result = await pool.query(`
      UPDATE pre_dispatch_inspection_reports
      SET ${sets.join(', ')}
      WHERE report_id = $${i} AND status <> 'Completed'
      RETURNING ${reportColumns('', { photosSummary })}
    `, values);
    // ... REPORT_LOCKED handling unchanged below this point
```

The rest of the Completed-report branch (permission check, `expected_revision` check, `finalizedSets = sets.filter(...)`, transaction) follows after this and is **not changed by this task** except that the `finalizedSets = sets.filter((s) => !s.startsWith('status = $'))` line is deleted (it becomes dead code once `status` is never added to `sets` in the first place — see below) and every later reference to `finalizedSets` in that branch becomes a reference to `sets` directly, since `sets` itself is now already correctly scoped.

- [ ] **Step 1: Move the `current` pre-read to the top, before building `sets`/`values`**

Replace the whole function signature-through-pre-read block (everything from `static async patchReport(` through the `const { status: currentStatus, ... } = current.rows[0];` line) with:

```js
  static async patchReport(reportId, fields, io, { photosSummary = false, role_id = null, edited_by = null, expected_revision } = {}) {
    const _id = Number(reportId);
    if (!Number.isFinite(_id)) throw new Error('Report not found');

    // Read BEFORE building sets/values -- the Completed-report branch below
    // excludes several fields entirely (status, inspected_by, customer_id,
    // order_id, inspection_date) rather than filtering them out after the
    // fact, and that requires knowing currentStatus from the start. A
    // malformed inspection_date on a finalized edit is a no-op, not an
    // error (see toIsoDateOrNull call below) -- so even date validation
    // needs this read to have already happened.
    const current = await pool.query(
      `SELECT status, revision_no, data FROM pre_dispatch_inspection_reports WHERE report_id = $1`,
      [_id]
    );
    if (current.rows.length === 0) throw new Error('Report not found');
    const { status: currentStatus, revision_no: currentRevision, data: currentData } = current.rows[0];
    const isFinalizedEdit = currentStatus === 'Completed';

    const sets = [];
    const values = [];
    let i = 1;

    // status/inspected_by/customer_id/order_id/inspection_date are no-ops on
    // a finalized edit, not errors -- only data/photos are actually
    // editable once Completed (see the finalized-report-editing design).
    // Previously these were added unconditionally and `status` alone was
    // stripped from the SQL *text* afterward without removing its bound
    // *value*, leaving an unreferenced parameter Postgres couldn't
    // type-infer (42P18). Not adding them here at all, for any of the five
    // fields, avoids that whole class of bug rather than patching around
    // one instance of it.
    if (fields.status !== undefined && !isFinalizedEdit) { sets.push(`status = $${i++}`); values.push(fields.status); }
    if (fields.inspected_by !== undefined && !isFinalizedEdit) { sets.push(`inspected_by = $${i++}`); values.push(fields.inspected_by || null); }
    if (fields.inspection_date !== undefined && !isFinalizedEdit) {
      sets.push(`inspection_date = $${i++}`);
      values.push(toIsoDateOrNull(fields.inspection_date));
    }
    if (fields.customer_id !== undefined && !isFinalizedEdit) { sets.push(`customer_id = $${i++}`); values.push(fields.customer_id || null); }
    if (fields.order_id !== undefined && !isFinalizedEdit) { sets.push(`order_id = $${i++}`); values.push(fields.order_id || null); }
    if (fields.data !== undefined) {
      // Merge, not replace -- every current caller already resends full
      // form state, so this is behavior-identical to replace for them, but
      // a future caller that sends a partial `data` object no longer
      // silently deletes every field it didn't mention.
      sets.push(`data = data || $${i++}::jsonb`);
      values.push(JSON.stringify(fields.data));
      const { prepared_by, approved_by } = extractSignerNames(fields.data);
      sets.push(`prepared_by = $${i++}`); values.push(prepared_by);
      sets.push(`approved_by = $${i++}`); values.push(approved_by);
    }
    if (fields.photos !== undefined) {
      sets.push(`photos = CASE WHEN photos = $${i}::jsonb THEN photos ELSE $${i}::jsonb END`);
      values.push(JSON.stringify(fields.photos));
      i++;
    }

    if (sets.length === 0) return this.getById(_id, { photosSummary });
```

- [ ] **Step 2: Update the not-Completed branch to use `currentStatus`/`isFinalizedEdit` instead of re-deriving it**

Immediately after the block above, the existing not-Completed branch:

```js
    if (currentStatus !== 'Completed') {
```

stays exactly as-is (it's already correctly written against `currentStatus`, which is now just computed earlier) — **no change needed here**, confirm by reading it, don't edit it.

- [ ] **Step 3: Remove the now-dead `finalizedSets` filter line and its references**

In the Completed-report branch further down, find:

```js
    const finalizedSets = sets.filter((s) => !s.startsWith('status = $'));
    if (finalizedSets.length === 0) {
      return this.getById(_id, { photosSummary });
    }
```

and the later use of `finalizedSets` in the transaction's UPDATE:

```js
    finalizedSets.push('revision_no = revision_no + 1');
    values.push(_id, currentRevision);

    const client = await pool.connect();
    let rolledBack = false;
    let result;
    try {
      await client.query('BEGIN');

      result = await client.query(`
        UPDATE pre_dispatch_inspection_reports
        SET ${finalizedSets.join(', ')}
        WHERE report_id = $${i} AND status = 'Completed' AND revision_no = $${i + 1}
        RETURNING ${reportColumns('', { photosSummary })}
      `, values);
```

Replace all four of these (the filter line, the `if (finalizedSets.length === 0)` check, and both later `finalizedSets` references) by renaming every `finalizedSets` to `sets` and deleting the now-unnecessary filter line entirely:

```js
    if (sets.length === 0) {
      return this.getById(_id, { photosSummary });
    }
```
```js
    sets.push('revision_no = revision_no + 1');
    values.push(_id, currentRevision);

    const client = await pool.connect();
    let rolledBack = false;
    let result;
    try {
      await client.query('BEGIN');

      result = await client.query(`
        UPDATE pre_dispatch_inspection_reports
        SET ${sets.join(', ')}
        WHERE report_id = $${i} AND status = 'Completed' AND revision_no = $${i + 1}
        RETURNING ${reportColumns('', { photosSummary })}
      `, values);
```

(This second `if (sets.length === 0)` check is now slightly redundant with the one added in Step 1 — both can in theory be true at the same time, but the first one returns before this code is ever reached when ALL fields were excluded or absent. This second check still matters for the specific case where the only field sent was one of the five finalized-edit no-ops (e.g. a lone `status` on an already-Completed report) — `sets` would be non-empty after Step 1's build pass... wait: if `fields.status !== undefined && !isFinalizedEdit` is the only condition and `isFinalizedEdit` is true, NOTHING gets added for that field, so `sets` stays empty from that field alone. If that was the ONLY field in the request, the first `if (sets.length === 0)` check from Step 1 already catches it and returns early, before this second check is ever reached. Keep this second check anyway — it's still reachable if, say, only `fields.data` was absent on a Completed report but something else no-op-only was sent alongside nothing else, which can't actually happen given data/photos are the only two fields capable of producing a non-empty `sets` on the Completed path. In short: this check still acts as a defensive no-op if the first one's logic is ever revisited; leave it in place as written above, don't try to remove it as "provably unreachable" since that's not quite proven and removing it risks a real regression for no benefit.)

- [ ] **Step 4: Update `tests/pdi_finalized_edit.test.js` for the new behavior**

This file mocks `pool.query` and asserts on the literal SQL text sent. Read the whole file first. Specifically:
- Any assertion checking for `'data = $'` in the UPDATE text now needs to check for `'data = data || $'` instead (merge, not replace).
- Any assertion relying on `status = $1` appearing in a Completed-report UPDATE's SQL text (if any exist) needs removing/updating — `status` is never in the SQL text at all for a Completed-report edit now, by construction, not filtered out afterward.
- Add a new test case: calling `patchReport` on a Completed report with `{ data: { pdi_no: 'X' }, status: 'Pending', inspected_by: 'Someone', customer_id: 99, order_id: 42, inspection_date: '2026-01-01' }` and a valid `expected_revision` succeeds (200-equivalent in the mock), the resulting SQL text contains no reference to `status`, `inspected_by`, `customer_id`, `order_id`, or `inspection_date` as SET targets, and — critically — does NOT throw (this is the exact combination that caused the 500 crash; a mocked-DB test can't catch the real Postgres `42P18` type-inference error since the mock doesn't type-check parameters, but it CAN and must catch the underlying bug: that `status`'s value would have been pushed into `values` while its placeholder was stripped from the text, which is directly observable by asserting the final `values` array passed to the mocked `pool.query`/`client.query` has no stray extra entries and its length matches the number of `$N` placeholders actually present in the SQL text).

- [ ] **Step 5: Update `tests/pdi_inspection_date.test.js` for the new exclusion/ordering behavior**

Read the whole file first. The three existing calls:
```js
PdiReports.patchReport(1, { inspection_date: '22-09-2026' })   // expects throw INVALID_INSPECTION_DATE
await PdiReports.patchReport(1, { inspection_date: '2026-09-22' });  // expects success
PdiReports.patchReport(1, { inspection_date: '' })  // some expected behavior, check the file
```
These tests mock `pool.query` to return a non-Completed status for report 1 (check the mock setup at the top of the file) — if so, `isFinalizedEdit` is `false` for all three, and `toIsoDateOrNull` still runs and can still throw exactly as before; these three should pass unchanged. Add one new case: mock the `current` pre-read to return `status: 'Completed'` for a different report id, then call `patchReport(thatId, { inspection_date: '22-09-2026' }, null, { role_id: 1, expected_revision: <matching value> })` and assert it does NOT throw `INVALID_INSPECTION_DATE` (the malformed date is silently ignored on a finalized edit, not validated at all) — this directly tests the ordering/exclusion fix from Step 1's comment.

- [ ] **Step 6: Run the updated tests**

```bash
cd CRM_BACKEND
npx jest tests/pdi_finalized_edit.test.js tests/pdi_inspection_date.test.js
```
Expected: all pass, including the two new cases.

- [ ] **Step 7: Commit**

```bash
git add models/operations/pdiReports.js tests/pdi_finalized_edit.test.js tests/pdi_inspection_date.test.js
git commit -m "fix: exclude non-data/photos fields and merge (not replace) data on finalized-report edits"
```

---

### Task 2: `deleteReport` — batch- and status-aware guards

**Files:**
- Modify: `CRM_BACKEND/models/operations/pdiReports.js:773-792` (`deleteReport`)
- Modify: `CRM_BACKEND/controllers/operations/pdiReports.controller.js:181-191` (`deleteReport` handler)

Depends on nothing else in this plan. `hasPermission` is already imported in `pdiReports.js` (used by `patchReport`) — confirm the import line at the top of the file and reuse it.

- [ ] **Step 1: Replace `deleteReport`'s body**

Current code:
```js
  static async deleteReport(reportId, io) {
    const _id = Number(reportId);
    if (!Number.isFinite(_id)) throw new Error('Report not found');
    const result = await pool.query(
      'DELETE FROM pre_dispatch_inspection_reports WHERE report_id = $1 RETURNING report_id, drive_file_id',
      [_id]
    );
    if (result.rows.length === 0) throw new Error('Report not found');

    await pdfCache.remove(_id);

    const driveFileId = result.rows[0].drive_file_id;
    if (driveFileId) {
      try { await deleteDriveFile(driveFileId); }
      catch (e) { logger.warn(`Drive cleanup failed for PDI report ${_id} (file ${driveFileId}): ${e.message}`); }
    }

    if (io?.emit) io.emit('pdiReportUpdate', { report_id: _id, status: 'Deleted' });
    return { report_id: _id };
  }
```

Replace with:
```js
  static async deleteReport(reportId, io, { role_id = null } = {}) {
    const _id = Number(reportId);
    if (!Number.isFinite(_id)) throw new Error('Report not found');

    const check = await pool.query(`
      SELECT r.status, r.batch_id, b.status AS batch_status
      FROM pre_dispatch_inspection_reports r
      LEFT JOIN pdi_report_batches b ON b.batch_id = r.batch_id
      WHERE r.report_id = $1
    `, [_id]);
    if (check.rows.length === 0) throw new Error('Report not found');
    const { status, batch_id, batch_status } = check.rows[0];

    // No repair/renumbering mechanism exists for a batch once it's
    // Completed -- deleting a member then is what silently corrupts the
    // combined PDF on its next cache-miss re-render (lot_quantity stays
    // stale, pages just vanish, no error). Block outright rather than
    // building that repair tooling; a non-Completed batch's incompleteness
    // is already caught by finalizeBatch's own BATCH_INCOMPLETE check.
    if (batch_id && batch_status === 'Completed') {
      const err = new Error('This report belongs to a finalized batch lot and cannot be deleted.');
      err.code = 'BATCH_MEMBER_LOCKED';
      throw err;
    }

    // Same permission the finalized-report-editing feature already gates
    // PATCH behind -- deleting a finalized report is a more extreme edit,
    // not a different capability.
    if (status === 'Completed' && !(await hasPermission(role_id, 'PreDispatchInspectionReports', 'can_write'))) {
      const err = new Error('Deleting a finalized report requires PDI write permission.');
      err.code = 'FINALIZED_REPORT_FORBIDDEN';
      throw err;
    }

    const result = await pool.query(
      'DELETE FROM pre_dispatch_inspection_reports WHERE report_id = $1 RETURNING report_id, drive_file_id',
      [_id]
    );
    if (result.rows.length === 0) throw new Error('Report not found');

    await pdfCache.remove(_id);

    const driveFileId = result.rows[0].drive_file_id;
    if (driveFileId) {
      try { await deleteDriveFile(driveFileId); }
      catch (e) { logger.warn(`Drive cleanup failed for PDI report ${_id} (file ${driveFileId}): ${e.message}`); }
    }

    if (io?.emit) io.emit('pdiReportUpdate', { report_id: _id, status: 'Deleted' });
    return { report_id: _id };
  }
```

- [ ] **Step 2: Update the controller**

Current:
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

Replace with:
```js
exports.deleteReport = async (req, res) => {
  try {
    const result = await PdiReports.deleteReport(req.params.id, req.io, { role_id: req.user.role_id });
    await invalidateCache();
    res.json(result);
  } catch (error) {
    if (error.message === 'Report not found') return res.status(404).json({ error: error.message });
    if (error.code === 'BATCH_MEMBER_LOCKED') return res.status(409).json({ error: error.message, code: error.code });
    if (error.code === 'FINALIZED_REPORT_FORBIDDEN') return res.status(403).json({ error: error.message, code: error.code });
    logger.error(`Error deleting PDI report ${req.params.id}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};
```

- [ ] **Step 3: Live-verify against the local dev server**

Local backend should already be running on `http://localhost:8000` (confirm with `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8000/`; if not, restart it: `cd CRM_BACKEND && FRONTEND_URL=http://localhost:5174 node server.js &` and wait ~15s). Mint an Admin token:
```bash
cd CRM_BACKEND
node -e "
require('dotenv').config();
const jwt = require('jsonwebtoken');
console.log(jwt.sign({ user_id: 1, role_id: 1, name: 'Admin' }, process.env.JWT_SECRET, { expiresIn: '2h' }));
"
```
Create a throwaway AutoNXT batch of 2, finalize it, then `DELETE /api/pdi/reports/:id` on one member — confirm `409 BATCH_MEMBER_LOCKED`. Create a throwaway standalone report, finalize it, `DELETE` it as Admin (role_id 1, which has PDI write permission) — confirm it succeeds (200). Mint a token for a role WITHOUT PDI write permission (query `SELECT * FROM permissions WHERE module = 'PreDispatchInspectionReports'` to find one with `can_write = false`), attempt to delete a different finalized standalone report as that role — confirm `403 FINALIZED_REPORT_FORBIDDEN`. Clean up every report/batch you created.

- [ ] **Step 4: Commit**

```bash
git add models/operations/pdiReports.js controllers/operations/pdiReports.controller.js
git commit -m "fix: block deleting a finalized batch member, require write permission to delete a finalized report"
```

---

### Task 3: Individual-report PDF respects the batch's shared-field override

**Files:**
- Create: `CRM_BACKEND/models/operations/pdi/batchOverrides.js`
- Modify: `CRM_BACKEND/models/operations/pdiReportBatches.js` (switch to the new module)
- Modify: `CRM_BACKEND/models/operations/pdiReports.js:726-771` (`getPdfForDownload`) and `:673-702` (`#reRenderFinalizedReport`)

Independent of Tasks 1-2. Must land before any live verification that touches batch-member individual PDFs.

- [ ] **Step 1: Create the new module**

```js
'use strict';

const pool = require('../../../config/db');

// A real multi-motor AutoNXT lot repeats these five fields identically
// across every linked report -- optionally seeded once at batch creation,
// and (mirroring pdi_no's own authoritative-at-render behavior) kept
// consistent across the whole lot at render time even if an individual
// report's own data drifts. Shared between pdiReportBatches.js (the
// combined-PDF route, which already applied this) and pdiReports.js (the
// individual-PDF route, which didn't -- see getActiveBatchOverride below)
// as a separate leaf module specifically because pdiReportBatches.js
// already requires pdiReports.js, so the reverse require would be circular.
const SHARED_FIELDS = ['customer_name', 'product_id', 'product_specifications', 'drawing_no', 'controller_type'];

function pickSharedFields(source) {
  const picked = {};
  for (const f of SHARED_FIELDS) {
    if (source[f]) picked[f] = source[f];
  }
  return picked;
}

// null if the report isn't a batch member, or its batch isn't Completed yet
// -- a non-Completed batch's shared fields aren't authoritative over
// anything yet (finalizeBatch/getBatchPdfForDownload only ever apply this
// override on an already-Completed batch).
async function getActiveBatchOverride(reportId) {
  const { rows } = await pool.query(`
    SELECT b.pdi_no, b.customer_name, b.product_id, b.product_specifications, b.drawing_no, b.controller_type
    FROM pre_dispatch_inspection_reports r
    JOIN pdi_report_batches b ON b.batch_id = r.batch_id AND b.status = 'Completed'
    WHERE r.report_id = $1
  `, [reportId]);
  if (rows.length === 0) return null;
  return { pdi_no: rows[0].pdi_no, ...pickSharedFields(rows[0]) };
}

module.exports = { SHARED_FIELDS, pickSharedFields, getActiveBatchOverride };
```

- [ ] **Step 2: Switch `pdiReportBatches.js` to import from the new module**

At the top of `models/operations/pdiReportBatches.js`, find:
```js
const MIN_LOT_QUANTITY = 1;
const MAX_LOT_QUANTITY = 50; // a technical safety cap, not a real business limit

const SHARED_FIELDS = ['customer_name', 'product_id', 'product_specifications', 'drawing_no', 'controller_type'];

function pickSharedFields(source) {
  const picked = {};
  for (const f of SHARED_FIELDS) {
    if (source[f]) picked[f] = source[f];
  }
  return picked;
}
```
Replace with:
```js
const MIN_LOT_QUANTITY = 1;
const MAX_LOT_QUANTITY = 50; // a technical safety cap, not a real business limit

const { pickSharedFields } = require('./pdi/batchOverrides');
```
Add the new require alongside the file's other top-of-file `require`s (near `const pool = require('../../config/db');` etc.) instead if that reads more naturally — either placement is fine, just don't leave two definitions of `pickSharedFields` in the file. Confirm via `grep -n "SHARED_FIELDS\|pickSharedFields" models/operations/pdiReportBatches.js` that nothing else in the file still references the now-deleted local `SHARED_FIELDS` constant (it shouldn't — `pickSharedFields` is the only consumer).

- [ ] **Step 3: Apply the override in `getPdfForDownload`**

Current (`pdiReports.js`):
```js
    let t = Date.now();
    const report = await this.getById(_id);
    timings.loadMs = Date.now() - t;
    timings.photos = countPhotos(report.photos);

    t = Date.now();
    const generateTimings = {};
    const buffer = await bufferPdf(await PDIGenerator.generate(
      report.template_id, report.template_version,
      { ...(report.data || {}), photos: report.photos || [] },
      { timings: generateTimings },
    ));
```
Replace with:
```js
    let t = Date.now();
    const report = await this.getById(_id);
    timings.loadMs = Date.now() - t;
    timings.photos = countPhotos(report.photos);

    const batchOverride = await getActiveBatchOverride(_id);

    t = Date.now();
    const generateTimings = {};
    const buffer = await bufferPdf(await PDIGenerator.generate(
      report.template_id, report.template_version,
      { ...(report.data || {}), ...(batchOverride || {}), photos: report.photos || [] },
      { timings: generateTimings },
    ));
```
Add the import near the top of `pdiReports.js` alongside its other `require`s: `const { getActiveBatchOverride } = require('./pdi/batchOverrides');`

- [ ] **Step 4: Apply the override in `#reRenderFinalizedReport`**

Current:
```js
  static async #reRenderFinalizedReport(reportId) {
    const startedAt = Date.now();
    try {
      const report = await this.getById(reportId);
      const previousDriveFileId = report.drive_file_id;
      const pdfBuffer = await bufferPdf(await PDIGenerator.generate(
        report.template_id, report.template_version,
        { ...(report.data || {}), photos: report.photos || [] },
      ));
```
Replace with:
```js
  static async #reRenderFinalizedReport(reportId) {
    const startedAt = Date.now();
    try {
      const report = await this.getById(reportId);
      const previousDriveFileId = report.drive_file_id;
      const batchOverride = await getActiveBatchOverride(reportId);
      const pdfBuffer = await bufferPdf(await PDIGenerator.generate(
        report.template_id, report.template_version,
        { ...(report.data || {}), ...(batchOverride || {}), photos: report.photos || [] },
      ));
```

- [ ] **Step 5: Live-verify the drift is fixed**

Create a throwaway single-report batch (quantity 1) with `pdi_no: "QA-FIX-SINGLE"`. Before finalizing, `PATCH` the member report directly with `data.pdi_no = "DRIFTED"`. Finalize the batch. `GET /api/pdi/report-batches/:id/pdf` should show `PDI No: QA-FIX-SINGLE`. `GET /api/pdi/reports/:reportId/pdf` (the individual route, forcing a cache miss if needed by checking there's no cached entry yet for a freshly-finalized report) should NOW also show `PDI No: QA-FIX-SINGLE`, not `DRIFTED` — confirming the fix. Clean up the test batch/report.

- [ ] **Step 6: Commit**

```bash
git add models/operations/pdi/batchOverrides.js models/operations/pdiReportBatches.js models/operations/pdiReports.js
git commit -m "fix: individual report PDF now respects its batch's shared-field override"
```

---

### Task 4: Batch finalize requires `motor_sr_no` per member

**Files:**
- Modify: `CRM_BACKEND/models/operations/pdiReportBatches.js` (`finalizeBatch`)
- Modify: `CRM_BACKEND/controllers/operations/pdiReportBatches.controller.js` (`finalizeBatch` handler)

Independent of Tasks 1-3.

- [ ] **Step 1: Add the check**

In `finalizeBatch`, find:
```js
    for (const report of reports) {
      if (!report.data?.pdi_no) {
        const err = new Error(`Report ${report.report_id} (lot ${report.lot_index}) is missing pdi_no.`);
        err.code = 'PDI_NO_REQUIRED';
        throw err;
      }
    }
```
Replace with:
```js
    for (const report of reports) {
      if (!report.data?.pdi_no) {
        const err = new Error(`Report ${report.report_id} (lot ${report.lot_index}) is missing pdi_no.`);
        err.code = 'PDI_NO_REQUIRED';
        throw err;
      }
      if (!report.data?.motor_sr_no) {
        const err = new Error(`Report ${report.report_id} (lot ${report.lot_index}) is missing motor_sr_no.`);
        err.code = 'MOTOR_SR_NO_REQUIRED';
        throw err;
      }
    }
```

- [ ] **Step 2: Map the new error code in the controller**

In `controllers/operations/pdiReportBatches.controller.js`'s `finalizeBatch` handler, find:
```js
    if (error.code === 'PDI_NO_REQUIRED') return res.status(400).json({ error: error.message, code: error.code });
```
Add immediately after it:
```js
    if (error.code === 'MOTOR_SR_NO_REQUIRED') return res.status(400).json({ error: error.message, code: error.code });
```

- [ ] **Step 3: Live-verify**

Create a throwaway batch of 2, leave one member's `motor_sr_no` blank (don't PATCH it after creation), attempt to finalize — confirm `400 MOTOR_SR_NO_REQUIRED` naming the correct report/lot index, and that neither report nor the batch got marked Completed (re-`GET` the batch, confirm `status` is still not `'Completed'`). Fill in the missing field, finalize again, confirm success. Clean up.

- [ ] **Step 4: Commit**

```bash
git add models/operations/pdiReportBatches.js controllers/operations/pdiReportBatches.controller.js
git commit -m "feat: require motor_sr_no on every batch member before finalizing"
```

---

### Task 5: Fix the Drive-file-orphan race in `#reRenderFinalizedReport`

**Files:**
- Modify: `CRM_BACKEND/models/operations/pdiReports.js` (`#reRenderFinalizedReport`)

Independent of Tasks 1-4, but touches the same method Task 3 Step 4 already modified — do this task AFTER Task 3 is committed, editing the version of the method that already has `batchOverride` applied.

- [ ] **Step 1: Serialize the `drive_file_id` read-then-update with a row lock**

Current (after Task 3's change):
```js
  static async #reRenderFinalizedReport(reportId) {
    const startedAt = Date.now();
    try {
      const report = await this.getById(reportId);
      const previousDriveFileId = report.drive_file_id;
      const batchOverride = await getActiveBatchOverride(reportId);
      const pdfBuffer = await bufferPdf(await PDIGenerator.generate(
        report.template_id, report.template_version,
        { ...(report.data || {}), ...(batchOverride || {}), photos: report.photos || [] },
      ));
      await pdfCache.write(reportId, pdfBuffer);

      const safeNo = String(report.data?.pdi_no || reportId).replace(/[^a-zA-Z0-9_-]/g, '_');
      const uploaded = await uploadBufferToDrivePrivate(pdfBuffer, 'application/pdf', `PDI_${safeNo}.pdf`);
      const res = await pool.query(
        'UPDATE pre_dispatch_inspection_reports SET drive_file_id = $1 WHERE report_id = $2',
        [uploaded.id, reportId]
      );
      if (res.rowCount === 0) {
        await deleteDriveFile(uploaded.id).catch((e) => logger.warn(`Drive cleanup failed for PDI report ${reportId}: ${e.message}`));
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
Replace the `UPDATE`/`previousDriveFileId` handling (keep everything above `const uploaded = ...` and the final `logger.info`/`catch` unchanged) with:
```js
      const safeNo = String(report.data?.pdi_no || reportId).replace(/[^a-zA-Z0-9_-]/g, '_');
      const uploaded = await uploadBufferToDrivePrivate(pdfBuffer, 'application/pdf', `PDI_${safeNo}.pdf`);

      // SELECT ... FOR UPDATE + the write in one transaction serializes two
      // near-simultaneous re-renders on the same report: the second call's
      // SELECT blocks until the first's COMMIT, so it reads the FIRST
      // call's newly-set drive_file_id as its own "previous" value, instead
      // of both racers reading the same stale original and one of their
      // uploads going permanently unreferenced and undeleted.
      const client = await pool.connect();
      let previousDriveFileId;
      let rowCount;
      try {
        await client.query('BEGIN');
        const locked = await client.query(
          'SELECT drive_file_id FROM pre_dispatch_inspection_reports WHERE report_id = $1 FOR UPDATE',
          [reportId]
        );
        if (locked.rows.length === 0) {
          await client.query('ROLLBACK');
          await deleteDriveFile(uploaded.id).catch((e) => logger.warn(`Drive cleanup failed for PDI report ${reportId}: ${e.message}`));
          return;
        }
        previousDriveFileId = locked.rows[0].drive_file_id;
        const updated = await client.query(
          'UPDATE pre_dispatch_inspection_reports SET drive_file_id = $1 WHERE report_id = $2',
          [uploaded.id, reportId]
        );
        rowCount = updated.rowCount;
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }

      if (rowCount === 0) {
        await deleteDriveFile(uploaded.id).catch((e) => logger.warn(`Drive cleanup failed for PDI report ${reportId}: ${e.message}`));
        return;
      }
      if (previousDriveFileId) {
        await deleteDriveFile(previousDriveFileId).catch((e) => logger.warn(`Failed to delete superseded Drive file for PDI report ${reportId}: ${e.message}`));
      }
      logger.info(`PDI report re-rendered after finalized edit: report ${reportId}, ${Date.now() - startedAt}ms, ${pdfBuffer.length} bytes`);
```

- [ ] **Step 2: Live-verify no regression in the single-call case**

Edit a Completed test report once via the finalized-edit PATCH path (correct permission + `expected_revision`), wait a few seconds, confirm `GET /:id/pdf` reflects the edit and `drive_file_id` changed in the DB — same check as before, just confirming this refactor didn't break the common single-edit case. (The actual concurrency fix is hard to deterministically reproduce in a quick manual check — the transaction logic itself is the verification here; don't spend time trying to force a real race.)

- [ ] **Step 3: Commit**

```bash
git add models/operations/pdiReports.js
git commit -m "fix: serialize finalized-report re-render's Drive-file swap to prevent an orphaned upload"
```

---

### Task 6 (final code review, not a subagent): whole CRM_BACKEND diff review

Dispatch a final code-reviewer subagent for the combined diff of Tasks 1-5 (all in CRM_BACKEND), mirroring this session's established pattern. Fix anything it finds before moving to the CRM web tasks.

---

### Task 7: Revision-aware editing — `AutoNXTGeneratorForm.jsx`

**Files:**
- Modify: `CRM/src/components/admin/AutoNXTGeneratorForm.jsx`

Independent of all CRM_BACKEND tasks for implementation purposes, but can only be correctly live-verified once Task 1 is deployed to the local dev server.

- [ ] **Step 1: Track `revisionNo` and `reportStatus` alongside `reportId`**

Find:
```js
  const [reportId, setReportId] = useState(null);
  const [hasSaved, setHasSaved] = useState(false);
```
Replace with:
```js
  const [reportId, setReportId] = useState(null);
  const [hasSaved, setHasSaved] = useState(false);
  const [revisionNo, setRevisionNo] = useState(null);
  const [reportStatus, setReportStatus] = useState(null);
```

- [ ] **Step 2: Capture both on resume-load**

Find (in the resume-load `useEffect`):
```js
        setReportId(report.report_id);
        setHasSaved(true);
        setActiveTab('performance');
        setIsOpen(true);
      } catch (err) {
        notifyError(err.response?.data?.error || 'Could not load that PDI report.');
```
Replace with:
```js
        setReportId(report.report_id);
        setRevisionNo(report.revision_no ?? null);
        setReportStatus(report.status ?? null);
        setHasSaved(true);
        setActiveTab('performance');
        setIsOpen(true);
      } catch (err) {
        notifyError(err.response?.data?.error || 'Could not load that PDI report.');
```

- [ ] **Step 3: Set them on a fresh report create too (so they're not stale from a previous session)**

Find (in `handleOpen`):
```js
      setReportId(response.data.report_id);
      setHasSaved(false);
      setForm(defaultForm());
```
Replace with:
```js
      setReportId(response.data.report_id);
      setRevisionNo(response.data.revision_no ?? null);
      setReportStatus(response.data.status ?? null);
      setHasSaved(false);
      setForm(defaultForm());
```

- [ ] **Step 4: Add a helper that builds the status-aware PATCH payload extras, and 403/409-aware error handling**

Add this helper near `inspectedByValue` (same area):
```js
  // Omits `status` and adds `expected_revision` when the loaded report is
  // already Completed -- `status` is a no-op on that path server-side now,
  // but there's no reason to send a meaningless value; `expected_revision`
  // is required for the edit to succeed at all once Completed.
  const finalizedEditExtras = () =>
    reportStatus === 'Completed' ? { expected_revision: revisionNo } : { status: 'In Progress' };

  // 403/409 get specific messages distinct from the generic save-failure
  // toast -- a finalized-report edit rejected for permission reasons
  // should never look like "try again", and a stale revision should
  // explicitly prompt a reload rather than inviting a retry that will
  // fail identically.
  const handleSaveError = async (err) => {
    const code = err.response?.data?.code;
    if (code === 'FINALIZED_REPORT_FORBIDDEN') {
      notifyError('You don’t have permission to edit a finalized report.');
      return;
    }
    if (code === 'REPORT_VERSION_CONFLICT') {
      notifyError('This report changed since you loaded it. Reloading...');
      if (!reportId) return;
      try {
        const token = localStorage.getItem('token');
        const response = await axios.get(`${API_URL}/api/pdi/reports/${reportId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        setRevisionNo(response.data.revision_no ?? null);
        setReportStatus(response.data.status ?? null);
      } catch {
        // If the reload itself fails, the next save attempt will just hit
        // the same 409 again and re-trigger this same path -- no further
        // handling needed here.
      }
      return;
    }
    notifyError(err.response?.data?.error || 'Failed to save progress.');
  };
```

- [ ] **Step 5: Wire `handleSave` to use both**

Find:
```js
  const handleSave = async () => {
    if (!reportId) return;
    const token = localStorage.getItem('token');
    if (!token) { notifyError('Please log in first.'); return; }
    setSaving(true);
    try {
      const { photos, ...data } = form;
      await axios.patch(`${API_URL}/api/pdi/reports/${reportId}`, {
        data: withComputedSpecDisplays(data), photos, status: 'In Progress', inspected_by: inspectedByValue(),
        inspection_date: form.date || undefined,
      }, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setHasSaved(true);
      notifySuccess('Progress saved.');
    } catch (err) {
      notifyError(err.response?.data?.error || 'Failed to save progress.');
    } finally {
      setSaving(false);
    }
  };
```
Replace with:
```js
  const handleSave = async () => {
    if (!reportId) return;
    const token = localStorage.getItem('token');
    if (!token) { notifyError('Please log in first.'); return; }
    setSaving(true);
    try {
      const { photos, ...data } = form;
      const response = await axios.patch(`${API_URL}/api/pdi/reports/${reportId}`, {
        data: withComputedSpecDisplays(data), photos, inspected_by: inspectedByValue(),
        inspection_date: form.date || undefined,
        ...finalizedEditExtras(),
      }, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setRevisionNo(response.data.revision_no ?? revisionNo);
      setHasSaved(true);
      notifySuccess('Progress saved.');
    } catch (err) {
      await handleSaveError(err);
    } finally {
      setSaving(false);
    }
  };
```

- [ ] **Step 6: Wire `handleFinalize`'s pre-finalize save the same way**

Find (inside `handleFinalize`):
```js
      const { photos, ...data } = form;
      await axios.patch(`${API_URL}/api/pdi/reports/${reportId}`, {
        data: withComputedSpecDisplays(data), photos, inspected_by: inspectedByValue(),
        inspection_date: form.date || undefined,
      }, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      setHasSaved(true);
```
Replace with:
```js
      const { photos, ...data } = form;
      const saveResponse = await axios.patch(`${API_URL}/api/pdi/reports/${reportId}`, {
        data: withComputedSpecDisplays(data), photos, inspected_by: inspectedByValue(),
        inspection_date: form.date || undefined,
        ...finalizedEditExtras(),
      }, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      setRevisionNo(saveResponse.data.revision_no ?? revisionNo);
      setHasSaved(true);
```
(This function's own `catch` block already exists further down for the finalize POST's own errors — leave that as-is; this PATCH call was already inside the same `try`, so a 403/409 here falls into that same existing catch. Check what that catch block currently does: if it's a generic `notifyError(...)`, that's an acceptable existing behavior for this specific call site — the spec doesn't require special-casing 403/409 inside `handleFinalize`, only `handleSave`, since finalizing a report that's ALREADY Completed isn't really a supported flow to begin with (finalize is for Pending/In Progress reports becoming Completed, not re-finalizing). Don't add handleSaveError's reload logic here — it doesn't apply to this call site.)

- [ ] **Step 7: Commit**

```bash
cd CRM
git add src/components/admin/AutoNXTGeneratorForm.jsx
git commit -m "feat: make AutoNXT generator form revision-aware so editing a finalized report actually works"
```

---

### Task 8: Revision-aware editing — `PDIGeneratorForm.jsx`

**Files:**
- Modify: `CRM/src/components/admin/PDIGeneratorForm.jsx`

Same pattern as Task 7, same file structure (plain `useState`, explicit `handleSave`/`handleFinalize`). Independent of Task 7.

- [ ] **Step 1: Track `revisionNo`/`reportStatus`**

Find the `reportId` state declaration (search `const [reportId, setReportId] = useState`) and add immediately after it:
```js
  const [revisionNo, setRevisionNo] = useState(null);
  const [reportStatus, setReportStatus] = useState(null);
```

- [ ] **Step 2: Capture on resume-load**

Find (in the resume-load effect):
```js
        setReportId(report.report_id);
        // It already exists server-side — Cancel should close, never delete it.
        setHasSaved(true);
```
Replace with:
```js
        setReportId(report.report_id);
        setRevisionNo(report.revision_no ?? null);
        setReportStatus(report.status ?? null);
        // It already exists server-side — Cancel should close, never delete it.
        setHasSaved(true);
```

- [ ] **Step 3: Capture on fresh create**

Find wherever this form's own equivalent of `handleOpen` sets `reportId` after `POST /api/pdi/reports` (search `axios.post(\`${API_URL}/api/pdi/reports\`` in this file) and add the same two `setRevisionNo`/`setReportStatus` lines right after that `setReportId(...)` call, reading `response.data.revision_no`/`response.data.status`.

- [ ] **Step 4: Add the same two helpers**

Add near wherever this form computes its save payload's `inspected_by` value:
```js
  const finalizedEditExtras = () =>
    reportStatus === 'Completed' ? { expected_revision: revisionNo } : { status: 'In Progress' };

  const handleSaveError = async (err) => {
    const code = err.response?.data?.code;
    if (code === 'FINALIZED_REPORT_FORBIDDEN') {
      notifyError('You don’t have permission to edit a finalized report.');
      return;
    }
    if (code === 'REPORT_VERSION_CONFLICT') {
      notifyError('This report changed since you loaded it. Reloading...');
      if (!reportId) return;
      try {
        const token = localStorage.getItem('token');
        const response = await axios.get(`${API_URL}/api/pdi/reports/${reportId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        setRevisionNo(response.data.revision_no ?? null);
        setReportStatus(response.data.status ?? null);
      } catch {
        // next save attempt will re-hit the same 409 and re-trigger this
      }
      return;
    }
    notifyError(err.response?.data?.error || 'Failed to save progress.');
  };
```

- [ ] **Step 5: Wire `handleSave`**

Find:
```js
      await axios.patch(`${API_URL}/api/pdi/reports/${reportId}`, {
        data, photos, status: 'In Progress', inspected_by: form.prepared_by?.trim() || undefined,
        inspection_date: form.date || undefined,
      }, {
        headers: { Authorization: `Bearer ${token}` },
      });
```
(this is inside `handleSave`, around line 782) — replace with:
```js
      const response = await axios.patch(`${API_URL}/api/pdi/reports/${reportId}`, {
        data, photos, inspected_by: form.prepared_by?.trim() || undefined,
        inspection_date: form.date || undefined,
        ...finalizedEditExtras(),
      }, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setRevisionNo(response.data.revision_no ?? revisionNo);
```
and find this `handleSave`'s existing `catch` block (it should currently read something like `notifyError(err.response?.data?.error || 'Failed to save progress.');`) and replace that one line with `await handleSaveError(err);`.

- [ ] **Step 6: Wire `handleFinalize`'s pre-finalize save**

Find (around line 816, inside `handleFinalize`):
```js
      await axios.patch(`${API_URL}/api/pdi/reports/${reportId}`, {
        data, photos, inspected_by: form.prepared_by?.trim() || undefined,
        inspection_date: form.date || undefined,
      }, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
```
Replace with:
```js
      const saveResponse = await axios.patch(`${API_URL}/api/pdi/reports/${reportId}`, {
        data, photos, inspected_by: form.prepared_by?.trim() || undefined,
        inspection_date: form.date || undefined,
        ...finalizedEditExtras(),
      }, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      setRevisionNo(saveResponse.data.revision_no ?? revisionNo);
```
Leave this call site's own existing catch behavior as-is (same reasoning as Task 7 Step 6 — finalize's pre-save isn't the place to add reload-on-409 logic).

- [ ] **Step 7: Commit**

```bash
cd CRM
git add src/components/admin/PDIGeneratorForm.jsx
git commit -m "feat: make General generator form revision-aware so editing a finalized report actually works"
```

---

### Task 9: Revision-aware editing — `GenericPdiGeneratorForm.jsx`

**Files:**
- Modify: `CRM/src/components/admin/GenericPdiGeneratorForm.jsx`

Independent of Tasks 7-8. This file uses a different architecture (debounced autosave via `runDataSave`/`runPhotosSave` chained promises, plus an explicit `handleSave`/`doFinalize` pair, plus a resume-load effect and a create flow) — five call sites total need the same treatment, not two. Read the whole file's save-related code fresh before starting (the specific line numbers below are from this session's read and may drift slightly if the file has changed).

- [ ] **Step 1: Add refs mirroring the file's existing `reportIdRef`-style pattern**

This file already uses refs (`reportIdRef`, `formRef`, `inspectedByRef`, etc. — confirm the exact existing ref names by reading the top of the component) to let the debounce-chain functions read current values without stale closures. Find wherever `reportIdRef` is declared/kept in sync (likely a `useRef` plus a `useEffect` syncing it from the `reportId` state, or it's assigned directly) and add two siblings the same way:
```js
  const [revisionNo, setRevisionNo] = useState(null);
  const [reportStatus, setReportStatus] = useState(null);
  const revisionNoRef = useRef(null);
  const reportStatusRef = useRef(null);
  useEffect(() => { revisionNoRef.current = revisionNo; }, [revisionNo]);
  useEffect(() => { reportStatusRef.current = reportStatus; }, [reportStatus]);
```
(If `reportIdRef` is kept in sync via a different mechanism than a `useEffect` — e.g. set directly inside the same callbacks that call `setReportId` — mirror THAT mechanism instead for consistency; read the actual existing code first rather than assuming the `useEffect` form.)

- [ ] **Step 2: Capture both on resume-load**

Find (in the resume-load effect):
```js
        setForm(resumedForm);
        setActiveKey(flattenSections(definition)[0]?.key ?? 'review');
        setReportId(report.report_id);
        hasSavedRef.current = true;
```
Replace with:
```js
        setForm(resumedForm);
        setActiveKey(flattenSections(definition)[0]?.key ?? 'review');
        setReportId(report.report_id);
        setRevisionNo(report.revision_no ?? null);
        setReportStatus(report.status ?? null);
        hasSavedRef.current = true;
```

- [ ] **Step 3: Capture on fresh create**

Find (around line 689, the `POST /api/pdi/reports` create call) and add the same two `setRevisionNo`/`setReportStatus` calls right after `setReportId(response.data.report_id);`, reading from `response.data`.

- [ ] **Step 4: Add a ref-based version of the extras helper (not state-based, since the debounce chain reads refs, not closures)**

```js
  // Ref-based (not the plain helper Tasks 7/8 use) because runDataSave/
  // runPhotosSave below read every other piece of save-time state via refs
  // too, for the same stale-closure reason documented at this file's own
  // dataSaveChainRef/photosSaveChainRef comment.
  const finalizedEditExtrasRef = useCallback(
    () => (reportStatusRef.current === 'Completed'
      ? { expected_revision: revisionNoRef.current }
      : { status: 'In Progress' }),
    [],
  );

  const handleFinalizedEditError = useCallback(async (err) => {
    const code = err.response?.data?.code;
    if (code === 'FINALIZED_REPORT_FORBIDDEN') {
      notifyError('You don’t have permission to edit a finalized report.');
      return true;
    }
    if (code === 'REPORT_VERSION_CONFLICT') {
      notifyError('This report changed since you loaded it. Reloading...');
      if (!reportIdRef.current) return true;
      try {
        const token = localStorage.getItem('token');
        const response = await axios.get(`${API_URL}/api/pdi/reports/${reportIdRef.current}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        setRevisionNo(response.data.revision_no ?? null);
        setReportStatus(response.data.status ?? null);
      } catch {
        // next save attempt re-hits the same 409 and re-triggers this
      }
      return true;
    }
    return false; // not a finalized-edit-specific error -- caller handles it as before
  }, [notifyError]);
```

- [ ] **Step 5: Wire `runDataSave`**

Find:
```js
        await axios.patch(`${API_URL}/api/pdi/reports/${reportIdRef.current}`, {
          data, status: 'In Progress',
          inspected_by: inspectedByRef.current(), inspection_date: inspectionDateRef.current(formRef.current),
        }, { headers: { Authorization: `Bearer ${token}` } });
        hasSavedRef.current = true;
        dataSavedSignatureRef.current = sentSignature;
        setSaveStatus(sentSignature === dataOnlySignature(formRef.current) ? 'saved' : 'unsaved');
      } catch {
        setSaveStatus('error');
      }
```
Replace with:
```js
        const response = await axios.patch(`${API_URL}/api/pdi/reports/${reportIdRef.current}`, {
          data,
          inspected_by: inspectedByRef.current(), inspection_date: inspectionDateRef.current(formRef.current),
          ...finalizedEditExtrasRef(),
        }, { headers: { Authorization: `Bearer ${token}` } });
        setRevisionNo(response.data.revision_no ?? revisionNoRef.current);
        hasSavedRef.current = true;
        dataSavedSignatureRef.current = sentSignature;
        setSaveStatus(sentSignature === dataOnlySignature(formRef.current) ? 'saved' : 'unsaved');
      } catch (err) {
        await handleFinalizedEditError(err);
        setSaveStatus('error');
      }
```
(`setSaveStatus('error')` runs unconditionally — `handleFinalizedEditError`'s return value isn't used here, only its side effect (showing a 403/409-specific message when applicable) matters. The autosave UI only has a generic "error" indicator today, and this task isn't adding a richer one for the autosave path specifically — Step 7/8's explicit `handleSave`/`doFinalize` are where a user-initiated action gets the full reload treatment front and center, and where the boolean return value actually gets used to decide whether to ALSO show a generic fallback message.)

- [ ] **Step 6: Wire `runPhotosSave`**

Find:
```js
        await axios.patch(`${API_URL}/api/pdi/reports/${reportIdRef.current}`, { photos }, {
          headers: { Authorization: `Bearer ${token}` },
        });
        hasSavedRef.current = true;
        photosSavedSignatureRef.current = sentSignature;
        setSaveStatus(sentSignature === JSON.stringify(formRef.current.photos) ? 'saved' : 'unsaved');
      } catch {
        setSaveStatus('error');
      }
```
Replace with:
```js
        const response = await axios.patch(`${API_URL}/api/pdi/reports/${reportIdRef.current}`, {
          photos,
          ...finalizedEditExtrasRef(),
        }, {
          headers: { Authorization: `Bearer ${token}` },
        });
        setRevisionNo(response.data.revision_no ?? revisionNoRef.current);
        hasSavedRef.current = true;
        photosSavedSignatureRef.current = sentSignature;
        setSaveStatus(sentSignature === JSON.stringify(formRef.current.photos) ? 'saved' : 'unsaved');
      } catch (err) {
        await handleFinalizedEditError(err);
        setSaveStatus('error');
      }
```

- [ ] **Step 7: Wire the explicit `handleSave`**

Find (inside `handleSave`):
```js
      await axios.patch(`${API_URL}/api/pdi/reports/${reportId}`, {
        data, photos, status: 'In Progress', inspected_by: inspectedByValue(),
        inspection_date: inspectionDateValue(form),
      }, {
        headers: { Authorization: `Bearer ${token}` },
      });
      hasSavedRef.current = true;
      dataSavedSignatureRef.current = sentDataSignature;
      photosSavedSignatureRef.current = sentPhotosSignature;
      setSaveStatus('saved');
      notifySuccess('Progress saved.');
    } catch (err) {
      setSaveStatus('error');
      notifyError(err.response?.data?.error || 'Failed to save progress.');
    } finally {
```
Replace with:
```js
      const response = await axios.patch(`${API_URL}/api/pdi/reports/${reportId}`, {
        data, photos, inspected_by: inspectedByValue(),
        inspection_date: inspectionDateValue(form),
        ...finalizedEditExtrasRef(),
      }, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setRevisionNo(response.data.revision_no ?? revisionNo);
      hasSavedRef.current = true;
      dataSavedSignatureRef.current = sentDataSignature;
      photosSavedSignatureRef.current = sentPhotosSignature;
      setSaveStatus('saved');
      notifySuccess('Progress saved.');
    } catch (err) {
      setSaveStatus('error');
      if (!(await handleFinalizedEditError(err))) {
        notifyError(err.response?.data?.error || 'Failed to save progress.');
      }
    } finally {
```

- [ ] **Step 8: Wire `doFinalize`'s pre-finalize save**

Find (inside `doFinalize`):
```js
      await axios.patch(`${API_URL}/api/pdi/reports/${reportId}`, {
        data, photos, inspected_by: inspectedByRef.current(),
        inspection_date: inspectionDateRef.current(formRef.current),
      }, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      hasSavedRef.current = true;
```
Replace with:
```js
      const saveResponse = await axios.patch(`${API_URL}/api/pdi/reports/${reportId}`, {
        data, photos, inspected_by: inspectedByRef.current(),
        inspection_date: inspectionDateRef.current(formRef.current),
        ...finalizedEditExtrasRef(),
      }, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      setRevisionNo(saveResponse.data.revision_no ?? revisionNo);
      hasSavedRef.current = true;
```
Leave `doFinalize`'s existing catch block as-is (same reasoning as Tasks 7/8 — re-finalizing an already-Completed report isn't a supported flow this task needs to special-case).

- [ ] **Step 9: Commit**

```bash
cd CRM
git add src/components/admin/GenericPdiGeneratorForm.jsx
git commit -m "feat: make the generic/authored-template generator form revision-aware for finalized edits"
```

---

### Task 10: Batch creation UI (AutoNXT)

**Files:**
- Create: `CRM/src/components/admin/AutoNXTBatchForm.jsx`
- Modify: `CRM/src/routeConfig.jsx` (add route)
- Modify: `CRM/src/components/admin/AutoNXTGeneratorForm.jsx` (add a link to the new flow)

Depends on Task 7 being committed (reuses `AutoNXTGeneratorForm` for per-member editing via its existing `?report=<id>` resume convention — no new dependency on Task 7's specific diff, just wants that form's revision-awareness already in place so a batch member opened through this new screen gets the same correct behavior once it's `Completed`).

- [ ] **Step 1: Create the new component**

```jsx
import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ClipboardCheck, Layers, Eye, Download } from 'lucide-react';
import axios from 'axios';
import { useNotify } from '../../hooks/useNotify';

const API_URL = import.meta.env.VITE_BACKEND_URL || '';

const INPUT_CLS =
  'w-full border border-navy-100 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold-400';

const SHARED_FIELDS = [
  { key: 'customer_name', label: 'Customer name', placeholder: 'e.g. AutoNXT' },
  { key: 'product_id', label: 'Product ID', placeholder: 'e.g. PMSM220_HV32384' },
  { key: 'product_specifications', label: 'Product specifications', placeholder: 'e.g. 32.0kW, 384V, 2350 RPM' },
  { key: 'drawing_no', label: 'Drawing number', placeholder: 'e.g. CASPL-220/007-00' },
  { key: 'controller_type', label: 'Controller type', placeholder: 'e.g. CASHV38140' },
];

const emptyForm = () => ({
  pdi_no: '', quantity: '',
  customer_name: '', product_id: '', product_specifications: '', drawing_no: '', controller_type: '',
});

export default function AutoNXTBatchForm() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { notifySuccess, notifyError } = useNotify();
  const [form, setForm] = useState(emptyForm());
  const [creating, setCreating] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [batch, setBatch] = useState(null);
  const [loadingBatch, setLoadingBatch] = useState(false);

  const batchId = searchParams.get('batch');

  const loadBatch = useCallback(async (id) => {
    const token = localStorage.getItem('token');
    if (!token) { notifyError('Please log in first.'); return; }
    setLoadingBatch(true);
    try {
      const response = await axios.get(`${API_URL}/api/pdi/report-batches/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setBatch(response.data);
    } catch (err) {
      notifyError(err.response?.data?.error || 'Could not load that batch.');
    } finally {
      setLoadingBatch(false);
    }
  }, [notifyError]);

  useEffect(() => {
    if (batchId) loadBatch(batchId);
  }, [batchId, loadBatch]);

  const setField = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!form.pdi_no.trim()) { notifyError('PDI No. is required.'); return; }
    const quantity = Number(form.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) {
      notifyError('Quantity must be a whole number between 1 and 50.');
      return;
    }
    const token = localStorage.getItem('token');
    if (!token) { notifyError('Please log in first.'); return; }
    setCreating(true);
    try {
      const optional = Object.fromEntries(
        SHARED_FIELDS.map(({ key }) => [key, form[key].trim()]).filter(([, v]) => Boolean(v))
      );
      const response = await axios.post(`${API_URL}/api/pdi/report-batches`, {
        template_id: 'autonxt', pdi_no: form.pdi_no.trim(), quantity, ...optional,
      }, {
        headers: { Authorization: `Bearer ${token}` },
      });
      notifySuccess(`Batch created with ${quantity} linked report(s).`);
      navigate(`/pdi-generator/autonxt-batch?batch=${response.data.batch_id}`, { replace: true });
    } catch (err) {
      notifyError(err.response?.data?.error || 'Could not create this batch.');
    } finally {
      setCreating(false);
    }
  };

  const handleFinalizeBatch = async () => {
    if (!batch) return;
    const token = localStorage.getItem('token');
    if (!token) { notifyError('Please log in first.'); return; }
    setFinalizing(true);
    try {
      const response = await axios.post(`${API_URL}/api/pdi/report-batches/${batch.batch_id}/finalize`, {}, {
        headers: { Authorization: `Bearer ${token}` },
        responseType: 'blob',
      });
      const blob = new Blob([response.data], { type: 'application/pdf' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `PDI_BATCH_${String(batch.pdi_no || batch.batch_id).replace(/[^a-zA-Z0-9_-]/g, '_')}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      notifySuccess('Batch finalized and combined PDF downloaded.');
      await loadBatch(batch.batch_id);
    } catch (err) {
      if (err.response?.data instanceof Blob) {
        try {
          const text = await err.response.data.text();
          const parsed = JSON.parse(text);
          notifyError(parsed.error || text || 'Failed to finalize batch.');
        } catch {
          notifyError('Failed to finalize batch.');
        }
      } else {
        notifyError(err.response?.data?.error || 'Failed to finalize batch.');
      }
    } finally {
      setFinalizing(false);
    }
  };

  const handleDownloadBatchPdf = async () => {
    if (!batch) return;
    const token = localStorage.getItem('token');
    try {
      const response = await axios.get(`${API_URL}/api/pdi/report-batches/${batch.batch_id}/pdf`, {
        headers: { Authorization: `Bearer ${token}` },
        responseType: 'blob',
      });
      const blob = new Blob([response.data], { type: 'application/pdf' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `PDI_BATCH_${String(batch.pdi_no || batch.batch_id).replace(/[^a-zA-Z0-9_-]/g, '_')}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      notifyError(err.response?.data?.error || 'Could not download the batch PDF.');
    }
  };

  if (batchId) {
    if (loadingBatch || !batch) {
      return <div className="max-w-5xl mx-auto p-8 text-center text-gray-400">Loading batch…</div>;
    }
    const allFinalized = batch.status === 'Completed';
    return (
      <div className="max-w-5xl mx-auto space-y-4 p-4">
        <div className="bg-white rounded-xl shadow-sm p-5 sm:p-6">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h2 className="text-xl font-bold text-navy-800">Batch {batch.pdi_no}</h2>
              <p className="text-gray-500 text-sm mt-1">
                {batch.lot_quantity} motor(s) · {batch.status}
                {batch.customer_name ? ` · ${batch.customer_name}` : ''}
              </p>
            </div>
            {allFinalized ? (
              <button
                type="button"
                onClick={handleDownloadBatchPdf}
                className="flex items-center gap-2 px-4 py-2 bg-navy-800 text-white rounded-lg text-sm font-semibold hover:bg-navy-900"
              >
                <Download size={16} /> Download Combined PDF
              </button>
            ) : (
              <button
                type="button"
                onClick={handleFinalizeBatch}
                disabled={finalizing}
                className="flex items-center gap-2 px-4 py-2 bg-gold-500 text-navy-900 rounded-lg text-sm font-semibold hover:bg-gold-400 disabled:opacity-50"
              >
                <ClipboardCheck size={16} /> {finalizing ? 'Finalizing…' : 'Finalize Batch'}
              </button>
            )}
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm divide-y divide-gray-100">
          {batch.reports.map((r) => (
            <div key={r.report_id} className="flex items-center justify-between gap-3 px-5 py-3">
              <div className="min-w-0">
                <span className="font-semibold text-navy-800">Lot {r.lot_index}/{batch.lot_quantity}</span>
                <span className="text-gray-400 text-sm ml-2">
                  {r.motor_sr_no ? `Sr. No. ${r.motor_sr_no}` : 'No serial number yet'}
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className={`text-xs px-2 py-1 rounded-full ${r.status === 'Completed' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}`}>
                  {r.status}
                </span>
                <button
                  type="button"
                  onClick={() => navigate(`/pdi-generator/autonxt?report=${r.report_id}`)}
                  className="p-2 hover:bg-navy-50 rounded-full text-navy-800"
                  title="Open this report"
                  aria-label={`Open report for lot ${r.lot_index}`}
                >
                  <Eye size={18} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-4">
      <form onSubmit={handleCreate} className="bg-white rounded-xl shadow-sm p-5 sm:p-8 space-y-4">
        <div className="flex items-center gap-3">
          <Layers className="text-gold-600" size={28} />
          <h2 className="text-xl font-bold text-navy-800">Create AutoNXT Batch Lot</h2>
        </div>
        <p className="text-gray-500 text-sm">
          Creates several linked PDI reports sharing the same PDI No. and lot-wide fields. Fill in each motor's checklist afterward.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-navy-800 mb-1">PDI No. *</label>
            <input className={INPUT_CLS} value={form.pdi_no} onChange={(e) => setField('pdi_no', e.target.value)} />
          </div>
          <div>
            <label className="block text-sm font-medium text-navy-800 mb-1">Quantity (1-50) *</label>
            <input type="number" min="1" max="50" className={INPUT_CLS} value={form.quantity} onChange={(e) => setField('quantity', e.target.value)} />
          </div>
          {SHARED_FIELDS.map(({ key, label, placeholder }) => (
            <div key={key}>
              <label className="block text-sm font-medium text-navy-800 mb-1">{label}</label>
              <input className={INPUT_CLS} placeholder={placeholder} value={form[key]} onChange={(e) => setField(key, e.target.value)} />
            </div>
          ))}
        </div>
        <button
          type="submit"
          disabled={creating}
          className="px-5 py-2.5 bg-gold-500 text-navy-900 rounded-lg font-semibold hover:bg-gold-400 disabled:opacity-50"
        >
          {creating ? 'Creating…' : 'Create Batch'}
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Add the route**

In `CRM/src/routeConfig.jsx`, find:
```js
import AutoNXTGeneratorForm from "./components/admin/AutoNXTGeneratorForm";
```
Add immediately after it:
```js
import AutoNXTBatchForm from "./components/admin/AutoNXTBatchForm";
```
Find:
```js
  {
    path: "/pdi-generator/autonxt",
    allowedRoles: ["admin", "production"],
    component: AutoNXTGeneratorForm,
  },
```
Add immediately after it:
```js
  {
    path: "/pdi-generator/autonxt-batch",
    allowedRoles: ["admin", "production"],
    component: AutoNXTBatchForm,
  },
```

- [ ] **Step 3: Link to the new flow from the existing single-report card**

In `AutoNXTGeneratorForm.jsx`, find:
```js
        <p className="text-center text-gray-400 text-sm mt-6">
          Click the card above to open the PDI form and generate the PDF
        </p>
      </div>
```
Replace with:
```js
        <p className="text-center text-gray-400 text-sm mt-6">
          Click the card above to open the PDI form and generate the PDF
        </p>
        <p className="text-center text-sm mt-2">
          <a href="/pdi-generator/autonxt-batch" className="text-gold-600 hover:underline font-medium">
            Creating several motors in one lot? Use batch creation instead →
          </a>
        </p>
      </div>
```

- [ ] **Step 4: Verify (manual — see the plan's note on gstack's browser automation being unreliable on this build)**

Start both dev servers if not already running (backend on `:8000` against production RDS with `FRONTEND_URL=http://localhost:5174`, frontend `npm run dev` from `CRM/`). Attempt `$B goto http://localhost:5174/pdi-generator/autonxt-batch` — if the headless browser crashes again (it did earlier this session on this exact build), STOP trying to force it and instead write out the manual repro steps clearly for the user to verify themselves: navigate to `/pdi-generator/autonxt-batch`, create a batch of 2 with a test PDI No., confirm redirect to the overview with 2 "Lot 1/2"/"Lot 2/2" rows, click the eye icon on one to confirm it opens that specific report in the existing AutoNXT form, fill in minimal required fields (motor_sr_no, pdi_no already set) and save, go back to the batch overview (browser back, or re-navigate to `/pdi-generator/autonxt-batch?batch=<id>`) and confirm that report's status updated, do the same for the second report, then confirm "Finalize Batch" appears once relevant and downloads a combined PDF. Report explicitly which of these you executed yourself vs. which need the user's own manual check, rather than claiming full verification if the browser tool failed.

- [ ] **Step 5: Commit**

```bash
cd CRM
git add src/components/admin/AutoNXTBatchForm.jsx src/routeConfig.jsx src/components/admin/AutoNXTGeneratorForm.jsx
git commit -m "feat: add AutoNXT batch-creation UI to the web admin app"
```

---

### Task 11 (final code review, not a subagent): whole implementation review

Dispatch a final code-reviewer subagent for the combined diff across both repos (all 11 tasks), mirroring this session's established pattern. Fix anything it finds.

---

### Task 12 (controller-personal, not a subagent): live re-verification of all original repro chains

Re-exercise, against the local dev server (CRM_BACKEND on `:8000` against production RDS):
- The exact `status`+`data` PATCH combination that crashed with 500 — confirm 200 now.
- `DELETE` on a Completed batch member — confirm `409 BATCH_MEMBER_LOCKED`.
- The pre-finalize-edit-then-finalize drift repro from the spec — confirm the individual and combined PDFs now agree.
- A blank batch member at finalize — confirm `400 MOTOR_SR_NO_REQUIRED`.
- Standalone delete without permission — confirm `403 FINALIZED_REPORT_FORBIDDEN`.

Clean up every throwaway report/batch created during this plan's execution (search for any left behind with a distinguishing `pdi_no` prefix like `QA-FIX-*` used in the task steps above) before considering this plan done. Report results plainly, including anything that didn't fully verify (e.g. the web UI's manual-check items from Task 10).
