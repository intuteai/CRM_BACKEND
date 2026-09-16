# PDI General Template Changes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise the PDI General template's Pg 3 per-slot photo cap from 10 to 25, add a Shaft Diameter measurement combined with the existing Shaft Length in one field, and add a "Bilateral" tolerance mode (two independently-signed offsets) alongside the existing Symmetric/Percentage modes — in `CRM_BACKEND` (PDF generation) and `CRM` (admin web form).

**Scope note:** A third codebase, `pdi-erp-app` (React Native mobile app, a full third peer client of the same `https://api.intute.biz/api/pdi/reports` backend, discovered mid-scoping), also needs the identical Bilateral formula and Shaft Diameter field for the same reports to validate consistently across clients. Since that app will be implemented by the app developer rather than as part of this plan, its changes are written up as a standalone handoff document instead: `pdi-erp-app/docs/pdi-general-template-changes.md` (committed to that repo already). This plan covers CRM_BACKEND + CRM only.

**Architecture:** `CRM_BACKEND` and `CRM` each have their own tolerance-check implementation (`CRM_BACKEND/models/operations/pdi/tolerance.js` and a documented-as-intentional duplicate inside `CRM/PDIGeneratorForm.jsx`) and must compute identical pass/fail results for the same input — the Bilateral formula and the `'bilateral'` mode string are implemented identically in both, and must also match the mobile app's separate implementation per the handoff document above. Shaft Diameter reuses the existing `shaft_length` field's wire key (backward-compatible with saved reports) but changes its meaning to a `/`-separated `"diameter/length"` combined value, mirroring the existing Current/RPM forward/reverse convention already used in this same template.

**Tech Stack:** CRM_BACKEND (Node.js, PDFKit), CRM (React web). Neither repo has a test framework — verification is manual/script-based, same pattern as this session's earlier plans.

**Spec:** `docs/superpowers/specs/2026-09-16-pdi-general-template-changes-design.md`

---

### Task 1: CRM — Pg 3 photo slot limit, 10 → 25

**Files:**
- Modify: `CRM/src/components/admin/PDIGeneratorForm.jsx`

Independent of everything else in this plan — do this first as a quick win.

- [ ] **Step 1: Pass `maxImages={25}` explicitly at the Pg 3 photo-slot call site**

Change:
```jsx
                        <ImageUploadCard
                          images={photo.images || []}
                          onFilesSelected={(fileList) => handleFilesChosen({ type: 'photo', id: photo.id }, fileList)}
                          onRemove={(imgIdx) => removePhotoImage(photo.id, imgIdx)}
                          heightCls="h-32"
                        />
```
to:
```jsx
                        <ImageUploadCard
                          images={photo.images || []}
                          onFilesSelected={(fileList) => handleFilesChosen({ type: 'photo', id: photo.id }, fileList)}
                          onRemove={(imgIdx) => removePhotoImage(photo.id, imgIdx)}
                          heightCls="h-32"
                          maxImages={25}
                        />
```
Do NOT touch `MAX_PHOTOS = 12` (a separate constant capping the number of slots, not images per slot — out of scope).

- [ ] **Step 2: Lint**

Run: `cd CRM && npx eslint src/components/admin/PDIGeneratorForm.jsx`
Expected: no output (clean).

- [ ] **Step 3: Commit**
```bash
cd CRM
git add src/components/admin/PDIGeneratorForm.jsx
git commit -m "$(cat <<'EOF'
feat: raise PDI General Pg 3 photo slot limit from 10 to 25

Each labeled photo slot on the Photos tab can now hold up to 25 images
instead of 10, matching the existing explicit-prop pattern already used
for the single-image Technical Drawing slot (maxImages={1}). The separate
MAX_PHOTOS=12 slot-count cap is unrelated and unchanged.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: CRM_BACKEND — Bilateral tolerance mode + diameter/length parsing

**Files:**
- Modify: `CRM_BACKEND/models/operations/pdi/tolerance.js`

Current file:
```js
'use strict';

// Mirrors CRM/src/components/admin/PDIGeneratorForm.jsx's checkTolerance —
// kept as a tiny duplicate rather than a shared package since the frontend
// and backend don't share a build pipeline. Any change here must be mirrored
// there, and vice versa.
function checkTolerance(measuredStr, nominalStr, toleranceMode, toleranceAmountStr) {
  const measured = parseFloat(measuredStr);
  const nominal = parseFloat(nominalStr);
  const toleranceAmount = parseFloat(toleranceAmountStr);
  if (!Number.isFinite(measured) || !Number.isFinite(nominal) || !Number.isFinite(toleranceAmount)) {
    return { outOfRange: false };
  }
  // Math.abs on the tolerance amount itself — a negative value typed by
  // mistake would otherwise invert the range and flag nearly every row.
  const amount = Math.abs(toleranceAmount);
  const delta = toleranceMode === '%' ? Math.abs(nominal) * (amount / 100) : amount;
  const outOfRange = measured < nominal - delta || measured > nominal + delta;
  return { outOfRange };
}

function parseForwardReverse(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return { forward: '', reverse: '' };
  if (trimmed.includes('/')) {
    const [f, r] = trimmed.split('/');
    return { forward: (f || '').trim(), reverse: (r || '').trim() };
  }
  return { forward: trimmed, reverse: '' };
}

module.exports = { checkTolerance, parseForwardReverse };
```

- [ ] **Step 1: Replace the whole file**

```js
'use strict';

