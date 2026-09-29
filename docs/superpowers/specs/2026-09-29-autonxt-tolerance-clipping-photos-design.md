# AutoNXT Motor PDI — Editable Tolerance, Clipped Specs, Multi-Photo

## Context

The General template went through two rounds of changes this quarter: editable, tolerance-validated specification values with red out-of-range flagging (form + PDF), a fix for a clipped "Spe…" label caused by single-line-only table cells, and multi-photo upload per slot. The user asked for the same treatment on the **AutoNXT Motor PDI** template (`CRM_BACKEND/models/operations/pdi/templates/autonxt.js`, `CRM/src/components/admin/AutoNXTGeneratorForm.jsx`).

AutoNXT is structurally different from General: it has no per-motor rows and no separate "spec row above many measured rows." It's three fixed checklists (Performance Test, General Check, Physical Parameters) where every row is hardcoded in the template file — the same specification text for every report, with no way to override it, and no tolerance math at all. Applying "what we did for General" here means adapting the pattern, not copying it.

**Scope for this round:** `CRM_BACKEND` and `CRM` only. AutoNXT also exists in `pdi-erp-app` (as a generic, data-driven template — `src/data/autonxtTemplate.ts` + `GenericReportEditorScreen.tsx` — a different mechanism from CRM's bespoke `AutoNXTGeneratorForm.jsx`). Extending it there is an explicit follow-up, not part of this spec, matching how General's first round was backend+web before the mobile app got its own separate change request.

## What already works, no changes needed

Checked directly against the current code before scoping this:
- **Duplicate as New PDI** — report-level, not template-specific. Already works for AutoNXT reports.
- **Backend performance work** (`?photos=summary`, Drive backup after response, photo downscale, on-disk PDF cache) — lives in `pdiReports.js`/`pdi_generator.js`, template-agnostic. Already applies to AutoNXT.
- **Signature split** (Electrical / Mechanical / Approved) — AutoNXT already has this as three roles on one page.
- **GO/NG entry** — already the default across AutoNXT's checklist rows.
- **Backend photo renderer** — `renderer.js`'s `drawPhotoSection` already normalizes both a single data-URI (AutoNXT's current shape) and an array of images (the multi-photo shape) for `fixed-slots` mode. No backend change needed for multi-photo — only the AutoNXT form needs to start sending arrays.

## Change 1: Editable, tolerance-validated specifications

### Which rows get it

Only rows that hold one clean, single numeric spec become editable + tolerance-checked. Rows that are already pass/fail (Go/NG) or hold a compound, multi-fact spec (e.g. "PCD Ø63.0, 06Nos M10, Depth 25.0, Go/NG") stay exactly as they are today — this mirrors General's own precedent of leaving its MTG and Key Dim. fields untouched.

**Performance Test @ No Load — all 8 rows, both BEMF and Current Specified columns (16 fields):**

| Row (RPM) | BEMF field | Default nominal / mode / tolerance | Current field | Default nominal / mode / tolerance |
|---|---|---|---|---|
| 500 | `spec_rpm_500_bemf` | 79.0 / `%` / 3 | `spec_rpm_500_current` | 6.0 / `±` / 2.0 |
| 1000 | `spec_rpm_1000_bemf` | 155.0 / `%` / 3 | `spec_rpm_1000_current` | 6.0 / `±` / 2.0 |
| 1500 | `spec_rpm_1500_bemf` | 227.0 / `%` / 3 | `spec_rpm_1500_current` | 3.0 / `±` / 1.0 |
| 1800 | `spec_rpm_1800_bemf` | 270.0 / `%` / 3 | `spec_rpm_1800_current` | 3.0 / `±` / 1.0 |
| 2000 | `spec_rpm_2000_bemf` | blank ("-") | `spec_rpm_2000_current` | blank ("-") |
| 2200 | `spec_rpm_2200_bemf` | blank ("-") | `spec_rpm_2200_current` | blank ("-") |
| 2500 | `spec_rpm_2500_bemf` | blank ("-") | `spec_rpm_2500_current` | blank ("-") |
| 3000 | `spec_rpm_3000_bemf` | blank ("-") | `spec_rpm_3000_current` | blank ("-") |

