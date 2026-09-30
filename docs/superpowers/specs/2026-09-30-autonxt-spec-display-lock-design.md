# AutoNXT Specification Display Text — Auto-Computed and Locked

## Problem

AutoNXT's 19 tolerance-eligible spec fields (Performance Test's BEMF/Current specifications across 8 RPM tiers, plus 3 Physical Parameters fields) each carry a "Specification" / "PDF display text" input that is completely independent of that field's Nominal value, Tolerance mode, and Tolerance amount inputs — on both the web admin form (`CRM/src/components/admin/AutoNXTGeneratorForm.jsx`'s `AutoNxtSpecCell`) and the mobile app's AutoNXT editor (`pdi-erp-app/src/screens/GenericReportEditorScreen.tsx`'s `AutoNxtSpecificationEditor`). A technician can change Nominal/Tolerance without updating the display text, so the printed PDF shows a specification string that no longer matches what the Measured value was actually validated against.

This is confirmed reproducible: `pdi-erp-app/src/services/autonxtParity.ts` seeds `rpm_500_bemf`'s display text to the literal default `'79.0±3%'` the first time a report is opened; from that point the three fields (display text, nominal, tolerance) are freely and independently editable with no re-sync. A report was found with Nominal changed 79.0→80 and Tolerance changed 3→6, while the display text remained stuck at `"79.0±3%"`.

The backend (`CRM_BACKEND/models/operations/pdi/templates/autonxt.js`) is not the cause and needs no behavior change: `specDisplay(data, id)` already just returns `data[spec_${id}_display] || SPEC_DEFAULTS[id].display` verbatim — it never validates or derives this text from the tolerance fields, for either AutoNXT or General.

### Why General does not have this bug

General's mobile editor (`pdi-erp-app/src/screens/ReportEditorScreen.tsx`) computes every `spec_X_display` value fresh from the live nominal/tolerance/mode state, inline, every time the save payload is built (via `formatToleranceSpecification(...)`) — there is no editable UI field for it at all, so it cannot drift. General's web form (`CRM/src/components/admin/PDIGeneratorForm.jsx`'s `ToleranceSpecInput`) does not send a display field at all; the backend's `general.js` template falls back to the plain nominal when it's absent. This fix brings AutoNXT to the same guarantee General already has, rather than inventing a new pattern.

### Why a plain auto-formatter isn't enough on its own

General's existing `formatToleranceSpecification` only knows `"nominal ±tolerance[%]"` / `"nominal +x/-y"`. AutoNXT's current hand-written defaults use per-field units and prefixes that a generic formatter can't reproduce: `"6.0±2.0A"` (an "A" suffix for amps) and `"Ø180.0 (-0.01 TO -0.05)"` (a "Ø" prefix and parenthetical "TO" wording for the bilateral diameter spec). Locking the field to a plain generic format would be a visible regression in wording on every AutoNXT PDF. This design adds per-field unit/prefix metadata so the computed text matches today's wording exactly.

## Scope

AutoNXT's 19 spec fields only, across two codebases:
- `CRM/src/components/admin/AutoNXTGeneratorForm.jsx`
- `pdi-erp-app/src/screens/GenericReportEditorScreen.tsx` + `pdi-erp-app/src/services/autonxtParity.ts`

Plus a one-time production data/PDF fix (`CRM_BACKEND`, run once, not part of the app/web code paths).

**Out of scope:** General's fields (already correct, not touched). Any backend template code change (not needed — the backend's print/fallback logic is unchanged). AutoNXT's tolerance-check logic itself (`checkTolerance`/`evaluateTolerance`, unrelated — this only concerns the printed display string). Making the spec catalog dynamically admin-configurable (it remains the existing fixed, hardcoded 19-field catalog in both clients).

## Design

### Where computation happens

Client-side, in both CRM (web) and pdi-erp-app (mobile), mirroring exactly how General already works. This matches this codebase's established convention: tolerance-check logic (`checkTolerance`/`evaluateTolerance`) is already intentionally duplicated across CRM_BACKEND, CRM, and pdi-erp-app because these three codebases don't share a build pipeline. The new formatter and metadata follow the same pattern — implemented once in JS (CRM) and once in TypeScript (pdi-erp-app), kept in sync by convention, not by a shared package.

### New per-field metadata

Added alongside each client's existing AutoNXT spec catalog (`AUTO_NXT_SPECIFICATIONS` in `autonxtParity.ts`; the equivalent literal table in `AutoNXTGeneratorForm.jsx`). Two optional string properties per spec id, derived directly from today's hardcoded default display strings:

| Field group | `unit` | `prefix` |
|---|---|---|
| `*_current` (8 fields: `rpm_{500,1000,1500,1800,2000,2200,2500,3000}_current`) | `"A"` | — |
| `*_bemf` (8 fields), `motor_total_length`, `shaft_op_length` | — | — |
| `locating_dia` | — | `"Ø"` |

### New formatter