// Mirrors CRM/src/components/admin/PDIGeneratorForm.jsx's checkTolerance —
// kept as a tiny duplicate rather than a shared package since the frontend
// and backend don't share a build pipeline. Any change here must be mirrored
// there, and vice versa. A third, independent implementation also lives in
// pdi-erp-app/src/services/tolerance.ts (TypeScript, different shape) — the
// FORMULA below must stay identical across all three, since the same report
// can be edited from any of the three apps and must get the same pass/fail
// result everywhere.
//
// Three modes:
//   '±'  (Symmetric):  range = [nominal - tol,  nominal + tol]
//   '%'  (Percentage): range = [nominal - nominal*tol/100, nominal + nominal*tol/100]
//   'bilateral':        range = [nominal + min(tol, tol2), nominal + max(tol, tol2)]
// Bilateral's min/max wrapping is deliberate — same defensive reasoning as
// the existing Math.abs guard below, so a mistyped sign on either field
// can't silently invert the range.
function checkTolerance(measuredStr, nominalStr, toleranceMode, toleranceAmountStr, toleranceAmount2Str) {
  const measured = parseFloat(measuredStr);
  const nominal = parseFloat(nominalStr);
  if (!Number.isFinite(measured) || !Number.isFinite(nominal)) {
    return { outOfRange: false };
  }

  if (toleranceMode === 'bilateral') {
    const plus = parseFloat(toleranceAmountStr);
    const minus = parseFloat(toleranceAmount2Str);
    if (!Number.isFinite(plus) || !Number.isFinite(minus)) {
      return { outOfRange: false };
    }
    const low = nominal + Math.min(plus, minus);
    const high = nominal + Math.max(plus, minus);
    return { outOfRange: measured < low || measured > high };
  }

  const toleranceAmount = parseFloat(toleranceAmountStr);
  if (!Number.isFinite(toleranceAmount)) {
    return { outOfRange: false };
  }
  // Math.abs on the tolerance amount itself — a negative value typed by
  // mistake would otherwise invert the range and flag nearly every row.
  const amount = Math.abs(toleranceAmount);
  const delta = toleranceMode === '%' ? Math.abs(nominal) * (amount / 100) : amount;
  const outOfRange = measured < nominal - delta || measured > nominal + delta;
  return { outOfRange };
}

function parseForwardReverse(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return { forward: '', reverse: '' };
  if (trimmed.includes('/')) {
    const [f, r] = trimmed.split('/');
    return { forward: (f || '').trim(), reverse: (r || '').trim() };
  }
  return { forward: trimmed, reverse: '' };
}

// Parses a Shaft Diameter/Length cell's raw text into { diameter, length }.
// "12/45" -> diameter=12, length=45. Same split-on-"/" mechanics as
// parseForwardReverse above, distinctly named since "forward/reverse"
// semantics don't apply here — diameter and length are validated against
// two entirely independent specs, not a shared one.
function parseDiaLength(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return { diameter: '', length: '' };
  if (trimmed.includes('/')) {
    const [d, l] = trimmed.split('/');
    return { diameter: (d || '').trim(), length: (l || '').trim() };
  }
  return { diameter: trimmed, length: '' };
}

module.exports = { checkTolerance, parseForwardReverse, parseDiaLength };
```

- [ ] **Step 2: Verify — regression check on existing modes**

```bash
cd CRM_BACKEND
node -e "
const { checkTolerance } = require('./models/operations/pdi/tolerance');
console.log('symmetric in-range:', checkTolerance('50', '50', '±', '0.5').outOfRange === false);
console.log('symmetric out-of-range:', checkTolerance('51', '50', '±', '0.5').outOfRange === true);
console.log('percent in-range:', checkTolerance('3050', '3000', '%', '2').outOfRange === false);
console.log('percent out-of-range:', checkTolerance('3061', '3000', '%', '2').outOfRange === true);
"
```
Expected: all four lines print `true`.

- [ ] **Step 3: Verify — Bilateral mode against the four SolidWorks reference cases from the spec**

```bash
cd CRM_BACKEND
node -e "
const { checkTolerance } = require('./models/operations/pdi/tolerance');
// nominal=850, + field=0.2, - field=+0.1 -> range [850.1, 850.2]
console.log('case1 850.15 in-range:', checkTolerance('850.15', '850', 'bilateral', '0.2', '0.1').outOfRange === false);
console.log('case1 850.05 out-of-range:', checkTolerance('850.05', '850', 'bilateral', '0.2', '0.1').outOfRange === true);
// nominal=850, + field=-0.2, - field=-0.1 -> range [849.8, 849.9]
console.log('case2 849.85 in-range:', checkTolerance('849.85', '850', 'bilateral', '-0.2', '-0.1').outOfRange === false);
console.log('case2 850 out-of-range:', checkTolerance('850', '850', 'bilateral', '-0.2', '-0.1').outOfRange === true);
// nominal=850, + field=0.2, - field=-0.1 -> range [849.9, 850.2]
console.log('case4 850 in-range:', checkTolerance('850', '850', 'bilateral', '0.2', '-0.1').outOfRange === false);
console.log('case4 850.3 out-of-range:', checkTolerance('850.3', '850', 'bilateral', '0.2', '-0.1').outOfRange === true);
"
```
Expected: all six lines print `true`.

- [ ] **Step 4: Verify `parseDiaLength`**

```bash
cd CRM_BACKEND
node -e "
const { parseDiaLength } = require('./models/operations/pdi/tolerance');
console.log(JSON.stringify(parseDiaLength('12/45')));
console.log(JSON.stringify(parseDiaLength('12')));
console.log(JSON.stringify(parseDiaLength('')));
"
```
Expected:
```
{"diameter":"12","length":"45"}
{"diameter":"12","length":""}
{"diameter":"","length":""}
```

- [ ] **Step 5: Commit**
```bash
cd CRM_BACKEND
git add models/operations/pdi/tolerance.js
git commit -m "$(cat <<'EOF'
feat: add Bilateral tolerance mode and diameter/length parsing

checkTolerance() gains a 'bilateral' mode (two independently-signed
offsets, range = [nominal+min(plus,minus), nominal+max(plus,minus)]) via
a new optional 5th parameter, alongside the existing Symmetric/Percentage
modes -- formula confirmed against the user's engineering team's SolidWorks
Dimension/Tolerance panel reference. New parseDiaLength() mirrors the
existing parseForwardReverse()'s split-on-"/" mechanics, distinctly named
for the upcoming Shaft Diameter/Length combined field (next commit), since
diameter and length validate against two independent specs rather than one
shared spec like Current/RPM's forward/reverse.

