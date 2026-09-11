# PDI General Template Enhancements — Tolerance Validation, F/R Values, Duplicate-as-New-PDI, Multi-Photo Upload

## Problem

Five tickets were raised against the PDI (Pre-Dispatch Inspection) system. Discussion clarified that every field-level ticket (tolerance validation, F/R dual values, structured spec entry) targets one specific artifact — the hand-coded **General** template (`CRM_BACKEND/models/operations/pdi/templates/general.js`) and its dedicated fill-out form (`CRM/src/components/admin/PDIGeneratorForm.jsx`) — not the separate, already-shipped guided-creation authoring system (`PdiTemplatesAdminPage.jsx`/`PdiTemplateSectionEditors.jsx`) that admins use to build new templates from scratch. The other two tickets (duplicate-as-new-PDI, multi-photo upload) are report-level and photo-section-level concerns that apply regardless of which template a report uses.

General is a real, actively-used template: its Electrical and Mechanical Check tables already have a "Specification" row (nominal values shown once, above per-motor measured rows — see `specRow` and `buildSpecVals` in `general.js`) and `data.spec_*` override fields, but no actual tolerance math — measured values are just printed as typed, with no validation or flagging. Its Electrical table also splits Forward/Reverse testing across two full rows per motor today (a `direction` column holding "F" or "R"), rather than capturing both readings against one motor.

Three independent pieces of work came out of this:

- **Track A** — real tolerance validation, editable spec values, and structured Forward/Reverse entry, scoped entirely to the General template (its two check tables, its fill-out form, its PDF renderer).
- **Track B** — a "Duplicate as New PDI" action so a new inspection for a similar customer/product doesn't require re-entering everything from scratch.
- **Track C** — multi-photo upload per photo slot, for any template.

## Scope

**In scope:**
1. Editable, tolerance-validated nominal values for the General template's Mechanical and Electrical spec rows.
2. Structured, flexible Forward/Reverse entry for Electrical's Current Measured / RPM Measured columns.
3. Visual (not blocking) flagging of out-of-tolerance values, in both the fill-out form and the generated PDF.
4. A "Duplicate as New PDI" action on the PDI Records list, for any template.
5. Multi-photo-per-upload support for both freeform and fixed-slot photo sections, for any template.

**Out of scope, deliberately:**
- The guided-creation authoring UI (`PdiTemplatesAdminPage.jsx` / `PdiTemplateSectionEditors.jsx`) is untouched. Nothing here becomes an admin-configurable column type — General's table structure stays hardcoded JS, matching how it already works today (`mechChecks`, `ELEC_CHECKS`, `checksColumns` are all hardcoded the same way).
- The AutoNXT template (`autonxt.js` / `AutoNXTGeneratorForm.jsx`) is untouched — every ticket was about General specifically.
- Search/filter by structured spec values anywhere in the app (PDI Records list, Part Creation, etc.) — Track A stores values in a way that *could* support this later, but no search UI is built now.
- Any change to the already-hardened autosave/save-chain logic in `GenericPdiGeneratorForm.jsx` — Track B and C's changes to shared photo/report code must stay additive, the same discipline followed in every prior round this session.

## Track A: Tolerance validation, editable specs, and F/R entry (General template only)

### What changes in the Mechanical Check table

