# AutoNXT Specification Display Text Lock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop AutoNXT's printed "Specification" text from drifting out of sync with its own Nominal/Tolerance fields, by computing it instead of letting it be typed independently — on both the web admin form and (via a handoff doc) the mobile app — and fix already-saved reports that currently have a mismatched value.

**Architecture:** A new per-field unit/prefix metadata table plus a `formatAutoNxtSpecDisplay` formatter, implemented three times (CRM web in JS, a CRM_BACKEND one-off script in JS, and pdi-erp-app mobile in TS via handoff doc) — matching this codebase's existing convention of duplicating tolerance-related logic across these three repos rather than sharing it, since they don't share a build pipeline. CRM's `AutoNxtSpecCell` becomes read-only, always showing the live computed value; the actual value sent to the backend is (re)computed at save/finalize time, not tracked incrementally in form state. The backend's print logic is untouched. A one-time script fixes already-saved production data and regenerates PDFs for affected finalized reports.

**Tech Stack:** React (CRM web, JS/JSX), Node.js + `pg` (CRM_BACKEND), no test framework in either repo (confirmed) — correctness is verified via throwaway comparison scripts, not a test suite.

**Spec:** `docs/superpowers/specs/2026-09-30-autonxt-spec-display-lock-design.md` (this repo). Read it first if anything below is unclear — it has the full rationale for every decision.

---

### Task 1: CRM — add per-field metadata and the display formatter

**Files:**
- Modify: `CRM/src/components/admin/AutoNXTGeneratorForm.jsx:148-149` (insert after `SPEC_FIELD_IDS`, before `defaultSpecFields`)

The file currently defines `SPEC_DEFAULTS` (line 126) and `SPEC_FIELD_IDS = Object.keys(SPEC_DEFAULTS)` (line 148) — 19 keys: `rpm_{500,1000,1500,1800,2000,2200,2500,3000}_bemf`, the same 8 `_current`, `motor_total_length`, `shaft_op_length`, `locating_dia`.

- [ ] **Step 1: Insert the unit/prefix metadata table and the formatter**

Insert immediately after line 148 (`const SPEC_FIELD_IDS = Object.keys(SPEC_DEFAULTS);`), before the `defaultSpecFields` function:

```jsx
// Per-field printed-unit metadata for formatAutoNxtSpecDisplay below --
// mirrors today's hardcoded SPEC_DEFAULTS[*].display strings exactly (an
// "A" suffix on every *_current field, a "Ø" prefix on locating_dia's
// bilateral diameter spec, nothing on everything else). See
// docs/superpowers/specs/2026-09-30-autonxt-spec-display-lock-design.md
// (CRM_BACKEND repo) for why this exists. Same duplicated-rather-than-shared
// convention as SPEC_DEFAULTS above -- also mirrored in CRM_BACKEND's
// one-off fix script and in the pdi-erp-app mobile handoff.
const SPEC_UNIT_PREFIX = {
  rpm_500_current:  { unit: 'A' },
  rpm_1000_current: { unit: 'A' },
  rpm_1500_current: { unit: 'A' },
  rpm_1800_current: { unit: 'A' },
  rpm_2000_current: { unit: 'A' },
  rpm_2200_current: { unit: 'A' },
  rpm_2500_current: { unit: 'A' },
  rpm_3000_current: { unit: 'A' },
  locating_dia:     { prefix: 'Ø' },
};

// Computes the printed Specification text from nominal/tolerance instead of
// letting it be typed independently of them -- see the design spec above
// for why (a technician could previously change Nominal/Tolerance without
// updating this text, so the PDF printed a specification that no longer
// matched what Measured was actually checked against). Must reproduce every
// one of SPEC_DEFAULTS' current hardcoded `display` strings exactly for
// that field's own (nominal, tolMode, tol, tolMinus) -- verified in Step 2.
function formatAutoNxtSpecDisplay(nominal, tolMode, tol, tolMinus, { unit = '', prefix = '' } = {}) {
  const nominalStr = String(nominal ?? '').trim();
  if (!nominalStr) return '-';
  if (tolMode === 'bilateral') {
    return `${prefix}${nominalStr} (${tol} TO ${tolMinus})`;
  }
  return `${prefix}${nominalStr}±${tol}${tolMode === '%' ? '%' : ''}${unit}`;
}
```

