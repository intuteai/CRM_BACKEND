# PDI QA Findings Remediation

## Background

A rugged, adversarial QA pass (three parallel agents, live testing against the real production database, not just code review) was run across three PDI features shipped earlier this session: lot/batch reports, controlled editing of finalized reports, and AutoNXT/General tolerance parity. It found 4 Critical, reproducible bugs plus several Important/Minor gaps and one design gap (missing web UI). This spec covers remediating all of it except the AutoNXT/General mobile forward/reverse-parser divergence, which goes to the app developer as a handoff doc instead (different repo, different team).

All backend changes are in `CRM_BACKEND` (`c:\Users\Rahul\OneDrive\Desktop\Projects\ERP-CRM\CRM_BACKEND`, branch `main`). All web changes are in `CRM` (`c:\Users\Rahul\OneDrive\Desktop\Projects\ERP-CRM\CRM`, branch `main`).

## Backend fixes

### 1. The `status`-field 500 crash (and, same mechanism, the audit-trail scope gap)

**Root cause** (`models/operations/pdiReports.js`, `patchReport`): `sets`/`values` are built in one unconditional pass (lines ~237-270) *before* the report's current status is known (the `current` pre-read happens afterward, line ~283). For a report that turns out to be `Completed`, the existing code strips `"status = $1"` from the SQL *text* (`finalizedSets = sets.filter(...)`) but never removes the corresponding `status` value from the `values` array — leaving a parameter bound with no placeholder referencing it, which Postgres can't type-infer (`42P18`). Every existing web-admin save call sends `status` unconditionally, so this is the first thing that happens on any web save against a Completed report.

Separately, the same build pass includes `inspected_by`/`customer_id`/`order_id`/`inspection_date` unconditionally too — none of these are filtered at all today, so they're silently applied to a Completed report's row without being captured in the `pdi_report_revisions` audit snapshot (which only stores `data`). A different user's save can silently overwrite who inspected a finalized report with no trace of the original value. (QA reproduced this specifically for `inspected_by`; `customer_id`/`order_id`/`inspection_date` share the identical gap by the same mechanism and are fixed the same way, for consistency with the feature's own stated contract — only `data`/`photos` should be editable once `Completed`.)

**Fix**: move the `current` pre-read (`SELECT status, revision_no, data ...`) to the top of `patchReport`, before the `sets`/`values` build pass — this is a reordering of two steps that already both run unconditionally for any non-empty patch, so it adds no new query and changes no behavior for the non-Completed path. Then build `sets`/`values` *knowing* `currentStatus` from the start: when `currentStatus === 'Completed'`, skip adding `status`, `inspected_by`, `customer_id`, `order_id`, and `inspection_date` to `sets`/`values` entirely (not filtered after the fact — never added in the first place, which is what actually eliminates the placeholder-numbering bug, not just this one instance of it). `data`/`photos`/`prepared_by`/`approved_by` are unaffected by this exclusion — they remain the only fields a finalized edit can actually change, which is what the feature's own documentation already claims.

One ordering note: `toIsoDateOrNull(fields.inspection_date)` can throw `INVALID_INSPECTION_DATE` — today this happens before any query; after this change it happens after one read-only `SELECT` (harmless: no write has occurred, so "a malformed date never reaches the database" as a *write* still holds). Also, since `inspection_date` is now a no-op field once `Completed` (same as `status`), `toIsoDateOrNull` should only be called — and only able to throw — when `currentStatus !== 'Completed'`; a malformed `inspection_date` sent alongside a finalized edit is silently ignored, not an error, matching `status`'s existing documented contract.

### 2. `data = data || $N::jsonb` instead of `data = $N` (merge, not replace)

Same `patchReport` build pass: `fields.data` is currently written with `sets.push('data = $N'); values.push(JSON.stringify(fields.data))` — a full replace of the JSONB column. Every current caller (all 3 web generator forms, the mobile app) always resends complete form state, so this has never caused an observed bug — but a future caller that sends a partial `data` object would silently delete every field it didn't mention. Change to `data = data || $N::jsonb` (Postgres JSONB shallow-merge concatenation; explicit `::jsonb` cast needed since the parameter is a JSON string). Scoped to `data` only — `photos` keeps its existing `CASE WHEN ... THEN photos ELSE ...` dedup logic unchanged, that's a different concern (write-skip optimization, not merge semantics).