This same formula and mode string ('bilateral', lowercase) must land
identically in CRM/PDIGeneratorForm.jsx's duplicate and pdi-erp-app's
tolerance.ts -- both come in later tasks of this plan.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: CRM_BACKEND — Shaft Diameter in the PDF template

**Files:**
- Modify: `CRM_BACKEND/models/operations/pdi/templates/general.js`

Depends on Task 2 (`parseDiaLength` must exist).

- [ ] **Step 1: Import `parseDiaLength`**

Change:
```js
const { checkTolerance, parseForwardReverse } = require('../tolerance');
```
to:
```js
const { checkTolerance, parseForwardReverse, parseDiaLength } = require('../tolerance');
```

- [ ] **Step 2: Update the `shaft_length` column's `isOutOfTolerance` to check both halves**

Change:
```js
  { key: 'shaft_length',        label: 'Shaft O/P\nD/Length', w: 50, align: 'center',
    isOutOfTolerance: (row, data) => checkTolerance(row.shaft_length, data.spec_shaft_length, data.spec_shaft_length_tol_mode, data.spec_shaft_length_tol).outOfRange },
```
to:
```js
  { key: 'shaft_length',        label: 'Shaft O/P\nD/Length', w: 50, align: 'center',
    // Combined "diameter/length" cell (e.g. "12/45") -- same convention as
    // ECOLS' current_measured/rpm_measured forward/reverse split below, but
    // diameter and length each validate against their OWN spec (unlike
    // forward/reverse, which share one spec) since they're different
    // physical measurements.
    isOutOfTolerance: (row, data) => {
      const { diameter, length } = parseDiaLength(row.shaft_length);
      return checkTolerance(diameter, data.spec_shaft_diameter, data.spec_shaft_diameter_tol_mode, data.spec_shaft_diameter_tol, data.spec_shaft_diameter_tol_minus).outOfRange
          || checkTolerance(length, data.spec_shaft_length, data.spec_shaft_length_tol_mode, data.spec_shaft_length_tol, data.spec_shaft_length_tol_minus).outOfRange;
    } },
```

- [ ] **Step 3: Add `shaft_diameter` to `buildSpecVals`**

Change:
```js
function buildSpecVals(data) {
  return {
    motor_length:        data.spec_motor_length || '',
    shaft_length:        data.spec_shaft_length || '',
    mounting_pcd:        data.spec_mounting_pcd || '',
    mtg:                 data.spec_mtg          || '1.M6 / 2.Ø8.0',
    key_dim_result:      data.spec_key_dim      || 'Go/NG',
    locating_dia_result: data.spec_locating_dia || '',
  };
}
```
to:
```js
function buildSpecVals(data) {
  return {
    motor_length:        data.spec_motor_length || '',
    shaft_length:        data.spec_shaft_length || '',
    shaft_diameter:      data.spec_shaft_diameter || '',
    mounting_pcd:        data.spec_mounting_pcd || '',
    mtg:                 data.spec_mtg          || '1.M6 / 2.Ø8.0',
    key_dim_result:      data.spec_key_dim      || 'Go/NG',
    locating_dia_result: data.spec_locating_dia || '',
  };
}
```

- [ ] **Step 4: Verify — regression check that existing single-value shaft length reports still validate correctly**

```bash
cd CRM_BACKEND
node -e "
const templates = require('./models/operations/pdi/templates');
const general = templates.general;
const col = general; // placeholder, replaced below
"
node -e "
require('dotenv').config();
const { checkTolerance, parseDiaLength } = require('./models/operations/pdi/tolerance');
// Old-shape report: shaft_length holds just a length value, no '/'
const parsed = parseDiaLength('45');
console.log('diameter half (should be empty):', JSON.stringify(parsed.diameter) === '\"\"' ? 'FAIL - check manually' : parsed.diameter);
console.log('length half:', parsed.length);
console.log('length in range:', checkTolerance(parsed.length, '45', '±', '1').outOfRange === false);
"
```
Expected: `length half: 45` and `length in range: true`. (A pre-existing report with no `/` in its shaft_length value parses as `{ diameter: '45', length: '' }` per `parseDiaLength`'s single-value fallback — this means an OLD report's stored value is treated as the diameter, not the length, once re-rendered. This is expected and acceptable per the spec's "no retroactive migration" decision: old reports keep whatever they had, and a human re-reviewing an old PDF would see it show up as an (uncalibrated, since `spec_shaft_diameter` would be empty on an old report) diameter reading rather than a length reading. This doesn't cause a validation error — `spec_shaft_diameter` being empty on old reports means `checkTolerance` returns `outOfRange: false` for that half via the existing non-finite-input guard.)

