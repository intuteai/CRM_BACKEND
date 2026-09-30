# Controlled Editing of Finalized PDI Reports

## Context

The mobile app developer's second requested PDI feature (the first, AutoNXT lot/batch reports, is already shipped — see `docs/superpowers/specs/2026-09-29-autonxt-batch-reports-design.md`): a way for an authorized user to edit a PDI report after it's been finalized (`status = 'Completed'`), with an audit trail, a revision/version field, and two new error codes (`FINALIZED_REPORT_FORBIDDEN`, `REPORT_VERSION_CONFLICT`).

Verified against the actual codebase before designing:
- `patchReport` and `finalizeReport` (`models/operations/pdiReports.js`) both already hard-lock a `Completed` report today via a guarded `UPDATE ... WHERE status <> 'Completed'`, throwing `REPORT_LOCKED` (409) on 0 rows affected. The comment above `patchReport`'s guard documents a real prior incident: a stale/delayed save from a second device silently overwrote a finalized report's data before this guard existed. Any softening of this lock must not reopen that race.
- A `permissions` table already exists with a `PreDispatchInspectionReports` module — currently granted `can_write` to exactly two roles (`Admin`, `Production`) — but **no PDI route checks it today** (`routes/operations/pdiReports.js` wires every route with only `authenticateToken`). This module is reused here, for the first time, specifically gating the one new action this spec adds.
- `middleware/auth.js`'s `checkPermission(module, action)` is route middleware (unconditional per route) — it has no equivalent that can be called conditionally from inside a model method. This spec factors out a plain `hasPermission(role_id, module, action)` async function so both the existing middleware and this new conditional check share one source of truth.
- No revision/audit-trail table or column exists anywhere in this codebase yet — this is new infrastructure, not a mirror of an existing pattern (unlike batch/lot reports, which reused almost everything).
- The `pre_dispatch_inspection_reports` table has no `updated_at`/`version` column today (`created_at` only).

## Scope

**In scope:**
1. A `revision_no` column on `pre_dispatch_inspection_reports` (starts at 1) and a new `pdi_report_revisions` table snapshotting each edit's pre-edit `data`.
2. Extending the existing `PATCH /api/pdi/reports/:id` (`patchReport`) so that, specifically when the report's current status is `Completed`, an edit succeeds only for a caller with `can_write` on `PreDispatchInspectionReports` **and** a correct `expected_revision`, instead of being unconditionally rejected as it is today.
3. A background PDF re-render (+ Drive backup + disk cache refresh) after a successful finalized-report edit, mirroring `finalizeReport`'s own fire-and-forget pattern — the report stays `Completed` throughout; there is no intermediate "reopened" status.
4. A new `GET /api/pdi/reports/:id/revisions` endpoint to actually read back the audit trail.
5. Two new error codes: `FINALIZED_REPORT_FORBIDDEN` (403) and `REPORT_VERSION_CONFLICT` (409).