This changes the literal SQL text the existing mocked tests assert on (`tests/pdi_finalized_edit.test.js`, `tests/pdi_inspection_date.test.js` — both mock `pool.query` and check the query string) — those assertions need updating to match, not just the behavior.

### 3. `DELETE /api/pdi/reports/:id` gains batch- and status-awareness

**Root cause**: `deleteReport` (`models/operations/pdiReports.js`, ~line 773) deletes unconditionally — no status check, no batch check. This is what let a single ordinary API call silently corrupt a finalized batch's combined PDF (deleting a `Completed` batch member, then a PDF-cache miss re-renders with one motor's pages just gone, no error, stale `lot_quantity`).

**Fix**: `deleteReport(reportId, io, { role_id } = {})` runs one check query first:
```sql
SELECT r.status, r.batch_id, b.status AS batch_status
FROM pre_dispatch_inspection_reports r
LEFT JOIN pdi_report_batches b ON b.batch_id = r.batch_id
WHERE r.report_id = $1
```
- `batch_id` is set and `batch_status = 'Completed'` → always blocked. New error code `BATCH_MEMBER_LOCKED` (409) — distinct from the existing `BATCH_ALREADY_FINALIZED`, which means something else (re-finalizing an already-finalized batch). No repair/renumbering mechanism is being built — blocking is simpler and sufficient, since a batch that isn't yet `Completed` is already safety-netted by `finalizeBatch`'s existing `BATCH_INCOMPLETE` check if a member goes missing before finalize.
- `status = 'Completed'` (batch member or not) → blocked unless `hasPermission(role_id, 'PreDispatchInspectionReports', 'can_write')` — reusing the exact permission check and error code (`FINALIZED_REPORT_FORBIDDEN`, 403) the finalized-editing feature already added for `PATCH`, rather than inventing a parallel one.
- Otherwise: unchanged, deletes immediately as today.

`controllers/operations/pdiReports.controller.js`'s `deleteReport` handler passes `{ role_id: req.user.role_id }` and maps both new error codes (409 for `BATCH_MEMBER_LOCKED`, 403 for `FINALIZED_REPORT_FORBIDDEN`) alongside the existing 404 mapping.

### 4. Individual-report PDF now respects the batch's shared-field override

**Root cause**: `pdiReportBatches.js`'s own code comments (lines ~13-18, ~171-176) already state the design intent explicitly: the batch's `pdi_no` + 5 `SHARED_FIELDS` are meant to be authoritative *at render time*, "even if an individual report's own data drifts" — deliberately not written back to storage. This is correctly implemented for the combined batch PDF (`finalizeBatch`, `getBatchPdfForDownload`) but was never extended to the individual-report PDF route — `pdiReports.js` has zero knowledge of `pdi_report_batches` (confirmed: no `batch_id` reference anywhere in that file). The result: a report's own individual PDF can permanently disagree with its batch's combined PDF for the exact same finalized record.

**Fix**: extract the override logic into a new small shared module, `models/operations/pdi/batchOverrides.js`:
```js
const pool = require('../../../config/db');

const SHARED_FIELDS = ['customer_name', 'product_id', 'product_specifications', 'drawing_no', 'controller_type'];

function pickSharedFields(source) {
  const picked = {};
  for (const f of SHARED_FIELDS) {
    if (source[f]) picked[f] = source[f];
  }
  return picked;
}

// null if the report isn't a batch member, or its batch isn't Completed yet
// (a non-Completed batch's shared fields aren't authoritative over anything
// yet -- finalizeBatch/getBatchPdfForDownload are the only places that
// apply this override today, and both only ever run on Completed batches).
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
(A new leaf module, not a re-export from either existing file — `pdiReportBatches.js` already `require`s `pdiReports.js`, so having `pdiReports.js` require back from `pdiReportBatches.js` would be circular. Both files import from this new module instead.)

- `pdiReportBatches.js`'s `finalizeBatch`/`getBatchPdfForDownload` switch their local `pickSharedFields`/`SHARED_FIELDS` to import from this module (behavior-identical, de-duplicated).
- `pdiReports.js`'s `getPdfForDownload` (the live-render path — i.e. only reached on a cache miss) and `#reRenderFinalizedReport` (the finalized-edit background re-render) both call `getActiveBatchOverride(reportId)` after loading the report, and if it returns non-null, spread the override onto `report.data` before handing it to `PDIGenerator.generate` — exactly mirroring how `getBatchPdfForDownload` already merges it: `{ ...(report.data || {}), ...override, photos: report.photos || [] }` (override fields win, same precedence as the batch route).

