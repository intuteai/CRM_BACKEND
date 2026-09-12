# PDI General Template Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add real tolerance validation and editable spec values to the General PDI template's Mechanical/Electrical check tables, restructure Electrical to one row per motor with flexible Forward/Reverse entry, add a "Duplicate as New PDI" report action, and support multi-photo upload across PDI photo sections.

**Architecture:** Three independent tracks. Track A touches only the General template's dedicated fill-out form (`PDIGeneratorForm.jsx`), its hand-coded template definition (`general.js`), and the shared PDF renderer (`renderer.js`) — no other template is affected. Track B adds one new backend endpoint and one new frontend action, usable by any template. Track C touches both photo-upload code paths that exist in this codebase (the shared one used by the guided-creation-authored templates, and General's own separate local copy) plus the PDF renderer's photo layout.

**Tech Stack:** React (CRM), Express/PostgreSQL (CRM_BACKEND), PDFKit (renderer.js).

**Committing:** Per explicit user instruction for this round, **do not run any `git add`/`git commit` after individual tasks.** Every task below intentionally has no "Commit" step. Work stays uncommitted in the working tree across all tasks. A single commit happens only in Task 11, after controller-personal live verification confirms everything works.

---

## Before you start

1. **Ground truth over the spec's assumptions.** The design spec (`docs/superpowers/specs/2026-09-11-pdi-general-template-enhancements-design.md`) was written before the plan author re-read `PDIGeneratorForm.jsx` in full. Two corrections already folded into this plan that are NOT obvious from the spec alone: (a) the Mechanical table's spec-row inputs already exist as plain `<input>` text fields today (`form.spec_motor_length` etc., lines ~820-844) — you're extending them, not building them from scratch; (b) **Locating Dia.'s per-row cell is currently a GO/NG `<select>` (line ~898)**, which is a real bug — it should be a numeric `<input>`, matching what its own spec-row placeholder already implies ("e.g. 50.0 mm"). Key Dim.'s per-row cell is ALSO a GO/NG `<select>` (line ~893) but stays that way — don't touch it.
2. **Electrical table has no spec row today.** Unlike Mechanical, `current_standard` and `rpm_specified` are today per-row free-text inputs (repeated on every row, not a true single spec row). Task 3 adds a real spec row to Electrical, matching Mechanical's existing pattern.
3. **This is a whole-form-save model, not autosave.** `PDIGeneratorForm.jsx` has an explicit "Save" button that PATCHes the entire `data`+`photos` object at once (see `handleSave`, line ~479) — there is no per-keystroke backend round-trip like the newer `GenericPdiGeneratorForm.jsx`. Tolerance flagging must therefore be computed **client-side in React** as the user types (recomputed on render from current form state), not via a backend validation call per keystroke. The backend only needs the tolerance-check logic for the PDF renderer (server-side, at Finalize time).
4. **Two separate photo-upload implementations exist.** `GenericPdiSections.jsx` imports the shared `ImageUploadCard` from `CRM/src/components/shared/PdiImageUpload.jsx` (used by every template that goes through the generic dialect engine). `PDIGeneratorForm.jsx` has its **own locally-defined** `ImageUploadCard` function (lines ~172-234) — a near-identical but separate copy, used only by General. Track C must update both, independently.
5. **General's dedicated form vs. the generic dialect engine.** `general.js` is a hand-coded JS template (not JSON-serializable — it embeds real functions like `checksColumns()`, `fixedRows: () => ELEC_CHECKS`). It is rendered by `renderer.js` for PDF output, and filled out via the entirely separate, dedicated `PDIGeneratorForm.jsx` component (routed at `/pdi-generator/general`) — NOT via `GenericPdiSections.jsx`/`PdiTemplateFillOutForm`, which only handles DB-authored templates. Track A never touches `GenericPdiSections.jsx` or the guided-creation authoring UI.

---

## Task 1: Mechanical table — fix Locating Dia., add tolerance to four numeric fields

**Files:**
- Modify: `CRM/src/components/admin/PDIGeneratorForm.jsx`

### Step 1: Add a tolerance-check helper near the top of the file

Add this after the `todayIST` function (around line 122), before `initGeneralChecks`:

```javascript
// Returns { outOfRange: boolean } for a single numeric reading against a
// nominal + tolerance. Tolerance mode is '±' (absolute) or '%' (percent of
// nominal). Any missing/non-numeric input is treated as in-range (nothing to
// flag) — flagging only fires once there's a real number to compare.
function checkTolerance(measuredStr, nominalStr, toleranceMode, toleranceAmountStr) {
  const measured = parseFloat(measuredStr);
  const nominal = parseFloat(nominalStr);
  const toleranceAmount = parseFloat(toleranceAmountStr);
  if (!Number.isFinite(measured) || !Number.isFinite(nominal) || !Number.isFinite(toleranceAmount)) {
    return { outOfRange: false };
  }
  const delta = toleranceMode === '%' ? Math.abs(nominal) * (toleranceAmount / 100) : toleranceAmount;
  const outOfRange = measured < nominal - delta || measured > nominal + delta;
  return { outOfRange };
}
```

### Step 2: Add tolerance-mode/amount fields to `defaultForm`

Replace lines 141-147 (the "Mechanical table's Specification row" block):

```javascript
    // Mechanical table's "Specification" row — manual entry, varies by product.
    // Motor Length, Shaft O/P D/Length, Mounting PCD, and Locating Dia. are real
    // numeric specs and get a tolerance mode + amount alongside the nominal.
    // MTG stays a free-text compound description (two sub-specs in one string,
    // e.g. "1.M6 / 2.Ø8.0") — informational only, no tolerance math. Key Dim.
    // stays a GO/NG pass/fail check, also no tolerance math.
    spec_motor_length: '',
    spec_motor_length_tol_mode: '±',
    spec_motor_length_tol: '',
    spec_shaft_length: '',
    spec_shaft_length_tol_mode: '±',
    spec_shaft_length_tol: '',
    spec_mounting_pcd: '',
    spec_mounting_pcd_tol_mode: '±',
    spec_mounting_pcd_tol: '',
    spec_mtg: '',
    spec_key_dim: 'Go/NG',
    spec_locating_dia: '',
    spec_locating_dia_tol_mode: '±',
    spec_locating_dia_tol: '',
```

Note: `spec_mounting_pcd` and `spec_locating_dia` no longer default to `'153'`/`'50.0 mm'` — per the design spec, a template reused across product lines was never correctly served by one silently-reused default, so every PDI now requires these to be typed in.

### Step 3: Change `locating_dia_result` in `makeRow` from a GO/NG value to a blank numeric string

In `makeRow` (line ~96), change:

```javascript
  key_dim_result: 'GO',
  locating_dia_result: 'GO',
```

to:

```javascript
  key_dim_result: 'GO',
  locating_dia_result: '',
```

### Step 4: Extend the Mechanical spec-row inputs (around lines 816-844) with tolerance mode + amount

Replace the six `<div>` blocks for the spec row (Motor Length through Locating Dia., lines ~820-843) with:

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

### Step 5: Replace the per-row Motor Length / Shaft Length / Mounting PCD cells with flagged numeric inputs, and Locating Dia.'s `<select>` with a flagged numeric input

Replace lines ~880-900 (from the Motor Length `<td>` through the Locating Dia. `<td>`) with:

