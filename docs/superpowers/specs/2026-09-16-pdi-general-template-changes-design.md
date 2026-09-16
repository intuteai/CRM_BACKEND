# PDI General Template — Photo Limit, Shaft Diameter, Bilateral Tolerance

## Context

Three requests came in against the PDI General template. Two are scoped here; the third is still TBD and out of scope for this spec.

This work spans **three separate codebases**, all serving the same production backend (`https://api.intute.biz`):
- `CRM_BACKEND` — PDF generation (`models/operations/pdi/templates/general.js`) and the shared tolerance-check logic (`models/operations/pdi/tolerance.js`).
- `CRM` — the admin web form (`src/components/admin/PDIGeneratorForm.jsx`), which has its own duplicate of the tolerance-check logic (documented in that file as intentionally mirrored, not shared, since frontend and backend don't share a build pipeline).
- `pdi-erp-app` (github.com/intute-ai-811/pdi-erp-app) — a React Native mobile app, discovered during this session to be a full third peer client of the same `/api/pdi/reports` endpoints, using the same snake_case `data` field convention as the other two. It has its own independent tolerance implementation (`src/services/tolerance.ts`) and its own Mechanical Check form (`src/components/pdi/MechanicalCheckForm.tsx`). Unlike the web app, a code change here requires a rebuild and app release before it reaches any device — it doesn't go live the moment it's merged.

## Change 1: Pg 3 photo slot limit — 10 → 25

Each labeled photo slot on the General template's Photos tab (Pg 3 of the generated PDF) currently caps at 10 images via `ImageUploadCard`'s `maxImages` default in `CRM/src/components/admin/PDIGeneratorForm.jsx`. Raise this to 25.

This is distinct from — and does not change — the separate `MAX_PHOTOS = 12` constant in the same file, which caps the number of labeled *slots* a report can have (not images within a slot).

**Scope:** `CRM` only. No backend or mobile-app change — the image count itself isn't validated server-side beyond storage.

## Change 2: Shaft Diameter, combined with Shaft Length in one field

Today, the Mechanical Check table's "Shaft O/P Dia./Length" column captures only a single length measurement (`shaft_length`) — no diameter value has ever existed anywhere in any of the three apps, despite the column header implying it covers both. Confirmed by code inspection: no delimiter-parsing exists for this field (unlike Current/RPM, which do combine two values via a `/`-separated string), and the mobile app's equivalent field is plainly labeled "Shaft length" with no diameter concept at all.

**Design:** make the header finally true. One measured-value field, format `diameter/length` (e.g. "12/45"), reusing the exact `/`-separated convention already used for `current_measured`/`rpm_measured` (forward/reverse). Diameter and Length are validated as two fully independent specs — each with its own nominal value and its own tolerance mode/amount (they may even use different tolerance modes from each other) — the shared field is only the measured-value entry, not the spec.

**Data model (new fields, additive):**
- `spec_shaft_diameter`, `spec_shaft_diameter_tol_mode`, `spec_shaft_diameter_tol` (and `_tol_plus`/`_tol_minus` per Change 2.5 below) — mirrors the existing `spec_shaft_length*` fields exactly.
- Existing `spec_shaft_length*` fields are unchanged.
- `row.shaft_length` (the measured-value field) keeps its existing key name for backward compatibility with already-saved reports, but its *meaning* changes from "length only" to "diameter/length combined" going forward. A new `parseDiaLength()` helper (mirrors `parseForwardReverse`'s split-on-`/` mechanics, distinctly named since "forward/reverse" semantics don't apply here) splits it for validation.

**Touch points (same shape in all three):**
1. `CRM_BACKEND/models/operations/pdi/templates/general.js` — new spec fields in `buildSpecVals`, `parseDiaLength()` helper, `MCOLS`' `shaft_length` column's `isOutOfTolerance` updated to check both halves against their respective specs.
2. `CRM/src/components/admin/PDIGeneratorForm.jsx` — new spec-row input group for Diameter (mirroring Length's), placeholder updated to "e.g. 12/45", dual-half tolerance-check/red-highlight logic mirroring the existing Current/RPM cells.
3. `pdi-erp-app` — `MechanicalCheckForm.tsx`'s "Shaft length" field becomes the combined field; `ToleranceSpecification` gains a Diameter counterpart alongside the existing Length one; `types/pdi.ts` and `api/reports.ts` gain the new `spec_shaft_diameter*` keys (same snake_case names as the backend, since this app talks that wire format directly).

No column header rename needed — "Shaft O/P Dia./Length" already says this; it becomes accurate rather than aspirational.

## Change 2.5: Tolerance system — add a "Bilateral" mode

Discovered while scoping Change 2: the user's engineering team needs a third tolerance mode beyond the existing `±` (Symmetric) and `%`. Reference confirmed directly against SolidWorks' own Dimension/Tolerance panel (screenshots provided): SolidWorks doesn't have separate modes for "straddles nominal" vs. "both above nominal" vs. "both below nominal" — it has one **Bilateral** type with two independently-signed fields, "+" (upper number, displayed on top) and "-" (lower number, displayed on bottom), where each field's stored value can be any sign regardless of its label. Four confirmed reference cases:

| + field | - field | Displayed | Range (nominal=850) |
|---|---|---|---|
| 0.2 | +0.1 | +0.2 / +0.1 | 850.1–850.2 (both above nominal) |
| -0.2 | -0.1 | -0.2 / -0.1 | 849.8–849.9 (both below nominal) |
| 0.2 | -0.1 | +0.2 / -0.1 | 849.9–850.2 (straddles nominal) |
| *(Symmetric, unrelated mode)* 0.2 | *(n/a)* | ±0.2 | 849.8–850.2 |

**This applies to every tolerance-checked field in the General template**, not just Shaft Diameter/Length (per explicit confirmation) — Motor Length, Shaft Diameter, Shaft Length, Mounting PCD, Locating Dia., Current, RPM.

**Data model (new fields, additive, per tolerance-checked field X):**
- `spec_X_tol` (existing) stays as the single Symmetric-mode value, unchanged — old saved reports with only this field populated keep working.
- `spec_X_tol_mode` (existing) gains a third accepted value for Bilateral: the literal string `'bilateral'` — must match exactly across all three codebases (the existing two values are `'±'` and `'%'`; this follows the same short-code convention).
- `spec_X_tol_plus`, `spec_X_tol_minus` (new) — only read/written when mode is Bilateral.

**Unified range formula**, replacing each codebase's `checkTolerance`/`evaluateTolerance`/`getToleranceRange`:
```
Symmetric (±):  range = [nominal - tol,  nominal + tol]
Percentage (%): range = [nominal - nominal*tol/100, nominal + nominal*tol/100]
Bilateral:      range = [nominal + min(tol_plus, tol_minus), nominal + max(tol_plus, tol_minus)]
```
The `min`/`max` wrapping on Bilateral is deliberate defensive coding, matching this codebase's existing convention of guarding against a mistyped sign inverting the range (see the existing `Math.abs` comment in `CRM_BACKEND/models/operations/pdi/tolerance.js`). Same existing convention also applies to missing/non-numeric input: today, if the nominal or tolerance amount isn't a finite number, no out-of-range flag is raised at all (an incomplete spec silently skips validation rather than erroring) — Bilateral mode keeps this behavior, requiring both `tol_plus` and `tol_minus` to be finite numbers before evaluating, same as the existing single-value modes require their one amount to be finite.

**Implementation order:** Change 2.5 (the tolerance system itself) should land before Change 2 (Shaft Diameter), since Shaft Diameter's new spec fields are meant to support Bilateral mode from the start rather than being added twice.

**Touch points — the largest of the three changes, three independent implementations to update in parallel:**
1. `CRM_BACKEND/models/operations/pdi/tolerance.js` — `checkTolerance()` rewritten to accept `tol_plus`/`tol_minus` and dispatch on mode.
2. `CRM/src/components/admin/PDIGeneratorForm.jsx` — its duplicate `checkTolerance()`, same rewrite; every tolerance-mode `<select>` (6 fields) gains the Bilateral option; each spec-row input group conditionally renders a second amount input when Bilateral is selected.
3. `pdi-erp-app/src/services/tolerance.ts` — `getToleranceRange()`/`evaluateTolerance()` rewritten equivalently (TypeScript, typed `ToleranceRange`); `ToleranceMode` type gains the new value; `ToleranceSpecification` component (used by both `MechanicalCheckForm.tsx` and `ElectricalCheckForm.tsx`) gains the conditional second field.

Dropdown label: "Bilateral" (matches the engineer's own terminology exactly, per confirmation).

## Change 3

Not yet discussed — out of scope for this spec and the plan that follows it.

## Explicitly out of scope

- No changes to the AutoNXT template or any admin-authored custom template — General only.
- No retroactive migration of existing saved reports' data — all new fields are additive and optional; old reports render exactly as they do today (Symmetric/% modes, single shaft-length-only value) unless and until someone edits them going forward.
- No change to `MAX_PHOTOS` (the 12-slot cap) — only the per-slot 10-image cap changes, per explicit confirmation.
- No mobile app release/deployment process is part of this scope — this spec covers the code change only; shipping it to devices is a separate, later step the user owns.

## Testing

No test framework exists in any of the three repos. Verification is manual: live checks against the existing three tolerance modes' known-good cases plus the four SolidWorks-confirmed Bilateral cases from the table above (all four combinations of +/- field signs), across both web form and mobile app, confirming identical pass/fail results for the same inputs in all three codebases (since the three `checkTolerance`-equivalents must never disagree on what counts as out-of-range for the same report).