- [ ] **Step 5: Commit**
```bash
cd CRM_BACKEND
git add models/operations/pdi/templates/general.js
git commit -m "$(cat <<'EOF'
feat: validate Shaft Diameter alongside Shaft Length in the PDF

The Mechanical Check table's shaft_length column now parses its cell as a
"diameter/length" combined value (parseDiaLength, added last commit) and
flags out-of-tolerance if EITHER half is outside ITS OWN spec -- same
pattern as the existing current_measured/rpm_measured forward/reverse
columns, except diameter and length each have independent specs rather
than sharing one. buildSpecVals gains spec_shaft_diameter alongside the
existing spec_shaft_length.

No column header change -- "Shaft O/P Dia./Length" already implied this;
it was just never backed by an actual diameter value until now.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: CRM — PDIGeneratorForm.jsx data layer (Bilateral + Shaft Diameter state)

**Files:**
- Modify: `CRM/src/components/admin/PDIGeneratorForm.jsx`

Depends on Task 1 (independent, but same file — do this after Task 1 to avoid merge overlap in the same session).

- [ ] **Step 1: Update the duplicate `checkTolerance`, matching Task 2's backend version exactly**

Change:
```js
function checkTolerance(measuredStr, nominalStr, toleranceMode, toleranceAmountStr) {
  const measured = parseFloat(measuredStr);
  const nominal = parseFloat(nominalStr);
  const toleranceAmount = parseFloat(toleranceAmountStr);
  if (!Number.isFinite(measured) || !Number.isFinite(nominal) || !Number.isFinite(toleranceAmount)) {
    return { outOfRange: false };
  }
  // Math.abs on the tolerance amount itself — a negative value typed by
  // mistake would otherwise invert the range (nominal - delta > nominal +
  // delta) and flag nearly every row at once.
  const amount = Math.abs(toleranceAmount);
  const delta = toleranceMode === '%' ? Math.abs(nominal) * (amount / 100) : amount;
  const outOfRange = measured < nominal - delta || measured > nominal + delta;
  return { outOfRange };
}
```
to:
```js
// Mirrors CRM_BACKEND/models/operations/pdi/tolerance.js's checkTolerance --
// kept as a duplicate since frontend and backend don't share a build
// pipeline. Any change here must be mirrored there, and vice versa.
//
// Three modes:
//   '±'  (Symmetric):  range = [nominal - tol,  nominal + tol]
//   '%'  (Percentage): range = [nominal - nominal*tol/100, nominal + nominal*tol/100]
//   'bilateral':        range = [nominal + min(tol, tol2), nominal + max(tol, tol2)]
function checkTolerance(measuredStr, nominalStr, toleranceMode, toleranceAmountStr, toleranceAmount2Str) {
  const measured = parseFloat(measuredStr);
  const nominal = parseFloat(nominalStr);
  if (!Number.isFinite(measured) || !Number.isFinite(nominal)) {
    return { outOfRange: false };
  }

  if (toleranceMode === 'bilateral') {
    const plus = parseFloat(toleranceAmountStr);
    const minus = parseFloat(toleranceAmount2Str);
    if (!Number.isFinite(plus) || !Number.isFinite(minus)) {
      return { outOfRange: false };
    }
    const low = nominal + Math.min(plus, minus);
    const high = nominal + Math.max(plus, minus);
    return { outOfRange: measured < low || measured > high };
  }

  const toleranceAmount = parseFloat(toleranceAmountStr);
  if (!Number.isFinite(toleranceAmount)) {
    return { outOfRange: false };
  }
  // Math.abs on the tolerance amount itself — a negative value typed by
  // mistake would otherwise invert the range (nominal - delta > nominal +
  // delta) and flag nearly every row at once.
  const amount = Math.abs(toleranceAmount);
  const delta = toleranceMode === '%' ? Math.abs(nominal) * (amount / 100) : amount;
  const outOfRange = measured < nominal - delta || measured > nominal + delta;
  return { outOfRange };
}
```

- [ ] **Step 2: Add `parseDiaLength`, directly below `parseForwardReverse`**

Add after the existing `parseForwardReverse` function (ends at line 159 currently):
```js

// Parses a Shaft Diameter/Length cell's raw text into { diameter, length }.
// "12/45" -> diameter=12, length=45. Same split-on-"/" mechanics as
// parseForwardReverse above, distinctly named since diameter and length
// validate against two independent specs, not one shared spec.
function parseDiaLength(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return { diameter: '', length: '' };
  if (trimmed.includes('/')) {
    const [d, l] = trimmed.split('/');
    return { diameter: (d || '').trim(), length: (l || '').trim() };
  }
  return { diameter: trimmed, length: '' };
}
```

- [ ] **Step 3: Add `_tol_minus` fields to `defaultForm`, and new `spec_shaft_diameter*` fields**

The existing `spec_X_tol` field is REUSED as the "+" value for Bilateral mode (matching the spec's data model exactly: "Keep the existing single tolerance field per spec... and add ONE new field"). Only `_tol_minus` is new — do NOT add a `_tol_plus` field, there isn't one.

Change:
```js
  spec_current_standard: '',
  spec_current_tol_mode: '±',
  spec_current_tol: '',
  spec_rpm_specified: '',
  spec_rpm_tol_mode: '±',
  spec_rpm_tol: '',
```
to:
```js
  spec_current_standard: '',
  spec_current_tol_mode: '±',
  spec_current_tol: '',
  spec_current_tol_minus: '',
  spec_rpm_specified: '',
  spec_rpm_tol_mode: '±',
  spec_rpm_tol: '',
  spec_rpm_tol_minus: '',
```

Change:
```js
  spec_motor_length: '',
  spec_motor_length_tol_mode: '±',
  spec_motor_length_tol: '',
  spec_shaft_length: '',
  spec_shaft_length_tol_mode: '±',
  spec_shaft_length_tol: '',
  spec_mounting_pcd: '',
  spec_mounting_pcd_tol_mode: '±',
  spec_mounting_pcd_tol: '',
```
to:
```js
  spec_motor_length: '',
  spec_motor_length_tol_mode: '±',
  spec_motor_length_tol: '',
  spec_motor_length_tol_minus: '',
  spec_shaft_length: '',
  spec_shaft_length_tol_mode: '±',
  spec_shaft_length_tol: '',
  spec_shaft_length_tol_minus: '',
  spec_shaft_diameter: '',
  spec_shaft_diameter_tol_mode: '±',
  spec_shaft_diameter_tol: '',
  spec_shaft_diameter_tol_minus: '',
  spec_mounting_pcd: '',
  spec_mounting_pcd_tol_mode: '±',
  spec_mounting_pcd_tol: '',
  spec_mounting_pcd_tol_minus: '',
```

Change:
```js
  spec_locating_dia: '',
  spec_locating_dia_tol_mode: '±',
  spec_locating_dia_tol: '',
```
to:
```js
  spec_locating_dia: '',
  spec_locating_dia_tol_mode: '±',
  spec_locating_dia_tol: '',
  spec_locating_dia_tol_minus: '',
```

- [ ] **Step 4: Lint**

Run: `cd CRM && npx eslint src/components/admin/PDIGeneratorForm.jsx`
Expected: no output (clean) — these are plain state fields and a pure function, nothing yet references them from JSX (that's Task 5).

- [ ] **Step 5: Commit**
```bash
cd CRM
git add src/components/admin/PDIGeneratorForm.jsx
git commit -m "$(cat <<'EOF'
feat: PDI General form data layer for Bilateral tolerance + Shaft Diameter

