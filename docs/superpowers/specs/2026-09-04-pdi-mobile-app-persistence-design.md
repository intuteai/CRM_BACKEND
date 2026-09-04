# PDI Mobile App: Persistence, Save/Resume, and Dashboard Unification

**Status:** Approved by user, ready for implementation planning
**Author:** Claude (session with Rahul Srivastava)
**Date:** 2026-09-04

## Context

The PDI Generator (built earlier this session, in `CRM_BACKEND/models/operations/pdi_generator.js` and `CRM/src/components/admin/PDIGeneratorForm.jsx`) currently works entirely ephemerally: the web form POSTs a full JSON payload to `POST /api/pdi/generate`, which streams back a generated PDF and persists nothing. Nothing is saved to the database or to disk.

Separately, an existing "PDI Records" page (`CRM/src/components/admin/PdiPage.jsx`, backed by `pre_dispatch_inspection_reports` / `models/operations/pdi.js`) is a manual tracking tool: a user creates a row linked to a customer/order, sets a status (`Pending` / `In Progress` / `Completed` / `Failed`), and manually pastes a URL into a `report_link` field pointing at wherever they've uploaded the actual PDF themselves. It has no connection to the PDI Generator today.

The immediate driver: a mobile app (React Native/Expo) is about to be built for PDI inspections. The app dev needs a backend to build against now. The user also wants two things that won't be *built* yet, but the app + backend design must not preclude:

1. Persisting generated PDI reports, showing them on a dashboard, with the PDF backed up to storage and a view/download option.
2. A future custom-template system (users define their own PDI layouts on the web dashboard). Out of scope for this round — the design just needs to not require rework when it lands.

## What already exists (reused, not rebuilt)

- **Auth**: JWT Bearer tokens (`Authorization: Bearer <token>`) via `/api/auth/login` — already how the web app authenticates API calls, and directly usable by a mobile app with no new auth system.
- **File storage**: `services/googleDrive.js` — a complete, production-proven service (`uploadBufferToDrive`, `uploadBufferToDrivePrivate`, `streamFileToDrive`, `deleteDriveFile`), already used by invoices, stock, and service-repair. This is the "drive" storage requirement (1) — no new infrastructure needed.
- **The exact pattern to follow**: `models/hr/invoiceRecords.js` + `controllers/hr/invoiceRecords.controller.js`. Invoices already solve "generate a PDF, persist its structured data, best-effort back it up to Drive, and serve view/download from a single endpoint that regenerates on the fly for system-generated documents." PDI is the same shape of problem (a deterministic PDF from structured input data) and should mirror this pattern directly, including its `source` ('generated' vs 'uploaded') column and its orphan-cleanup-on-insert-failure handling.

## Key decisions from discussion

- **Unify with PDI Records**, don't build a separate dashboard. Generating/saving a PDI report auto-populates a `pre_dispatch_inspection_reports` row (auto-filled `report_link`) instead of requiring someone to manually paste a link.
- **Order linking stays optional.** `order_id` is currently a hard-required field on that table's `create` — this requirement is relaxed. PDI reports remain free-form (typed customer name, no dependency on an existing Order record), matching how the Generator works today.
- **"Save and continue later" is the real requirement — not offline-first sync.** A PDI inspection spans multiple stations/sessions (Electrical Check now, Mechanical Check later, Photos after final assembly) — it is *not* about the app needing to function with zero network signal. "Save" is a normal network call requiring connectivity when tapped; "continue later" means reopening the same draft (by report ID) in a future session, from the same or a different device. This rules out local on-device draft storage, background sync queues, and idempotency-key complexity — a save is just "create once, then `PATCH` by ID for every subsequent save."
- **Photos**: no new upload mechanism. Same approach as the web form built this session — client-side crop (aspect-locked to the printed photo box shape) + resize/compress (1600px long edge, JPEG) + base64-encode, included directly in the save/finalize JSON body. Because saves are live network calls (not queued for later), there's no need for a separate per-asset upload endpoint or an orphaned-upload cleanup job.
- **The web form migrates onto this flow too**, not just the app. One persistence layer, one dashboard, cross-device continuity — a report can be started on the app and finished on the web, or vice versa.
- **Template forward-compat**: every report is tagged with a `template_id` (defaulting to `'general'`) from day one, so no backfill migration is needed when template #2 exists later. The app ships with the general template's fields hardcoded — the same way the web form works today — and does not need to render templates dynamically yet.

## Data model

Extend `pre_dispatch_inspection_reports` (not a new table) with:

| Column | Type | Notes |
|---|---|---|
| `data` | `jsonb` | Full Generator form content: header fields, motor rows, general checks, cable-length/spec-row values. Everything except photos. |
| `photos` | `jsonb` | Photo entries — `{ label, image }` per entry, matching the web form's `photos` array shape, plus the technical drawing image. |
| `template_id` | `text`, default `'general'` | Unused beyond the default until Option 2 lands. |
| `drive_file_id` | `text`, nullable | Set only on finalize (not on every partial save) — best-effort Drive backup of the generated PDF, mirroring the invoice pattern. |