```jsx
                          <td className="py-1 px-1 border border-gray-100">
                            <input
                              className={`${INPUT_CLS} ${checkTolerance(row.motor_length, form.spec_motor_length, form.spec_motor_length_tol_mode, form.spec_motor_length_tol).outOfRange ? 'border-red-500 bg-red-50' : ''}`}
                              value={row.motor_length} onChange={(e) => setRowField(idx, 'motor_length', e.target.value)} placeholder="mm"
                            />
                          </td>
                          <td className="py-1 px-1 border border-gray-100">
                            <input
                              className={`${INPUT_CLS} ${checkTolerance(row.shaft_length, form.spec_shaft_length, form.spec_shaft_length_tol_mode, form.spec_shaft_length_tol).outOfRange ? 'border-red-500 bg-red-50' : ''}`}
                              value={row.shaft_length} onChange={(e) => setRowField(idx, 'shaft_length', e.target.value)} placeholder="mm"
                            />
                          </td>
                          <td className="py-1 px-1 border border-gray-100">
                            <input
                              className={`${INPUT_CLS} ${checkTolerance(row.mounting_pcd, form.spec_mounting_pcd, form.spec_mounting_pcd_tol_mode, form.spec_mounting_pcd_tol).outOfRange ? 'border-red-500 bg-red-50' : ''}`}
                              value={row.mounting_pcd} onChange={(e) => setRowField(idx, 'mounting_pcd', e.target.value)} placeholder="153"
                            />
                          </td>
                          <td className="py-1 px-1 border border-gray-100">
                            <input className={INPUT_CLS} value={row.mtg} onChange={(e) => setRowField(idx, 'mtg', e.target.value)} placeholder="4*M8" />
                          </td>
                          <td className="py-1 px-2 border border-gray-100 text-center">
                            <select className={SELECT_CLS} value={row.key_dim_result} onChange={(e) => setRowField(idx, 'key_dim_result', e.target.value)}>
                              {['GO', 'NG'].map((o) => <option key={o}>{o}</option>)}
                            </select>
                          </td>
                          <td className="py-1 px-1 border border-gray-100">
                            <input
                              className={`${INPUT_CLS} ${checkTolerance(row.locating_dia_result, form.spec_locating_dia, form.spec_locating_dia_tol_mode, form.spec_locating_dia_tol).outOfRange ? 'border-red-500 bg-red-50' : ''}`}
                              value={row.locating_dia_result} onChange={(e) => setRowField(idx, 'locating_dia_result', e.target.value)} placeholder="mm"
                            />
                          </td>
```

### Step 6: Update the table header to drop the "(Go/NG)" label from Locating Dia.

Around line 869, change:

```jsx
                        <th className={TH_CLS}>Locating Dia (Go/NG)</th>
```

to:

```jsx
                        <th className={TH_CLS}>Locating Dia</th>
```

Leave `<th className={TH_CLS}>Key Dim (Go/NG)</th>` (line 868) unchanged.

### Step 7: Verify with lint and build

```bash
cd CRM && npx eslint src/components/admin/PDIGeneratorForm.jsx
npm run build
```

Expected: no errors. Warnings pre-existing in this file are fine.

---

## Task 2: Electrical table — one row per motor, real spec row, flexible F/R entry

**Files:**
- Modify: `CRM/src/components/admin/PDIGeneratorForm.jsx`

### Step 1: Add an F/R parser helper next to `checkTolerance` (from Task 1, Step 1)

```javascript
// Parses a Current/RPM Measured cell's raw text into { forward, reverse }.
// "2/4" -> forward=2, reverse=4. A bare number with no "/" is stored as
// forward by convention (documented here, not configurable) — a
// single-direction test defaults to Forward unless the column is the R-only
// variant, which this template doesn't currently have.
function parseForwardReverse(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return { forward: '', reverse: '' };
  if (trimmed.includes('/')) {
    const [f, r] = trimmed.split('/');
    return { forward: (f || '').trim(), reverse: (r || '').trim() };
  }
  return { forward: trimmed, reverse: '' };
}

// Inverse of parseForwardReverse — how a { forward, reverse } pair displays
// back in the single combined input.
function formatForwardReverse(forward, reverse) {
  if (forward && reverse) return `${forward}/${reverse}`;
  return forward || reverse || '';
}
```

### Step 2: Replace `makeRow`'s Electrical fields (lines 96-106)

Replace:

```javascript
const makeRow = (sno) => ({
  sno,
  motor_sr_no: '',
  // Electrical — a motor is tested running in one direction at a time
  voltage: '',
  direction: 'F',
  current_standard: '',
  current_measured: '',
  rpm_specified: '',
  rpm_measured: '',
  electrical_remarks: '',
```

with:

```javascript
const makeRow = (sno) => ({
  sno,
  motor_sr_no: '',
  // Electrical — one row per motor. current_measured/rpm_measured hold raw
  // text like "2/4" (forward/reverse), "2" (one direction), parsed on the fly
  // via parseForwardReverse for display/validation and re-serialized the same
  // way on save — no separate forward/reverse React state, the raw string IS
  // the source of truth, matching how every other free-text cell works here.
  voltage: '',
  current_measured: '',
  rpm_measured: '',
  electrical_remarks: '',
```

### Step 3: Add Electrical spec fields to `defaultForm`

In `defaultForm` (around line 128), add after `product_specifications: '',`:

```javascript
    // Electrical table's spec row — one nominal + tolerance for Current and
    // RPM, shared across every motor row in this PDI (not re-typed per row).
    spec_current_standard: '',
    spec_current_tol_mode: '±',
    spec_current_tol: '',
    spec_rpm_specified: '',
    spec_rpm_tol_mode: '±',
    spec_rpm_tol: '',
```

### Step 4: Replace the Electrical table header (lines ~710-720)

```jsx
                      <tr>
                        <th className={TH_CLS}>S. No</th>
                        <th className={TH_CLS}>Motor Sr. No</th>
                        <th className={TH_CLS}>Voltage</th>
                        <th className={TH_CLS}>Current Measured F/R</th>
                        <th className={TH_CLS}>RPM Measured F/R</th>
                        <th className={TH_CLS}>Remarks</th>
                      </tr>
```

### Step 5: Add a spec-row entry above the motor rows

Insert this immediately before the `<tbody>` opening's `{form.rows.map(...)}` (i.e. right after `<tbody>` at line ~722), as the first row rendered inside `<tbody>`:

```jsx
                      <tr className="bg-amber-50">
                        <td className={TD_CLS} colSpan={3}>
                          <span className="font-semibold text-gray-700 text-xs">Specification</span>
                        </td>
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
                        <td className="py-1 px-1 border border-gray-100" />
                      </tr>
```

### Step 6: Replace the per-row cells (the `direction` select through `rpm_measured` input, lines ~732-748) with the restructured F/R cells

```jsx
                          <td className="py-1 px-1 border border-gray-100">
                            <input className={INPUT_CLS} value={row.voltage} onChange={(e) => setRowField(idx, 'voltage', e.target.value)} placeholder="V" />
                          </td>
                          <td className="py-1 px-1 border border-gray-100">
                            {(() => {
                              const { forward, reverse } = parseForwardReverse(row.current_measured);
                              const fFlag = checkTolerance(forward, form.spec_current_standard, form.spec_current_tol_mode, form.spec_current_tol).outOfRange;
                              const rFlag = checkTolerance(reverse, form.spec_current_standard, form.spec_current_tol_mode, form.spec_current_tol).outOfRange;
                              return (
                                <input
                                  className={`${INPUT_CLS} ${(fFlag || rFlag) ? 'border-red-500 bg-red-50' : ''}`}
                                  value={row.current_measured}
                                  onChange={(e) => setRowField(idx, 'current_measured', e.target.value)}
                                  placeholder="e.g. 2/4"
                                />
                              );
                            })()}
                          </td>
                          <td className="py-1 px-1 border border-gray-100">
                            {(() => {
                              const { forward, reverse } = parseForwardReverse(row.rpm_measured);
                              const fFlag = checkTolerance(forward, form.spec_rpm_specified, form.spec_rpm_tol_mode, form.spec_rpm_tol).outOfRange;
                              const rFlag = checkTolerance(reverse, form.spec_rpm_specified, form.spec_rpm_tol_mode, form.spec_rpm_tol).outOfRange;
                              return (
                                <input
                                  className={`${INPUT_CLS} ${(fFlag || rFlag) ? 'border-red-500 bg-red-50' : ''}`}
                                  value={row.rpm_measured}
                                  onChange={(e) => setRowField(idx, 'rpm_measured', e.target.value)}
                                  placeholder="e.g. 2950/2960"
                                />
                              );
                            })()}
                          </td>
```