This means once fix #3 is in place and a permitted user successfully edits a batch member while `Completed`, the resulting re-rendered individual PDF will correctly carry the batch override too — the two features compose correctly instead of leaving a new gap.

### 5. Batch finalize requires `motor_sr_no` per member

**Root cause**: `finalizeBatch` only checks that every member has `data.pdi_no` (trivially true — the batch stamps it at creation). A completely blank report (no `motor_sr_no`, no checklist data at all) can be finalized and, combined with fix #3's "no deletion once the batch is Completed" rule, permanently locked into a batch with zero substantive content.

**Fix**: alongside the existing `pdi_no` check in `finalizeBatch`'s per-report loop, add: if `!report.data?.motor_sr_no`, throw a new error with code `MOTOR_SR_NO_REQUIRED` (`Report ${report.report_id} (lot ${report.lot_index}) is missing motor_sr_no.`), same pattern as the existing `PDI_NO_REQUIRED` check right next to it. The route/controller for batch finalize needs this new code mapped to 400, alongside the existing `PDI_NO_REQUIRED`/`BATCH_INCOMPLETE` mappings.

### 6. Drive-file-orphan race on concurrent finalized-edit re-renders

**Root cause**: `#reRenderFinalizedReport` (`pdiReports.js`, ~line 673) reads `previousDriveFileId` via a plain `getById` at the start, uploads a new PDF, updates `drive_file_id`, then deletes `previousDriveFileId`. Two edits to the same report close together both read the *same* original `previousDriveFileId`, both upload their own new file, and whichever `UPDATE drive_file_id` loses the "last write wins" race leaves its own newly-uploaded file referenced by nothing and deleted by nothing — a permanent, leaked Drive file. Observed in testing: two re-renders' log lines finishing 571ms apart, confirming real overlap, not just a theoretical window.

**Fix**: wrap the read-then-update in a transaction using `SELECT ... FOR UPDATE` to serialize concurrent calls on the same report row:
```js
const client = await pool.connect();
let previousDriveFileId;
try {
  await client.query('BEGIN');
  const { rows } = await client.query(
    'SELECT drive_file_id FROM pre_dispatch_inspection_reports WHERE report_id = $1 FOR UPDATE',
    [reportId]
  );
  previousDriveFileId = rows[0]?.drive_file_id;
  await client.query(
    'UPDATE pre_dispatch_inspection_reports SET drive_file_id = $1 WHERE report_id = $2',
    [uploaded.id, reportId]
  );
  await client.query('COMMIT');
} catch (e) {
  await client.query('ROLLBACK');
  throw e;
} finally {
  client.release();
}
// delete previousDriveFileId AFTER the transaction commits/releases -- the
// Drive API call shouldn't hold a DB row lock while it runs.
```
The row lock means the second concurrent call's `SELECT ... FOR UPDATE` blocks until the first one's transaction commits, so it correctly reads the *first* call's newly-set `drive_file_id` as its own "previous" value — the orphan becomes impossible because the delete always targets the file that was truly superseded, not a stale snapshot from before either upload happened. The upload itself (`uploadBufferToDrivePrivate`) and the eventual delete of the old file both stay outside the transaction, same as today — only the read-then-write of the `drive_file_id` column itself needs the lock.

## Web UI additions (CRM)

### 7. Batch creation UI (AutoNXT)