Changed:

- `order_id`, `customer_id` — made nullable (currently `order_id` is required by `Pdi.create`'s validation; that check is removed).
- `status` — reuses the existing `Pending` / `In Progress` / `Completed` / `Failed` values. A draft in progress is `Pending` or `In Progress`; finalizing (generating the PDF) moves it to `Completed`.

Unchanged: `sr_no`, `report_id`, `inspected_by`, `inspection_date`, `report_link` (now auto-populated instead of manually typed — pointing at the `GET .../pdf` endpoint below rather than a Drive link directly, so it always reflects current data even if the Drive backup is stale or missing).

## API endpoints

All under the existing `/api/pdi` router.

| Endpoint | Purpose |
|---|---|
| `POST /api/pdi/reports` | Create a new draft — can be near-empty (just started) or partially filled. Returns `report_id` immediately. |
| `PATCH /api/pdi/reports/:id` | Save progress — accepts any subset of fields. No PDF-generation-level validation, just persists whatever's filled in so far. Callable repeatedly, across sessions, from web or app. |
| `GET /api/pdi/reports/:id` | Fetch a report's current full data — used to resume a draft (app or web) and to power a "view details" screen. |
| `GET /api/pdi/reports` | List with the existing cursor pagination, extended with a `status` filter — powers both the PDI Records dashboard and the app's "My Drafts / In Progress" list. |
| `POST /api/pdi/reports/:id/finalize` | Marks complete: generates the PDF from stored data, does the best-effort Drive backup (failure doesn't block finalizing — same as invoices), sets `status = 'Completed'`, streams the PDF back in the same response (no separate round-trip needed to download after finalizing). |
| `GET /api/pdi/reports/:id/pdf` | Regenerates the PDF on the fly from stored data for view/download — works on drafts as sparse as just a `pdi_no`, so it isn't gated behind `finalize`. It still 400s if `pdi_no` itself is missing, since `PDIGenerator.generate()` requires it to name the document; every other field tolerates being blank. This is what `report_link` points at. |
| `DELETE /api/pdi/reports/:id` | Unchanged from today; additionally trashes the Drive backup if one exists (mirroring `InvoiceRecords.delete`). |
| `GET /api/pdi/templates` | Returns `[{ id: 'general', name: 'General', version: 1 }]`. Not consumed by the app yet — exists so Option 2 doesn't need a new endpoint, just new entries in this list. |

`POST /api/pdi/generate` (today's ephemeral, no-persistence endpoint) is retired in favor of the flow above, since the web form is migrating too (see below).

## Web form changes

- Opening "+ Create PDI" calls `POST /api/pdi/reports` immediately (near-empty draft, `status = 'Pending'`) instead of only initializing local component state, so a stable `report_id` exists from the first keystroke.
- A **Save** action calls `PATCH /api/pdi/reports/:id` with the current form state. (Exact trigger — explicit button vs. autosave on tab switch — is a UX detail for the implementation plan, not fixed here.)
- **"Generate PDF"** becomes **"Finalize & Generate PDF"** — calls `POST /api/pdi/reports/:id/finalize`, which both completes the report and returns the PDF for download in one step, same click-count as today.
- **PDI Records** becomes the shared entry point: clicking a `Pending`/`In Progress` row opens the Generator form pre-filled via `GET /api/pdi/reports/:id`, enabling a report started on one platform (app or web) to be finished on the other.
- Closing the form without saving discards unsaved changes, same as today.

## Mobile app (React Native/Expo)

- Auth: reuse the existing JWT login flow — no new auth system.
- Screens needed: report list (filtered by status, powers "My Drafts"), a form matching the general template's fields (header, Electrical/Mechanical/Photos tabs — same fields as the web form), Save and Finalize actions calling the endpoints above.
- Photos: `expo-image-picker` / `expo-camera` for capture-or-choose (mirroring the web's "Take Photo" / "Choose File" pair), `expo-image-manipulator` for the crop + resize + compress step, base64-encoded into the same `PATCH`/`finalize` payload shape the web form already sends.
- Hardcodes the general template's field layout directly (same as the web form) — does not need to call `GET /api/pdi/templates` yet.

## Explicitly out of scope for this round

- The custom template system itself (Option 2) — only the `template_id` column and the templates-list endpoint exist as forward-compat hooks.
- True offline (zero-signal) operation — ruled out by the "Save mechanism" decision above. If ever needed later, it would layer local draft storage and a sync queue on top of this design without changing the endpoint shapes.
- Autosave UX details (trigger cadence, conflict handling if the same report is edited from two devices at once) — left to the implementation plan.