(The Remarks `<td>` immediately after stays unchanged.)

Note `formatForwardReverse` (Step 1) isn't called anywhere in the UI — it's exported for Task 4/5 (renderer.js and backend parsing) to reuse the identical formatting convention. That's fine; it's used cross-file, not dead code.

### Step 7: Verify with lint and build

```bash
cd CRM && npx eslint src/components/admin/PDIGeneratorForm.jsx
npm run build
```

Expected: no errors.

---

## Task 3: `general.js` — add Electrical spec row, drop stale Mechanical defaults

**Files:**
- Modify: `CRM_BACKEND/models/operations/pdi/templates/general.js`

### Step 1: Read the current `ECOLS`, `checksColumns`, `DEFAULT_SPEC_VALS`, `buildSpecVals`, and `generalTemplate.pages[0]` electrical table section to confirm line numbers before editing (they may have shifted slightly from what's quoted below if Tasks 1-2 already ran — they haven't touched this file, so line numbers should match).

### Step 2: Replace `ECOLS` (lines 9-19)

```javascript
const ECOLS = [
  { key: 'sno',                label: 'S. No',                    w: 22, align: 'center' },
  { key: 'motor_sr_no',        label: 'Motor Sr. No',             w: 56, align: 'center' },
  { key: 'voltage',            label: 'Voltage',                  w: 32, align: 'center' },
  { key: 'current_measured',   label: 'Current\nMeasured F/R',    w: 50, align: 'center' },
  { key: 'rpm_measured',       label: 'RPM\nMeasured F/R',        w: 50, align: 'center' },
  { key: 'electrical_remarks', label: 'Remarks',                  align: 'left' },
];
```

### Step 3: Add an electrical spec-row builder, next to `buildSpecVals` (after line 75, before `activeRowsFilter`)

```javascript
// Electrical table's spec row — one Current Standard + RPM Specified nominal
// shared by every motor row in this PDI, mirroring the Mechanical table's own
// spec-row pattern (buildSpecVals above). No hardcoded fallback — these are
// required per-PDI entries, same reasoning as the mechanical spec fields.
function buildElecSpecVals(data) {
  return {
    current_measured: data.spec_current_standard || '',
    rpm_measured: data.spec_rpm_specified || '',
  };
}
```

### Step 4: Drop the stale Mechanical defaults in `DEFAULT_SPEC_VALS` and `buildSpecVals` (lines 61-75)

Replace:

```javascript
const DEFAULT_SPEC_VALS = {
  motor_length: '', shaft_length: '', mounting_pcd: '153',
  mtg: '1.M6 / 2.Ø8.0', key_dim_result: 'Go/NG', locating_dia_result: '50.0 mm',
};

function buildSpecVals(data) {
  return {
    motor_length:        data.spec_motor_length || DEFAULT_SPEC_VALS.motor_length,
    shaft_length:        data.spec_shaft_length || DEFAULT_SPEC_VALS.shaft_length,
    mounting_pcd:        data.spec_mounting_pcd || DEFAULT_SPEC_VALS.mounting_pcd,
    mtg:                 data.spec_mtg          || DEFAULT_SPEC_VALS.mtg,
    key_dim_result:      data.spec_key_dim      || DEFAULT_SPEC_VALS.key_dim_result,
    locating_dia_result: data.spec_locating_dia || DEFAULT_SPEC_VALS.locating_dia_result,
  };
}
```

with:

```javascript
// No hardcoded fallbacks for the four numeric fields (motor_length,
// shaft_length, mounting_pcd, locating_dia_result) — a template reused across
// many product lines was never correctly served by one silently-reused
// default, so these are required per-PDI entries now. MTG and Key Dim. keep
// their informational/GO-NG defaults since they're not numeric specs.
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

### Step 5: Add the spec row to the Electrical table section, and update its `footerHeight`

In `generalTemplate.pages[0].sections`, the electrical table section (lines ~103-108) currently reads:

```javascript
        {
          type: 'table', gap: 6,
          mode: 'repeatable', dataKey: 'rows', filterRow: activeRowsFilter,
          columns: ECOLS, headerHeight: 28, rowHeight: 14,
          footerHeight: () => GCH * (1 + ELEC_CHECKS.length) + 6 + REM_H + 6 + SIG_H + 8,
        },
```

Replace with:

```javascript
        {
          type: 'table', gap: 6,
          mode: 'repeatable', dataKey: 'rows', filterRow: activeRowsFilter,
          columns: ECOLS, headerHeight: 28, rowHeight: 14,
          specRow: { fill: '#fffde7', firstColLabel: 'Specification', build: buildElecSpecVals },
          footerHeight: () => GCH * (1 + ELEC_CHECKS.length) + 6 + REM_H + 6 + SIG_H + 8,
        },
```

(`footerHeight` is unaffected by the spec row — `drawTableSection` in `renderer.js` draws the spec row inline before the paginated rows, it doesn't reserve extra footer space; this matches exactly how the Mechanical table's existing `specRow` already works.)

### Step 6: Verify

```bash
cd CRM_BACKEND && node -e "require('./models/operations/pdi/templates/general.js'); console.log('OK — general.js loads without error')"
```

Expected output: `OK — general.js loads without error`

---

## Task 4: `renderer.js` — tolerance-flag out-of-range cells and F/R display in the PDF

**Files:**
- Modify: `CRM_BACKEND/models/operations/pdi/renderer.js`

### Step 1: Add the same tolerance-check + F/R helpers used in Task 1/2, as a small local module

Create `CRM_BACKEND/models/operations/pdi/tolerance.js`:

```javascript
'use strict';