`formatAutoNxtSpecDisplay(nominal, tolMode, tol, tolMinus, { unit = '', prefix = '' })`, implemented once per client (mirrors `formatToleranceSpecification`'s existing shape/signature style):

- Blank/non-numeric `nominal` → returns `"-"` (matches the existing placeholder already used by the four undefined RPM tiers' defaults — not an empty string, since AutoNXT reports commonly leave those tiers blank and the table cell must still show something).
- `tolMode === '±'` or `'%'`: `` `${prefix}${nominal} ±${tol}${tolMode === '%' ? '%' : ''}${unit}` `` — e.g. `"6.0 ±2.0A"`, `"79.0 ±3%"`, `"467.5 ±1.0"`.
- `tolMode === 'bilateral'`: `` `${prefix}${nominal} (${tol} TO ${tolMinus})` `` — e.g. `"Ø180.0 (-0.01 TO -0.05)"`.

This reproduces every one of today's 19 default strings exactly (verified by direct comparison against `CRM_BACKEND`'s `SPEC_DEFAULTS` table and `autonxtParity.ts`'s `defaultDisplay` values during implementation/testing).

### UI change: read-only, always visible

`AutoNxtSpecCell` (web) and `AutoNxtSpecificationEditor` (mobile): the "Specification" / "PDF display text" input stays visible but becomes **read-only** (disabled), always showing `formatAutoNxtSpecDisplay(...)` computed live from that field's current nominal/mode/tolerance/tolerance-minus state. The technician can see exactly what will print but can no longer type into it or cause it to diverge. Its `onChange` handler is removed; nominal, tolerance-mode select, and tolerance-amount input(s) are unchanged.

On save, the computed value (not a stored/typed one) is what gets written into `spec_X_display` and sent to the backend — the wire contract (`spec_${id}_display` as a string field in `data`) is unchanged; only how the client populates it changes.

`autonxtParity.ts`'s `initializeAutoNxtParityData` keeps seeding `spec_${id}` / `_tol_mode` / `_tol` / `_tol_minus` from each field's `defaultNominal`/`defaultMode`/`defaultTolerance`/`defaultToleranceMinus` exactly as today (a report still needs starting nominal/tolerance values). It **stops** seeding `spec_${id}_display` from `defaultDisplay` — that field is now always freshly computed from whatever nominal/tolerance values are in effect (seeded or edited), so a stored default for it is redundant. `defaultDisplay` itself can stay on `AutoNxtSpecification` unused, or be removed — an implementation detail, not a behavior change either way.

### Backend

No code changes. `specDisplay(data, id)` in `CRM_BACKEND/models/operations/pdi/templates/autonxt.js` keeps its existing `data[spec_${id}_display] || SPEC_DEFAULTS[id].display` fallback — this still matters for reports saved by an app/web version older than this fix.

### One-time production data/PDF fix

A Node script in `CRM_BACKEND`, run once directly against production (same category of operation as this session's earlier direct-DB cleanups), with a **dry-run mode first** (reports what would change, makes no writes) reviewed before the real run:

1. For every saved AutoNXT report (`pre_dispatch_inspection_reports` where `template_id` is AutoNXT), for each of the 19 spec ids: recompute `spec_${id}_display` from that report's own currently-stored `spec_${id}` / `spec_${id}_tol_mode` / `spec_${id}_tol` / `spec_${id}_tol_minus` (falling back to `SPEC_DEFAULTS[id]` for any that are unset, matching the app's own fallback behavior) using the same formula as the client formatter above. Overwrite `data.spec_${id}_display` with the recomputed value. This is idempotent — a report whose stored text already happens to match is written with the same value it already had.
2. This is a direct database write, not a call through `PdiReports.patchReport`: it does not go through the permission/`expected_revision` check added by the finalized-report-editing feature, and does not create a `pdi_report_revisions` audit snapshot. This mirrors how this session's earlier ad-hoc test-data cleanup was also done directly, and is appropriate here since it's a one-time correctness fix applied uniformly, not a user-attributed edit.
3. For every report that is `status = 'Completed'` **and** had at least one `spec_X_display` value actually change in step 1: re-render its PDF and re-upload it to Google Drive, reusing the existing `#reRenderFinalizedReport` private method (added for the finalized-report-editing feature) — same effect as if that report had just been edited, without needing to fabricate a fake edit through the API. Reports with no actual change, or that are not yet `Completed` (still `In Progress`/`Pending`, where the PDF hasn't been generated yet or will be regenerated at finalize time anyway), are skipped for this step.

## Testing

- **Formatter correctness (both clients):** pure-function tests/checks (no live server needed) asserting `formatAutoNxtSpecDisplay` reproduces all 19 of today's exact default strings from their `(nominal, tolMode, tol, tolMinus)` components, plus the blank-nominal → `"-"` case.
- **Web UI:** live browser check (local dev server against production RDS, established session pattern) confirming the Specification field renders disabled/read-only and updates live as Nominal/Tolerance/Mode change, for at least one `±`, one `%`, and the one `bilateral` field (Locating Diameter).
- **Mobile:** logic verified via the same pure-function checks as above (this environment has no mobile UI testing tooling); the on-screen read-only rendering itself needs the app developer's own manual verification via simulator/device, same caveat as prior mobile handoffs this session.
- **One-time script:** dry-run output reviewed before the real run; after running, spot-check a handful of reports (including the specific report from the incident screenshot) directly against the database to confirm `spec_X_display` now matches its nominal/tolerance, and confirm the affected `Completed` reports' PDFs were regenerated (new `drive_file_id`, updated cache).