**Explicitly out of scope:**
- Any change to `finalizeReport` itself — re-finalizing an already-`Completed` report is still always blocked (`REPORT_LOCKED`, unchanged), regardless of permission. Editing and finalizing remain distinct actions.
- Editing a report that is a member of a `Completed` batch — stays hard-locked exactly as today; the combined batch PDF's re-render is not part of this feature.
- Snapshotting `photos` in the audit trail — only `data` is captured per revision (see Data model).
- Printing the revision number on the rendered PDF — it's an internal field (API response + audit trail only), unrelated to a template's own unconnected "Rev. No" (that's the paper *form's* revision, not this report's edit history).
- A free-text "reason for edit" field — not requested, not added.
- Any mobile app (`pdi-erp-app`) code change — this spec delivers the API contract; a handoff doc for the app developer follows the same pattern as the batch/lot-reports one, once this is implemented and verified.

## Data model

```sql
ALTER TABLE pre_dispatch_inspection_reports ADD COLUMN revision_no INTEGER NOT NULL DEFAULT 1;

CREATE TABLE pdi_report_revisions (
  revision_id SERIAL PRIMARY KEY,
  report_id INTEGER NOT NULL REFERENCES pre_dispatch_inspection_reports(report_id),
  revision_no INTEGER NOT NULL,   -- the revision number this snapshot WAS, immediately before the edit that superseded it
  data JSONB NOT NULL,            -- report.data exactly as it was before that edit
  edited_by INTEGER REFERENCES users(user_id),
  edited_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Every existing report defaults to `revision_no = 1` (additive, no backfill needed). A row in `pdi_report_revisions` represents one past state — the current state is simply the live row in `pre_dispatch_inspection_reports` at its current `revision_no`. `photos` is deliberately not snapshotted: photos can be several MB each, and the PDF is always re-rendered from whatever is currently stored regardless, so nothing about "does the delivered PDF match reality" depends on a photo history — only "restore an old photo" would, which isn't a requirement here.

## Permission mechanic: `hasPermission`

`middleware/auth.js`'s `checkPermission` is refactored to call a new exported `hasPermission(role_id, module, action)` (the same `SELECT can_write FROM permissions WHERE role_id = $1 AND module = $2` query it already runs, just callable directly). `checkPermission` itself is unchanged in behavior — still route middleware, still used nowhere on PDI routes except this one new conditional check inside `patchReport`. This is the only way to gate one specific action (editing a report that happens to currently be `Completed`) without gating every PDI edit — the alternative, blanket route middleware, would suddenly require `Admin`/`Production` for *any* PDI edit, a real regression from today's zero-permission-check behavior on ordinary in-progress reports.

## Edit flow

`patchReport(reportId, fields, io, options)` gains two new inputs threaded through from the controller: `role_id` (from `req.user`) and `expected_revision` (from the request body, only meaningful when editing a `Completed` report). The SQL branches on the report's current status:

- **Status is not `Completed`:** completely unchanged from today — same guarded `UPDATE ... WHERE status <> 'Completed'`, no permission check, no `expected_revision` requirement.
- **Status is `Completed`:**
  1. `hasPermission(role_id, 'PreDispatchInspectionReports', 'can_write')` — false → throw `FINALIZED_REPORT_FORBIDDEN` (403), nothing written.
  2. `expected_revision` missing, or not equal to the report's current `revision_no` (checked via a `SELECT ... FOR UPDATE`-free read first, since the real compare-and-swap happens in the UPDATE below) → throw `REPORT_VERSION_CONFLICT` (409), nothing written.
  3. Insert one row into `pdi_report_revisions` with the *current* (pre-edit) `data` and `revision_no`.
  4. Guarded `UPDATE pre_dispatch_inspection_reports SET data = $1, photos = …, revision_no = revision_no + 1 WHERE report_id = $N AND status = 'Completed' AND revision_no = $expected_revision`. Zero rows affected (a concurrent edit won the race between the read in step 2 and this UPDATE) → throw `REPORT_VERSION_CONFLICT` — this is what actually closes the race, the same way the original `REPORT_LOCKED` guard did, just conditional on `revision_no` now instead of absolute on `status`.
  5. On success: kick off a background re-render (`PDIGenerator.generate` → `pdfCache.write` → Drive re-upload, replacing the existing `drive_file_id`), fire-and-forget exactly like `finalizeReport`'s own `background` promise. The report's `status` never changes — it's `Completed` before and after.

## New endpoint

```
GET /api/pdi/reports/:id/revisions
  → 200 [ { revision_no, edited_by, edited_at, data }, ... ]   -- newest first
```

No permission gate on this read (`authenticateToken` only) — matches every other PDI `GET` today; only the *write* path (editing a `Completed` report) is gated.

## Error codes

| Code | HTTP | When |
|---|---|---|
| `FINALIZED_REPORT_FORBIDDEN` | 403 | Editing a `Completed` report without `can_write` on `PreDispatchInspectionReports` |
| `REPORT_VERSION_CONFLICT` | 409 | `expected_revision` missing/stale on a `Completed` report, or a concurrent edit won the race |

`REPORT_LOCKED` is untouched and still used exactly as today by `finalizeReport` (re-finalizing an already-`Completed` report is always blocked, for everyone — unrelated to this feature).

## Testing

Same Jest-with-mocked-DB pattern as every other PDI model test (`../config/db` and `../services/googleDrive` fully mocked, no real Postgres connection): a permitted edit with the correct `expected_revision` succeeds (bumps `revision_no`, writes exactly one snapshot row with the pre-edit data, triggers the background re-render); missing `can_write` → `FINALIZED_REPORT_FORBIDDEN` with nothing written; missing/stale `expected_revision` → `REPORT_VERSION_CONFLICT` with nothing written; the guarded-UPDATE-returns-0-rows race (permission and pre-check both pass, but a concurrent edit already bumped `revision_no`) → `REPORT_VERSION_CONFLICT`; editing a non-`Completed` report is completely unaffected (no permission or revision requirement, matching today exactly); `GET .../revisions` returns snapshots newest-first. Final task is controller-personal live verification against production data: a real throwaway report, finalized, edited as `Production` (permitted) with the correct revision (confirm the PDF actually changes), then the same edit attempted as an unpermitted role (403) and with a deliberately stale revision (409), then cleanup.
