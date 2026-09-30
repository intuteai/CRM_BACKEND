# AutoNXT Lot/Batch Reports

## Context

The mobile app developer requested backend support for two AutoNXT PDI mobile-app features: (1) lot/batch reports — one PDI number covering N motors, each with its own report, finalized and merged into one PDF together — and (2) permission-gated editing of already-finalized reports with an audit trail. These are independent enough to design and ship separately; this spec covers **only feature 1**. Feature 2 (`FINALIZED_REPORT_FORBIDDEN`, `REPORT_VERSION_CONFLICT`, the audit trail, the permission gate) is explicitly out of scope here and gets its own spec later.

The request, verified against the actual codebase before designing (not assumed):
- **No batch/lot infrastructure exists at all** today — confirmed by a full-repo search.
- **No PDF-merge library** is a dependency (`pdfkit`/`svg-to-pdfkit` only) — PDFKit alone can't concatenate pre-rendered PDF buffers.
- **PDI routes have zero permission checks today** (`routes/operations/pdiReports.js` wires every route with only `authenticateToken`) — batch endpoints should match this, not introduce a new gate (feature 2's job).
- The existing single-report `finalizeReport` (`models/operations/pdiReports.js:440-513`) uses a conditional `UPDATE ... WHERE status <> 'Completed'` as its concurrency guard, backs up the finalized PDF to Google Drive in the background (`#backupPdfToDrive`, fire-and-forget, not awaited by the controller), and caches the rendered PDF on disk (`models/operations/pdi/pdfCache.js`, keyed by `report_id`). All of this stays completely unchanged and is reused as-is for each report inside a batch.

## Scope

**In scope:**
1. A new `pdi_report_batches` table and two new columns (`batch_id`, `lot_index`) on `pre_dispatch_inspection_reports`.
2. Four endpoints: create a batch, read a batch's status, finalize a batch (validates + finalizes every linked report + merges their PDFs into one), and download the combined PDF.
3. Atomic batch creation (one DB transaction; all-or-nothing).
4. Server-side PDF combination — generating all N reports into one shared PDF document in a single pass, not merging N pre-rendered PDFs.
5. Reusing every existing single-report mechanism unchanged: `createReport`'s row shape, `patchReport` for per-motor editing, `finalizeReport` for per-motor finalize (called once per linked report from inside batch-finalize), the photo pipeline, the PDF cache, the Drive backup.

**Explicitly out of scope:**
- Any permission/role gate on batch endpoints — matches PDI's current no-gate behavior everywhere else.
- Editing a report after its batch has been finalized (feature 2's job; that spec covers exactly this, including "changing one motor invalidates the combined PDF").
- Any change to `pdi-erp-app` (mobile) code — this spec delivers the API contract; the app developer implements their own side once it's live, same pattern as every other PDI backend round this session.
- Batching for the General template — the schema is template-agnostic (no hardcoded `'autonxt'` constraint) so it costs nothing to leave open, but the app only wires this up for AutoNXT.

## Data model

```sql
CREATE TABLE pdi_report_batches (
  batch_id SERIAL PRIMARY KEY,
  template_id TEXT NOT NULL,
  pdi_no TEXT NOT NULL,
  lot_quantity INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'In Progress',   -- 'In Progress' | 'Completed'
  drive_file_id TEXT,                            -- the COMBINED PDF's Drive id
  created_by INTEGER REFERENCES users(user_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Optional, added after comparing this design against a real multi-motor
  -- Compage QA document: these five fields repeat identically across every
  -- motor in a real lot. Seeding them once here (alongside pdi_no) means a
  -- technician doesn't retype them on every one of N reports, and they're
  -- authoritative at render time exactly like pdi_no already is (a null
  -- column here leaves whatever an individual report's own data holds
  -- untouched, so this is fully backward-compatible with a batch created
  -- before these columns existed).
  customer_name TEXT,
  product_id TEXT,
  product_specifications TEXT,
  drawing_no TEXT,
  controller_type TEXT
);

ALTER TABLE pre_dispatch_inspection_reports
  ADD COLUMN batch_id INTEGER REFERENCES pdi_report_batches(batch_id),
  ADD COLUMN lot_index INTEGER;
```

A batched report is an ordinary row in the existing table in every other respect — same `data`/`photos`/`status` columns, same finalize/PDF-cache/Drive-backup machinery. `lot_index` is a stable 1..N ordinal assigned at creation time (creation order), used only for merge ordering and display — it is not the same thing as `motor_sr_no` (which the technician fills in per motor, already exists, untouched).

## Endpoints

```
POST /api/pdi/report-batches
  body: { template_id: "autonxt", pdi_no: "PDI-2026-001", quantity: 5,
          customer_name?, product_id?, product_specifications?, drawing_no?, controller_type? }
  → 201 { batch_id, template_id, pdi_no, lot_quantity, status: "In Progress",
          customer_name, product_id, product_specifications, drawing_no, controller_type,
          reports: [ { report_id, lot_index, lot_quantity }, ... ] }   -- N entries

GET /api/pdi/report-batches/:batchId
  → 200 { batch_id, template_id, pdi_no, lot_quantity, status,
          reports: [ { report_id, lot_index, status, motor_sr_no, pdi_no }, ... ] }
  -- per-report summary only (id/lot_index/status/motor_sr_no/pdi_no); full report
     data/photos still come from the existing GET /api/pdi/reports/:id

POST /api/pdi/report-batches/:batchId/finalize
  → 200 (application/pdf) the combined PDF -- same streaming/Content-Disposition
     pattern as single-report finalize (controllers/operations/pdiReports.controller.js:106-128)

GET /api/pdi/report-batches/:batchId/pdf
  → 200 (application/pdf) the combined PDF, served from cache/Drive once finalized
  → 409 BATCH_NOT_READY if the batch has not been finalized yet
```

Every other batch-member operation — view one motor's full report, save/edit one motor's data and photos, view/download that one motor's own individual PDF — uses the existing, completely unmodified single-report endpoints. A batched report behaves exactly like any other report except it carries `batch_id`/`lot_index` and its PDF also becomes one page-range inside a combined document once the batch is finalized.

## Creation flow

Runs inside a single DB transaction (`BEGIN`/`COMMIT`/`ROLLBACK`): insert one `pdi_report_batches` row, then insert `quantity` rows into `pre_dispatch_inspection_reports` (same shape the existing `createReport` produces — empty `data`/`photos`, `status: 'Pending'`), each stamped with the new `batch_id` and `lot_index` 1..N. Any failure partway rolls back the whole transaction — no partial batch ever exists. `quantity` is validated as an integer in `[1, 50]` (a technical safety cap, not a real business limit) — outside that range: `400 INVALID_LOT_QUANTITY`.

## Finalize flow

Traced through the actual mechanics before finalizing this design: `finalizeReport`'s per-report PDF is a *finished* PDFKit output (bytes) — it cannot be fed into a second shared document afterward (Approach A's shared-`PDFDocument` trick only works on a live, not-yet-`.end()`-ed document). Calling the existing `finalizeReport` once per report and *then* combining would mean rendering every report twice. Batch finalize therefore does **not** call the existing single-report `finalizeReport` — it has its own leaner flow:

1. Validate every linked report has what finalize needs (same `pdi_no` check `finalizeReport` already does — trivially satisfied here since `pdi_no` is stamped onto every linked report at batch-creation time from the batch's own shared `pdi_no`). If any report fails, the whole batch finalize fails before anything is marked `Completed`, identifying which report and why.
2. Mark each linked report `Completed` with the same guarded `UPDATE ... WHERE status <> 'Completed'` SQL `finalizeReport` already uses (reused as a SQL pattern, not by calling the function) — one report at a time, in `lot_index` order.
3. Render all N reports into **one shared `PDFDocument`** in a single pass (Approach A) — each report's photos are downscaled the same way a single-report PDF already is. Page numbering restarts at "Pg 1 of N" for each report's own page count, matching a normal single-report PDF (confirmed against an actual multi-motor Compage QA lot document, which numbers every motor's pages independently rather than continuously across the whole lot). The batch's own `pdi_no` and any set shared field (customer_name, product_id, product_specifications, drawing_no, controller_type) are authoritative over whatever an individual report's own data holds, same reasoning for all of them.
4. Cache and Drive-back-up **only the combined PDF**, mirroring the existing per-report pattern but at the batch level (`pdi_report_batches.drive_file_id`, cache key `batch-${batchId}`).
5. Mark the batch `Completed`.

This means each report is rendered exactly once, total. The tradeoff: a batch member's own individual PDF (`GET /api/pdi/reports/:id/pdf`) is not pre-cached the way a normally-finalized single report's is — it still works, but renders on demand on first request, same as any `Completed` report whose cache entry was never populated or was evicted. A repeat finalize call on an already-`Completed` batch returns `409 BATCH_ALREADY_FINALIZED`.

## Download & caching

The combined PDF gets its own cache entry via the existing `pdfCache.js` module, keyed `batch-${batchId}` (one parameter change at the call site, no new module) and its own Drive backup written to `pdi_report_batches.drive_file_id` in the background, mirroring the existing per-report `#backupPdfToDrive` pattern exactly (fire-and-forget, not awaited by the controller). `GET .../pdf` serves from that cache when present; on a cache miss for an already-`Completed` batch, it re-renders by repeating the finalize-flow's merge step against the stored per-report data (same fallback shape `getPdfForDownload` already has for a single report).

## Error codes

| Code | HTTP | When |
|---|---|---|
| `INVALID_LOT_QUANTITY` | 400 | `quantity` outside `[1, 50]` or not an integer |
| `BATCH_NOT_READY` | 409 | `GET .../pdf` called before the batch has been finalized |
| `BATCH_ALREADY_FINALIZED` | 409 | `POST .../finalize` called on an already-`Completed` batch |

`FINALIZED_REPORT_FORBIDDEN` and `REPORT_VERSION_CONFLICT` (also requested by the app developer) belong to feature 2 (controlled editing), not this spec.

## Testing

No automated test suite covers batch-anything today, since nothing exists yet. New Jest coverage in `CRM_BACKEND`, following this session's established pattern: the transaction's atomic rollback on a simulated mid-batch failure, the finalize-loop-then-merge logic (using the real PDF renderer, not mocked, matching how `pdi_autonxt_tolerance.test.js` and friends already work), the cache/Drive-backup wiring for the combined PDF, and the three new error codes. Final task is controller-personal live verification against production data: create a real throwaway batch (clearly named, e.g. `BATCH-PLAN-VERIFY`), fill in and finalize all N linked reports, download the combined PDF, confirm page count/order/content, then delete every report and the batch row afterward — same safety pattern used for every prior live-verification round this session.