Mirrors CRM_BACKEND's tolerance.js changes: checkTolerance() gains the
'bilateral' mode, parseDiaLength() added for the upcoming combined
Shaft Diameter/Length field. defaultForm gains spec_X_tol_minus for all 6
existing tolerance-checked fields (Motor Length, Shaft Length, Mounting
PCD, Locating Dia., Current, RPM) plus new spec_shaft_diameter* fields --
the existing spec_X_tol field is reused as the "+" value, no separate
_tol_plus field.

This is the data layer only -- no UI yet references these new fields
(next commit).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: CRM — PDIGeneratorForm.jsx UI layer (Bilateral inputs + Shaft Diameter row)

**Files:**
- Modify: `CRM/src/components/admin/PDIGeneratorForm.jsx`

Depends on Task 4.

- [ ] **Step 1: Add a shared `ToleranceSpecInput` component**

Add directly above the `ImageUploadCard` function definition (or any other top-level function in this file — place it near the other small shared sub-components, e.g. directly below the `makeRow` function):

```jsx
// Shared by every spec-row tolerance group in this form (6 total: Motor
// Length, Shaft Length, Shaft Diameter, Mounting PCD, Locating Dia.,
// Current, RPM) -- renders the nominal value, the tolerance-mode select,
// and either one tolerance-amount input (Symmetric/Percentage) or two
// signed "+"/"-" inputs (Bilateral), matching the SolidWorks Dimension/
// Tolerance panel convention this mode was modeled on. The existing `tol`
// value doubles as the "+" field in Bilateral mode (matching every other
// codebase's identical reuse of the single existing tolerance field) --
// `tolMinus` is the only genuinely new value.
function ToleranceSpecInput({
  nominalValue, onNominalChange, nominalPlaceholder,
  mode, onModeChange,
  tol, onTolChange,
  tolMinus, onTolMinusChange,
}) {
  return (
    <div className="flex gap-1 flex-wrap">
      <input className={INPUT_CLS} value={nominalValue} onChange={(e) => onNominalChange(e.target.value)} placeholder={nominalPlaceholder} />
      <select className={SELECT_CLS} value={mode} onChange={(e) => onModeChange(e.target.value)}>
        <option value="±">±</option>
        <option value="%">±%</option>
        <option value="bilateral">Bilateral</option>
      </select>
      <input
        className={INPUT_CLS}
        value={tol}
        onChange={(e) => onTolChange(e.target.value)}
        placeholder={mode === 'bilateral' ? '+' : 'tol.'}
        style={{ maxWidth: mode === 'bilateral' ? 50 : 60 }}
      />
      {mode === 'bilateral' && (
        <input className={INPUT_CLS} value={tolMinus} onChange={(e) => onTolMinusChange(e.target.value)} placeholder="-" style={{ maxWidth: 50 }} />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Replace the electrical spec-row's Current and RPM tolerance groups**

Change:
```jsx
                        <td className="py-1 px-1 border border-gray-100">
                          <div className="flex gap-1">
                            <input className={INPUT_CLS} value={form.spec_current_standard} onChange={(e) => setField('spec_current_standard', e.target.value)} placeholder="e.g. 4" />
                            <select className={SELECT_CLS} value={form.spec_current_tol_mode} onChange={(e) => setField('spec_current_tol_mode', e.target.value)}>
                              <option value="±">±</option>
                              <option value="%">±%</option>
                            </select>
                            <input className={INPUT_CLS} value={form.spec_current_tol} onChange={(e) => setField('spec_current_tol', e.target.value)} placeholder="tol." style={{ maxWidth: 60 }} />
                          </div>
                        </td>
                        <td className="py-1 px-1 border border-gray-100">
                          <div className="flex gap-1">
                            <input className={INPUT_CLS} value={form.spec_rpm_specified} onChange={(e) => setField('spec_rpm_specified', e.target.value)} placeholder="e.g. 3000" />
                            <select className={SELECT_CLS} value={form.spec_rpm_tol_mode} onChange={(e) => setField('spec_rpm_tol_mode', e.target.value)}>
                              <option value="±">±</option>
                              <option value="%">±%</option>
                            </select>
                            <input className={INPUT_CLS} value={form.spec_rpm_tol} onChange={(e) => setField('spec_rpm_tol', e.target.value)} placeholder="tol." style={{ maxWidth: 60 }} />
                          </div>
                        </td>
```
to:
```jsx
                        <td className="py-1 px-1 border border-gray-100">
                          <ToleranceSpecInput
                            nominalValue={form.spec_current_standard} onNominalChange={(v) => setField('spec_current_standard', v)} nominalPlaceholder="e.g. 4"
                            mode={form.spec_current_tol_mode} onModeChange={(v) => setField('spec_current_tol_mode', v)}
                            tol={form.spec_current_tol} onTolChange={(v) => setField('spec_current_tol', v)}
                            tolMinus={form.spec_current_tol_minus} onTolMinusChange={(v) => setField('spec_current_tol_minus', v)}
                          />
                        </td>
                        <td className="py-1 px-1 border border-gray-100">
                          <ToleranceSpecInput
                            nominalValue={form.spec_rpm_specified} onNominalChange={(v) => setField('spec_rpm_specified', v)} nominalPlaceholder="e.g. 3000"
                            mode={form.spec_rpm_tol_mode} onModeChange={(v) => setField('spec_rpm_tol_mode', v)}
                            tol={form.spec_rpm_tol} onTolChange={(v) => setField('spec_rpm_tol', v)}
                            tolMinus={form.spec_rpm_tol_minus} onTolMinusChange={(v) => setField('spec_rpm_tol_minus', v)}
                          />
                        </td>