// Mirrors CRM/src/components/admin/PDIGeneratorForm.jsx's checkTolerance —
// kept as a tiny duplicate rather than a shared package since the frontend
// and backend don't share a build pipeline. Any change here must be mirrored
// there, and vice versa (see Task 1 Step 1 / Task 2 Step 1).
function checkTolerance(measuredStr, nominalStr, toleranceMode, toleranceAmountStr) {
  const measured = parseFloat(measuredStr);
  const nominal = parseFloat(nominalStr);
  const toleranceAmount = parseFloat(toleranceAmountStr);
  if (!Number.isFinite(measured) || !Number.isFinite(nominal) || !Number.isFinite(toleranceAmount)) {
    return { outOfRange: false };
  }
  const delta = toleranceMode === '%' ? Math.abs(nominal) * (toleranceAmount / 100) : toleranceAmount;
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

### Step 2: Give `drawTableRow` a way to flag a cell

Replace `drawTableRow` (lines 153-163) with:

```javascript
function drawTableRow(doc, cols, row, sectionData, data, rowHeight, y) {
  const { F } = getFonts();
  let x = M;
  cols.forEach(c => {
    const val = resolveCellValue(c, row, sectionData, data);
    const flagged = c.isOutOfTolerance ? c.isOutOfTolerance(row, data) : false;
    box(doc, x, y, c.w, rowHeight, { stroke: '#000', sw: 0.3, fill: flagged ? '#fee2e2' : undefined });
    t(doc, val, x + 2, y + 3, c.w - 4, { font: F, size: 7.5, align: c.align, color: flagged ? '#b91c1c' : '#000' });
    x += c.w;
  });
  return y + rowHeight;
}
```

`resolveCellValue`/`box`/`t` are unchanged — `box`'s existing `{ fill }` option already supports an optional fill color (see `primitives.js` line 122), so passing `undefined` when not flagged preserves today's unfilled-cell appearance exactly.

### Step 3: Wire `isOutOfTolerance` into `general.js`'s column definitions

Back in `CRM_BACKEND/models/operations/pdi/templates/general.js`, add at the top:

```javascript
const { checkTolerance, parseForwardReverse } = require('../tolerance');
```

Then update `MCOLS` (lines 21-31) to add `isOutOfTolerance` to the four numeric fields:

```javascript
const MCOLS = [
  { key: 'sno',                 label: 'S. No',               w: 26, align: 'center' },
  { key: 'motor_sr_no',         label: 'Motor\nSr. No',       w: 52, align: 'center' },
  { key: 'motor_length',        label: 'Motor\nLength',       w: 44, align: 'center',
    isOutOfTolerance: (row, data) => checkTolerance(row.motor_length, data.spec_motor_length, data.spec_motor_length_tol_mode, data.spec_motor_length_tol).outOfRange },
  { key: 'shaft_length',        label: 'Shaft O/P\nD/Length', w: 50, align: 'center',
    isOutOfTolerance: (row, data) => checkTolerance(row.shaft_length, data.spec_shaft_length, data.spec_shaft_length_tol_mode, data.spec_shaft_length_tol).outOfRange },
  { key: 'mounting_pcd',        label: 'PCD',                 w: 40, align: 'center', group: 'Mounting Holes',
    isOutOfTolerance: (row, data) => checkTolerance(row.mounting_pcd, data.spec_mounting_pcd, data.spec_mounting_pcd_tol_mode, data.spec_mounting_pcd_tol).outOfRange },
  { key: 'mtg',                 label: 'MTG',                 w: 50, align: 'center', group: 'Mounting Holes' },
  { key: 'key_dim_result',      label: 'Key\nDim.',           w: 34, align: 'center' },
  { key: 'locating_dia_result', label: 'Locating\nDia.',      w: 38, align: 'center',
    isOutOfTolerance: (row, data) => checkTolerance(row.locating_dia_result, data.spec_locating_dia, data.spec_locating_dia_tol_mode, data.spec_locating_dia_tol).outOfRange },
  { key: 'mechanical_remarks',  label: 'Remarks',             align: 'left' },
];
```

And update `ECOLS` (from Task 3, Step 2) to add `isOutOfTolerance` on the two F/R measured columns:

```javascript
const ECOLS = [
  { key: 'sno',                label: 'S. No',                    w: 22, align: 'center' },
  { key: 'motor_sr_no',        label: 'Motor Sr. No',             w: 56, align: 'center' },
  { key: 'voltage',            label: 'Voltage',                  w: 32, align: 'center' },
  { key: 'current_measured',   label: 'Current\nMeasured F/R',    w: 50, align: 'center',
    isOutOfTolerance: (row, data) => {
      const { forward, reverse } = parseForwardReverse(row.current_measured);
      return checkTolerance(forward, data.spec_current_standard, data.spec_current_tol_mode, data.spec_current_tol).outOfRange
          || checkTolerance(reverse, data.spec_current_standard, data.spec_current_tol_mode, data.spec_current_tol).outOfRange;
    } },
  { key: 'rpm_measured',       label: 'RPM\nMeasured F/R',        w: 50, align: 'center',
    isOutOfTolerance: (row, data) => {
      const { forward, reverse } = parseForwardReverse(row.rpm_measured);
      return checkTolerance(forward, data.spec_rpm_specified, data.spec_rpm_tol_mode, data.spec_rpm_tol).outOfRange
          || checkTolerance(reverse, data.spec_rpm_specified, data.spec_rpm_tol_mode, data.spec_rpm_tol).outOfRange;
    } },
  { key: 'electrical_remarks', label: 'Remarks',                  align: 'left' },
];
```

### Step 4: Verify

```bash
cd CRM_BACKEND && node -e "require('./models/operations/pdi/templates/general.js'); console.log('OK')"
node -e "const {checkTolerance} = require('./models/operations/pdi/tolerance'); console.log(JSON.stringify(checkTolerance('55','50','±','2'))); console.log(JSON.stringify(checkTolerance('51','50','±','2')))"
```

Expected: `OK`, then `{"outOfRange":true}`, then `{"outOfRange":false}`.

---

## Task 5: Backend — Duplicate PDI report endpoint

**Files:**
- Modify: `CRM_BACKEND/models/operations/pdiReports.js`
- Modify: `CRM_BACKEND/controllers/operations/pdiReports.controller.js`
- Modify: `CRM_BACKEND/routes/operations/pdiReports.js`

### Step 1: Add `duplicateReport` to `PdiReports` model

In `CRM_BACKEND/models/operations/pdiReports.js`, add a new static method after `createReport` (after line 82):

```javascript
  // "Duplicate as New PDI" — starts a new report from a completed/in-progress
  // one for a similar customer/product. Resets everything that's specific to
  // the physical unit(s) actually tested (pdi_no, inspection_date, photos,
  // every table/checklist/fill-in-list row, signatures); carries forward
  // everything else in `data` unchanged (Customer Name, Product ID, Drawing
  // No, Product Specifications, and — for General specifically — the
  // tolerance/spec-row fields, since those describe the whole batch, not one
  // motor). customer_id/order_id carry forward too (same customer/order);
  // inspected_by/status/created_at are freshly assigned via createReport,
  // same as any brand-new report.
  static async duplicateReport(reportId, io) {
    const source = await this.getById(reportId);
    const sourceData = source.data || {};

    // Reset: pdi_no, date, every table's rows, every signature field, general
    // check results. Keep everything else (Header-level identity/spec fields).
    const resetKeys = new Set([
      'pdi_no', 'date',
      'rows', // General's electrical/mechanical motor rows
      'prepared_by', 'approved_by', // General's signatures
      'general_electrical', 'general_mechanical', // General's fixed GO/NG checks
      'electrical_remarks', 'mechanical_remarks', // per-run remarks, not batch spec
    ]);
    const newData = {};
    for (const [key, value] of Object.entries(sourceData)) {
      if (!resetKeys.has(key)) newData[key] = value;
    }

    return this.createReport({
      customer_id: source.customer_id,
      order_id: source.order_id,
      data: newData,
      photos: [],
      template_id: source.template_id,
    }, io);
  }
```

### Step 2: Add the controller action

In `CRM_BACKEND/controllers/operations/pdiReports.controller.js`, add after `exports.createReport` (after line 36):

```javascript
exports.duplicateReport = async (req, res) => {
  try {
    const report = await PdiReports.duplicateReport(req.params.id, req.io);
    await invalidateCache();
    logger.info(`PDI report duplicated: ${req.params.id} -> ${report.report_id} by ${req.user.user_id}`);
    res.status(201).json(report);
  } catch (error) {
    if (error.message === 'Report not found') return res.status(404).json({ error: error.message });
    logger.error(`Error duplicating PDI report ${req.params.id}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};
```

### Step 3: Add the route

In `CRM_BACKEND/routes/operations/pdiReports.js`, add after the `POST /` route (after line 6):

```javascript
router.post('/:id/duplicate', authenticateToken, controller.duplicateReport);
```

### Step 4: Verify

```bash
cd CRM_BACKEND && node -e "require('./controllers/operations/pdiReports.controller.js'); require('./routes/operations/pdiReports.js'); console.log('OK — routes load without error')"
```

Expected: `OK — routes load without error`

(Full end-to-end verification of this endpoint happens live in Task 11 — there's no automated test suite in this repo to unit-test against here, consistent with every prior PDI round.)

---

## Task 6: Frontend — "Duplicate as New PDI" action

**Files:**
- Modify: `CRM/src/components/shared/PdiReportsTable.jsx`

### Step 1: Add the `Copy` icon import

Change line 4:

```javascript
import { ArrowDownUp, Search, Eye, Pencil, Trash2 } from 'lucide-react';
```

to:

```javascript
import { ArrowDownUp, Search, Eye, Pencil, Trash2, Copy } from 'lucide-react';
```

### Step 2: Add a `handleDuplicate` callback

Add after `handleDelete` (after line 241):

```javascript
  const handleDuplicate = useCallback(
    async (report) => {
      const label = report.pdi_no || `#${report.report_id}`;
      try {
        const token = localStorage.getItem('token');
        const response = await fetch(`${BASE_URL}/api/pdi/reports/${report.report_id}/duplicate`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) throw new Error('Duplicate failed');
        const newReport = await response.json();
        notifySuccess(`Duplicated ${label} — opening the new PDI.`, { autoClose: 2000 });
        navigate(`/pdi-generator/${newReport.template_id || 'general'}?report=${newReport.report_id}`);
      } catch (err) {
        console.error('Duplicate error:', err);
        notifyError('Failed to duplicate PDI report.', { autoClose: 3000 });
      }
    },
    [navigate, notifySuccess, notifyError]
  );