Note the two different spacing rules: **no space** before `±` in the `±`/`%` case (today's defaults have none — `"79.0±3%"`, `"6.0±2.0A"`), but **a space** before the parenthetical in the `bilateral` case (`"Ø180.0 (-0.01 TO -0.05)"`).

- [ ] **Step 2: Verify the formatter reproduces all 19 current defaults exactly**

This repo has no test framework (confirmed earlier in this session) — verify via a throwaway Node script instead, then delete it. Create `CRM/verify-autonxt-display.mjs`:

```js
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

const SPEC_UNIT_PREFIX = {
  rpm_500_current:  { unit: 'A' },
  rpm_1000_current: { unit: 'A' },
  rpm_1500_current: { unit: 'A' },
  rpm_1800_current: { unit: 'A' },
  rpm_2000_current: { unit: 'A' },
  rpm_2200_current: { unit: 'A' },
  rpm_2500_current: { unit: 'A' },
  rpm_3000_current: { unit: 'A' },
  locating_dia:     { prefix: 'Ø' },
};

function formatAutoNxtSpecDisplay(nominal, tolMode, tol, tolMinus, { unit = '', prefix = '' } = {}) {
  const nominalStr = String(nominal ?? '').trim();
  if (!nominalStr) return '-';
  if (tolMode === 'bilateral') {
    return `${prefix}${nominalStr} (${tol} TO ${tolMinus})`;
  }
  return `${prefix}${nominalStr}±${tol}${tolMode === '%' ? '%' : ''}${unit}`;
}

let failures = 0;
for (const [id, def] of Object.entries(SPEC_DEFAULTS)) {
  const got = formatAutoNxtSpecDisplay(def.nominal, def.tolMode, def.tol, def.tolMinus, SPEC_UNIT_PREFIX[id]);
  const ok = got === def.display;
  if (!ok) failures++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${id}: expected "${def.display}", got "${got}"`);
}
console.log(failures === 0 ? '\nAll 19 fields match.' : `\n${failures} mismatch(es).`);
```

Run: `node CRM/verify-autonxt-display.mjs`
Expected: 19 `OK` lines, `All 19 fields match.` at the end. If any `FAIL` lines appear, fix the formatter (not the expected values) and re-run until all 19 pass.

- [ ] **Step 3: Delete the throwaway verification script**

```bash
rm CRM/verify-autonxt-display.mjs
```

- [ ] **Step 4: Commit**

```bash
cd CRM
git add src/components/admin/AutoNXTGeneratorForm.jsx
git commit -m "feat: add unit/prefix-aware spec display formatter for AutoNXT"
```

---

### Task 2: CRM — make the Specification field read-only and computed

**Files:**
- Modify: `CRM/src/components/admin/AutoNXTGeneratorForm.jsx:355-399` (`AutoNxtSpecCell`)
- Modify: `CRM/src/components/admin/AutoNXTGeneratorForm.jsx:666-686` (`handleSave`)
- Modify: `CRM/src/components/admin/AutoNXTGeneratorForm.jsx:702-711` (inside `handleFinalize`, the save-before-finalize PATCH)

Depends on Task 1 (`SPEC_UNIT_PREFIX`, `formatAutoNxtSpecDisplay`, `SPEC_FIELD_IDS` must already exist).

- [ ] **Step 1: Add a helper that recomputes all 19 display fields on an outgoing payload**

Insert this near the other module-level helpers (e.g. directly after `formatAutoNxtSpecDisplay` from Task 1):

```jsx
// Recomputes every spec_<id>_display field from that field's own current
// nominal/tolerance-mode/tolerance-amount right before sending -- this is
// the actual save-time source of truth. AutoNxtSpecCell's on-screen preview
// (below) calls the same formatAutoNxtSpecDisplay, so what's shown and what
// gets sent are always identical; nothing needs to be kept in sync via
// effects or per-keystroke handlers.
function withComputedSpecDisplays(data) {
  const out = { ...data };
  SPEC_FIELD_IDS.forEach((id) => {
    out[`spec_${id}_display`] = formatAutoNxtSpecDisplay(
      data[`spec_${id}`],
      data[`spec_${id}_tol_mode`],
      data[`spec_${id}_tol`],
      data[`spec_${id}_tol_minus`],
      SPEC_UNIT_PREFIX[id],
    );
  });
  return out;
}
```

- [ ] **Step 2: Make `AutoNxtSpecCell`'s Specification input read-only and computed**

Replace the whole `AutoNxtSpecCell` function (lines 355-399) with:

```jsx
// One reusable cell for every tolerance-eligible field: a read-only,
// computed Specification preview (spec_<id>_display -- what prints in the
// PDF, now always derived from the nominal/tolerance group below rather
// than independently typed) plus a compact nominal + tolerance-mode +
// tolerance-amount group (spec_<id>/_tol_mode/_tol/_tol_minus, used both to
// flag the Measured cell and to compute the Specification preview).
// Mirrors General's own ToleranceSpecInput (CRM/src/components/admin/
// PDIGeneratorForm.jsx) with one addition -- the Specification preview --
// since AutoNXT's rows have no separate "spec row above many measured rows"
// the way General's do, this print text has to live somewhere per-row. See
// docs/superpowers/specs/2026-09-30-autonxt-spec-display-lock-design.md
// (CRM_BACKEND repo) for why this field is no longer independently typed.
function AutoNxtSpecCell({ form, setField, id }) {
  const mode = form[`spec_${id}_tol_mode`];
  const computedDisplay = formatAutoNxtSpecDisplay(
    form[`spec_${id}`],
    mode,
    form[`spec_${id}_tol`],
    form[`spec_${id}_tol_minus`],
    SPEC_UNIT_PREFIX[id],
  );
  return (
    <div className="space-y-1 min-w-[150px]">
      <input
        className={INPUT_CLS}
        value={computedDisplay}
        disabled
        readOnly
        title="Computed automatically from Nominal, Tolerance mode and Tolerance amount below -- not editable."
        aria-label="Specification (computed automatically)"
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

(Only the `<input>` for the Specification preview changed — `value` now comes from `computedDisplay` instead of `form[spec_${id}_display]`, `onChange` is removed, `disabled`/`readOnly`/`title`/`aria-label` added. The nominal/mode/tolerance inputs below are untouched.)

- [ ] **Step 3: Apply the computed displays in `handleSave`**

In `handleSave` (around line 672), change:

```jsx
      const { photos, ...data } = form;
      await axios.patch(`${API_URL}/api/pdi/reports/${reportId}`, {
        data, photos, status: 'In Progress', inspected_by: inspectedByValue(),
        inspection_date: form.date || undefined,
      }, {
```

to:

```jsx
      const { photos, ...data } = form;
      await axios.patch(`${API_URL}/api/pdi/reports/${reportId}`, {
        data: withComputedSpecDisplays(data), photos, status: 'In Progress', inspected_by: inspectedByValue(),
        inspection_date: form.date || undefined,
      }, {
```

- [ ] **Step 4: Apply the computed displays in `handleFinalize`**

In `handleFinalize` (around line 703), change:

```jsx
      const { photos, ...data } = form;
      await axios.patch(`${API_URL}/api/pdi/reports/${reportId}`, {
        data, photos, inspected_by: inspectedByValue(),
        inspection_date: form.date || undefined,
      }, {
```

to:

```jsx
      const { photos, ...data } = form;
      await axios.patch(`${API_URL}/api/pdi/reports/${reportId}`, {
        data: withComputedSpecDisplays(data), photos, inspected_by: inspectedByValue(),
        inspection_date: form.date || undefined,
      }, {
```

- [ ] **Step 5: Commit**

```bash
cd CRM
git add src/components/admin/AutoNXTGeneratorForm.jsx
git commit -m "fix: lock AutoNXT's Specification field to the computed nominal/tolerance text"
```

---

### Task 3: CRM_BACKEND — expose a script-usable PDF re-render wrapper

**Files:**
- Modify: `models/operations/pdiReports.js` (right after the existing `#reRenderFinalizedReport` private method, currently ending around line 702)

`#reRenderFinalizedReport(reportId)` is private (added for the finalized-report-editing feature earlier this session) — it re-fetches the report, re-renders its PDF from current `data`, uploads to Drive, updates `drive_file_id`, and deletes the superseded Drive file. Task 4's one-off script needs to call this same logic after correcting `data` directly in the database, but can't reach a private class method from outside — this task adds a thin public wrapper.

- [ ] **Step 1: Add the wrapper method**

Read the current file first to find the exact end of `#reRenderFinalizedReport` (it currently ends with a closing `}` around line 702, right before `static async getPdfBuffer(reportId) {`). Insert immediately after that closing `}`:

```js
  // Exposed for one-off maintenance scripts (e.g.
  // scripts/migrations/2026-09-30-fix-autonxt-spec-display.js) that correct
  // a report's stored `data` directly in the database and then need to
  // force a matching PDF re-render/Drive re-upload -- there is no "edit" by
  // a user to attribute here, so this deliberately bypasses patchReport's
  // permission/revision machinery entirely, same as the script's own direct
  // UPDATE does for the data correction itself. Not part of the public
  // HTTP-facing API -- no controller or route should call this.
  static async reRenderFinalizedReportForMaintenance(reportId) {
    return this.#reRenderFinalizedReport(reportId);
  }
```

- [ ] **Step 2: Commit**

```bash
git add models/operations/pdiReports.js
git commit -m "feat: expose a PDF re-render wrapper for one-off maintenance scripts"
```

---

### Task 4: CRM_BACKEND — one-time script to fix already-saved AutoNXT reports

**Files:**
- Create: `scripts/migrations/2026-09-30-fix-autonxt-spec-display.js`

Depends on Task 3 (`PdiReports.reRenderFinalizedReportForMaintenance`). This repo's `scripts/migrations/` directory holds only schema migrations today — there is no separate one-off/data-fix directory, so this follows the same directory and `YYYY-MM-DD-<description>.js` naming convention rather than inventing a new location, with a comment making clear it changes data, not schema.

- [ ] **Step 1: Write the script**

```js
require('dotenv').config();
const pool = require('../../config/db');
const PdiReports = require('../../models/operations/pdiReports');

// One-time DATA fix, not a schema migration (despite living in this
// directory alongside the schema ones -- this repo has no separate one-off-
// script location, see docs/superpowers/specs/2026-09-30-autonxt-spec-
// display-lock-design.md). Recomputes every AutoNXT report's 19
// spec_<id>_display values from that report's own stored nominal/tolerance,
// using the exact same formula as CRM's formatAutoNxtSpecDisplay (kept in
// sync by convention, not by a shared package -- see that spec for why).
// Run with --dry-run first and review the output before running for real.
const DRY_RUN = process.argv.includes('--dry-run');

// Mirrors CRM/src/components/admin/AutoNXTGeneratorForm.jsx's SPEC_DEFAULTS
// exactly (string-typed nominal/tol, matching what the web form actually
// stores) -- used only as the fallback when a report predates this field
// existing at all. Deliberately NOT importing the numeric-typed SPEC_DEFAULTS
// from models/operations/pdi/templates/autonxt.js: String(79.0) === "79" in
// JS, which would silently drop the ".0" and break exact reproduction of
// today's printed text in the fallback case.
const SPEC_DEFAULTS = {
  rpm_500_bemf:       { nominal: '79.0',  tolMode: '%', tol: '3' },
  rpm_500_current:    { nominal: '6.0',   tolMode: '±', tol: '2.0' },
  rpm_1000_bemf:      { nominal: '155.0', tolMode: '%', tol: '3' },
  rpm_1000_current:   { nominal: '6.0',   tolMode: '±', tol: '2.0' },
  rpm_1500_bemf:      { nominal: '227.0', tolMode: '%', tol: '3' },
  rpm_1500_current:   { nominal: '3.0',   tolMode: '±', tol: '1.0' },
  rpm_1800_bemf:      { nominal: '270.0', tolMode: '%', tol: '3' },
  rpm_1800_current:   { nominal: '3.0',   tolMode: '±', tol: '1.0' },
  rpm_2000_bemf:      { nominal: '', tolMode: '±', tol: '' },
  rpm_2000_current:   { nominal: '', tolMode: '±', tol: '' },
  rpm_2200_bemf:      { nominal: '', tolMode: '±', tol: '' },
  rpm_2200_current:   { nominal: '', tolMode: '±', tol: '' },
  rpm_2500_bemf:      { nominal: '', tolMode: '±', tol: '' },
  rpm_2500_current:   { nominal: '', tolMode: '±', tol: '' },
  rpm_3000_bemf:      { nominal: '', tolMode: '±', tol: '' },
  rpm_3000_current:   { nominal: '', tolMode: '±', tol: '' },
  motor_total_length: { nominal: '467.5', tolMode: '±', tol: '1.0' },
  shaft_op_length:    { nominal: '10.0',  tolMode: '±', tol: '0.5' },
  locating_dia:       { nominal: '180.0', tolMode: 'bilateral', tol: '-0.01', tolMinus: '-0.05' },
};
const SPEC_FIELD_IDS = Object.keys(SPEC_DEFAULTS);

const SPEC_UNIT_PREFIX = {
  rpm_500_current:  { unit: 'A' },
  rpm_1000_current: { unit: 'A' },
  rpm_1500_current: { unit: 'A' },
  rpm_1800_current: { unit: 'A' },
  rpm_2000_current: { unit: 'A' },
  rpm_2200_current: { unit: 'A' },
  rpm_2500_current: { unit: 'A' },
  rpm_3000_current: { unit: 'A' },
  locating_dia:     { prefix: 'Ø' },
};

function formatAutoNxtSpecDisplay(nominal, tolMode, tol, tolMinus, { unit = '', prefix = '' } = {}) {
  const nominalStr = String(nominal ?? '').trim();
  if (!nominalStr) return '-';
  if (tolMode === 'bilateral') {
    return `${prefix}${nominalStr} (${tol} TO ${tolMinus})`;
  }
  return `${prefix}${nominalStr}±${tol}${tolMode === '%' ? '%' : ''}${unit}`;
}

async function run() {
  console.log(DRY_RUN ? 'DRY RUN -- no writes will be made.\n' : 'LIVE RUN -- this will write to the database.\n');

  const { rows: reports } = await pool.query(
    `SELECT report_id, status, data FROM pre_dispatch_inspection_reports WHERE template_id = 'autonxt'`
  );
  console.log(`Found ${reports.length} AutoNXT report(s).\n`);

  let reportsChanged = 0;
  let fieldsChanged = 0;
  let reportsRerendered = 0;

  for (const report of reports) {
    const data = report.data || {};
    const newData = { ...data };
    const changedFieldsForThisReport = [];

    SPEC_FIELD_IDS.forEach((id) => {
      const def = SPEC_DEFAULTS[id];
      const nominal  = data[`spec_${id}`] ?? def.nominal;
      const tolMode  = data[`spec_${id}_tol_mode`] ?? def.tolMode;
      const tol      = data[`spec_${id}_tol`] ?? def.tol;
      const tolMinus = data[`spec_${id}_tol_minus`] ?? def.tolMinus;
      const newDisplay = formatAutoNxtSpecDisplay(nominal, tolMode, tol, tolMinus, SPEC_UNIT_PREFIX[id]);
      const oldDisplay = data[`spec_${id}_display`];
      newData[`spec_${id}_display`] = newDisplay;
      if (oldDisplay !== newDisplay) {
        changedFieldsForThisReport.push({ id, oldDisplay, newDisplay });
      }
    });

    if (changedFieldsForThisReport.length > 0) {
      reportsChanged++;
      fieldsChanged += changedFieldsForThisReport.length;
      console.log(`Report ${report.report_id} (${report.status}):`);
      changedFieldsForThisReport.forEach(({ id, oldDisplay, newDisplay }) => {
        console.log(`  ${id}: ${JSON.stringify(oldDisplay)} -> ${JSON.stringify(newDisplay)}`);
      });
    }

    if (!DRY_RUN) {
      // Written unconditionally for every report (idempotent -- a report
      // whose text already matches is written with the same value), per
      // the design spec: simpler than tracking whether the earlier ??
      // comparison makes a per-field skip worthwhile.
      await pool.query(
        `UPDATE pre_dispatch_inspection_reports SET data = $1 WHERE report_id = $2`,
        [JSON.stringify(newData), report.report_id]
      );

      if (report.status === 'Completed' && changedFieldsForThisReport.length > 0) {
        await PdiReports.reRenderFinalizedReportForMaintenance(report.report_id);
        reportsRerendered++;
        console.log(`  -> PDF re-rendered and re-uploaded to Drive.`);
      }
    }
  }

  console.log(`\n${reportsChanged} of ${reports.length} report(s) had at least one field change (${fieldsChanged} field(s) total).`);
  if (!DRY_RUN) {
    console.log(`${reportsRerendered} finalized report(s) had their PDF re-rendered.`);
  } else {
    console.log('Dry run only -- nothing was written. Re-run without --dry-run to apply.');
  }

  await pool.end();
}

run().catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify the script's formatter matches Task 1's exactly**

Run the same 19-case comparison as Task 1's Step 2, this time against this script's copy of `formatAutoNxtSpecDisplay`/`SPEC_DEFAULTS`/`SPEC_UNIT_PREFIX` (reuse the verification script's body from Task 1, pointed at this file's tables — the expected `display` strings are identical). This confirms the two independent implementations (CRM web, this script) agree, which matters because a report fixed by this script must show the identical text a fresh web edit would also produce.

- [ ] **Step 3: Commit**

```bash
git add scripts/migrations/2026-09-30-fix-autonxt-spec-display.js
git commit -m "feat: add one-time script to fix already-saved AutoNXT reports' display text"
```

---

### Task 5 (controller-personal, not a subagent): live browser verification — CRM

Start the CRM dev server locally against production RDS (established session pattern, including the `FRONTEND_URL` CORS override), open the AutoNXT report form, and confirm:

- The Specification field for at least one `±` field (e.g. Motor Total Length), one `%` field (e.g. any BEMF), and the one `bilateral` field (Locating Diameter) renders visibly disabled/greyed-out.
- Changing that field's Nominal, Tolerance mode, or Tolerance amount immediately updates the Specification preview to match (no page reload/save needed).
- Saving a report and re-fetching it (e.g. via `GET /api/pdi/reports/:id`) shows `spec_<id>_display` matching what the preview showed at save time.

Fix anything found with its own commit before moving on.

---

### Task 6 (controller-personal, not a subagent): pdi-erp-app handoff document

**Files:**
- Create: `pdi-erp-app/docs/pdi-autonxt-spec-display-lock.md`

Addressed to the app developer, following the style of the three prior mobile handoff docs this session (`pdi-finalized-report-editing.md`, `pdi-report-open-timeout.md`, `pdi-general-template-changes.md`). Must cover:

- **The bug, as found:** `pdi-erp-app/src/services/autonxtParity.ts`'s `AUTO_NXT_SPECIFICATIONS`/`initializeAutoNxtParityData` seeds `spec_<id>_display` once from each field's `defaultDisplay`; from then on, `GenericReportEditorScreen.tsx`'s `AutoNxtSpecificationEditor` renders it as a fully independent, freely-editable `Field` alongside Nominal/Tolerance mode/Tolerance amount — with no re-sync between them. Reference the exact reproduced scenario: `rpm_500_bemf` defaults to `defaultDisplay: '79.0±3%'`/`defaultNominal: '79.0'`; a report was found with Nominal changed to `80` and Tolerance changed to `6`, while the display text stayed at the stale default.
- **The fix:** the same per-field unit/prefix table and `formatAutoNxtSpecDisplay` formula as CRM's implementation (reproduce the table and function from Task 1 verbatim in the doc, spacing rules included, so there's no ambiguity — this must match CRM's behavior exactly, string for string). `AutoNxtSpecificationEditor`'s "PDF display text" `Field` becomes read-only/disabled, always showing the live computed value the same way CRM's does. `initializeAutoNxtParityData` stops seeding `spec_<id>_display` from `defaultDisplay` (nominal/mode/tolerance/tolerance-minus seeding is unchanged) — that default is now redundant since the field is always freshly computed.
- **What NOT to build:** don't add a way to override the computed text — it's meant to be fully locked, matching how the equivalent field already works in General's own mobile screen (`ReportEditorScreen.tsx`'s `formatToleranceSpecification`, which this design is intentionally modeled on).
- **Verification checklist**, matching the style of the prior three docs: confirm the field renders disabled and updates live as Nominal/Tolerance/Mode change, for at least one `±`, one `%`, and the `bilateral` field (Locating Diameter); confirm a saved-then-reloaded report's `spec_<id>_display` matches what was shown at save time; confirm the four blank RPM tiers (2000/2200/2500/3000) still show `"-"`, not an empty string, when left unfilled.

After writing it, commit it to `pdi-erp-app`'s local `main` (docs-only commit, established pattern this session — local `main` is currently 12 commits ahead of `origin/main` with prior uncommitted work already sitting there; this follows the same pattern, not pushed):

```bash
cd pdi-erp-app
git add docs/pdi-autonxt-spec-display-lock.md
git commit -m "docs: AutoNXT specification display-text lock handoff for the mobile app"
```

Do not push. Deliver the doc's contents to the user in this conversation as well, same as the prior three handoffs.

---

### Task 7 (controller-personal, not a subagent): dry-run the production fix script

Run the Task 4 script in dry-run mode against production and review the output before anything gets written:

```bash
cd CRM_BACKEND
node scripts/migrations/2026-09-30-fix-autonxt-spec-display.js --dry-run
```

Save the full output for the user to review. **Do not run the script without `--dry-run`** as part of this plan's execution — the real (writing) run requires the user's separate explicit go-ahead in conversation, same as every other production-writing action this session (test-data deletion, migrations, etc.). Report the dry-run's summary (reports scanned, reports that would change, fields that would change, and — separately — how many of those are `Completed` reports that would get a PDF re-render) back to the user and wait for their decision before running it for real.