```

- [ ] **Step 3: Replace the mechanical spec-row's Motor Length, Shaft Length groups; add a Shaft Diameter group; update Mounting PCD and Locating Dia. groups**

Change:
```jsx
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Motor Length</label>
                      <div className="flex gap-1">
                        <input className={INPUT_CLS} value={form.spec_motor_length} onChange={(e) => setField('spec_motor_length', e.target.value)} placeholder="e.g. 254.4" />
                        <select className={SELECT_CLS} value={form.spec_motor_length_tol_mode} onChange={(e) => setField('spec_motor_length_tol_mode', e.target.value)}>
                          <option value="±">±</option>
                          <option value="%">±%</option>
                        </select>
                        <input className={INPUT_CLS} value={form.spec_motor_length_tol} onChange={(e) => setField('spec_motor_length_tol', e.target.value)} placeholder="tol." style={{ maxWidth: 60 }} />
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Shaft O/P Dia./Length</label>
                      <div className="flex gap-1">
                        <input className={INPUT_CLS} value={form.spec_shaft_length} onChange={(e) => setField('spec_shaft_length', e.target.value)} placeholder="e.g. 24.0" />
                        <select className={SELECT_CLS} value={form.spec_shaft_length_tol_mode} onChange={(e) => setField('spec_shaft_length_tol_mode', e.target.value)}>
                          <option value="±">±</option>
                          <option value="%">±%</option>
                        </select>
                        <input className={INPUT_CLS} value={form.spec_shaft_length_tol} onChange={(e) => setField('spec_shaft_length_tol', e.target.value)} placeholder="tol." style={{ maxWidth: 60 }} />
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">PCD</label>
                      <div className="flex gap-1">
                        <input className={INPUT_CLS} value={form.spec_mounting_pcd} onChange={(e) => setField('spec_mounting_pcd', e.target.value)} placeholder="e.g. 152.74" />
                        <select className={SELECT_CLS} value={form.spec_mounting_pcd_tol_mode} onChange={(e) => setField('spec_mounting_pcd_tol_mode', e.target.value)}>
                          <option value="±">±</option>
                          <option value="%">±%</option>
                        </select>
                        <input className={INPUT_CLS} value={form.spec_mounting_pcd_tol} onChange={(e) => setField('spec_mounting_pcd_tol', e.target.value)} placeholder="tol." style={{ maxWidth: 60 }} />
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">MTG</label>
                      <input className={INPUT_CLS} value={form.spec_mtg} onChange={(e) => setField('spec_mtg', e.target.value)} placeholder="e.g. 4*M8" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Key Dim.</label>
                      <input className={INPUT_CLS} value={form.spec_key_dim} onChange={(e) => setField('spec_key_dim', e.target.value)} placeholder="e.g. Go/NG" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Locating Dia.</label>
                      <div className="flex gap-1">
                        <input className={INPUT_CLS} value={form.spec_locating_dia} onChange={(e) => setField('spec_locating_dia', e.target.value)} placeholder="e.g. 50.0" />
                        <select className={SELECT_CLS} value={form.spec_locating_dia_tol_mode} onChange={(e) => setField('spec_locating_dia_tol_mode', e.target.value)}>
                          <option value="±">±</option>
                          <option value="%">±%</option>
                        </select>
                        <input className={INPUT_CLS} value={form.spec_locating_dia_tol} onChange={(e) => setField('spec_locating_dia_tol', e.target.value)} placeholder="tol." style={{ maxWidth: 60 }} />
                      </div>
                    </div>
```
to:
```jsx
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Motor Length</label>
                      <ToleranceSpecInput
                        nominalValue={form.spec_motor_length} onNominalChange={(v) => setField('spec_motor_length', v)} nominalPlaceholder="e.g. 254.4"
                        mode={form.spec_motor_length_tol_mode} onModeChange={(v) => setField('spec_motor_length_tol_mode', v)}
                        tol={form.spec_motor_length_tol} onTolChange={(v) => setField('spec_motor_length_tol', v)}
                        tolMinus={form.spec_motor_length_tol_minus} onTolMinusChange={(v) => setField('spec_motor_length_tol_minus', v)}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Shaft O/P Dia./Length</label>
                      <p className="text-[10px] text-gray-400 mb-1">Length spec — measured value below is entered as "diameter/length"</p>
                      <ToleranceSpecInput
                        nominalValue={form.spec_shaft_length} onNominalChange={(v) => setField('spec_shaft_length', v)} nominalPlaceholder="e.g. 24.0"
                        mode={form.spec_shaft_length_tol_mode} onModeChange={(v) => setField('spec_shaft_length_tol_mode', v)}
                        tol={form.spec_shaft_length_tol} onTolChange={(v) => setField('spec_shaft_length_tol', v)}
                        tolMinus={form.spec_shaft_length_tol_minus} onTolMinusChange={(v) => setField('spec_shaft_length_tol_minus', v)}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Shaft Diameter</label>
                      <p className="text-[10px] text-gray-400 mb-1">Diameter spec — same measured field as Length above</p>
                      <ToleranceSpecInput
                        nominalValue={form.spec_shaft_diameter} onNominalChange={(v) => setField('spec_shaft_diameter', v)} nominalPlaceholder="e.g. 12.0"
                        mode={form.spec_shaft_diameter_tol_mode} onModeChange={(v) => setField('spec_shaft_diameter_tol_mode', v)}
                        tol={form.spec_shaft_diameter_tol} onTolChange={(v) => setField('spec_shaft_diameter_tol', v)}
                        tolMinus={form.spec_shaft_diameter_tol_minus} onTolMinusChange={(v) => setField('spec_shaft_diameter_tol_minus', v)}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">PCD</label>
                      <ToleranceSpecInput
                        nominalValue={form.spec_mounting_pcd} onNominalChange={(v) => setField('spec_mounting_pcd', v)} nominalPlaceholder="e.g. 152.74"
                        mode={form.spec_mounting_pcd_tol_mode} onModeChange={(v) => setField('spec_mounting_pcd_tol_mode', v)}
                        tol={form.spec_mounting_pcd_tol} onTolChange={(v) => setField('spec_mounting_pcd_tol', v)}
                        tolMinus={form.spec_mounting_pcd_tol_minus} onTolMinusChange={(v) => setField('spec_mounting_pcd_tol_minus', v)}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">MTG</label>
                      <input className={INPUT_CLS} value={form.spec_mtg} onChange={(e) => setField('spec_mtg', e.target.value)} placeholder="e.g. 4*M8" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Key Dim.</label>
                      <input className={INPUT_CLS} value={form.spec_key_dim} onChange={(e) => setField('spec_key_dim', e.target.value)} placeholder="e.g. Go/NG" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Locating Dia.</label>
                      <ToleranceSpecInput
                        nominalValue={form.spec_locating_dia} onNominalChange={(v) => setField('spec_locating_dia', v)} nominalPlaceholder="e.g. 50.0"
                        mode={form.spec_locating_dia_tol_mode} onModeChange={(v) => setField('spec_locating_dia_tol_mode', v)}
                        tol={form.spec_locating_dia_tol} onTolChange={(v) => setField('spec_locating_dia_tol', v)}
                        tolMinus={form.spec_locating_dia_tol_minus} onTolMinusChange={(v) => setField('spec_locating_dia_tol_minus', v)}
                      />
                    </div>
