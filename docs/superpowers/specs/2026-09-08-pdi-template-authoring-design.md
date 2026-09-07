# PDI Template Authoring UI (Phase 2) — Design Spec

**Date:** 2026-09-08
**Status:** Approved for implementation

## Problem

Phase 1 (shipped) built a data-driven PDI template engine — a generic PDF renderer walking 6 section types (header/table/photo/image/signature/text) — and validated it against two real, structurally different formats: General (production) and AutoNXT (a second customer). Both are hand-written `templates/*.js` files; adding a third customer's format today means writing a new JS file, its own React form component, and redeploying.

This phase closes that gap for the common case: an admin defines a new template's *document structure* through a web UI, without touching code. The fill-out *form* stays hand-coded per template (unchanged from Phase 1 — see Scope below); this phase is PDF-template authoring only.

## Scope

**In scope:**
- A new `pdi_templates` database table storing authored templates as versioned JSON.
- A declarative, JSON-safe dialect of the 6 section types (no JS closures — see "The declarative dialect" below) and a small adapter that hydrates a stored definition into the exact in-memory shape Phase 1's existing `renderTemplate` already knows how to draw.
- Admin-only CRUD + publish/archive endpoints, plus a live-preview endpoint that renders a draft (saved or not) against sample data.
- A single-page structured admin editor (not free-form/drag-and-drop): template metadata, an ordered list of pages, each with an ordered list of sections, each section's config edited via a type-specific inline form.
- `GET /api/pdi/templates` (the picker's existing endpoint) extended to merge the code registry with active, published DB templates.

**Explicitly out of scope (unchanged from Phase 1's own scope decisions, reaffirmed here):**
- No auto-generated fill-out form. An authored template still needs a hand-coded form component before it can actually be used to create reports — this phase only removes the "write a template.js file" step, not the "write a form" step.
- General and AutoNXT are **not** migrated into the database. They stay exactly as they are — hand-coded, in the code registry, zero risk to production. The database is purely additive: new templates only.
- No support in the authored dialect for arbitrary computed logic (dynamic label interpolation, General's spec-row, custom row filters beyond "this field is non-empty"). A template needing that kind of customization is still hand-coded, same as today — this is an accepted, permanent boundary, not a gap to close later.
- No hard delete. Retiring a template means archiving it (see Versioning below) — its version history is never destroyed, since existing reports must always be able to regenerate their PDF exactly as it was.

## Data model

### `pdi_templates` table

```sql
CREATE TABLE pdi_templates (
  id          TEXT NOT NULL,
  version     INT NOT NULL,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  definition  JSONB NOT NULL,
  created_by  INT REFERENCES users(user_id),
  created_at  TIMESTAMP NOT NULL DEFAULT now(),
  PRIMARY KEY (id, version)
);
CREATE INDEX idx_pdi_templates_id_version ON pdi_templates (id, version DESC);
```

**Append-only versioning.** Every save — editing content, publishing, or archiving — inserts a new row with `version` incremented; existing version rows are never updated or deleted. "The current state of template X" means "the highest `version` row for that id." This is what makes the versioning guarantee below possible, and it's also a free audit trail (every past state of a template is still queryable).

**Status** governs whether a template is offered when *creating a new report* (`status = 'active'`) — it has no bearing on whether an *existing* report can still regenerate its PDF, which always resolves by exact `(id, version)` regardless of status. Archiving a template hides it from new-report creation without touching anything already created under it.

### `pre_dispatch_inspection_reports` gains one column

```sql
ALTER TABLE pre_dispatch_inspection_reports ADD COLUMN IF NOT EXISTS template_version INT;
```

`NULL` for reports created against a code-based template (General, AutoNXT — those aren't versioned at the DB level; a code change ships as a new deployment, which is Phase 1's existing, accepted model). For a DB-authored template, `createReport` snapshots the *current active* version's number into this column at creation time — this is the mechanism that fulfills "editing a template can never silently alter historical documents": every report pins to the exact version it was created under, forever.

### Template ID collisions

A new template's `id` must not collide with any code-registered template id (`general`, `autonxt`, ...) — checked at creation time, rejected with 409 if it does. One namespace, one source of truth per id, no ambiguity about which registry wins.

## The declarative dialect

Phase 1's code templates lean on raw JS closures everywhere a value needs computing (`value: (row, sectionData) => ...`, `fixedRows: (data) => [...]`, `placeholder.text: (data) => ...`). None of that survives a JSONB column. The authored dialect replaces every closure with a small, explicit data shape — chosen because it's exactly what General's and AutoNXT's *actual* closures turned out to compute, nothing more:

**header** — `infoFields` rows become `{ leftLabel, leftKey, leftFormat, rightLabel, rightKey, rightFormat }` (`format` is `"text"` or `"date"`; the adapter does `data[key]` directly, or `fmtDate(new Date(data[key]))` when format is `"date"`, replacing the `valueFn(data)` closure). `extraFormatLines` is already a plain string array in Phase 1 — unchanged.

**table** — a column's value now comes from exactly one declared `cell` source:
- `{ source: "row" }` — plain `row[key]` lookup (covers every repeatable-table column in both existing templates).
- `{ source: "sectionData", subfield, default }` — `(data[dataKey][row.key] || {})[subfield] || default` (covers every fixed-checklist "Measurement" column in both existing templates).
- `{ source: "constant", value }` — always renders `value` (covers General's "Specified: Go/NG" column).

`fixedRows` becomes a literal JSON array instead of a function of `data` — meaning an authored fixed table's row labels can't embed per-report dynamic text (AutoNXT's cable-length-in-the-label pattern doesn't carry over; that stays a hand-coded-only trick). `filterRow` becomes `filterKey: "some_field"` — the adapter filters repeatable rows where that field is truthy, covering General's/AutoNXT's actual filter (`motor_sr_no` non-empty) exactly. `specRow` isn't representable at all in this dialect — an authored table never has one.

`footerHeight` is **not** part of the authored schema — the adapter computes it automatically (see "Automatic pagination reservation" below), removing a manual-calculation step Phase 1 required of hand-coded templates.

**photo, signature, text** — already fully data (no closures existed here in Phase 1), carried over unchanged.

**image** — `placeholder.text` becomes a static string instead of `(data) => string`. `annotations` were already plain data in Phase 1 (`text`/`x`/`xFrac`/`y`/`w`/`wFrac`/`size`/`align`) — unchanged.

## Adapter: hydration, not a second renderer

`models/operations/pdi/authoredTemplate.js` (new) takes `(definition, data)` and returns a template object shaped exactly like `general.js`/`autonxt.js` already produce — real functions plugged in for `value`, `fixedRows`, `filterRow`, `placeholder.text`, and a computed `footerHeight`. That object is handed to Phase 1's existing `renderTemplate(doc, template, data)` **completely unmodified** — this phase adds zero lines to `renderer.js`. The entire authoring system is: a JSON dialect in, a `renderTemplate`-shaped object out.

**Automatic pagination reservation.** For a repeatable table section at index *i* on a page, the adapter sums the "static height" of every section after it on the same page: `text` → 40, `signature` → 36, a `fixed`-mode table → `headerHeight + rows.length × rowHeight`. A `photo`/`image` section, or a second `repeatable` table, following it has content-dependent height that can't be known in advance — the adapter adds a fixed 150pt safety buffer in that case rather than trying to compute it exactly. This is a heuristic, not a guarantee: worst case, a table breaks onto a continuation page slightly earlier than strictly necessary. It never causes a crash or an overlap, and it removes a calculation Phase 1 required template *authors* to get right by hand.

## API

All `/api/pdi/admin/templates*` routes require `authenticateToken` **and** `req.user.role_id === 1` (admin) — matching this codebase's existing inline role-check pattern (e.g. `activities.controller.js`), not a new middleware.

| Method & path | Purpose |
|---|---|
| `GET /api/pdi/templates` | *(existing, extended)* Merge code registry with DB templates where `status = 'active'` (latest version each). Unchanged response shape. |
| `GET /api/pdi/admin/templates` | List every template id with its latest version's name/status/updated_at, for the admin list page. |
| `GET /api/pdi/admin/templates/:id` | Full definition of the latest version, for editing. |
| `POST /api/pdi/admin/templates` | Create: `{ id, name, definition }` → inserts version 1, `status: 'draft'`. 409 if `id` collides with a code template or an existing DB template. |
| `PUT /api/pdi/admin/templates/:id` | Save an edit: `{ name, definition }` → inserts a new version, carrying forward the current status. |
| `POST /api/pdi/admin/templates/:id/publish` | Inserts a new version (same definition as latest) with `status: 'active'`. |
| `POST /api/pdi/admin/templates/:id/archive` | Inserts a new version (same definition as latest) with `status: 'archived'`. |
| `POST /api/pdi/admin/templates/:id/preview` | Body: `{ definition }` (need not be saved yet). Hydrates it against a built-in sample-data fixture and returns a PDF (`responseType: blob` on the frontend, same pattern as report finalization). |

`createReport` (existing endpoint, already accepts `template_id`) gains: when the resolved template is DB-backed rather than code-registered, snapshot its current active version into the new `template_version` column. `PDIGenerator.generate` and `getPdfBuffer`/`finalizeReport` gain the same resolution order: check the code registry by id first; if not found, look up `pdi_templates` by `(template_id, template_version)` and run it through the adapter.

## Frontend

New admin-only page, `src/components/admin/PdiTemplatesAdminPage.jsx`, linked from the admin dashboard (mirroring how `PdiPage`/`PDIGeneratorForm` are already linked). Two views on one route, toggled by local state (not two separate routes — keeps template list ↔ editor navigation instant):

**List view:** table of templates (name, id, status badge, latest version, updated_at), a "+ New Template" button, per-row Edit/Preview/Publish/Archive actions.

**Editor view:** name + id (id immutable after creation) at the top, then an ordered list of pages (add/remove/reorder via up/down buttons — consistent with the earlier "structured, not drag-and-drop" decision), each expandable to its ordered list of sections (same add/remove/reorder pattern), each section showing a type-specific inline config form matching the dialect shapes above 1:1 (e.g. the table section's column list is itself an add/remove/reorder sub-list, each column's `cell` source picked from a dropdown that reveals the relevant sub-fields). "Preview PDF" calls the preview endpoint with the current in-editor state, no save required first. "Save," "Save & Publish," and "Archive" map to the three POST/PUT actions above.

## Testing

**Backend:** unit tests for the adapter (declarative JSON → hydrated object → valid PDF, including the auto-footerHeight logic and its buffer-fallback case) and for the code/DB registry merge and id-collision rejection; an integration test creating a template via the API, publishing it, creating a report against it, finalizing, and confirming the PDF is valid and pinned to the right version (edit the template afterward, regenerate the same report's PDF, confirm it's unchanged).

**Frontend:** no test framework exists for this codebase's React components (confirmed — Phase 1's `PDIGeneratorForm.jsx`/`AutoNXTGeneratorForm.jsx`/`PdiTemplatePicker.jsx` were all verified via lint, build, and a live browser walkthrough only, never unit tests). This phase follows the same pattern: lint + build clean, plus a live end-to-end walkthrough (create a template, preview it, publish it, create and finalize a real report against it, confirm the PDF) before shipping.