```

### Step 3: Add the Duplicate button next to Resume/View/Delete

Replace the actions `<div>` (lines 358-373):

```jsx
                    <div className="flex items-center gap-1">
                      {canManage && (
                        <button onClick={() => handleResume(report)} className="p-2 hover:bg-amber-100 rounded-full text-amber-700" title="Resume in Generator" aria-label={`Resume PDI report ${report.pdi_no || report.report_id}`}>
                          <Pencil size={18} />
                        </button>
                      )}
                      <button onClick={() => handleViewDownload(report)} className="p-2 hover:bg-amber-100 rounded-full text-amber-700" title="View / Download PDF" aria-label={`View PDI report ${report.pdi_no || report.report_id}`}>
                        <Eye size={18} />
                      </button>
                      {canManage && (
                        <button onClick={() => handleDuplicate(report)} className="p-2 hover:bg-amber-100 rounded-full text-amber-700" title="Duplicate as New PDI" aria-label={`Duplicate PDI report ${report.pdi_no || report.report_id}`}>
                          <Copy size={18} />
                        </button>
                      )}
                      {canManage && (
                        <button onClick={() => handleDelete(report)} className="p-2 hover:bg-red-50 rounded-full text-red-500" title="Delete" aria-label={`Delete PDI report ${report.pdi_no || report.report_id}`}>
                          <Trash2 size={18} />
                        </button>
                      )}
                    </div>
```

### Step 4: Verify with lint and build

```bash
cd CRM && npx eslint src/components/shared/PdiReportsTable.jsx
npm run build
```

Expected: no errors.

---

## Task 7: Shared photo upload — multi-file select + sequential crop queue

**Files:**
- Modify: `CRM/src/components/shared/PdiImageUpload.jsx`

### Step 1: Change `ImageUploadCard`'s props from single `value`/`onSelect`/`onClear` to a multi-image shape

Replace the whole `ImageUploadCard` function (lines 11-101) with:

```jsx
// `images` is an array of data-URI strings (possibly empty). `onFilesSelected`
// receives the raw FileList from either the camera or file input — the
// caller is responsible for queuing each file through crop+compress (see
// CropModal below) and appending the result. `onRemove(index)` removes one
// image from the array.
export function ImageUploadCard({ label, hint, images = [], onFilesSelected, onRemove, heightCls = 'h-40', maxImages = 10 }) {
  const cameraInputRef = useRef(null);
  const fileInputRef = useRef(null);
  const [dragActive, setDragActive] = useState(false);
  const atLimit = images.length >= maxImages;

  const handleDragOver = (e) => {
    e.preventDefault();
    if (!atLimit) setDragActive(true);
  };
  const handleDragLeave = (e) => {
    e.preventDefault();
    setDragActive(false);
  };
  const handleDrop = (e) => {
    e.preventDefault();
    setDragActive(false);
    if (atLimit) return;
    if (e.dataTransfer.files?.length) onFilesSelected(e.dataTransfer.files);
  };

  return (
    <div>
      {label && <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>}
      {hint && <p className="text-xs text-gray-400 mb-1.5">{hint}</p>}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`relative rounded-lg border-2 border-dashed bg-gray-50 ${heightCls} overflow-hidden ${
          dragActive ? 'border-amber-400 bg-amber-50' : images.length ? 'border-gray-200' : 'border-gray-300'
        }`}
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
                >
                  <X size={12} />
                </button>
              </div>
            ))}
            {!atLimit && (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="aspect-square rounded border-2 border-dashed border-gray-300 flex items-center justify-center text-gray-400 hover:text-amber-500 hover:border-amber-300"
                title="Add more photos"
              >
                <ImageIcon size={20} />
              </button>
            )}
          </div>
        ) : (
          <div className="h-full flex flex-col items-center justify-center gap-2 text-gray-400">
            <div className="flex items-center gap-5">
              <button
                type="button"
                onClick={() => cameraInputRef.current?.click()}
                className="flex flex-col items-center gap-1.5 hover:text-amber-500 transition-colors"
              >
                <Camera size={26} />
                <span className="text-xs font-medium">Take Photo</span>
              </button>
              <div className="w-px h-9 bg-gray-200" />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex flex-col items-center gap-1.5 hover:text-amber-500 transition-colors"
              >
                <ImageIcon size={26} />
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
        onChange={(e) => { if (e.target.files?.length) onFilesSelected(e.target.files); e.target.value = ''; }}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => { if (e.target.files?.length) onFilesSelected(e.target.files); e.target.value = ''; }}
      />
    </div>
  );
}
```

Note: `onSelect`/`onClear`'s old signature (`(file, inputEl)` / `()`) is gone — every caller (Task 8, Task 9) is updated to the new `onFilesSelected(FileList)` / `onRemove(index)` shape. `capture="environment"` + `multiple` together: most mobile browsers only let the camera capture one photo per tap even with `multiple` set, but selecting from the gallery (`fileInputRef`) picks several at once — this is a real, existing platform limitation, not a bug in this implementation.

### Step 2: `CropModal` stays as-is (single-image crop), but is now driven by a queue

No changes needed to `CropModal` itself (lines 106-182 today) — Task 8 and Task 9 add the queue logic around it (crop one file, apply, advance to the next file in the batch, repeat).

### Step 3: `ImageUploadCard` is also used by non-photo single-image sections — these must be adapted too, not left broken

Two other call sites use this same shared `ImageUploadCard` with the OLD single-`value` signature and are **outside** Track C's photo-section scope, but Step 1's prop change breaks them unless adapted: `ImageSection` in `GenericPdiSections.jsx` (renders `type: 'image'` sections, e.g. a reference-image field) and `PDIGeneratorForm.jsx`'s own "Technical Drawing" upload (its `drawing_image` field, a `type: 'image'`-equivalent, not a `type: 'photo'` section). Both stay conceptually single-image — adapt them to the new multi-image interface with `maxImages={1}` rather than building a second component:

In `GenericPdiSections.jsx`, update `ImageSection` (covered fully in Task 8, Step 4a below).

In `PDIGeneratorForm.jsx`, update the Technical Drawing `<ImageUploadCard>` call (covered fully in Task 9, Step 1a below).

### Step 4: Verify with lint

```bash
cd CRM && npx eslint src/components/shared/PdiImageUpload.jsx
```

Expected: no errors. (Full build verification happens after Task 8, once callers exist again — this component's props changed, so the build WILL fail until Task 8/9 update every caller to match. That's expected and fine mid-task; don't treat it as a regression.)

---

## Task 8: `GenericPdiSections.jsx` — multi-photo data shape + crop queue

**Files:**
- Modify: `CRM/src/components/admin/GenericPdiSections.jsx`
- Modify: `CRM/src/components/admin/GenericPdiGeneratorForm.jsx` (only the photo-related state helpers — everything else in this file is the already-hardened autosave/save-chain logic and must not be touched)

### Step 1: Read `GenericPdiGeneratorForm.jsx`'s photo-related state helpers first

Before editing, find and read in full: `addFreeformPhoto`, `removeFreeformPhoto`, `setFreeformPhotoLabel`, `setFreeformPhotoImage`, `setFixedSlotImage`, `handleFileChosen`, `applyCroppedImage`/crop-target state, and `buildDefaultFormData`'s photo-section initialization (search for `mode === 'freeform'` in that file). These are the functions passed into `FreeformPhotoSection`/`FixedSlotPhotoSection` as props today (per `GenericPdiSections.jsx` lines 364-367) and must be updated to the new array-based shape without touching the surrounding save-chain code.

### Step 2: Change the stored shape

Freeform entries change from `{ label, image }` to `{ label, images: [] }`. Fixed slots change from `slotData[slot.key]` being a single data-URI to `slotData[slot.key]` being an array of data-URIs.

In `GenericPdiGeneratorForm.jsx`, update:
- Wherever a freeform photo entry is initialized (in `buildDefaultFormData` or an `addFreeformPhoto`-equivalent), change `{ label: '', image: null }` to `{ label: '', images: [] }`.
- `setFreeformPhotoImage(dataKey, idx, dataUri)` (single-image setter) becomes two functions: `addFreeformPhotoImage(dataKey, idx, dataUri)` (appends to `images[]`, capped at 10) and `removeFreeformPhotoImage(dataKey, idx, imageIdx)` (splices one out).
- `setFixedSlotImage(dataKey, slotKey, dataUri)` becomes `addFixedSlotImage(dataKey, slotKey, dataUri)` (appends, capped at 10) and `removeFixedSlotImage(dataKey, slotKey, imageIdx)` (splices one out).
- Do not change `handleFileChosen`'s single-file crop-and-apply plumbing directly — instead add a small queue wrapper (Step 3) that calls the existing single-file path once per file in a `FileList`, in sequence.

### Step 3: Add a crop-queue helper in `GenericPdiGeneratorForm.jsx`

The crop step is asynchronous — it waits for the user to interact with `CropModal` and click Apply — so the queue must advance from `applyCroppedImage`'s completion (Step 4 below), not synchronously when files are first selected. Add next to the existing `handleFileChosen`/crop-target state:

```javascript
// Turns a multi-file selection into a sequence of single-file crop steps,
// reusing the existing one-image-at-a-time CropModal/handleFileChosen path
// unchanged — just queues the remaining files and advances after each Apply
// (see advanceCropQueue, called from applyCroppedImage in Step 4).
const [cropQueue, setCropQueue] = useState({ files: [], onApplied: null });