```

- [ ] **Step 4: Update the table cell for Current/RPM to pass the Bilateral tolerance-plus/minus values**

Change:
```jsx
                              const { forward, reverse } = parseForwardReverse(row.current_measured);
                              const fFlag = checkTolerance(forward, form.spec_current_standard, form.spec_current_tol_mode, form.spec_current_tol).outOfRange;
                              const rFlag = checkTolerance(reverse, form.spec_current_standard, form.spec_current_tol_mode, form.spec_current_tol).outOfRange;
```
to:
```jsx
                              const { forward, reverse } = parseForwardReverse(row.current_measured);
                              const fFlag = checkTolerance(forward, form.spec_current_standard, form.spec_current_tol_mode, form.spec_current_tol, form.spec_current_tol_minus).outOfRange;
                              const rFlag = checkTolerance(reverse, form.spec_current_standard, form.spec_current_tol_mode, form.spec_current_tol, form.spec_current_tol_minus).outOfRange;
```

Change:
```jsx
                              const { forward, reverse } = parseForwardReverse(row.rpm_measured);
                              const fFlag = checkTolerance(forward, form.spec_rpm_specified, form.spec_rpm_tol_mode, form.spec_rpm_tol).outOfRange;
                              const rFlag = checkTolerance(reverse, form.spec_rpm_specified, form.spec_rpm_tol_mode, form.spec_rpm_tol).outOfRange;
```
to:
```jsx
                              const { forward, reverse } = parseForwardReverse(row.rpm_measured);
                              const fFlag = checkTolerance(forward, form.spec_rpm_specified, form.spec_rpm_tol_mode, form.spec_rpm_tol, form.spec_rpm_tol_minus).outOfRange;
                              const rFlag = checkTolerance(reverse, form.spec_rpm_specified, form.spec_rpm_tol_mode, form.spec_rpm_tol, form.spec_rpm_tol_minus).outOfRange;
```

(`checkTolerance`'s 5th param, `toleranceAmount2Str`, is only read when mode is `'bilateral'` — passing `tol_minus` unconditionally here is safe, since it's `''` and ignored for the other two modes.)

- [ ] **Step 5: Update Motor Length, Mounting PCD, Locating Dia. table cells with the Bilateral 5th arg**

Change:
```jsx
                              className={`${INPUT_CLS} ${checkTolerance(row.motor_length, form.spec_motor_length, form.spec_motor_length_tol_mode, form.spec_motor_length_tol).outOfRange ? 'border-red-500 bg-red-50' : ''}`}
                              value={row.motor_length} onChange={(e) => setRowField(idx, 'motor_length', e.target.value)} placeholder="mm"
                              title={checkTolerance(row.motor_length, form.spec_motor_length, form.spec_motor_length_tol_mode, form.spec_motor_length_tol).outOfRange ? 'Outside tolerance' : undefined}
```
to:
```jsx
                              className={`${INPUT_CLS} ${checkTolerance(row.motor_length, form.spec_motor_length, form.spec_motor_length_tol_mode, form.spec_motor_length_tol, form.spec_motor_length_tol_minus).outOfRange ? 'border-red-500 bg-red-50' : ''}`}
                              value={row.motor_length} onChange={(e) => setRowField(idx, 'motor_length', e.target.value)} placeholder="mm"
                              title={checkTolerance(row.motor_length, form.spec_motor_length, form.spec_motor_length_tol_mode, form.spec_motor_length_tol, form.spec_motor_length_tol_minus).outOfRange ? 'Outside tolerance' : undefined}
```

Change:
```jsx
                              className={`${INPUT_CLS} ${checkTolerance(row.mounting_pcd, form.spec_mounting_pcd, form.spec_mounting_pcd_tol_mode, form.spec_mounting_pcd_tol).outOfRange ? 'border-red-500 bg-red-50' : ''}`}
                              value={row.mounting_pcd} onChange={(e) => setRowField(idx, 'mounting_pcd', e.target.value)} placeholder="153"
                              title={checkTolerance(row.mounting_pcd, form.spec_mounting_pcd, form.spec_mounting_pcd_tol_mode, form.spec_mounting_pcd_tol).outOfRange ? 'Outside tolerance' : undefined}
```
to:
```jsx
                              className={`${INPUT_CLS} ${checkTolerance(row.mounting_pcd, form.spec_mounting_pcd, form.spec_mounting_pcd_tol_mode, form.spec_mounting_pcd_tol, form.spec_mounting_pcd_tol_minus).outOfRange ? 'border-red-500 bg-red-50' : ''}`}
                              value={row.mounting_pcd} onChange={(e) => setRowField(idx, 'mounting_pcd', e.target.value)} placeholder="153"
                              title={checkTolerance(row.mounting_pcd, form.spec_mounting_pcd, form.spec_mounting_pcd_tol_mode, form.spec_mounting_pcd_tol, form.spec_mounting_pcd_tol_minus).outOfRange ? 'Outside tolerance' : undefined}
```

Change:
```jsx
                              value={row.locating_dia_result} onChange={(e) => setRowField(idx, 'locating_dia_result', e.target.value)} placeholder="mm"
