# PDI Web Form Migration — Design

**Status:** Approved by user, implementing directly (user requested skipping the written-spec review pause)
**Author:** Claude (session with Rahul Srivastava)
**Date:** 2026-09-04

## Context

The backend persistence layer for PDI reports (`/api/pdi/reports/*`, per `docs/superpowers/specs/2026-09-04-pdi-mobile-app-persistence-design.md` and `docs/superpowers/plans/2026-09-04-pdi-reports-backend.md`) is now live on `main`. This design covers migrating the CRM web frontend onto it — the third piece of the original three-part roadmap's first item ("save PDI reports to DB, show on dashboard, PDF to Drive, view/download") — and retiring the now-unused legacy system.

Three frontend files are affected, none previously known to overlap:
- `CRM/src/components/admin/PDIGeneratorForm.jsx` — the form that builds a PDI report and downloads its PDF. Currently calls the ephemeral `POST /api/pdi/generate` (no persistence).
- `CRM/src/components/admin/PdiPage.jsx` (route `/pdi`, roles `admin`/`design`/`dispatch`) — a read/edit-only dashboard table.
- `CRM/src/components/production/ProductionPDIPage.jsx` (route `/production-pdi`, role `production`) — discovered during this session's project-context exploration to be a near-byte-identical duplicate of `PdiPage.jsx`, both driving the same legacy flat `/api/pdi` endpoints.

## Decisions

**1. Component consolidation.** `PdiPage.jsx` and `ProductionPDIPage.jsx` are unified into one shared `PdiReportsTable` component (parameterized only by page title), used by both routes. New behavior (resume, authenticated view, delete) gets built once instead of twice, preventing the two from drifting further apart the way they already have.

**2. Generator form data flow.**
- Opening "+ Create PDI" immediately calls `POST /api/pdi/reports`, creating a `Pending` draft — matches the already-approved backend design (a stable `report_id` from the first keystroke).
- **Save** is an explicit button, positioned on the left of the modal footer, separate from the Cancel/Finalize pair on the right. Calls `PATCH /api/pdi/reports/:id` with the current form state.
- **Cancel before Save has ever been clicked** on that draft auto-deletes the row (`DELETE /api/pdi/reports/:id`), so opening the form by mistake doesn't leave clutter in the dashboard. Once Save has fired at least once, Cancel just closes the modal normally — no delete.
- **"Generate PDF"** becomes **"Finalize & Generate PDF"** — calls `POST /api/pdi/reports/:id/finalize`, downloads the returned PDF exactly as today.

**3. Resume flow.** The dashboard links to `/pdi-generator?report=<id>`. `PDIGeneratorForm.jsx` checks for that query param on mount, fetches `GET /api/pdi/reports/:id`, and auto-opens the modal pre-filled with the full saved state. The Generator form remains the single owner of the form UI — the dashboard never renders form fields itself.

**4. Role access.** `/pdi-generator` today allows `admin`/`production`. Those are the only roles that get a **Resume** action on a draft row. `design`/`dispatch` (who can see `/pdi` but not `/pdi-generator`) get a **View/Download** action instead — an authenticated fetch of `GET /api/pdi/reports/:id/pdf` opened as a blob, the same pattern `PDIGeneratorForm.jsx` already uses for its PDF download today. No route-permission changes are needed. Delete follows the same admin/production gating as Resume.

**5. Dashboard redesign.** The table drops the `Customer ID` / `Order ID` columns (in the current legacy data they are almost always blank — the Generator flow is free-form and doesn't link a CRM customer/order record) and adds **PDI No.** and **Customer**, sourced from `data.pdi_no` / `data.customer_name`. Status keeps its existing color coding. Real-time row updates switch from listening for the legacy `pdiUpdate` socket event to the new `pdiReportUpdate` event the reports backend emits.

**6. Legacy-shaped rows.** Any report row created before this migration (or via the retired legacy endpoints, before they're removed) has `data: {}`. The table renders `—` for PDI No./Customer in that case rather than breaking, the same graceful-fallback style the table already uses for other missing fields.

**7. Legacy system retirement.** Once none of the three frontend files call the legacy paths, the legacy backend system is removed outright rather than left running unused indefinitely:
- `models/operations/pdi.js` deleted.
- `controllers/operations/pdi.controller.js`'s `generate`, `create`, `getAll`, `getOne`, `update`, `delete` exports removed (the file's new `getTemplates` export, added in the reports-backend plan, stays — it isn't part of the legacy system, just co-located in the same file).
- `routes/operations/pdi.js`'s routes for those six handlers removed; the `GET /templates` route stays, still mounted under `/api/pdi`.
- The legacy `pdiUpdate` socket event stops being emitted (nothing will emit it once the model is deleted); all three frontend files' socket listeners are updated to `pdiReportUpdate` as part of this same migration, so there's no dangling listener for an event that no longer fires.
- Verified via full-repo search before removal that no other backend or frontend code (routes, scripts, tests, cron jobs) references the legacy model, controller exports, or routes beyond the three frontend files already being migrated.

## Explicitly out of scope

- The custom template authoring system (`docs/superpowers/specs/2026-09-04-pdi-mobile-app-persistence-design.md` Section 4, Option 2) — unaffected by this migration.
- The mobile app itself — being built independently against the already-live `/api/pdi/reports/*` API.
- Any change to the PDI Generator's actual form fields, photo handling, or PDF layout — this migration only changes how the form persists and downloads, not what it collects or renders.