const handleFilesChosen = useCallback((onEachApplied, fileList) => {
  const files = Array.from(fileList || []);
  if (files.length === 0) return;
  const [first, ...rest] = files;
  setCropQueue({ files: rest, onApplied: onEachApplied });
  handleFileChosen(onEachApplied, first);
}, [handleFileChosen]);

// Called from applyCroppedImage (existing function) after each crop is
// applied — advances to the next queued file, if any.
const advanceCropQueue = useCallback(() => {
  setCropQueue((current) => {
    if (current.files.length === 0) return current;
    const [next, ...rest] = current.files;
    handleFileChosen(current.onApplied, next);
    return { files: rest, onApplied: current.onApplied };
  });
}, [handleFileChosen]);
```

Find the existing `applyCroppedImage` function (the one that fires when `CropModal`'s Apply button resolves) and add a call to `advanceCropQueue()` at the end of it, after it applies the current crop result — this makes the modal automatically reopen for the next file in the batch until the queue is empty.

### Step 4: Update `FreeformPhotoSection` and `FixedSlotPhotoSection` in `GenericPdiSections.jsx`

Replace both functions (lines 261-316):

```jsx
function FreeformPhotoSection({ section, form, addPhoto, removePhoto, setLabel, handleFilesChosen, addImage, removeImage }) {
  const photos = form[section.dataKey] || [];
  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-gray-700">Photos</h3>
        <button
          type="button"
          onClick={() => addPhoto(section.dataKey)}
          disabled={photos.length >= MAX_PHOTOS}
          className="flex items-center gap-1 px-3 py-1.5 border border-amber-300 text-amber-700 rounded-lg hover:bg-amber-50 disabled:opacity-40 disabled:hover:bg-transparent text-xs font-medium"
        >
          <Plus size={14} /> Add Photo
        </button>
      </div>
      <div className="grid grid-cols-2 gap-4">
        {photos.map((photo, idx) => (
          <div key={idx} className="space-y-1.5">
            <div className="flex items-center gap-2">
              <input className={INPUT_CLS} value={photo.label} onChange={(e) => setLabel(section.dataKey, idx, e.target.value)} placeholder={`Photo ${idx + 1} label`} />
              <button type="button" onClick={() => removePhoto(section.dataKey, idx)} className="shrink-0 p-1.5 text-gray-400 hover:text-red-500">
                <Trash2 size={16} />
              </button>
            </div>
            <ImageUploadCard
              images={photo.images || []}
              onFilesSelected={(fileList) => handleFilesChosen((dataUri) => addImage(section.dataKey, idx, dataUri), fileList)}
              onRemove={(imgIdx) => removeImage(section.dataKey, idx, imgIdx)}
              heightCls="h-32"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function FixedSlotPhotoSection({ section, form, handleFilesChosen, addSlotImage, removeSlotImage }) {
  const slotData = form[section.dataKey] || {};
  return (
    <div className="mb-6">
      <h3 className="text-sm font-semibold text-gray-700 mb-2">Photos</h3>
      <div className="grid grid-cols-2 gap-4">
        {section.slots.map((slot) => (
          <ImageUploadCard
            key={slot.key}
            label={slot.label}
            images={slotData[slot.key] || []}
            onFilesSelected={(fileList) => handleFilesChosen((dataUri) => addSlotImage(section.dataKey, slot.key, dataUri), fileList)}
            onRemove={(imgIdx) => removeSlotImage(section.dataKey, slot.key, imgIdx)}
          />
        ))}
      </div>
    </div>
  );
}
```

### Step 4a: Adapt `ImageSection` (single-image, `type: 'image'`) to the new `ImageUploadCard` interface

This is a different section type from the photo sections above (`FreeformPhotoSection`/`FixedSlotPhotoSection`) — it's out of Track C's stated scope, but breaks if left on the old props (see Task 7 Step 3). Replace `ImageSection` (lines 318-330):

```jsx
function ImageSection({ section, form, handleFilesChosen, setImageField }) {
  const value = form[section.dataKey];
  return (
    <div className="mb-6">
      <ImageUploadCard
        label={section.title || 'Image'}
        images={value ? [value] : []}
        maxImages={1}
        onFilesSelected={(fileList) => handleFilesChosen((dataUri) => setImageField(section.dataKey, dataUri), fileList)}
        onRemove={() => setImageField(section.dataKey, null)}
        heightCls="h-28"
      />
    </div>
  );
}
```

`setImageField` is unchanged (it already sets a single value); only the props passed to `ImageUploadCard` change. Update `renderSection`'s `case 'image':` branch to pass `handleFilesChosen` instead of `handleFileChosen` (same `ctx.handleFilesChosen` added in Step 3).

### Step 5: Update `renderSection`'s wiring for these two cases (around line 358+)

Find the `case 'photo':` branch and update the props passed to `FreeformPhotoSection`/`FixedSlotPhotoSection` to match the new function signatures (`handleFilesChosen`, `addImage`/`removeImage` or `addSlotImage`/`removeSlotImage` instead of the old `handleFileChosen`/`setImage`/`setSlotImage`), sourced from `ctx` (the context object `GenericPdiGeneratorForm.jsx` passes down — add the new helpers from Steps 2-3 to that same `ctx` object wherever it's constructed).

### Step 6: Verify with lint and build

```bash
cd CRM && npx eslint src/components/admin/GenericPdiSections.jsx src/components/admin/GenericPdiGeneratorForm.jsx src/components/shared/PdiImageUpload.jsx
npm run build
```

Expected: no errors. If `GenericPdiGeneratorForm.jsx`'s autosave/save-chain logic triggers any lint warning from this change, stop and re-read the surrounding code before proceeding — that file's save-chain correctness is load-bearing from 5+ rounds of review earlier this session and must not regress.

---

## Task 9: `PDIGeneratorForm.jsx` — mirror the same multi-photo change for General

**Files:**
- Modify: `CRM/src/components/admin/PDIGeneratorForm.jsx`

### Step 1: Replace the local `ImageUploadCard` (lines 172-234) with the same multi-image version from Task 7

Use the exact same component body as Task 7 Step 1's replacement (copy it verbatim — this file has its own local copy, not an import, per the "Before you start" note #4).

### Step 1a: Adapt the "Technical Drawing" upload (single-image, not a photo section) to the new `ImageUploadCard` interface

Same reason as Task 8 Step 4a — this call site uses the old single-`value` props and breaks otherwise. Replace the Technical Drawing `<ImageUploadCard>` call in the Photos tab (lines ~989-996):

```jsx
                <ImageUploadCard
                  label="Technical Drawing (Pg 2)"
                  hint="Shown in the Mechanical Check sheet's drawing box. Leave blank to keep the text placeholder."
                  images={form.drawing_image ? [form.drawing_image] : []}
                  maxImages={1}
                  onFilesSelected={(fileList) => handleFilesChosen({ type: 'drawing' }, fileList)}
                  onRemove={() => setField('drawing_image', null)}
                  heightCls="h-28"
                />
```

(`handleFilesChosen` is added in Step 5 below — this step and Step 5 touch the same file, order doesn't matter as long as both land.)

### Step 2: Change `defaultForm`'s photo seeding (lines 149-152)

```javascript
  photos: [
    { id: makePhotoId(), label: 'Overall Motor', images: [] },
    { id: makePhotoId(), label: 'Name Plate', images: [] },
  ],
```

### Step 3: Change `drawing_image` handling — leave as single-image (it's a separate `type: 'image'` section, not `type: 'photo'`, per the spec's Track C scope which is photo sections only). No change needed there.

### Step 4: Replace the photo callbacks (`addPhoto`, `removePhoto`, `setPhotoLabel`, `clearPhotoImage`, lines 438-456) and the crop-apply logic (`applyCroppedImage`, lines 420-434)

```javascript
  const addPhoto = useCallback(() => {
    setForm((prev) => (
      prev.photos.length >= MAX_PHOTOS
        ? prev
        : { ...prev, photos: [...prev.photos, { id: makePhotoId(), label: '', images: [] }] }
    ));
  }, []);

  const removePhoto = useCallback((id) => {
    setForm((prev) => ({ ...prev, photos: prev.photos.filter((p) => p.id !== id) }));
  }, []);

  const setPhotoLabel = useCallback((id, label) => {
    setForm((prev) => ({ ...prev, photos: prev.photos.map((p) => (p.id === id ? { ...p, label } : p)) }));
  }, []);

  const addPhotoImage = useCallback((id, dataUri) => {
    setForm((prev) => ({
      ...prev,
      photos: prev.photos.map((p) => (p.id === id ? { ...p, images: [...(p.images || []), dataUri].slice(0, 10) } : p)),
    }));
  }, []);

  const removePhotoImage = useCallback((id, imgIdx) => {
    setForm((prev) => ({
      ...prev,
      photos: prev.photos.map((p) => (p.id === id ? { ...p, images: (p.images || []).filter((_, i) => i !== imgIdx) } : p)),
    }));
  }, []);
```

And replace `applyCroppedImage`:

```javascript
  const applyCroppedImage = useCallback((dataUri) => {
    setCropTarget((current) => {
      if (!current) return current;
      const { target } = current;
      if (target.type === 'drawing') {
        setField('drawing_image', dataUri);
      } else {
        addPhotoImage(target.id, dataUri);
      }
      // Advance the crop queue (see cropQueue state added below) — if more
      // files were selected in this batch, immediately open the next one.
      setCropQueue((queue) => {
        if (queue.files.length === 0) return { files: [], onApplied: null };
        const [next, ...rest] = queue.files;
        handleFileChosen(queue.target, next);
        return { files: rest, target: queue.target };
      });
      return null;
    });
  }, [setField, addPhotoImage]);
```

### Step 5: Add the crop-queue state and `handleFilesChosen` wrapper

Add near `cropTarget` state (line 396):

```javascript
  const [cropQueue, setCropQueue] = useState({ files: [], target: null });

  // Turns a multi-file selection into a sequence of single-file crop steps —
  // handleFileChosen (unchanged) opens CropModal for the first file; applying
  // that crop (applyCroppedImage above) advances to the next queued file.
  const handleFilesChosen = useCallback((target, fileList) => {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    const [first, ...rest] = files;
    setCropQueue({ files: rest, target });
    handleFileChosen(target, first);
  }, [handleFileChosen]);
```

### Step 6: Update the Photos tab JSX (lines 1013-1040) to use the new props

```jsx
                  <div className="grid grid-cols-2 gap-4">
                    {form.photos.map((photo, idx) => (
                      <div key={photo.id} className="space-y-1.5">
                        <div className="flex items-center gap-2">
                          <input
                            className={INPUT_CLS}
                            value={photo.label}
                            onChange={(e) => setPhotoLabel(photo.id, e.target.value)}
                            placeholder={`Photo ${idx + 1} label`}
                          />
                          <button
                            type="button"
                            onClick={() => removePhoto(photo.id)}
                            className="shrink-0 p-1.5 text-gray-400 hover:text-red-500"
                            title="Remove this photo slot"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                        <ImageUploadCard
                          images={photo.images || []}
                          onFilesSelected={(fileList) => handleFilesChosen({ type: 'photo', id: photo.id }, fileList)}
                          onRemove={(imgIdx) => removePhotoImage(photo.id, imgIdx)}
                          heightCls="h-32"
                        />
                      </div>
                    ))}
                  </div>
```

### Step 7: Verify with lint and build

```bash
cd CRM && npx eslint src/components/admin/PDIGeneratorForm.jsx
npm run build
```

Expected: no errors.

---

## Task 10: `renderer.js` — multi-photo PDF layout

**Files:**
- Modify: `CRM_BACKEND/models/operations/pdi/renderer.js`

### Step 1: Flatten multi-image slots/entries into individual PDF cells before the existing 2-per-row grid loop

Replace `drawPhotoSection` (lines 239-267):

```javascript
function drawPhotoSection(doc, section, data, y) {
  if (section.mode !== 'freeform' && section.mode !== 'fixed-slots') {
    throw new Error(`PDI photo section has invalid mode: ${section.mode} (expected 'freeform' or 'fixed-slots')`);
  }
  let groups; // [{ label, images: [...] }]
  if (section.mode === 'fixed-slots') {
    const slotData = data[section.dataKey] || {};
    groups = section.slots.map(slot => ({ label: slot.label, images: slotData[slot.key] || [] }));
  } else {
    const list = Array.isArray(data[section.dataKey]) ? data[section.dataKey] : [];
    groups = list
      .filter(p => p && ((p.label && p.label.trim()) || (p.images && p.images.length)))
      .map(p => ({ label: (p.label || '').trim(), images: p.images || [] }));
  }

  // Flatten each group's photos into individual PDF cells — a group with N
  // photos produces N labeled cells ("Damage Photos (1)", "(2)", ...) instead
  // of being limited to one, matching the design spec's chosen layout.
  const items = [];
  groups.forEach((g) => {
    if (g.images.length === 0) {
      items.push({ label: g.label, image: null }); // preserve today's "empty slot still shows" behavior for fixed-slots
    } else if (g.images.length === 1) {
      items.push({ label: g.label, image: g.images[0] });
    } else {
      g.images.forEach((img, i) => items.push({ label: `${g.label} (${i + 1})`, image: img }));
    }
  });

  y = drawPhotosHeader(doc, y);
  for (let i = 0; i < items.length; i += 2) {
    if (y + PHOTO_ROW_H > PAGE_H - BOT_M) {
      doc.addPage();
      y = drawPhotosHeader(doc, 10);
    }
    drawPhotoCell(doc, items[i].label || `Photo ${i + 1}`, items[i].image, i, M, y);
    if (items[i + 1]) {
      drawPhotoCell(doc, items[i + 1].label || `Photo ${i + 2}`, items[i + 1].image, i + 1, M + PHOTO_CELL_W + PHOTO_GAP, y);
    }
    y += PHOTO_ROW_H;
  }
  return y;
}
```

`drawPhotoCell`, `drawPhotosHeader`, and the rest of the file are unchanged — this only changes how `items` is built before the existing loop.

### Step 2: Verify

```bash
cd CRM_BACKEND && node -e "require('./models/operations/pdi/renderer.js'); console.log('OK')"
```

Expected: `OK`

---

## Task 11: Controller-personal live verification (gstack) — and the single commit

**Do this task yourself, in the main session — not via a dispatched subagent.** This repo's dev backend connects to the same production RDS database as `intute.biz` (no separate staging DB) — same discipline as every previous live-verification pass this session: create clearly-named throwaway test data, delete every bit of it afterward, and if `CRM_BACKEND/.env`'s `FRONTEND_URL` needs to be temporarily pointed at `http://localhost:5173`, capture its exact original bytes first and restore them byte-for-byte when done (including restarting the backend process).

- [ ] **Step 1: Start both dev servers, log in.** Use gstack's `browse` binary (not browsermcp — proved unreliable this session).

- [ ] **Step 2: Mechanical table — tolerance flagging.** Open the General PDI form, go to the Mechanical tab, set Locating Dia. spec to `50.0` with tolerance `±0.5`. Enter `50.2` in a row's Locating Dia. cell — confirm no red flag. Enter `51.0` — confirm it flags red. Confirm Locating Dia.'s per-row cell is now a free-typed input, not a GO/NG dropdown. Confirm Key Dim. is still a GO/NG dropdown, untouched. Repeat the in/out-of-tolerance check for Motor Length, Shaft Length, and Mounting PCD.

- [ ] **Step 3: Electrical table — one row per motor, F/R entry.** Confirm there's now one row per motor (no `direction` column). Set Current Standard spec to `4` with tolerance `±0.5`, RPM Specified to `3000` with tolerance `±50`. In a motor row's Current Measured cell, type `4.1/6` — confirm forward (4.1) doesn't flag but reverse (6) does (assuming 6 is out of a ±0.5 tolerance around 4 — adjust the test numbers as needed to hit one flagged, one not). Try a single value with no `/` (e.g. `4.1`) — confirm it's treated as forward-only and validates correctly.

- [ ] **Step 4: PDF output matches the form.** Finalize the PDI, download the PDF, and use the PowerShell + `Windows.Data.Pdf` WinRT technique (`powershell.exe`, not `pwsh`) to render it to PNG for a real visual check. Confirm: the Electrical table shows one row per motor with the new columns, the spec row shows the nominal values, out-of-tolerance cells are visibly flagged (red fill/text), the Mechanical table's Locating Dia. shows the typed numeric value (not GO/NG), and its out-of-tolerance cells are flagged too.

- [ ] **Step 5: Duplicate as New PDI.** From the PDI Records list, duplicate a completed report. Confirm: `pdi_no` and inspection date are blank, all motor rows are reset to the default 20 blank rows, all photos are gone, Prepared By/Approved By are blank — but Customer Name, Product ID, Drawing No, Product Specifications, and (if it was a General-template report) the spec-row tolerance values from Task 1-2 all carried forward unchanged.

- [ ] **Step 6: Multi-photo upload.** In the General form's Photos tab, click "Choose Files" on one photo slot and select 3 images at once — confirm the crop modal appears once per image in sequence (not all 3 dumped in unedited), and after cropping all 3, the slot shows 3 thumbnails. Remove one, confirm 2 remain. Repeat for a DB-authored template's Fill-in-list or fixed-slot photo section (any existing test template, or create a throwaway one) to confirm the shared `GenericPdiSections.jsx` path works too. Finalize both and confirm the PDF shows each photo as its own labeled cell.

- [ ] **Step 7: Autosave sanity check on the DB-authored path.** Since Task 8 touched `GenericPdiGeneratorForm.jsx`'s photo helpers, open any DB-authored template's fill-out form, make an unrelated text-field edit, and confirm "All changes saved" still appears correctly — no regression in the save-chain logic from the photo changes.

- [ ] **Step 8: Clean up.** Delete every test PDI report and any throwaway test template created during this pass. Revert `CRM_BACKEND/.env` to its exact original bytes if it was changed, and restart the backend so its live process matches.

- [ ] **Step 9: The single commit.** Only after every check above passes, stage and commit everything from Tasks 1-10 in one commit (or a small number of logically-grouped commits if that reads more clearly in `git log` — controller's judgment at this point):

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat: add tolerance validation, F/R entry, PDI duplication, and multi-photo upload

General template's Mechanical/Electrical check tables now validate measured
values against an admin-typed nominal + tolerance, flagging (not blocking)
out-of-range readings in both the form and the generated PDF. Electrical
restructured to one row per motor with flexible Forward/Reverse entry
(single input, e.g. "4/2"). Locating Dia.'s per-row cell, previously a GO/NG
dropdown by mistake, is now a real numeric input.

Also adds a "Duplicate as New PDI" report action (any template) and
multi-photo-per-upload support across both photo-upload code paths.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

Report DONE if every step in this task passed; if anything failed, fix it directly (this task is personal, not delegated), re-verify, then report DONE.

---

## Self-Review

**Spec coverage:** Every numbered item in the design spec's Track A/B/C sections maps to a task above — Task 1-2 (Mechanical/Electrical form UI + flagging), Task 3-4 (general.js + renderer.js), Task 5-6 (Track B), Task 7-10 (Track C, both photo paths + renderer). No spec requirement without a task.

**Placeholder scan:** No TBD/TODO markers. Every step has real, complete code.

**Cross-scope breakage caught in self-review:** `ImageUploadCard` (Task 7) is shared by more than the two photo-section types Track C nominally targets — `ImageSection` (`type: 'image'`, e.g. a reference-image field) and General's own "Technical Drawing" upload both use the same component with the old single-`value` props. Changing the shared component's interface without also updating these would have silently broken two unrelated, in-scope-elsewhere features. Fixed by adapting both call sites to the new multi-image interface with `maxImages={1}` (Task 8 Step 4a, Task 9 Step 1a) rather than forking a second component.

**Type consistency:** `checkTolerance(measuredStr, nominalStr, toleranceMode, toleranceAmountStr)` has the identical signature and return shape (`{ outOfRange }`) in both `PDIGeneratorForm.jsx` (Task 1) and `CRM_BACKEND/models/operations/pdi/tolerance.js` (Task 4) — same for `parseForwardReverse`. `ImageUploadCard`'s new prop names (`images`, `onFilesSelected`, `onRemove`, `maxImages`) are used identically by Task 8 (GenericPdiSections.jsx) and Task 9 (PDIGeneratorForm.jsx's own copy). Photo entry shape `{ label, images: [] }` is consistent across `defaultForm()` (Task 9), `GenericPdiGeneratorForm.jsx`'s equivalent (Task 8), and `renderer.js`'s `drawPhotoSection` (Task 10).