Scoped to AutoNXT only, matching where the mobile app built it and where the real multi-motor-lot need was confirmed (SHARED_FIELDS' own comment: "confirmed against an actual 16-motor Compage QA document"). Mirrors the mobile app's actual flow (`BatchCreateScreen.tsx` → `BatchOverviewScreen.tsx`), not inventing new UX:

- A "Create Batch" entry point alongside the existing single-report AutoNXT creation flow, opening a form: PDI No. (required), Quantity (1-50), and the 5 optional shared fields (Customer name, Product ID, Product specifications, Drawing number, Controller type) — same fields `BatchCreateScreen.tsx` collects. Submits to `POST /api/pdi/report-batches`.
- On success, a Batch Overview view: lists the `N` linked reports (lot index, status, motor serial number if filled), each row opens that specific report in the existing `AutoNXTGeneratorForm` (already report-id-aware) to fill in its checklist data.
- A "Finalize Batch" action (enabled once every member looks filled in, though the actual gate is still the backend's own validation) calling `POST /api/pdi/report-batches/:id/finalize` and downloading the resulting combined PDF, mirroring the existing single-report finalize button's download behavior.

### 8. Revision-aware editing in all 3 generator forms

`PDIGeneratorForm.jsx`, `AutoNXTGeneratorForm.jsx`, `GenericPdiGeneratorForm.jsx` — today none of them read or send `revision_no`/`expected_revision` at all, so editing a `Completed` report from the web app is unusable even once backend fix #1 lands (it would stop crashing, then just fail every time with a clean 409 instead). For each form:

- Store `revision_no` in form state whenever a report is fetched (initial load, and refreshed from every subsequent save response).
- When saving a report whose loaded `status` is `Completed`, include `expected_revision: revisionNo` in the PATCH body. (`status` no longer needs to be conditionally omitted from the payload for *correctness* now that backend fix #1 silently ignores it — but it's cleaner not to send a value that's meaningless once a report is finalized, so omit it for the Completed case anyway.)
- On a `403 FINALIZED_REPORT_FORBIDDEN` response: show "You don't have permission to edit a finalized report." and do not offer a retry.
- On a `409 REPORT_VERSION_CONFLICT` response: show "This report changed since you loaded it." with a "Reload" action that re-fetches the report (picking up the current `revision_no`) before allowing another save attempt — instead of today's generic, confusing "Failed to save progress" toast that retries into the same guaranteed failure.

## Mobile handoff (pdi-erp-app)

A handoff doc, same pattern as every other mobile-side fix this session, covering the forward/reverse-measurement parser divergence: `pdi-erp-app/src/services/tolerance.ts`'s `parseDirectionalMeasurement` uses `indexOf('/')` for a single split (so `"12/45/99"` → reverse `"45/99"` → `NaN` → evaluates as not-out-of-range), while the web/backend `parseForwardReverse` destructures a full `split('/')` (so `"12/45/99"` → reverse `"45"`, a valid number that *does* get tolerance-checked) — the same stored report can show as flagged on web/PDF and passing on mobile for any F/R measurement containing two slashes. Fix: change `parseDirectionalMeasurement` to match `parseForwardReverse`'s exact behavior (take only the first two slash-delimited segments, keep the second segment's value as-is rather than discarding it for containing a further slash).

## Testing

- Live re-exercise of all 4 original Critical repro chains (status+data PATCH on a Completed report; delete-then-cache-miss on a Completed batch member; pre-finalize-edit-then-finalize drift check on both the combined and individual PDF; standalone delete without permission) against the local dev server/production DB.
- `tests/pdi_finalized_edit.test.js` and `tests/pdi_inspection_date.test.js` updated for the new `data = data || $N::jsonb` query text, plus a new case covering `status` sent alongside `data` on a Completed report (the exact combination that crashed).
- New live checks for fixes #4-#6: an individual report's PDF matches its batch's combined PDF after a pre-finalize edit; a blank batch member blocks finalize with `MOTOR_SR_NO_REQUIRED`; two near-simultaneous finalized edits on the same report leave no orphaned Drive file (verified via Drive API listing, not just log timing).
- Web UI: live browser verification of the new batch-creation flow (AutoNXT) and revision-aware editing's 403/409 handling in at least one of the 3 forms — browser automation has been unreliable in this environment this session (the gstack headless browser has crashed on this specific CRM build before), so this may end up being a manual check instead; call that out plainly if automation fails again rather than skipping verification silently.