The 2000-3000 rows default to blank/"-" (today's fixed text). They're editable like every other row — if someone later fills in a real nominal, it becomes tolerance-checked like any other row; until then, a blank/non-numeric spec skips validation, the same convention `tolerance.js` already uses everywhere else (General included).

**Physical Parameters — 3 rows (3 fields):**

| Row | Field | Default nominal / mode / tolerance |
|---|---|---|
| Motor Total Length (Incl.Hyd.Mtg) | `spec_motor_total_length` | 467.5 / `±` / 1.0 |
| Shaft O/P Length from Mounting Surface | `spec_shaft_op_length` | 10.0 / `±` / 0.5 |
| Locating Dia. | `spec_locating_dia` | 180.0 / `bilateral` / +−0.01, −0.05 |

Locating Dia.'s spec today is `Ø180.0 (-0.01 TO -0.05)` — both tolerance figures are negative (both below nominal), which is exactly the case the `bilateral` mode (already built for General) exists to handle; `±`/`%` can't express it.

**Unchanged:** General Check's 7 rows (all Go/NG); Physical Parameters' remaining 22 rows (Go/NG checks, and compound specs like Shaft Flange Mtg., Mounting Details, the two Hyd. Mtg rows, Power/Temp Sensor Cable Length, Noise, Physical Damage).

### Data model

Per tolerance-eligible field `X`: `spec_X` (nominal), `spec_X_tol_mode` (`'±'` / `'%'` / `'bilateral'`), `spec_X_tol` (used for `±`/`%`), `spec_X_tol_plus`/`spec_X_tol_minus` (used for `bilateral`) — identical naming convention and identical semantics to General's fields, no new tolerance logic. `CRM_BACKEND/models/operations/pdi/tolerance.js`'s `checkTolerance` is reused unchanged.

All fields are additive and default to the values in the tables above when absent from `data`, so any report nobody edits — old or newly created — renders exactly as it does today.

### Backend (`CRM_BACKEND`)

- `templates/autonxt.js`: row-value functions for the Specified/Measurement columns read `data.spec_X*` with fallback to the current hardcoded literal (today's `bemfSpec`/`currentSpec`/`spec` strings become the defaults, not the only values).
- `isOutOfTolerance` added to the Measured columns for all 19 fields, calling `checkTolerance` the same way General's MCOLS columns already do.
- Self-sizing row layout (`specCellLayout`, ported from `general.js`/`renderer.js`) applied to the Specification column in all three AutoNXT tables, fixing the clipping the template's own code comment already flags ("flattened to one comma-joined line since table cells render single-line with ellipsis truncation, not multi-line wrapping").

### Web form (`CRM`, `AutoNXTGeneratorForm.jsx`)

- Each of the 19 fields gets an inline nominal input + tolerance-mode select + tolerance-amount input(s), placed next to its existing Measured input in the same table row. A second amount input appears only when Bilateral is selected (same conditional-second-input pattern as General).
- Motor Total Length, Shaft O/P Length, and Locating Dia.'s Measured cell changes from the current GO/NG/NA `<select>` to a free numeric `<input>` — these are real dimensions, not pass/fail checks (the same bug General's Locating Dia. field had before its own fix). Performance Test's `bemf_measured`/`current_measured` are already free-text inputs; unchanged.
- Out-of-tolerance values get the same red border/background flag General uses, in both the form and the generated PDF.

## Change 2: Multi-photo upload

AutoNXT's 6 fixed photo slots currently use `ImageUploadCard` with a single `value`/`onSelect`/`onClear` (one image per slot). This changes to the shared multi-image pattern already used elsewhere (`images` array, `onFilesSelected`, `onRemove` by index) — same component contract `GenericPdiSections.jsx`'s `FixedSlotPhotoSection` already uses. Each slot's stored value becomes `{ label, images: [...] }` instead of a bare data-URI string.

No backend change: `renderer.js`'s `drawPhotoSection` already normalizes both the legacy single-string shape and the array shape for `fixed-slots` mode (existing code comment confirms this was anticipated). Old AutoNXT reports with a single-string photo value keep rendering correctly.

## Testing

No automated test suite covers `AutoNXTGeneratorForm.jsx` or the AutoNXT template's PDF output today (consistent with every prior PDI round — the only backend test coverage that exists in this area is General's own suite). Verification is:

- **Backend:** extend `pdi_template_renderer.test.js`-style coverage for AutoNXT — the new tolerance fields for all three modes (including the Locating Dia. bilateral case), the fallback-to-default behavior for reports with none of the new fields, and the self-sizing row for a long spec string.
- **Web form, live/manual:** for each of the 19 tolerance-eligible fields, enter an in-tolerance and an out-of-tolerance measured value and confirm the red flag appears in both the form and the generated PDF; confirm an old/unedited report still prints identically to today; confirm Locating Dia.'s Measured cell is now a number input; confirm multi-photo upload works across all 6 slots and each photo appears in the PDF.

## Explicitly out of scope

- `pdi-erp-app` (mobile) — AutoNXT's generic-template-driven mobile screen is untouched this round; a follow-up spec if/when needed.
- The 22 unchanged Physical Parameters rows and 7 General Check rows — no editable spec, no tolerance math, matching how General itself left similar non-numeric fields alone.
- No retroactive migration of existing AutoNXT reports — all new fields are additive/optional; old reports render unchanged unless edited going forward.