```
Find its surrounding block (search for `locating_dia_result` in the table body) and update both `checkTolerance(...)` calls there the same way, appending `, form.spec_locating_dia_tol_minus` as the 5th argument to each.

- [ ] **Step 6: Replace the Shaft Length table cell with the combined dual-check**

Change:
```jsx
                          <td className="py-1 px-1 border border-gray-100">
                            <input
                              className={`${INPUT_CLS} ${checkTolerance(row.shaft_length, form.spec_shaft_length, form.spec_shaft_length_tol_mode, form.spec_shaft_length_tol).outOfRange ? 'border-red-500 bg-red-50' : ''}`}
                              value={row.shaft_length} onChange={(e) => setRowField(idx, 'shaft_length', e.target.value)} placeholder="mm"
                              title={checkTolerance(row.shaft_length, form.spec_shaft_length, form.spec_shaft_length_tol_mode, form.spec_shaft_length_tol).outOfRange ? 'Outside tolerance' : undefined}
                            />
                          </td>
```
to:
```jsx
                          <td className="py-1 px-1 border border-gray-100">
                            {(() => {
                              const { diameter, length } = parseDiaLength(row.shaft_length);
                              const dFlag = checkTolerance(diameter, form.spec_shaft_diameter, form.spec_shaft_diameter_tol_mode, form.spec_shaft_diameter_tol, form.spec_shaft_diameter_tol_minus).outOfRange;
                              const lFlag = checkTolerance(length, form.spec_shaft_length, form.spec_shaft_length_tol_mode, form.spec_shaft_length_tol, form.spec_shaft_length_tol_minus).outOfRange;
                              return (
                                <input
                                  className={`${INPUT_CLS} ${(dFlag || lFlag) ? 'border-red-500 bg-red-50' : ''}`}
                                  value={row.shaft_length}
                                  onChange={(e) => setRowField(idx, 'shaft_length', e.target.value)}
                                  placeholder="e.g. 12/45"
                                  title={dFlag && lFlag ? 'Both diameter and length outside tolerance' : dFlag ? 'Diameter outside tolerance' : lFlag ? 'Length outside tolerance' : undefined}
                                />
                              );
                            })()}
                          </td>
```

- [ ] **Step 7: Lint**

Run: `cd CRM && npx eslint src/components/admin/PDIGeneratorForm.jsx`
Expected: no output (clean).

- [ ] **Step 8: Commit**
```bash
cd CRM
git add src/components/admin/PDIGeneratorForm.jsx
git commit -m "$(cat <<'EOF'
feat: PDI General form UI for Bilateral tolerance + Shaft Diameter

New shared ToleranceSpecInput component (nominal + mode select + either
one tolerance input or two signed +/- inputs for Bilateral) replaces the
6 near-identical inline spec-row groups. Adds a 7th group for the new
Shaft Diameter spec. The Shaft Length table cell now parses its value as
"diameter/length" and flags red if either half is out of range, mirroring
the existing Current/RPM forward/reverse cells.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Verification (controller-personal, not a subagent)

Do this yourself in the current session.

- [ ] **Step 1: Regression check — existing modes unaffected**

```bash
cd CRM_BACKEND
node -e "
require('dotenv').config();
const PdiReports = require('./models/operations/pdiReports');
PdiReports.listReports({ limit: 3, template_id: 'general' }).then(r => { console.log('general reports load OK, count:', r.data.length); process.exit(0); });
"
```

- [ ] **Step 2: Re-confirm the four Bilateral reference cases** (already verified individually in Tasks 2/4, this is a final sanity pass)

```bash
cd CRM_BACKEND
node -e "
const { checkTolerance } = require('./models/operations/pdi/tolerance');
const cases = [
  ['850.15', '850', '0.2', '0.1', false],
  ['850.05', '850', '0.2', '0.1', true],
  ['849.85', '850', '-0.2', '-0.1', false],
  ['850', '850', '-0.2', '-0.1', true],
  ['850', '850', '0.2', '-0.1', false],
  ['850.3', '850', '0.2', '-0.1', true],
];
const results = cases.map(([m, n, t, t2, expected]) => checkTolerance(m, n, 'bilateral', t, t2).outOfRange === expected);
console.log('all 6 cases correct:', results.every(Boolean));
"
```
Expected: `all 6 cases correct: true`.

- [ ] **Step 3: Live browser check of CRM's web form** (local dev server against production RDS, same pattern established earlier this session)

Start local servers:
```bash
cd CRM_BACKEND && FRONTEND_URL=http://localhost:5173 npm run dev
```
```bash
cd CRM && npm run dev
```
(Check port 8000 isn't already bound first via `netstat -ano | grep :8000` before starting, per this session's earlier EADDRINUSE lesson.)

Via gstack browse, logged in as `admin@compageauto.com` / `password123`:
- Navigate to PDI Generator → General template.
- Photos tab: confirm the code path no longer caps at 10 (inspect the rendered Photos-slot `ImageUploadCard`'s disabled state after 10 images are added — it should still allow more, up to 25 — via `$B js` evaluating the add-button's disabled attribute, or trust Task 1's code-level verification if uploading 25 real images isn't practical in this session).
- Mechanical tab: confirm the Shaft O/P Dia./Length and new Shaft Diameter spec-row groups both render, each with a mode dropdown that includes "Bilateral".
- Select "Bilateral" on the Shaft Diameter group's mode dropdown — confirm the "+"/"-" input pair appears in place of the single "tol." input.
- Enter a nominal + bilateral +/- pair, enter a Shaft Diameter/Length measured value in a motor row (e.g. "12/45") that should be in-range for diameter but out-of-range for length — confirm the cell highlights red and its title/tooltip says "Length outside tolerance".
- Repeat for at least one other field (e.g. Motor Length) switched to Bilateral mode, to confirm the shared `ToleranceSpecInput` component works generically, not just for Shaft Diameter.

- [ ] **Step 4: Fix anything found**, re-run the relevant lint/verification script, and commit the fix with its own message in whichever repo it applies to.

- [ ] **Step 5: Stop both local dev servers.**

- [ ] **Step 6: Confirm nothing was pushed.** Both repos' new commits stay local-only unless the user explicitly asks to push, same as every other plan this session.