Checked against the actual current code in `PDIGeneratorForm.jsx` (not just `general.js`'s PDF-side defaults), here's the real starting point:

| Field | Spec-row input today | Per-row input today | Becomes |
|---|---|---|---|
| Motor Length | free-text input, blank default | free-text input | tolerance mode + amount added; numeric validation + flagging added |
| Shaft O/P D/Length | free-text input, blank default | free-text input | tolerance mode + amount added; numeric validation + flagging added |
| Mounting PCD | free-text input, default `'153'` | free-text input | tolerance mode + amount added; numeric validation + flagging added |
| MTG | free-text input, default `'4*M8'`/`'1.M6 / 2.Ø8.0'` | free-text input | **unchanged** — a compound description (two sub-specs in one string), not a single number. Stays free-text/informational, no numeric tolerance math. |
| Key Dim. | free-text input, default `'Go/NG'` | **GO/NG `<select>` dropdown** | **unchanged** — this is already a real pass/fail check, not a numeric spec. Stays exactly as it is. |
| Locating Dia. | free-text input, default `'50.0 mm'` | **GO/NG `<select>` dropdown** ← this is the bug | **changes from a GO/NG dropdown to a free numeric input** (matching what the spec row already implies — a real dimension, e.g. "50.2 mm" — not a pass/fail choice), then gets tolerance mode + amount added, numeric validation + flagging. |

So the spec-row inputs mostly already exist (as plain free-text, no tolerance math) — the real gaps are: (1) Locating Dia.'s per-row cell is wrongly forced into a GO/NG dropdown today and needs to become a free numeric input, and (2) four fields (Motor Length, Shaft O/P D/Length, Mounting PCD, Locating Dia.) need tolerance mode + amount added next to their existing nominal input, plus the actual validation/flagging logic, which doesn't exist at all today.

Each motor's row for these four fields is checked against `nominal ± tolerance` as the inspector types. Out-of-range values save normally (never blocked) and render with a flagged style (red border/background, matching the existing NG result styling) both in the browser and in the generated PDF.

### What changes in the Electrical Check table

Today: one row per motor **per direction** — a `direction` column holds "F" or "R", so testing both directions means two rows. `current_standard` and `rpm_specified` are separate per-row columns showing the same repeated value on every row (not a true single spec row like Mechanical has).

Becomes:

- **One row per motor.** The `direction` column is removed entirely.
- **Current Standard and RPM Specified move into a real spec row** (matching Mechanical's existing pattern) — one nominal + tolerance (mode + amount) for Current, one for RPM, typed once per PDI, not repeated per row.
- **Current Measured and RPM Measured stay single columns** (no new columns added) but become smart inputs: the inspector types `2/4` (forward/reverse), or `2` (one direction only), or `4` (the other direction only) — whichever the actual test covered. Voltage is unaffected — it stays a single plain value, no F/R split, no tolerance (not requested).
- The backend parses whatever was typed and stores it structured — two fields per measured column (e.g. `current_measured_forward`, `current_measured_reverse`), each left `null` if that side wasn't entered. Parsing rule: a value containing `/` splits into forward/reverse; a bare single number (no `/`) is stored as forward, on the convention that a single-direction test defaults to Forward unless the column's header text says otherwise (e.g. a column explicitly labeled "RPM Measured R" would store a lone number as reverse instead) — this convention is documented in code next to the parser, not configurable.
- Each side that has a value is tolerance-checked independently against the shared nominal, flagged the same way as Track A's Mechanical fields.
- The column header text itself (e.g. "Current Measured F/R", "Current Measured F") is set in `general.js` as a plain label string, same mechanism as every other column label today — not a new configuration concept, just descriptive text reflecting what's actually being tested in a given deployment of this template.

### Where the editable inputs live

`PDIGeneratorForm.jsx` already renders spec-row values as plain `<input>` text fields (`form.spec_motor_length`, `form.spec_mounting_pcd`, `form.spec_locating_dia`, etc. — see lines ~820-844) and per-row Mechanical values the same way, via `setField`/`setRowField`. This work does not introduce a new input mechanism — it adds tolerance mode + amount inputs next to the four numeric nominal fields (Mechanical) and Current/RPM (Electrical, where today those are per-row free-text fields with no spec row at all — see below), wires real parsing/validation into `setRowField`'s existing update path, and fixes Locating Dia.'s per-row cell from a `<select>` (GO/NG) to a numeric `<input>`.

`general.js`'s `buildSpecVals`/`DEFAULT_SPEC_VALS` (used only at PDF-render time in the backend) drop their hardcoded fallback values for the four now-required numeric fields — a template reused across many product lines was never correctly served by one silently-reused default PCD or Locating Dia., so `renderer.js` should require these to be present in `data` rather than substituting a stale default.

### Validation and flagging, precisely

- **Malformed input** (non-numeric text in a numeric field) is rejected at entry — this already happens today for any numeric input; unchanged.
- **Out-of-tolerance numeric input** (a real number, just outside `nominal ± tolerance`) is **accepted and saved**, and the cell is visually flagged (red) in both the fill-out form and the PDF. This is a deliberate reversal of Ticket 1's literal wording ("reject the entry") — a PDI's purpose is to catch real defects, and a hard rejection would make it impossible to record a motor that genuinely failed a spec check.
- Flagging never blocks Save, autosave, or Finalize & Generate PDF.

## Track B: Duplicate as New PDI

A new action, "Duplicate as New PDI," added to the PDI Records list (`PdiReportsTable.jsx`) alongside the existing Resume/View/Delete actions, available on any report regardless of which template it used.

**Behavior:**
- Creates a new report using the same `template_id` (pinned to the current active `template_version`, same as any new report today).
- **Resets to blank:** `pdi_no`, `inspection_date`, `photos`, every table/checklist/fill-in-list row (all "measured" data — a different physical unit is being tested), and all signatures.
- **Carries forward unchanged:** everything else in `data` — Header-level fields (Customer Name, Product ID, Drawing No, Product Specifications, and any other info-field), and (for General specifically) the Track A spec-row nominal/tolerance values, since those apply to the whole batch, not one motor.
- Opens the new report directly in its fill-out form, same as clicking "Resume" on a freshly-created report.

**Backend:** new `POST /api/pdi/reports/:id/duplicate` endpoint. Reads the source report's `data`, applies the reset/carry-forward split described above, and calls the same report-creation path `createReport` already uses (so `report_id`, `sr_no`, `status: 'Pending'`, `created_at`, etc. are freshly assigned exactly as they are for any new report).

## Track C: Multi-photo upload

Applies to both photo section modes, for any template, in `GenericPdiSections.jsx` (`FreeformPhotoSection`, `FixedSlotPhotoSection`) and the shared upload component (`PdiImageUpload.jsx` family):

- The file input gains `multiple`, so a technician can select several photos from their gallery in one dialog instead of repeating the add-photo flow per file.
- Each freeform entry and each fixed slot now holds an **array** of image references instead of one. Up to 10 photos per entry/slot; accepted formats JPEG/PNG/HEIC (HEIC auto-converts, same as the existing single-photo pipeline already does).
- Existing per-photo compression/thumbnailing (already built for the single-photo case) applies to each photo in the batch the same way.
- **PDF rendering:** each photo in a slot gets its own cell in the existing 2-per-row grid layout (`drawPhotoCell` in `renderer.js`) — a slot with 3 photos produces 3 labeled cells ("Damage Photos (1)", "(2)", "(3)") instead of being limited to one.
- **Report storage:** the report's `photos` JSONB column already stores a list at the top level; this changes the *shape of entries within it* (each freeform/slot entry becomes `{ label, images: [...] }` instead of `{ label, image }`), not the column type itself.

## Testing

No automated frontend test suite exists in this repo (consistent with every prior PDI round) — verification is lint + build + live manual/browser verification.

Given Track A touches a real, actively-used template's PDF output, the implementation plan must include a controller-personal live-verification pass covering: filling in spec-row nominal/tolerance for both tables, entering an in-tolerance and an out-of-tolerance value and confirming the flag appears (form and PDF), entering F/R values as `x/y`, `x` only, and `y` only and confirming each parses and validates correctly, duplicating a completed PDI and confirming the reset/carry-forward split is exactly right, and uploading multiple photos in one action to both a freeform section and a fixed slot and confirming the PDF shows every photo.
