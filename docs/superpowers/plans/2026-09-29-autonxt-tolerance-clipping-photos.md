# AutoNXT Tolerance, Clipping, Multi-Photo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the AutoNXT Motor PDI template up to the same "editable, tolerance-validated specifications" standard as the General template — 19 rows across its Performance Test and Physical Parameters tables get an editable specification and a nominal+tolerance check that flags an out-of-range Measured value in red — plus a self-sizing Specification column (fixing a clipping bug), a free-text Measurement input everywhere it was locked to GO/NG/NA, and multi-photo upload for all 6 photo slots.

**Architecture:** `CRM_BACKEND/models/operations/pdi/templates/autonxt.js` gains a `SPEC_DEFAULTS` config table (one entry per tolerance-eligible field, giving its default printed text, nominal, tolerance mode and amount) plus two small helpers (`specDisplay`, `specOutOfTolerance`) that every tolerance-eligible column reads through — this keeps the 19-field surface data-driven rather than hand-duplicated. `CRM_BACKEND/models/operations/pdi/renderer.js` gains self-sizing row height for `mode: 'fixed'` table rows (mirroring the self-sizing already built for General's spec row), gated behind a new per-column `wrap: true` flag so every other template's fixed-mode tables are unaffected. `CRM/src/components/admin/AutoNXTGeneratorForm.jsx` mirrors the same `SPEC_DEFAULTS` table and `checkTolerance` function (this codebase's established "duplicate rather than share across the frontend/backend build boundary" convention, already used for General), adds one small reusable `AutoNxtSpecCell` component for the 19 fields' inputs, converts all 25 Physical Parameters Measurement cells to a free-text-with-quick-picks input, and upgrades the 6 photo slots to multi-image upload by porting General's own already-built multi-image `ImageUploadCard`/`CropModal` pattern.

**Tech Stack:** Node.js/Express/PDFKit (CRM_BACKEND), React (CRM), Jest (CRM_BACKEND only — CRM has no test framework in this codebase).

---

## Reference: the 19-field table

Every task below refers back to this table. Do not re-derive these numbers — they come directly from `CRM_BACKEND/models/operations/pdi/templates/autonxt.js`'s current hardcoded `PERFORMANCE_ROWS`/`PHYSICAL_PARAM_ROWS` and `CRM/src/components/admin/AutoNXTGeneratorForm.jsx`'s matching duplicate.

| Field id | Default display (today's literal) | Default nominal | Default tol mode | Default tol | Default tol minus |
|---|---|---|---|---|---|
| `rpm_500_bemf` | `79.0±3%` | `79.0` | `%` | `3` | — |
| `rpm_500_current` | `6.0±2.0A` | `6.0` | `±` | `2.0` | — |
| `rpm_1000_bemf` | `155.0±3%` | `155.0` | `%` | `3` | — |
| `rpm_1000_current` | `6.0±2.0A` | `6.0` | `±` | `2.0` | — |
| `rpm_1500_bemf` | `227.0±3%` | `227.0` | `%` | `3` | — |
| `rpm_1500_current` | `3.0±1.0A` | `3.0` | `±` | `1.0` | — |
| `rpm_1800_bemf` | `270.0±3%` | `270.0` | `%` | `3` | — |
| `rpm_1800_current` | `3.0±1.0A` | `3.0` | `±` | `1.0` | — |
| `rpm_2000_bemf` | `-` | `''` | `±` | `''` | — |
| `rpm_2000_current` | `-` | `''` | `±` | `''` | — |
| `rpm_2200_bemf` | `-` | `''` | `±` | `''` | — |
| `rpm_2200_current` | `-` | `''` | `±` | `''` | — |
| `rpm_2500_bemf` | `-` | `''` | `±` | `''` | — |
| `rpm_2500_current` | `-` | `''` | `±` | `''` | — |
| `rpm_3000_bemf` | `-` | `''` | `±` | `''` | — |
| `rpm_3000_current` | `-` | `''` | `±` | `''` | — |
| `motor_total_length` | `467.5±1.0` | `467.5` | `±` | `1.0` | — |
| `shaft_op_length` | `10.0±0.5` | `10.0` | `±` | `0.5` | — |
| `locating_dia` | `Ø180.0 (-0.01 TO -0.05)` | `180.0` | `bilateral` | `-0.01` | `-0.05` |

For each field id `X`, the data model is: `data.spec_X_display` (freely-typed text — this is what prints in the Specification/Specified PDF column; decoupled from the tolerance check below, same "print exactly what's typed, never rebuilt from tolerance fields" principle as General's `buildSpecVals`), `data.spec_X` (nominal, used only for the tolerance check), `data.spec_X_tol_mode` (`'±'` / `'%'` / `'bilateral'`), `data.spec_X_tol` (the amount for `±`/`%`, or the "+" amount for `bilateral`), `data.spec_X_tol_minus` (the "-" amount, `bilateral` only). All five are additive/optional — absent on any report (old or new-but-never-touched) falls back to the table above, so nothing changes in the PDF until someone actually edits a field.

---

### Task 1: Backend — `SPEC_DEFAULTS` table and tolerance helpers in `autonxt.js`

**Files:**
- Modify: `CRM_BACKEND/models/operations/pdi/templates/autonxt.js`
- Test: `CRM_BACKEND/tests/pdi_autonxt_tolerance.test.js` (new)

This task adds the data-driven core everything else in the backend builds on: the `SPEC_DEFAULTS` table and the two helpers that read it. No column definitions change yet — that's Task 2.

- [ ] **Step 1: Write the failing test**

Create `CRM_BACKEND/tests/pdi_autonxt_tolerance.test.js`:

```js
const PDFDocument = require('pdfkit');
const { registerFonts } = require('../models/operations/pdi/primitives');
const { renderTemplate } = require('../models/operations/pdi/renderer');
const autonxtTemplate = require('../models/operations/pdi/templates/autonxt');
const { specDisplay, specOutOfTolerance, SPEC_DEFAULTS } = require('../models/operations/pdi/templates/autonxt');

function bufferPdf(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

describe('AutoNXT tolerance-eligible fields — specDisplay/specOutOfTolerance', () => {
  it('SPEC_DEFAULTS has exactly the 19 documented field ids', () => {
    expect(Object.keys(SPEC_DEFAULTS).sort()).toEqual([
      'locating_dia', 'motor_total_length', 'shaft_op_length',
      'rpm_1000_bemf', 'rpm_1000_current', 'rpm_1500_bemf', 'rpm_1500_current',
      'rpm_1800_bemf', 'rpm_1800_current', 'rpm_2000_bemf', 'rpm_2000_current',
      'rpm_2200_bemf', 'rpm_2200_current', 'rpm_2500_bemf', 'rpm_2500_current',
      'rpm_3000_bemf', 'rpm_3000_current', 'rpm_500_bemf', 'rpm_500_current',
    ].sort());
  });

  it('specDisplay falls back to the default literal when data has no override', () => {
    expect(specDisplay({}, 'rpm_500_bemf')).toBe('79.0±3%');
    expect(specDisplay({}, 'motor_total_length')).toBe('467.5±1.0');
    expect(specDisplay({}, 'locating_dia')).toBe('Ø180.0 (-0.01 TO -0.05)');
  });

  it('specDisplay prints exactly what was typed when data has an override', () => {
    expect(specDisplay({ spec_rpm_500_bemf_display: '80.0±2%' }, 'rpm_500_bemf')).toBe('80.0±2%');
  });

  it('specOutOfTolerance flags a measured value outside the default ± range', () => {
    // motor_total_length: 467.5 ± 1.0 -> range [466.5, 468.5]
    expect(specOutOfTolerance('469.0', {}, 'motor_total_length')).toBe(true);
    expect(specOutOfTolerance('467.8', {}, 'motor_total_length')).toBe(false);
  });

  it('specOutOfTolerance flags a measured value outside the default % range', () => {
    // rpm_500_bemf: 79.0 ± 3% -> range [76.63, 81.37]
    expect(specOutOfTolerance('82.0', {}, 'rpm_500_bemf')).toBe(true);
    expect(specOutOfTolerance('80.0', {}, 'rpm_500_bemf')).toBe(false);
  });

  it('specOutOfTolerance flags a measured value outside the default bilateral range (Locating Dia.)', () => {
    // locating_dia: 180.0, +(-0.01)/-0.05 -> range [179.95, 179.99]
    expect(specOutOfTolerance('179.90', {}, 'locating_dia')).toBe(true);
    expect(specOutOfTolerance('179.97', {}, 'locating_dia')).toBe(false);
  });

  it('specOutOfTolerance never flags a blank-spec row (rpm 2000-3000) until a real nominal is entered', () => {
    expect(specOutOfTolerance('999', {}, 'rpm_2000_bemf')).toBe(false);
    expect(specOutOfTolerance('999', { spec_rpm_2000_bemf: '10', spec_rpm_2000_bemf_tol_mode: '±', spec_rpm_2000_bemf_tol: '1' }, 'rpm_2000_bemf')).toBe(true);
  });

  it('a report\'s own spec_X/_tol_mode/_tol override the default nominal/tolerance used for the check', () => {
    // Override motor_total_length to 500 ± 2 -> a measured value of 469.0 (out of range
    // against the DEFAULT 467.5±1.0) is now in range against the override.
    const data = { spec_motor_total_length: '500', spec_motor_total_length_tol_mode: '±', spec_motor_total_length_tol: '2' };
    expect(specOutOfTolerance('469.0', data, 'motor_total_length')).toBe(true);
    expect(specOutOfTolerance('499.5', data, 'motor_total_length')).toBe(false);
  });
});

describe('AutoNXT template renders without throwing', () => {
  it('renders an old-shaped report (no spec_* fields at all) without throwing', async () => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 10, bottom: 0, left: 36, right: 36 }, autoFirstPage: false, bufferPages: true });
    registerFonts(doc);
    expect(() => renderTemplate(doc, autonxtTemplate, {
      customer_name: 'Old Co.', pdi_no: 'PDI-OLD-1',
      performance_test: { rpm_500: { bemf_measured: '80', current_measured: '6.5' } },
      physical_parameters: { motor_total_length: { measured: '468' } },
    })).not.toThrow();
    doc.end();
    const buf = await bufferPdf(doc);
    expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('renders a report with every new field populated without throwing', async () => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 10, bottom: 0, left: 36, right: 36 }, autoFirstPage: false, bufferPages: true });
    registerFonts(doc);
    const data = {
      customer_name: 'New Co.', pdi_no: 'PDI-NEW-1',
      spec_rpm_500_bemf_display: '80.0±2%', spec_rpm_500_bemf: '80.0', spec_rpm_500_bemf_tol_mode: '%', spec_rpm_500_bemf_tol: '2',
      spec_locating_dia_display: 'Ø180.0 (+0.00 TO -0.03)', spec_locating_dia: '180.0', spec_locating_dia_tol_mode: 'bilateral', spec_locating_dia_tol: '0', spec_locating_dia_tol_minus: '-0.03',
      performance_test: { rpm_500: { bemf_measured: '81', current_measured: '6.5' } },
      physical_parameters: { locating_dia: { measured: '179.98' } },
    };
    expect(() => renderTemplate(doc, autonxtTemplate, data)).not.toThrow();
    doc.end();
    const buf = await bufferPdf(doc);
    expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/pdi_autonxt_tolerance.test.js`
Expected: FAIL — `specDisplay`/`specOutOfTolerance`/`SPEC_DEFAULTS` are not exported from `autonxt.js` yet.

- [ ] **Step 3: Add `SPEC_DEFAULTS` and the two helpers to `autonxt.js`**

Open `CRM_BACKEND/models/operations/pdi/templates/autonxt.js`. Add this near the top, after the existing `require` line:

```js
const { checkTolerance } = require('../tolerance');
```

Then add, directly after the `PERFORMANCE_ROWS` array's closing `];` (before the `performanceColumns` function):

```js
// Every tolerance-eligible field across both tables (Performance Test's BEMF/
// Current Specified columns, and 3 Physical Parameters rows) follows the
// same shape: a freely-typed Specification-column string (spec_<id>_display,
// what actually prints — decoupled from the tolerance check below, same
// "printed exactly as typed, never rebuilt from the tolerance fields"
// principle as general.js's buildSpecVals) plus a separate nominal+tolerance
// (spec_<id>, spec_<id>_tol_mode, spec_<id>_tol, spec_<id>_tol_minus) used
// only to flag the Measured cell. This table gives the default for both
// halves -- today's fixed literal text, plus the equivalent nominal/mode/
// tolerance -- so an unedited report (old or new) prints and validates
// exactly as it always has. See the plan's field-id table for where each of
// these numbers came from.
const SPEC_DEFAULTS = {
  rpm_500_bemf:       { display: '79.0±3%',  nominal: 79.0,  tolMode: '%', tol: 3 },
  rpm_500_current:    { display: '6.0±2.0A', nominal: 6.0,   tolMode: '±', tol: 2.0 },
  rpm_1000_bemf:      { display: '155.0±3%', nominal: 155.0, tolMode: '%', tol: 3 },
  rpm_1000_current:   { display: '6.0±2.0A', nominal: 6.0,   tolMode: '±', tol: 2.0 },
  rpm_1500_bemf:      { display: '227.0±3%', nominal: 227.0, tolMode: '%', tol: 3 },
  rpm_1500_current:   { display: '3.0±1.0A', nominal: 3.0,   tolMode: '±', tol: 1.0 },
  rpm_1800_bemf:      { display: '270.0±3%', nominal: 270.0, tolMode: '%', tol: 3 },
  rpm_1800_current:   { display: '3.0±1.0A', nominal: 3.0,   tolMode: '±', tol: 1.0 },
  rpm_2000_bemf:      { display: '-', nominal: '', tolMode: '±', tol: '' },
  rpm_2000_current:   { display: '-', nominal: '', tolMode: '±', tol: '' },
  rpm_2200_bemf:      { display: '-', nominal: '', tolMode: '±', tol: '' },
  rpm_2200_current:   { display: '-', nominal: '', tolMode: '±', tol: '' },
  rpm_2500_bemf:      { display: '-', nominal: '', tolMode: '±', tol: '' },
  rpm_2500_current:   { display: '-', nominal: '', tolMode: '±', tol: '' },
  rpm_3000_bemf:      { display: '-', nominal: '', tolMode: '±', tol: '' },
  rpm_3000_current:   { display: '-', nominal: '', tolMode: '±', tol: '' },
  motor_total_length: { display: '467.5±1.0', nominal: 467.5, tolMode: '±', tol: 1.0 },
  shaft_op_length:    { display: '10.0±0.5',  nominal: 10.0,  tolMode: '±', tol: 0.5 },
  locating_dia:       { display: 'Ø180.0 (-0.01 TO -0.05)', nominal: 180.0, tolMode: 'bilateral', tol: -0.01, tolMinus: -0.05 },
};

function specDisplay(data, id) {
  return data[`spec_${id}_display`] || SPEC_DEFAULTS[id].display;
}

function specOutOfTolerance(measured, data, id) {
  const def = SPEC_DEFAULTS[id];
  const nominal   = data[`spec_${id}`] ?? def.nominal;
  const mode      = data[`spec_${id}_tol_mode`] ?? def.tolMode;
  const tol       = data[`spec_${id}_tol`] ?? def.tol;
  const tolMinus  = data[`spec_${id}_tol_minus`] ?? def.tolMinus;
  return checkTolerance(measured, nominal, mode, tol, tolMinus).outOfRange;
}
```

At the bottom of the file, change the export line from:

```js
module.exports = autonxtTemplate;
```

to:

```js
module.exports = autonxtTemplate;
module.exports.SPEC_DEFAULTS = SPEC_DEFAULTS;
module.exports.specDisplay = specDisplay;
module.exports.specOutOfTolerance = specOutOfTolerance;
```

(This keeps `require('.../autonxt')` returning the template object directly, as every existing caller expects — `pdi_generator.js`'s `templates[templateId]` — while also exposing the three named things the test needs. Function declarations and `const SPEC_DEFAULTS` hoist/exist at module-eval time regardless of where in the file this assignment happens, so appending it at the end is safe.)

- [ ] **Step 4: Run test to verify the new describe block passes**

Run: `npx jest tests/pdi_autonxt_tolerance.test.js -t "specDisplay/specOutOfTolerance"`
Expected: PASS — all 7 tests in that describe block. The "renders without throwing" describe block still fails (Step 5 fixes that).

- [ ] **Step 5: Commit**

```bash
git add models/operations/pdi/templates/autonxt.js tests/pdi_autonxt_tolerance.test.js
git commit -m "$(cat <<'EOF'
feat: AutoNXT tolerance-field defaults and check helpers

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Backend — wire the 19 fields into `autonxt.js`'s columns

**Files:**
- Modify: `CRM_BACKEND/models/operations/pdi/templates/autonxt.js`
- Test: `CRM_BACKEND/tests/pdi_autonxt_tolerance.test.js`

This task makes the "renders without throwing" tests from Task 1 pass, and adds the tests that actually prove the PDF prints/flags correctly.

- [ ] **Step 1: Write the failing test**

Add to `CRM_BACKEND/tests/pdi_autonxt_tolerance.test.js` (inside the file, as a new top-level `describe`):

```js
describe('AutoNXT template — drawn PDF content', () => {
  function drawnTexts(data) {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 10, bottom: 0, left: 36, right: 36 }, autoFirstPage: false, bufferPages: true });
    registerFonts(doc);
    const drawn = [];
    const originalText = doc.text.bind(doc);
    doc.text = (str, ...rest) => { drawn.push(String(str)); return originalText(str, ...rest); };
    renderTemplate(doc, autonxtTemplate, data);
    doc.end();
    return drawn;
  }

  it('prints the default literal spec text for every tolerance-eligible field when data has no overrides', () => {
    const drawn = drawnTexts({ customer_name: 'X', pdi_no: 'X' });
    expect(drawn).toContain('79.0±3%');       // rpm_500_bemf
    expect(drawn).toContain('467.5±1.0');     // motor_total_length
    expect(drawn).toContain('Ø180.0 (-0.01 TO -0.05)'); // locating_dia
  });

  it('prints an edited spec_X_display verbatim, and never derives it from the tolerance fields', () => {
    const drawn = drawnTexts({
      customer_name: 'X', pdi_no: 'X',
      spec_motor_total_length_display: '470.0 (special run)',
      spec_motor_total_length: '470.0', spec_motor_total_length_tol_mode: '±', spec_motor_total_length_tol: '0.5',
    });
    expect(drawn).toContain('470.0 (special run)');
    expect(drawn).not.toContain('467.5±1.0');
  });

  it('flags an out-of-tolerance Motor Total Length measurement in red, and leaves an in-range one alone', () => {
    const outOfRange = new PDFDocument({ size: 'A4', margins: { top: 10, bottom: 0, left: 36, right: 36 }, autoFirstPage: false, bufferPages: true });
    registerFonts(outOfRange);
    const fillsOut = [];
    const origFillOut = outOfRange.fillColor.bind(outOfRange);
    outOfRange.fillColor = (c, ...rest) => { fillsOut.push(c); return origFillOut(c, ...rest); };
    renderTemplate(outOfRange, autonxtTemplate, {
      customer_name: 'X', pdi_no: 'X',
      physical_parameters: { motor_total_length: { measured: '470.0' } }, // out of [466.5, 468.5]
    });
    outOfRange.end();
    expect(fillsOut).toContain('#fee2e2');

    const inRange = new PDFDocument({ size: 'A4', margins: { top: 10, bottom: 0, left: 36, right: 36 }, autoFirstPage: false, bufferPages: true });
    registerFonts(inRange);
    const fillsIn = [];
    const origFillIn = inRange.fillColor.bind(inRange);
    inRange.fillColor = (c, ...rest) => { fillsIn.push(c); return origFillIn(c, ...rest); };
    renderTemplate(inRange, autonxtTemplate, {
      customer_name: 'X', pdi_no: 'X',
      physical_parameters: { motor_total_length: { measured: '467.8' } }, // in [466.5, 468.5]
    });
    inRange.end();
    expect(fillsIn).not.toContain('#fee2e2');
  });

  it('a non-numeric Measurement (e.g. still "GO") on a tolerance-eligible row is never flagged', () => {
    const drawn = drawnTexts({
      customer_name: 'X', pdi_no: 'X',
      physical_parameters: { motor_total_length: { measured: 'GO' } },
    });
    expect(drawn).toContain('GO');
  });

  it('the 22 non-numeric Physical Parameters rows still print their fixed spec text unchanged', () => {
    const drawn = drawnTexts({ customer_name: 'X', pdi_no: 'X' });
    expect(drawn).toContain('PCD Ø63.0, 06Nos M10, Depth 25.0, Go/NG'); // Shaft Flange Mtg.
    expect(drawn).toContain('No Abnormal Noise'); // Noise
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/pdi_autonxt_tolerance.test.js`
Expected: FAIL — the two "renders without throwing" tests from Task 1 still pass (they didn't depend on wiring), but every test in the new "drawn PDF content" describe block fails, since the columns don't read `spec_*` fields yet.

- [ ] **Step 3: Enrich `fixedRows` and update column definitions**

In `CRM_BACKEND/models/operations/pdi/templates/autonxt.js`, replace the `performanceColumns` function with:

```js
// Folds each row's current Measured value and this field's display/
// out-of-tolerance state into the row object once, so both performanceColumns'
// `value` functions and their `isOutOfTolerance` functions can read plain
// row.* fields -- the same shape General's MCOLS/ECOLS rows already have --
// instead of every column re-deriving it from data/sectionData itself.
function performanceRows(data) {
  const sectionData = data.performance_test || {};
  return PERFORMANCE_ROWS.map((r) => {
    const measured = sectionData[r.key] || {};
    return {
      ...r,
      bemf_measured:    measured.bemf_measured || '',
      current_measured: measured.current_measured || '',
      bemfDisplay:    specDisplay(data, `${r.key}_bemf`),
      currentDisplay: specDisplay(data, `${r.key}_current`),
      bemfOutOfTolerance:    specOutOfTolerance(measured.bemf_measured, data, `${r.key}_bemf`),
      currentOutOfTolerance: specOutOfTolerance(measured.current_measured, data, `${r.key}_current`),
    };
  });
}

function performanceColumns() {
  return [
    { label: 'RPM', w: 40, align: 'center', value: (row) => row.rpm },
    { label: 'Source Voltage DC (V)', w: 70, align: 'center', value: (row) => row.sourceVoltage },
    { label: 'Specified', w: 55, align: 'center', group: 'BEMF (V)', wrap: true,
      value: (row) => row.bemfDisplay },
    { label: 'Measured', w: 55, align: 'center', group: 'BEMF (V)',
      value: (row) => row.bemf_measured,
      isOutOfTolerance: (row) => row.bemfOutOfTolerance },
    { label: 'Specified', w: 55, align: 'center', group: 'Running Current (A)', wrap: true,
      value: (row) => row.currentDisplay },
    { label: 'Measured', w: 55, align: 'center', group: 'Running Current (A)',
      value: (row) => row.current_measured,
      isOutOfTolerance: (row) => row.currentOutOfTolerance },
    { label: 'Measurement Method', align: 'center', value: (row) => row.method },
  ];
}
```

Replace the `physicalParamColumns` function with:

```js
// Same enrichment approach as performanceRows above. Only the 3 rows present
// in SPEC_DEFAULTS get specDisplay/specOutOfTolerance computed; the other 22
// rows' `row.spec`/`row.method` (their fixed literal text) pass through
// untouched, and physicalParamColumns' Specification column falls back to
// `row.spec` for them.
function physicalParamRows(data) {
  const sectionData = data.physical_parameters || {};
  return PHYSICAL_PARAM_ROWS.map((r) => {
    const measured = (sectionData[r.key] || {}).measured ?? 'GO';
    const row = { ...r, measured };
    if (SPEC_DEFAULTS[r.key]) {
      row.specDisplay = specDisplay(data, r.key);
      row.specOutOfTolerance = specOutOfTolerance(measured, data, r.key);
    }
    return row;
  });
}

function physicalParamColumns() {
  return [
    { label: 'Sr.No', w: 30, align: 'center', value: (row) => row.sno },
    { label: 'Parameter', w: 150, align: 'left', value: (row) => row.label },
    { label: 'Specification', w: 150, align: 'center', wrap: true,
      value: (row) => (row.specDisplay !== undefined ? row.specDisplay : row.spec) },
    { label: 'Measurement', w: 80, align: 'center',
      value: (row) => row.measured,
      isOutOfTolerance: (row) => !!row.specOutOfTolerance },
    { label: 'Measurement Method', align: 'center', value: (row) => row.method },
  ];
}
```

Now update the two `fixedRows:` references in the `autonxtTemplate` object (the template definition near the bottom of the file) from:

```js
fixedRows: () => PERFORMANCE_ROWS, columns: performanceColumns(),
```

to:

```js
fixedRows: performanceRows, columns: performanceColumns(),
```

and from:

```js
fixedRows: () => PHYSICAL_PARAM_ROWS, columns: physicalParamColumns(),
```

to:

```js
fixedRows: physicalParamRows, columns: physicalParamColumns(),
```

(`section.fixedRows(data)` is already how `renderer.js`'s `drawTableSection` calls this — it was always passed `data`, `PERFORMANCE_ROWS`/`PHYSICAL_PARAM_ROWS` just never used it. No renderer.js change needed for this step.)

Also add `Sr.No` numbering to `PHYSICAL_PARAM_ROWS` entries if not already present — check the existing rows already have `sno: 1..25`; if so, no change needed there. `GENERAL_CHECK_ROWS` and `generalCheckColumns()` are untouched by this task (out of scope, per the plan header).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/pdi_autonxt_tolerance.test.js`
Expected: PASS — all tests in both describe blocks.

- [ ] **Step 5: Run the full backend PDI test suite to check for regressions**

Run: `npx jest tests/pdi_ --runInBand`
Expected: PASS, same pre-existing failure count as before this change (one unrelated pre-existing photo-size test failure, per this session's established baseline — nothing new should fail).

- [ ] **Step 6: Commit**

```bash
git add models/operations/pdi/templates/autonxt.js tests/pdi_autonxt_tolerance.test.js
git commit -m "$(cat <<'EOF'
feat: wire tolerance-eligible fields into AutoNXT's PDF columns

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Backend — self-sizing rows for `mode: 'fixed'` tables (`wrap: true`)

**Files:**
- Modify: `CRM_BACKEND/models/operations/pdi/renderer.js`
- Test: `CRM_BACKEND/tests/pdi_template_renderer.test.js`

Task 2 already set `wrap: true` on 3 AutoNXT columns (2 Performance Test Specified columns, 1 Physical Parameters Specification column) — `renderer.js`'s `drawTableRow` doesn't understand that flag yet, so right now it's silently ignored (still single-line, truncated to ellipsis, same clipping bug as before). This task teaches `drawTableRow` to size the whole row to a `wrap` column's content, the same two-pass measure-then-draw approach `drawSpecRow` already uses for General's spec row (see `specCellLayout`, already in this file).

- [ ] **Step 1: Write the failing test**

Add to `CRM_BACKEND/tests/pdi_template_renderer.test.js`, as a new `describe` block before the final closing `});` of the file's outer `describe('PDI template renderer', ...)`:

```js
  describe('fixed-mode table row sizes itself to a `wrap: true` column\'s text', () => {
    const wrapTemplate = (specText) => ({
      pages: [{
        sections: [{
          type: 'table',
          mode: 'fixed', dataKey: 'rows',
          fixedRows: () => [{ spec: specText }],
          columns: [
            { label: 'Parameter', w: 60, align: 'left', value: () => 'Some Check' },
            { label: 'Specification', w: 80, align: 'center', wrap: true, value: (row) => row.spec },
          ],
          headerHeight: 14, rowHeight: 14,
        }],
      }],
    });
    async function rectHeights(specText) {
      const doc = new PDFDocument({ size: 'A4', margins: { top: 10, bottom: 0, left: 36, right: 36 }, autoFirstPage: false, bufferPages: true });
      registerFonts(doc);
      const heights = [];
      const originalRect = doc.rect.bind(doc);
      doc.rect = (x, y, w, h) => { heights.push(h); return originalRect(x, y, w, h); };
      renderTemplate(doc, wrapTemplate(specText), {});
      doc.end();
      await bufferPdf(doc);
      return heights;
    }

    it('stays a normal row (14pt) when the text fits on one line', async () => {
      expect(Math.max(...(await rectHeights('Go/NG')))).toBe(14);
    });

    it('grows when the text is too wide for one line, instead of being clipped', async () => {
      expect(Math.max(...(await rectHeights('PCD Ø63.0, 06Nos M10, Depth 25.0, Go/NG')))).toBeGreaterThan(14);
    });

    it('a non-wrap column\'s row is completely unaffected (existing single-line-ellipsis behavior)', async () => {
      const template = {
        pages: [{
          sections: [{
            type: 'table', mode: 'fixed', dataKey: 'rows',
            fixedRows: () => [{ spec: 'This is a very long line of text that would normally be ellipsis-truncated' }],
            columns: [{ label: 'Specification', w: 80, align: 'center', value: (row) => row.spec }],
            headerHeight: 14, rowHeight: 14,
          }],
        }],
      };
      const doc = new PDFDocument({ size: 'A4', margins: { top: 10, bottom: 0, left: 36, right: 36 }, autoFirstPage: false, bufferPages: true });
      registerFonts(doc);
      const heights = [];
      const originalRect = doc.rect.bind(doc);
      doc.rect = (x, y, w, h) => { heights.push(h); return originalRect(x, y, w, h); };
      renderTemplate(doc, template, {});
      doc.end();
      await bufferPdf(doc);
      expect(Math.max(...heights)).toBe(14);
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/pdi_template_renderer.test.js -t "sizes itself"`
Expected: FAIL — the "grows when the text is too wide" test fails (row stays 14pt); the other two already pass by coincidence (nothing to grow, or `wrap` doesn't exist yet so it's a no-op).

- [ ] **Step 3: Add self-sizing to `drawTableRow`**

In `CRM_BACKEND/models/operations/pdi/renderer.js`, replace the `drawTableRow` function with:

```js
function drawTableRow(doc, cols, row, sectionData, data, rowHeight, y) {
  const { F, FB } = getFonts();
  // Columns marked `wrap: true` (AutoNXT's now-editable Specification/
  // Specified text, which can run longer than the fixed literal it used to
  // always be) size the WHOLE row to their own content -- the same two-pass
  // measure-then-draw approach drawSpecRow already uses for General's spec
  // row (see specCellLayout above). A row with no wrap column, or a wrap
  // column whose text fits on one line, is unaffected: exactly `rowHeight`,
  // same single-line-ellipsis text as before.
  const layouts = [];
  cols.forEach((c, i) => {
    if (!c.wrap) return;
    const val = resolveCellValue(c, row, sectionData, data);
    layouts[i] = specCellLayout(doc, String(val ?? ''), c.w - 4, F);
  });
  const contentH = Math.max(0, ...layouts.filter(Boolean).map((l) => l.height));
  const h = layouts.some(Boolean) ? Math.max(rowHeight, contentH + 5) : rowHeight;

  let x = M;
  cols.forEach((c, i) => {
    const val = resolveCellValue(c, row, sectionData, data);
    const flagged = c.isOutOfTolerance ? c.isOutOfTolerance(row, data) : false;
    // Bold text is the flag's print-safe cue — the light-red fill and dark-red
    // text are the primary on-screen/color-print signal, but a light fill can
    // wash out on a black-and-white printer or a photocopy of one; bold still
    // reads as "different" once color is gone.
    box(doc, x, y, c.w, h, { stroke: '#000', sw: 0.3, fill: flagged ? '#fee2e2' : undefined });
    t(doc, val, x + 2, y + 3, c.w - 4, {
      font: flagged ? FB : F,
      size: layouts[i] ? layouts[i].size : 7.5,
      align: c.align,
      color: flagged ? '#b91c1c' : '#000',
      lb: !!c.wrap,
    });
    x += c.w;
  });
  return y + h;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/pdi_template_renderer.test.js`
Expected: PASS — every test in the file, including the new `describe` block and every pre-existing test (backward compatibility: no template anywhere else in the codebase sets `wrap: true`, so `layouts.some(Boolean)` is always `false` for them and `h` stays exactly `rowHeight`).

- [ ] **Step 5: Run the AutoNXT test file again to confirm the clipping fix actually shows up there too**

Run: `npx jest tests/pdi_autonxt_tolerance.test.js`
Expected: PASS (unchanged from Task 2 — this step is a sanity check that Task 3's renderer change didn't regress Task 2's tests).

- [ ] **Step 6: Commit**

```bash
git add models/operations/pdi/renderer.js tests/pdi_template_renderer.test.js
git commit -m "$(cat <<'EOF'
feat: self-sizing fixed-mode table rows for wrap:true columns

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Backend — regression test confirming multi-photo AutoNXT slots need no backend change

**Files:**
- Test: `CRM_BACKEND/tests/pdi_autonxt_tolerance.test.js`

Confirmed by reading the code before writing this plan: `renderer.js`'s `drawPhotoSection` already normalizes both a bare data-URI string (today's AutoNXT shape) and an array of data-URIs (the shape Task 8, in `CRM`, switches AutoNXT to) for `mode: 'fixed-slots'`; `pdiReports.js`'s `countPhotos` and `photosSummarySql` already handle both shapes generically for any object-shaped `photos` value. This task adds one test proving it, so a future change to either function that breaks this doesn't slip through silently — no production code changes in this task.

- [ ] **Step 1: Write the test**

Add to `CRM_BACKEND/tests/pdi_autonxt_tolerance.test.js`:

```js
describe('AutoNXT fixed-slots photos — both the legacy single-image shape and the new multi-image shape render', () => {
  const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

  it('renders a slot holding a bare data-URI string (today\'s shape) without throwing', async () => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 10, bottom: 0, left: 36, right: 36 }, autoFirstPage: false, bufferPages: true });
    registerFonts(doc);
    expect(() => renderTemplate(doc, autonxtTemplate, {
      customer_name: 'X', pdi_no: 'X',
      photos: { overall_motor: TINY_PNG },
    })).not.toThrow();
    doc.end();
    const buf = await bufferPdf(doc);
    expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('renders a slot holding an array of data-URIs (the new multi-photo shape) without throwing, one cell per photo', async () => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 10, bottom: 0, left: 36, right: 36 }, autoFirstPage: false, bufferPages: true });
    registerFonts(doc);
    const drawn = [];
    const originalText = doc.text.bind(doc);
    doc.text = (str, ...rest) => { drawn.push(String(str)); return originalText(str, ...rest); };
    renderTemplate(doc, autonxtTemplate, {
      customer_name: 'X', pdi_no: 'X',
      photos: { overall_motor: [TINY_PNG, TINY_PNG, TINY_PNG] },
    });
    doc.end();
    await bufferPdf(doc);
    expect(drawn.some((s) => s.includes('Overall Motor Photo (1)'))).toBe(true);
    expect(drawn.some((s) => s.includes('Overall Motor Photo (2)'))).toBe(true);
    expect(drawn.some((s) => s.includes('Overall Motor Photo (3)'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it already passes**

Run: `npx jest tests/pdi_autonxt_tolerance.test.js -t "fixed-slots photos"`
Expected: PASS — both tests, with no production code change. This confirms the claim in the plan header; if either test fails here, stop and investigate `renderer.js`'s `drawPhotoSection` before proceeding to Task 8, since that would mean the CRM-side photo change does need a backend counterpart after all.

- [ ] **Step 3: Also confirm `countPhotos` handles both shapes**

Read `CRM_BACKEND/models/operations/pdiReports.js`'s `countPhotos` function (near the top of the file) to confirm it still reads as:

```js
function countPhotos(photos) {
  const countOf = (v) => (Array.isArray(v) ? v.length : (v ? 1 : 0));
  if (Array.isArray(photos)) return photos.reduce((n, p) => n + (Array.isArray(p?.images) ? p.images.length : 0), 0);
  if (photos && typeof photos === 'object') return Object.values(photos).reduce((n, v) => n + countOf(v), 0);
  return 0;
}
```

If it does (it should — this was read directly from the file while writing this plan), no test is needed here; this function is already covered by `tests/pdi_photos_summary.test.js`'s existing suite for the object-shaped case. Do not add a duplicate test.

- [ ] **Step 4: Commit**

```bash
git add tests/pdi_autonxt_tolerance.test.js
git commit -m "$(cat <<'EOF'
test: confirm AutoNXT's fixed-slots photo rendering needs no backend change for multi-photo

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: CRM — `SPEC_DEFAULTS`, `checkTolerance`, and `defaultForm()` fields

**Files:**
- Modify: `CRM/src/components/admin/AutoNXTGeneratorForm.jsx`

No automated test framework exists in `CRM` (confirmed earlier this session) — this and the remaining CRM tasks are verified by the live browser check in the final task. This task only adds data/state — no rendering changes yet, so there is nothing user-visible to check until Task 6.

- [ ] **Step 1: Add `SPEC_DEFAULTS` (mirrors `CRM_BACKEND`'s table exactly)**

In `CRM/src/components/admin/AutoNXTGeneratorForm.jsx`, add this near the top of the file, directly after the `PHYSICAL_PARAM_ROWS` array's closing `];`:

```js
// Mirrors CRM_BACKEND/models/operations/pdi/templates/autonxt.js's
// SPEC_DEFAULTS exactly (same duplicated-rather-than-shared convention this
// file already documents at its top for the row/column definitions above —
// no shared build pipeline between frontend and backend). Any change here
// must be mirrored there, and vice versa.
const SPEC_DEFAULTS = {
  rpm_500_bemf:       { display: '79.0±3%',  nominal: '79.0',  tolMode: '%', tol: '3' },
  rpm_500_current:    { display: '6.0±2.0A', nominal: '6.0',   tolMode: '±', tol: '2.0' },
  rpm_1000_bemf:      { display: '155.0±3%', nominal: '155.0', tolMode: '%', tol: '3' },
  rpm_1000_current:   { display: '6.0±2.0A', nominal: '6.0',   tolMode: '±', tol: '2.0' },
  rpm_1500_bemf:      { display: '227.0±3%', nominal: '227.0', tolMode: '%', tol: '3' },
  rpm_1500_current:   { display: '3.0±1.0A', nominal: '3.0',   tolMode: '±', tol: '1.0' },
  rpm_1800_bemf:      { display: '270.0±3%', nominal: '270.0', tolMode: '%', tol: '3' },
  rpm_1800_current:   { display: '3.0±1.0A', nominal: '3.0',   tolMode: '±', tol: '1.0' },
  rpm_2000_bemf:      { display: '-', nominal: '', tolMode: '±', tol: '' },
  rpm_2000_current:   { display: '-', nominal: '', tolMode: '±', tol: '' },
  rpm_2200_bemf:      { display: '-', nominal: '', tolMode: '±', tol: '' },
  rpm_2200_current:   { display: '-', nominal: '', tolMode: '±', tol: '' },
  rpm_2500_bemf:      { display: '-', nominal: '', tolMode: '±', tol: '' },
  rpm_2500_current:   { display: '-', nominal: '', tolMode: '±', tol: '' },
  rpm_3000_bemf:      { display: '-', nominal: '', tolMode: '±', tol: '' },
  rpm_3000_current:   { display: '-', nominal: '', tolMode: '±', tol: '' },
  motor_total_length: { display: '467.5±1.0', nominal: '467.5', tolMode: '±', tol: '1.0' },
  shaft_op_length:    { display: '10.0±0.5',  nominal: '10.0',  tolMode: '±', tol: '0.5' },
  locating_dia:       { display: 'Ø180.0 (-0.01 TO -0.05)', nominal: '180.0', tolMode: 'bilateral', tol: '-0.01', tolMinus: '-0.05' },
};

const SPEC_FIELD_IDS = Object.keys(SPEC_DEFAULTS);

// Builds the 5 flat form fields (spec_<id>_display, spec_<id>,
// spec_<id>_tol_mode, spec_<id>_tol, spec_<id>_tol_minus) for every
// tolerance-eligible field, defaulted from SPEC_DEFAULTS -- spread into
// defaultForm() below.
function defaultSpecFields() {
  const out = {};
  SPEC_FIELD_IDS.forEach((id) => {
    const def = SPEC_DEFAULTS[id];
    out[`spec_${id}_display`] = def.display;
    out[`spec_${id}`] = def.nominal;
    out[`spec_${id}_tol_mode`] = def.tolMode;
    out[`spec_${id}_tol`] = def.tol;
    out[`spec_${id}_tol_minus`] = def.tolMinus ?? '';
  });
  return out;
}
```

- [ ] **Step 2: Add `checkTolerance` (mirrors `tolerance.js`/`PDIGeneratorForm.jsx` exactly)**

Add directly after `defaultSpecFields`:

```js
// Fourth copy of this exact formula in the codebase (CRM_BACKEND/models/
// operations/pdi/tolerance.js, CRM/src/components/admin/PDIGeneratorForm.jsx,
// pdi-erp-app/src/services/tolerance.ts, and now here) — kept as a
// duplicate rather than shared for the same reason as SPEC_DEFAULTS above.
// The FORMULA must stay identical across all of them.
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
  const amount = Math.abs(toleranceAmount);
  const delta = toleranceMode === '%' ? Math.abs(nominal) * (amount / 100) : amount;
  const outOfRange = measured < nominal - delta || measured > nominal + delta;
  return { outOfRange };
}

// True when the given field id's current Measured value is outside its
// current nominal ± tolerance. `measured` is read by the caller (it lives in
// form.performance_test[row.key] or form.physical_parameters[row.key], two
// different shapes) and passed in rather than looked up here.
function isFieldOutOfTolerance(form, id, measured) {
  return checkTolerance(
    measured,
    form[`spec_${id}`],
    form[`spec_${id}_tol_mode`],
    form[`spec_${id}_tol`],
    form[`spec_${id}_tol_minus`],
  ).outOfRange;
}
```

- [ ] **Step 3: Spread `defaultSpecFields()` into `defaultForm()`**

In the `defaultForm` function, change:

```js
const defaultForm = () => ({
  customer_name: '', date: todayIST(), product_id: '', drawing_no: '',
  product_specifications: '', pdi_no: '', motor_sr_no: '', controller_type: '',
```

to:

```js
const defaultForm = () => ({
  customer_name: '', date: todayIST(), product_id: '', drawing_no: '',
  product_specifications: '', pdi_no: '', motor_sr_no: '', controller_type: '',
  ...defaultSpecFields(),
```

(Leave everything else in `defaultForm` unchanged for this task — `performance_test`, `general_check`, `physical_parameters`, `photos`, etc. stay exactly as they are; the multi-photo change to `photos` is Task 8.)

- [ ] **Step 4: Verify the file still parses and the app still loads**

Run: `cd CRM && npx eslint src/components/admin/AutoNXTGeneratorForm.jsx`
Expected: no new errors (pre-existing warnings, if any, are unrelated and unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/components/admin/AutoNXTGeneratorForm.jsx
git commit -m "$(cat <<'EOF'
feat: AutoNXT tolerance-field defaults and check helper in the web form

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: CRM — `AutoNxtSpecCell` component, wired into Performance Test

**Files:**
- Modify: `CRM/src/components/admin/AutoNXTGeneratorForm.jsx`

- [ ] **Step 1: Add the `AutoNxtSpecCell` component**

Add directly after the `ImageUploadCard` function (around line 211, before `CropModal`):

```js
// One reusable cell for every tolerance-eligible field: a freely-typed
// Specification text input (spec_<id>_display -- what prints in the PDF,
// independent of the tolerance check below) plus a compact nominal +
// tolerance-mode + tolerance-amount group (spec_<id>/_tol_mode/_tol/
// _tol_minus, used only to flag the Measured cell). Mirrors General's own
// ToleranceSpecInput (CRM/src/components/admin/PDIGeneratorForm.jsx) with
// one addition -- the Specification text input -- since AutoNXT's rows have
// no separate "spec row above many measured rows" the way General's do,
// this print text has to live somewhere per-row.
function AutoNxtSpecCell({ form, setField, id }) {
  const mode = form[`spec_${id}_tol_mode`];
  return (
    <div className="space-y-1 min-w-[150px]">
      <input
        className={INPUT_CLS}
        value={form[`spec_${id}_display`]}
        onChange={(e) => setField(`spec_${id}_display`, e.target.value)}
        placeholder="Specification"
      />
      <div className="flex gap-1 flex-wrap">
        <input
          className={INPUT_CLS}
          value={form[`spec_${id}`]}
          onChange={(e) => setField(`spec_${id}`, e.target.value)}
          placeholder="nominal"
          style={{ maxWidth: 64 }}
        />
        <select className={SELECT_CLS} value={mode} onChange={(e) => setField(`spec_${id}_tol_mode`, e.target.value)}>
          <option value="±">±</option>
          <option value="%">±%</option>
          <option value="bilateral">Bilateral</option>
        </select>
        <input
          className={INPUT_CLS}
          value={form[`spec_${id}_tol`]}
          onChange={(e) => setField(`spec_${id}_tol`, e.target.value)}
          placeholder={mode === 'bilateral' ? '+' : 'tol.'}
          aria-label={mode === 'bilateral' ? 'Plus tolerance' : 'Tolerance amount'}
          style={{ maxWidth: mode === 'bilateral' ? 50 : 60 }}
        />
        {mode === 'bilateral' && (
          <input
            className={INPUT_CLS}
            value={form[`spec_${id}_tol_minus`]}
            onChange={(e) => setField(`spec_${id}_tol_minus`, e.target.value)}
            placeholder="-"
            aria-label="Minus tolerance"
            style={{ maxWidth: 50 }}
          />
        )}
      </div>
    </div>
  );
}
```

`setField` here is called with a plain top-level field name (`spec_rpm_500_bemf_display`, etc.) — every one of these is a flat key on `form` (per Task 5's `defaultSpecFields()`), so the component can use the existing `setField(field, value)` callback unchanged; it does not need `setChecklistField`.

- [ ] **Step 2: Wire it into the Performance Test table**

Replace the Performance Test table's `<thead>` and row-mapping. Find:

```jsx
                      <thead>
                        <tr>
                          <th className={TH_CLS}>RPM</th>
                          <th className={TH_CLS}>Source V (DC)</th>
                          <th className={TH_CLS}>BEMF Spec</th>
                          <th className={TH_CLS}>BEMF Measured</th>
                          <th className={TH_CLS}>Current Spec</th>
                          <th className={TH_CLS}>Current Measured</th>
                        </tr>
                      </thead>
                      <tbody>
                        {PERFORMANCE_ROWS.map((row, idx) => (
                          <tr key={row.key} className={idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                            <td className={TD_CLS}>{row.rpm}</td>
                            <td className={TD_CLS}>{row.sourceVoltage}</td>
                            <td className={TD_CLS}>{row.bemfSpec}</td>
                            <td className="py-1 px-1 border border-navy-100">
                              <input
                                className={INPUT_CLS}
                                value={form.performance_test[row.key].bemf_measured}
                                onChange={(e) => setChecklistField('performance_test', row.key, 'bemf_measured', e.target.value)}
                              />
                            </td>
                            <td className={TD_CLS}>{row.currentSpec}</td>
                            <td className="py-1 px-1 border border-navy-100">
                              <input
                                className={INPUT_CLS}
                                value={form.performance_test[row.key].current_measured}
                                onChange={(e) => setChecklistField('performance_test', row.key, 'current_measured', e.target.value)}
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
```

Replace with:

```jsx
                      <thead>
                        <tr>
                          <th className={TH_CLS}>RPM</th>
                          <th className={TH_CLS}>Source V (DC)</th>
                          <th className={TH_CLS}>BEMF Specification</th>
                          <th className={TH_CLS}>BEMF Measured</th>
                          <th className={TH_CLS}>Current Specification</th>
                          <th className={TH_CLS}>Current Measured</th>
                        </tr>
                      </thead>
                      <tbody>
                        {PERFORMANCE_ROWS.map((row, idx) => {
                          const bemfFlag = isFieldOutOfTolerance(form, `${row.key}_bemf`, form.performance_test[row.key].bemf_measured);
                          const currentFlag = isFieldOutOfTolerance(form, `${row.key}_current`, form.performance_test[row.key].current_measured);
                          return (
                            <tr key={row.key} className={idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                              <td className={TD_CLS}>{row.rpm}</td>
                              <td className={TD_CLS}>{row.sourceVoltage}</td>
                              <td className="py-1 px-1 border border-navy-100">
                                <AutoNxtSpecCell form={form} setField={setField} id={`${row.key}_bemf`} />
                              </td>
                              <td className="py-1 px-1 border border-navy-100">
                                <input
                                  className={`${INPUT_CLS} ${bemfFlag ? 'border-red-500 bg-red-50' : ''}`}
                                  value={form.performance_test[row.key].bemf_measured}
                                  onChange={(e) => setChecklistField('performance_test', row.key, 'bemf_measured', e.target.value)}
                                />
                              </td>
                              <td className="py-1 px-1 border border-navy-100">
                                <AutoNxtSpecCell form={form} setField={setField} id={`${row.key}_current`} />
                              </td>
                              <td className="py-1 px-1 border border-navy-100">
                                <input
                                  className={`${INPUT_CLS} ${currentFlag ? 'border-red-500 bg-red-50' : ''}`}
                                  value={form.performance_test[row.key].current_measured}
                                  onChange={(e) => setChecklistField('performance_test', row.key, 'current_measured', e.target.value)}
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
```

- [ ] **Step 3: Verify lint passes**

Run: `cd CRM && npx eslint src/components/admin/AutoNXTGeneratorForm.jsx`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/admin/AutoNXTGeneratorForm.jsx
git commit -m "$(cat <<'EOF'
feat: editable spec+tolerance inputs for AutoNXT's Performance Test rows

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: CRM — Physical Parameters: spec cells for 3 rows, free-text Measurement for all 25

**Files:**
- Modify: `CRM/src/components/admin/AutoNXTGeneratorForm.jsx`

- [ ] **Step 1: Replace the Physical Parameters table body**

Find:

```jsx
                <div>
                  <h3 className="text-sm font-semibold text-navy-800 mb-2">C. Physical Parameters</h3>
                  <div className="overflow-x-auto rounded-lg border border-navy-100">
                    <table className="w-full">
                      <thead>
                        <tr>
                          <th className={TH_CLS + ' text-left'}>Parameter</th>
                          <th className={TH_CLS}>Specification</th>
                          <th className={TH_CLS}>Method</th>
                          <th className={TH_CLS}>Measurement</th>
                        </tr>
                      </thead>
                      <tbody>
                        {PHYSICAL_PARAM_ROWS.map((row) => (
                          <tr key={row.key} className="border-t border-navy-100 hover:bg-navy-50/60 transition-colors">
                            <td className="py-2 px-3 text-sm text-gray-700">{row.label}</td>
                            <td className={TD_CLS}>{row.spec}</td>
                            <td className={TD_CLS}>{row.method}</td>
                            <td className="py-1 px-2 border border-navy-100 text-center">
                              <select
                                className={SELECT_CLS}
                                value={form.physical_parameters[row.key].measured}
                                onChange={(e) => setChecklistField('physical_parameters', row.key, 'measured', e.target.value)}
                              >
                                {MEASURED_OPTIONS.map((o) => <option key={o}>{o}</option>)}
                              </select>
                            </td>
                          </tr>
                        ))}
                      </tbody>
```

Replace with:

```jsx
                <div>
                  <h3 className="text-sm font-semibold text-navy-800 mb-2">C. Physical Parameters</h3>
                  {/* Shared by every Measurement cell below (this table only) -- GO/NG/NA
                      stay one-click options, but the input itself accepts any typed value. */}
                  <datalist id="physical-param-measured-options">
                    {MEASURED_OPTIONS.map((o) => <option key={o} value={o} />)}
                  </datalist>
                  <div className="overflow-x-auto rounded-lg border border-navy-100">
                    <table className="w-full">
                      <thead>
                        <tr>
                          <th className={TH_CLS + ' text-left'}>Parameter</th>
                          <th className={TH_CLS}>Specification</th>
                          <th className={TH_CLS}>Method</th>
                          <th className={TH_CLS}>Measurement</th>
                        </tr>
                      </thead>
                      <tbody>
                        {PHYSICAL_PARAM_ROWS.map((row) => {
                          const isToleranceRow = !!SPEC_DEFAULTS[row.key];
                          const measured = form.physical_parameters[row.key].measured;
                          const flagged = isToleranceRow && isFieldOutOfTolerance(form, row.key, measured);
                          return (
                            <tr key={row.key} className="border-t border-navy-100 hover:bg-navy-50/60 transition-colors">
                              <td className="py-2 px-3 text-sm text-gray-700">{row.label}</td>
                              <td className="py-1 px-1 border border-navy-100">
                                {isToleranceRow
                                  ? <AutoNxtSpecCell form={form} setField={setField} id={row.key} />
                                  : <div className={TD_CLS}>{row.spec}</div>}
                              </td>
                              <td className={TD_CLS}>{row.method}</td>
                              <td className="py-1 px-2 border border-navy-100 text-center">
                                <input
                                  list="physical-param-measured-options"
                                  className={`${INPUT_CLS} ${flagged ? 'border-red-500 bg-red-50' : ''}`}
                                  value={measured}
                                  onChange={(e) => setChecklistField('physical_parameters', row.key, 'measured', e.target.value)}
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
```

(`TD_CLS` already includes `text-center` and border/padding, so wrapping the non-tolerance rows' spec text in a `<div className={TD_CLS}>` inside the `<td>` — rather than putting the class on the `<td>` itself as before — keeps every row's `<td>` markup structurally identical, which matters here since the tolerance rows' `<td>` no longer has `TD_CLS` on it directly (`AutoNxtSpecCell` needs left-aligned block layout, not `TD_CLS`'s `text-center`). The closing `</table></div></div>` and Page 1 Remarks block after this table are unchanged.)

- [ ] **Step 2: Verify lint passes**

Run: `cd CRM && npx eslint src/components/admin/AutoNXTGeneratorForm.jsx`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/admin/AutoNXTGeneratorForm.jsx
git commit -m "$(cat <<'EOF'
feat: editable spec+tolerance for 3 Physical Parameters rows; free-text Measurement for all 25

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: CRM — multi-photo upload for the 6 fixed slots

**Files:**
- Modify: `CRM/src/components/admin/AutoNXTGeneratorForm.jsx`

Ports General's own already-built multi-image `ImageUploadCard`/`CropModal`/crop-queue pattern (`CRM/src/components/admin/PDIGeneratorForm.jsx`, read in full while writing this plan) into AutoNXT's local copy, adapted for AutoNXT's simpler "6 fixed slots, no freeform list, no drawing image" shape — a slot is addressed directly by its `slotKey` string, not by a `{type, id}` target object the way General's freeform+drawing+fixed-slot mix needs.

- [ ] **Step 1: Replace the local `ImageUploadCard` with the multi-image version**

Replace the existing `ImageUploadCard` function (lines ~152-211) with:

```js
// Multi-image version, ported from General's own local copy in
// PDIGeneratorForm.jsx (same "duplicated rather than shared" convention).
// `images` is an array of data-URI strings; `onFilesSelected` receives the
// selected files (already clamped to however many slots remain);
// `onRemove(index)` removes one image.
function ImageUploadCard({ label, hint, images = [], onFilesSelected, onRemove, heightCls = 'h-32', maxImages = 10 }) {
  const cameraInputRef = useRef(null);
  const fileInputRef = useRef(null);
  const [dragActive, setDragActive] = useState(false);
  const atLimit = images.length >= maxImages;

  const handleDragOver = (e) => { e.preventDefault(); if (!atLimit) setDragActive(true); };
  const handleDragLeave = (e) => { e.preventDefault(); setDragActive(false); };
  const selectFiles = (fileList) => {
    if (!fileList?.length) return;
    const remaining = maxImages - images.length;
    if (remaining <= 0) return;
    onFilesSelected(Array.from(fileList).slice(0, remaining));
  };
  const handleDrop = (e) => {
    e.preventDefault();
    setDragActive(false);
    if (atLimit) return;
    selectFiles(e.dataTransfer.files);
  };

  return (
    <div>
      {label && <label className="block text-sm font-medium text-navy-800 mb-1">{label}</label>}
      {hint && <p className="text-xs text-gray-400 mb-1.5">{hint}</p>}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`relative rounded-lg border-2 border-dashed bg-gray-50 ${heightCls} overflow-hidden ${dragActive ? 'border-gold-400 bg-gold-400/10' : 'border-gray-300'}`}
      >
        {images.length > 0 ? (
          <div className="h-full w-full overflow-y-auto p-1.5 grid grid-cols-3 gap-1.5">
            {images.map((src, i) => (
              <div key={i} className="relative aspect-square bg-white rounded overflow-hidden border border-gray-200">
                <img src={src} alt={`${label || 'Photo'} ${i + 1}`} className="h-full w-full object-cover" />
                <button
                  type="button"
                  onClick={() => onRemove(i)}
                  className="absolute top-0.5 right-0.5 p-0.5 bg-white/90 rounded-full shadow hover:bg-white text-gray-600 hover:text-red-500"
                  title="Remove image"
                  aria-label={`Remove ${label || 'photo'} ${i + 1}`}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
            {!atLimit && (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="aspect-square rounded border-2 border-dashed border-navy-100 flex items-center justify-center text-gray-400 hover:text-gold-600 hover:border-gold-400"
                title="Add more photos"
                aria-label="Add more photos"
              >
                <ImageIcon size={20} />
              </button>
            )}
          </div>
        ) : (
          <div className="h-full flex flex-col items-center justify-center gap-2 text-gray-400">
            <div className="flex items-center gap-5">
              <button type="button" onClick={() => cameraInputRef.current?.click()} className="flex flex-col items-center gap-1.5 hover:text-gold-600 transition-colors">
                <Camera size={22} />
                <span className="text-xs font-medium">Take Photo</span>
              </button>
              <div className="w-px h-9 bg-gray-200" />
              <button type="button" onClick={() => fileInputRef.current?.click()} className="flex flex-col items-center gap-1.5 hover:text-gold-600 transition-colors">
                <ImageIcon size={22} />
                <span className="text-xs font-medium">Choose Files</span>
              </button>
            </div>
            <span className="text-[11px] text-gray-300">or drag photos here — pick several at once</span>
          </div>
        )}
      </div>
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        className="hidden"
        onChange={(e) => { selectFiles(e.target.files); e.target.value = ''; }}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => { selectFiles(e.target.files); e.target.value = ''; }}
      />
    </div>
  );
}
```

`CropModal` is unchanged — it already crops one image at a time and hands back one `dataUri`, which is exactly what a crop-queue needs; no edit required there.

- [ ] **Step 2: Change `photos` default from per-slot `null` to per-slot `[]`**

In `defaultForm`, change:

```js
  photos: Object.fromEntries(PHOTO_SLOTS.map((s) => [s.key, null])),
```

to:

```js
  photos: Object.fromEntries(PHOTO_SLOTS.map((s) => [s.key, []])),
```

- [ ] **Step 3: Replace the crop-target/handler state with the crop-queue version**

Find (inside the component body):

```js
  const [cropTarget, setCropTarget] = useState(null); // { slotKey, imageSrc }

  const handleFileChosen = useCallback(async (slotKey, file, inputEl) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      notifyError('Please choose an image file.');
      if (inputEl) inputEl.value = '';
      return;
    }
    if (file.size > MAX_RAW_IMAGE_BYTES) {
      notifyError(`Image is too large (max ${(MAX_RAW_IMAGE_BYTES / (1024 * 1024)).toFixed(0)}MB).`);
      if (inputEl) inputEl.value = '';
      return;
    }
    try {
      const dataUri = await fileToDataUri(file);
      setCropTarget({ slotKey, imageSrc: dataUri });
    } catch {
      notifyError('Failed to read image file.');
    } finally {
      if (inputEl) inputEl.value = '';
    }
  }, [notifyError]);

  const applyCroppedImage = useCallback((dataUri) => {
    setCropTarget((current) => {
      if (!current) return current;
      setForm((prev) => ({ ...prev, photos: { ...prev.photos, [current.slotKey]: dataUri } }));
      return null;
    });
  }, []);

  const cancelCrop = useCallback(() => setCropTarget(null), []);
  const clearPhotoImage = useCallback((slotKey) => {
    setForm((prev) => ({ ...prev, photos: { ...prev.photos, [slotKey]: null } }));
  }, []);
```

Replace with:

```js
  const [cropTarget, setCropTarget] = useState(null); // { slotKey, imageSrc }

  const MAX_IMAGES_PER_SLOT = 10;

  const addSlotImage = useCallback((slotKey, dataUri) => {
    setForm((prev) => ({
      ...prev,
      photos: { ...prev.photos, [slotKey]: [...(prev.photos[slotKey] || []), dataUri].slice(0, MAX_IMAGES_PER_SLOT) },
    }));
  }, []);

  const removeSlotImage = useCallback((slotKey, imgIdx) => {
    setForm((prev) => ({
      ...prev,
      photos: { ...prev.photos, [slotKey]: (prev.photos[slotKey] || []).filter((_, i) => i !== imgIdx) },
    }));
  }, []);

  const handleFileChosen = useCallback(async (slotKey, file, inputEl) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      notifyError('Please choose an image file.');
      if (inputEl) inputEl.value = '';
      return;
    }
    if (file.size > MAX_RAW_IMAGE_BYTES) {
      notifyError(`Image is too large (max ${(MAX_RAW_IMAGE_BYTES / (1024 * 1024)).toFixed(0)}MB).`);
      if (inputEl) inputEl.value = '';
      return;
    }
    try {
      const dataUri = await fileToDataUri(file);
      setCropTarget({ slotKey, imageSrc: dataUri });
    } catch {
      notifyError('Failed to read image file.');
    } finally {
      if (inputEl) inputEl.value = '';
    }
  }, [notifyError]);

  // Queued files from a multi-file selection still waiting to be cropped, plus
  // the slot they belong to -- refs, not useState, for the same re-entrancy
  // reason General's own copy of this uses refs (see PDIGeneratorForm.jsx):
  // a ref write is synchronous, so there's no window between the last queued
  // file's dequeue and the async FileReader resolving where a concurrent
  // selection could slip through.
  const cropQueueFilesRef = useRef([]);
  const cropQueueSlotRef = useRef(null);

  const handleFilesChosen = useCallback((slotKey, fileList) => {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    if (cropQueueFilesRef.current.length > 0 || cropQueueSlotRef.current) {
      notifyError('Finish cropping the current batch of photos before adding more.');
      return;
    }
    const [first, ...rest] = files;
    cropQueueFilesRef.current = rest;
    cropQueueSlotRef.current = slotKey;
    handleFileChosen(slotKey, first);
  }, [handleFileChosen, notifyError]);

  const applyCroppedImage = useCallback((dataUri) => {
    setCropTarget((current) => {
      if (!current) return current;
      addSlotImage(current.slotKey, dataUri);
      return null;
    });
    if (cropQueueFilesRef.current.length > 0) {
      const [next, ...rest] = cropQueueFilesRef.current;
      cropQueueFilesRef.current = rest;
      handleFileChosen(cropQueueSlotRef.current, next);
    } else {
      cropQueueSlotRef.current = null;
    }
  }, [addSlotImage, handleFileChosen]);

  const cancelCrop = useCallback(() => {
    const remaining = cropQueueFilesRef.current.length;
    cropQueueFilesRef.current = [];
    cropQueueSlotRef.current = null;
    setCropTarget(null);
    if (remaining > 0) {
      notifyError(`Cancelled — ${remaining} more photo${remaining === 1 ? '' : 's'} in this batch were not added.`);
    }
  }, [notifyError]);
```

(`clearPhotoImage` is removed entirely — `removeSlotImage` replaces it, called per-index from the Photos tab below.)

- [ ] **Step 4: Update the Photos tab JSX**

Find:

```jsx
            {activeTab === 'photos' && (
              <div className="space-y-5">
                <p className="text-xs text-gray-400">Tap a slot to take a photo or choose one — you&rsquo;ll crop it next.</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {PHOTO_SLOTS.map((slot) => (
                    <ImageUploadCard
                      key={slot.key}
                      label={slot.label}
                      value={form.photos[slot.key]}
                      onSelect={(file, el) => handleFileChosen(slot.key, file, el)}
                      onClear={() => clearPhotoImage(slot.key)}
                    />
                  ))}
                </div>
              </div>
            )}
```

Replace with:

```jsx
            {activeTab === 'photos' && (
              <div className="space-y-5">
                <p className="text-xs text-gray-400">Take or choose several photos per slot — you&rsquo;ll crop each one before it&rsquo;s added.</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {PHOTO_SLOTS.map((slot) => (
                    <ImageUploadCard
                      key={slot.key}
                      label={slot.label}
                      images={form.photos[slot.key] || []}
                      onFilesSelected={(fileList) => handleFilesChosen(slot.key, fileList)}
                      onRemove={(idx) => removeSlotImage(slot.key, idx)}
                    />
                  ))}
                </div>
              </div>
            )}
```

- [ ] **Step 5: Update the resume-report photo-loading fallback**

Find (in the `useEffect` that loads a report to resume):

```js
        setForm({
          ...base,
          ...(report.data || {}),
          photos: report.photos && typeof report.photos === 'object' && !Array.isArray(report.photos)
            ? { ...base.photos, ...report.photos }
            : base.photos,
        });
```

This spreads `report.photos` (whatever shape it's actually stored in — either the legacy `{slotKey: dataUri|null}` shape for an old report, or the new `{slotKey: [dataUri,...]}` shape for one saved after this change) directly over `base.photos`. `ImageUploadCard` now expects `images` to be an array; a legacy report's slot value is a bare string (or `null`), not an array. Change this block to normalize each slot's value to an array as it loads:

```js
        const loadedPhotos = report.photos && typeof report.photos === 'object' && !Array.isArray(report.photos)
          ? report.photos
          : {};
        setForm({
          ...base,
          ...(report.data || {}),
          photos: Object.fromEntries(
            PHOTO_SLOTS.map((s) => {
              const raw = loadedPhotos[s.key];
              return [s.key, Array.isArray(raw) ? raw : (raw ? [raw] : [])];
            })
          ),
        });
```

- [ ] **Step 6: Verify lint passes**

Run: `cd CRM && npx eslint src/components/admin/AutoNXTGeneratorForm.jsx`
Expected: no new errors. `clearPhotoImage` and the old single-value `ImageUploadCard` usage are gone, so there should be no unused-variable warnings left over from this change.

- [ ] **Step 7: Commit**

```bash
git add src/components/admin/AutoNXTGeneratorForm.jsx
git commit -m "$(cat <<'EOF'
feat: multi-photo upload for AutoNXT's 6 fixed photo slots

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Live verification (controller-personal, not a subagent)

**Files:** none — verification only, using the gstack skill's browse tool against a local dev server pointed at the real production RDS (same `FRONTEND_URL` CORS-override pattern used in every prior PDI round this session).

- [ ] **Step 1: Start CRM_BACKEND locally against production RDS**

Confirm the existing `.env`/override pattern from prior rounds this session still applies (dev backend hitting the same production database as always — use clearly named throwaway data, e.g. customer name `AUTONXT-PLAN-VERIFY`, and delete it afterward). Start the backend dev server.

- [ ] **Step 2: Start CRM locally with `FRONTEND_URL` pointed at it, run the backend Jest suite one more time serially**

Run: `cd CRM_BACKEND && npx jest tests/pdi_ --runInBand`
Expected: PASS, with the same pre-existing single unrelated failure as the session's established baseline (a photo-size check unrelated to this work) — no new failures introduced across Tasks 1-4.

- [ ] **Step 3: Browse to the AutoNXT form and verify, using the gstack skill's browse tool**

Open a new AutoNXT PDI report and check, in order:
1. **Tolerance flag, Performance Test:** enter a BEMF Measured value for the 500 RPM row outside `[76.63, 81.37]` (e.g. `85`) — the Measured input turns red. Enter `80` — the red clears.
2. **Tolerance flag, Physical Parameters:** enter a Motor Total Length Measurement outside `[466.5, 468.5]` (e.g. `470`) — turns red; `467.8` — clears. Confirm the Measurement cell is a free-text input, not a dropdown.
3. **Locating Dia. bilateral case:** confirm its default Specification text reads `Ø180.0 (-0.01 TO -0.05)`, and that entering a Measurement of `179.90` (outside `[179.95, 179.99]`) flags red while `179.97` does not.
4. **Free-text Measurement, non-tolerance row:** on a Go/NG row (e.g. "Shield Plate check"), confirm GO/NG/NA still appear as quick-pick suggestions (typing shows the datalist) but any other text can also be typed and saved.
5. **Unedited report renders unchanged:** save this report without touching any Specification field, finalize it, and open the generated PDF — confirm the Specification/Specified column text for every tolerance-eligible row matches today's literal text exactly (per the plan's reference table), byte-for-byte (e.g. `79.0±3%`, `467.5±1.0`, `Ø180.0 (-0.01 TO -0.05)`).
6. **Edited Specification text prints exactly as typed:** on a fresh report, change one Specification field's text to something arbitrary (e.g. `470.0 (special run)`), finalize, and confirm the PDF prints exactly that string, not a value re-derived from the nominal/tolerance inputs.
7. **Self-sizing / clipping fix:** confirm the Physical Parameters table's long Specification strings (e.g. "PCD Ø63.0, 06Nos M10, Depth 25.0, Go/NG") print in full in the PDF, not clipped to "Spe…" or any other truncation.
8. **Multi-photo:** in the Photos tab, add 3 photos to one slot (e.g. "Overall Motor Photo") in a single multi-select, confirm all 3 thumbnails appear with individual remove buttons, remove one, confirm 2 remain, finalize, and confirm the generated PDF shows 2 separate labeled photo cells for that slot ("Overall Motor Photo (1)", "(2)").
9. **General Check unaffected:** confirm General Check's 7 rows are still a plain GO/NG/NA dropdown (not the free-text combo), and their Specification text is unchanged.

- [ ] **Step 4: Fix anything found, with its own commit**

If any check in Step 3 fails, fix it directly (not via a subagent, per this task's own instruction) and commit the fix with a message describing what was wrong and the fix, ending with the same `Co-Authored-By` trailer used throughout this plan.

- [ ] **Step 5: Clean up the throwaway report**

Delete the `AUTONXT-PLAN-VERIFY`-named report(s) created during verification via the PDI Records list or a direct API call, confirming no test data is left in production.

- [ ] **Step 6: Confirm nothing is pushed**

Run `git status` and `git log --oneline -10` in both `CRM_BACKEND` and `CRM` to confirm all of Tasks 1-8's commits are local only (matching this plan's instruction not to push). Report the final commit list to the user and wait for them to ask before pushing anything.
