# AutoNXT Controller PDI Template Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third PDI template, `autonxt_controller`, covering Pre-Dispatch Inspection of the AutoNXT controller unit — full feature parity with the existing `autonxt` (Motor) template: single-report entry, lot/batch creation, and controlled editing of finalized reports, on both the backend and the web admin app.

**Architecture:** A new template file (`autonxt_controller.js`) registered alongside `general`/`autonxt`, using the existing template-rendering DSL (`mode: 'repeatable'` for the firmware-parameter table whose row list varies by controller type, `mode: 'fixed'` for the general checklist — both patterns already exist and need no renderer changes). The batch system and finalized-report editing are already template-agnostic and need only a small generalization (the `motor_sr_no` finalize-check becomes `motor_sr_no`-or-`controller_sr_no` depending on the batch's template). Two new web components mirror `AutoNXTGeneratorForm.jsx`/`AutoNXTBatchForm.jsx` almost line-for-line, with the tolerance-checking machinery replaced by exact-match parameter checking.

**Tech Stack:** Node.js/Express/PostgreSQL (CRM_BACKEND), React/Vite (CRM). PDFKit-based template renderer (`models/operations/pdi/renderer.js`, unchanged by this plan — every section type it needs already exists).

---

## Spec coverage checklist (self-review)

| Spec section | Task |
|---|---|
| Template registration | Task 1 |
| Section A (presets, repeatable table, exact-match remarks, NA override) | Task 1 (backend), Task 4 (web) |
| Section B (fixed 10-row checklist) | Task 1 (backend), Task 4 (web) |
| Header fields (`controller_sr_no`, `controller_type`) | Task 1 (backend), Task 4 (web) |
| Photos (5 slots) | Task 1 (backend), Task 4 (web) |
| 2-page layout, signature on both pages | Task 1 (backend) |
| Lot/batch support + `CONTROLLER_SR_NO_REQUIRED` | Task 2 (backend), Task 5 (web) |
| Controlled/finalized editing | Inherited for free — verified in Task 6, no new code |
| Web routes | Task 6 |
| Live verification | Task 7 |

---

### Task 1: Backend template — `autonxt_controller.js`

**Files:**
- Create: `models/operations/pdi/templates/autonxt_controller.js`
- Modify: `models/operations/pdi/templates/index.js`
- Test: `tests/pdi_autonxt_controller.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/pdi_autonxt_controller.test.js
const PDFDocument = require('pdfkit');
const { registerFonts } = require('../models/operations/pdi/primitives');
const { renderTemplate } = require('../models/operations/pdi/renderer');
const autonxtControllerTemplate = require('../models/operations/pdi/templates/autonxt_controller');
const { CONTROLLER_TYPE_PRESETS, computeRemarks } = require('../models/operations/pdi/templates/autonxt_controller');

function bufferPdf(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

describe('AutoNXT Controller — CONTROLLER_TYPE_PRESETS', () => {
  it('CASHV38140 preset has exactly 35 rows, transcribed from the reference PDI document', () => {
    const rows = CONTROLLER_TYPE_PRESETS.CASHV38140;
    expect(rows).toHaveLength(35);
    expect(rows[0]).toEqual({ parameter: 'F01.00', specification: '11' });
    expect(rows[rows.length - 1]).toEqual({ parameter: 'F01.13', specification: '37.50' });
    rows.forEach((r) => {
      expect(typeof r.parameter).toBe('string');
      expect(typeof r.specification).toBe('string');
    });
  });
});

describe('AutoNXT Controller — computeRemarks (exact-match, not tolerance)', () => {
  it('returns OK when Measured exactly matches Specification (after trimming)', () => {
    expect(computeRemarks({ specification: '90', measured: '90' })).toBe('OK');
    expect(computeRemarks({ specification: '90', measured: ' 90 ' })).toBe('OK');
  });

  it('returns NG when Measured does not match Specification', () => {
    expect(computeRemarks({ specification: '90', measured: '91' })).toBe('NG');
  });

  it('returns blank when Measured is not yet filled in', () => {
    expect(computeRemarks({ specification: '90', measured: '' })).toBe('');
    expect(computeRemarks({ specification: '90' })).toBe('');
  });

  it('an explicit remarks value (e.g. a manual NA override) always wins over the computed value', () => {
    expect(computeRemarks({ specification: '90', measured: '91', remarks: 'NA' })).toBe('NA');
    expect(computeRemarks({ specification: '90', measured: '90', remarks: 'NA' })).toBe('NA');
  });
});

describe('AutoNXT Controller template renders without throwing', () => {
  it('renders a report with parameter rows, general check, and photos', async () => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 10, bottom: 0, left: 36, right: 36 }, autoFirstPage: false, bufferPages: true });
    registerFonts(doc);
    const data = {
      customer_name: 'Autonxt', pdi_no: 'CASPL-QA-PDI-202509008',
      controller_sr_no: '2500-00184', controller_type: 'CASHV38140',
      parameter_rows: CONTROLLER_TYPE_PRESETS.CASHV38140.map((r) => ({ ...r, measured: r.specification })),
      general_check: { can_card: { measured: 'GO' } },
      photos: {},
    };
    expect(() => renderTemplate(doc, autonxtControllerTemplate, data)).not.toThrow();
    doc.end();
    const buf = await bufferPdf(doc);
    expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('renders an empty/new report (no parameter_rows yet) without throwing', async () => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 10, bottom: 0, left: 36, right: 36 }, autoFirstPage: false, bufferPages: true });
    registerFonts(doc);
    expect(() => renderTemplate(doc, autonxtControllerTemplate, { customer_name: 'New Co.', pdi_no: 'PDI-NEW-1' })).not.toThrow();
    doc.end();
    const buf = await bufferPdf(doc);
    expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-');
  });
});

describe('AutoNXT Controller template is registered', () => {
  it('is reachable via templates/index.js under id "autonxt_controller"', () => {
    const templates = require('../models/operations/pdi/templates');
    expect(templates.autonxt_controller).toBe(autonxtControllerTemplate);
    expect(templates.autonxt_controller.name).toBe('AutoNXT Controller PDI');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/pdi_autonxt_controller.test.js`
Expected: FAIL — `Cannot find module '../models/operations/pdi/templates/autonxt_controller'`

- [ ] **Step 3: Create the template file**

```js
// models/operations/pdi/templates/autonxt_controller.js
'use strict';

const { fmtDate } = require('../primitives');

// ── Section A: Parameter Check — a per-controller-type preset of firmware
//    parameter codes/specs seeds data.parameter_rows at report-creation time
//    (mirrored in CRM's AutoNXTControllerGeneratorForm.jsx and the mobile
//    app -- same duplicated-not-shared convention as every other PDI
//    template constant in this codebase). Unlike AutoNXT Motor's fixed-row
//    tables, the row LIST itself varies by controller type, so rows are real
//    stored data (mode: 'repeatable', same mechanism as General's checklist
//    rows), not recomputed from a template-side function on every render.
//    Transcribed directly from CASPL-QA-PDI-202509008 (a 20-unit CASHV38140
//    lot), confirmed identical across every unit sampled in that document.
const CONTROLLER_TYPE_PRESETS = {
  CASHV38140: [
    { parameter: 'F01.00', specification: '11' },
    { parameter: 'F01.01', specification: '1' },
    { parameter: 'F01.02', specification: '2' },
    { parameter: 'F01.09', specification: '90' },
    { parameter: 'F01.10', specification: '90' },
    { parameter: 'F01.12', specification: '90' },
    { parameter: 'F01.22', specification: '5' },
    { parameter: 'F01.23', specification: '14' },
    { parameter: 'F02.00', specification: '1' },
    { parameter: 'F02.01', specification: '6' },
    { parameter: 'F02.02', specification: '32' },
    { parameter: 'F02.03', specification: '90' },
    { parameter: 'F02.04', specification: '1800' },
    { parameter: 'F02.05', specification: '270' },
    { parameter: 'F02.06', specification: '60' },
    { parameter: 'F02.07', specification: '1' },
    { parameter: 'F05.50', specification: '8.5' },
    { parameter: 'F05.52', specification: '50' },
    { parameter: 'F10.01', specification: '100' },
    { parameter: 'F10.43', specification: '0' },
    { parameter: 'F10.17', specification: '250' },
    { parameter: 'F10.21', specification: '10' },
    { parameter: 'F10.28', specification: '110' },
    { parameter: 'F10.30', specification: '200' },
    { parameter: 'F10.31', specification: '0001' },
    { parameter: 'F10.32', specification: '0001' },
    { parameter: 'F10.34', specification: '1.0' },
    { parameter: 'F10.35', specification: '100' },
    { parameter: 'F10.50', specification: '3' },
    { parameter: 'F10.57', specification: '1' },
    { parameter: 'F07.10', specification: '1' },
    { parameter: 'F07.12', specification: '0.000' },
    { parameter: 'F07.23', specification: '0.00' },
    { parameter: 'F03.15', specification: '100' },
    { parameter: 'F01.13', specification: '37.50' },
  ],
};

// Remarks is sent pre-computed from the client (CRM / mobile app), same
// "computed right before sending" convention as AutoNXT Motor's
// spec_<id>_display (withComputedSpecDisplays). This is also the render-
// time fallback for older or partial data: an explicit row.remarks (e.g. a
// manual NA override) always wins; otherwise OK/NG is derived from an exact
// (trimmed) string match between Measured and Specification -- not a
// tolerance range, since this is firmware-parameter verification, not a
// physical dimension. A row with no Measured value yet renders blank rather
// than a premature NG.
function computeRemarks(row) {
  const explicit = String(row.remarks ?? '').trim();
  if (explicit) return explicit;
  const measured = String(row.measured ?? '').trim();
  if (!measured) return '';
  const spec = String(row.specification ?? '').trim();
  return measured === spec ? 'OK' : 'NG';
}

const PARAMETER_CHECK_COLUMNS = [
  { label: 'S.No', w: 30, align: 'center', key: 'sno' },
  { label: 'Parameter', w: 90, align: 'center', value: (row) => row.parameter || '' },
  { label: 'Specification', w: 90, align: 'center', value: (row) => row.specification || '' },
  { label: 'Measured Value', w: 90, align: 'center', value: (row) => row.measured || '' },
  {
    label: 'Remarks', align: 'center',
    value: (row) => computeRemarks(row),
    isOutOfTolerance: (row) => computeRemarks(row) === 'NG',
  },
];

/* ── Section B: General Check — fixed 10-row Go/NG checklist, same shape as
      AutoNXT Motor's own General Check section (generalCheckColumns in
      autonxt.js), transcribed from the reference document's page 2. ── */
const CONTROLLER_GENERAL_CHECK_ROWS = [
  { key: 'can_card',        sno: 1,  label: 'CAN CARD CHECK',            spec: 'Go/NG', method: 'VI' },
  { key: 'io_card',         sno: 2,  label: 'I/O CARD CHECK',            spec: 'Go/NG', method: 'VI' },
  { key: 'power_connector', sno: 3,  label: 'Power Connector check',     spec: 'Go/NG', method: 'VI' },
  { key: 'pin14_connector', sno: 4,  label: '14PIN Connector check',     spec: 'Go/NG', method: 'VI' },
  { key: 'resolver_conn',   sno: 5,  label: 'Resolver connector',        spec: 'Go/NG', method: 'VI' },
  { key: 'rj45_connector',  sno: 6,  label: 'Rj45 connector check',      spec: 'Go/NG', method: 'VI' },
  { key: 'harness_check',   sno: 7,  label: 'HARNESS CHECK',             spec: 'Go/NG', method: 'VI' },
  { key: 'drive_on_key',    sno: 8,  label: 'DRIVE ON WHEN KEY S/W ON',  spec: 'Go/NG', method: 'TESTING' },
  { key: 'run_750_rpm',     sno: 9,  label: 'RUN @750 RPM WHEN START',   spec: 'Go/NG', method: 'TESTING' },
  { key: 'physical_check',  sno: 10, label: 'PHYSICAL CHECK',            spec: 'Go/NG', method: 'VI' },
];

function controllerGeneralCheckColumns() {
  return [
    { label: 'Sr.No', w: 30, align: 'center', value: (row) => row.sno },
    { label: 'Parameter', w: 180, align: 'left', value: (row) => row.label },
    { label: 'Specification', w: 100, align: 'center', value: (row) => row.spec },
    { label: 'Measurement', w: 90, align: 'center', value: (row, sectionData) => (sectionData[row.key] || {}).measured || 'GO' },
    { label: 'Measurement Method', align: 'center', value: (row) => row.method },
  ];
}

// Both pages sign off with the same 2-role block (Prepared By / Approved
// By) -- unlike AutoNXT Motor's 3-way electrical/mechanical split, this
// template has no electrical/mechanical section distinction, matching the
// reference document exactly (one preparer, one approver, repeated on both
// pages).
const SIG_ROLES = [
  { key: 'prepared_by', label: 'Prepared By' },
  { key: 'approved_by', label: 'Approved By' },
];

// Reserves space after Section A's repeatable table for the Remarks text and
// signature block that follow it on the SAME page, so the auto-paginating
// repeatable-table renderer doesn't let them get orphaned onto a stray
// extra page -- same mechanism and same constants as general.js's own
// REM_H/SIG_H footerHeight reservations.
const REM_H = 40;
const SIG_H = 36;

const autonxtControllerTemplate = {
  id: 'autonxt_controller',
  name: 'AutoNXT Controller PDI',
  version: 1,
  pages: [
    {
      // Page 1 — header, Parameter Check, remarks, signature
      sections: [
        {
          type: 'header', gap: 6,
          companyName: 'Compage Automation Systems Pvt.Ltd.,',
          formatNo: 'CASPL/QA/F/26', revNo: '01', effDate: '20-06-2025',
          logoAsset: 'compage_header_left.png',
          rLabelW: 80,
          infoFields: [
            ['Customer Name:', (d) => d.customer_name || '', 'Dt:', (d) => d.date ? fmtDate(new Date(d.date)) : ''],
            ['Product ID:', (d) => d.product_id || '', 'Dwg. No:', (d) => d.drawing_no || ''],
            ['Product Specifications:', (d) => d.product_specifications || '', 'PDI No:', (d) => d.pdi_no || ''],
            ['Controller Sr.No:', (d) => d.controller_sr_no || '', 'Controller Type:', (d) => d.controller_type || ''],
          ],
        },
        {
          type: 'table', gap: 6,
          title: 'A. Parameter Check:',
          mode: 'repeatable', dataKey: 'parameter_rows',
          columns: PARAMETER_CHECK_COLUMNS, headerHeight: 14, rowHeight: 14,
          footerHeight: () => REM_H + 8 + SIG_H + 8,
        },
        { type: 'text', gap: 8, label: 'Remarks:', dataKey: 'page1_remarks', default: 'ALL OK, PASSED.' },
        { type: 'signature', roles: SIG_ROLES },
      ],
    },
    {
      // Page 2 — General Check, remarks, photos, signature (matches the
      // reference document's own page 2 ordering exactly: checklist table,
      // then "Remarks:", then "Photos:", then the sign-off row at the
      // bottom).
      sections: [
        {
          type: 'table', gap: 6,
          title: 'B. General Check',
          mode: 'fixed', dataKey: 'general_check',
          fixedRows: () => CONTROLLER_GENERAL_CHECK_ROWS, columns: controllerGeneralCheckColumns(),
          headerHeight: 14, rowHeight: 14,
        },
        { type: 'text', gap: 8, label: 'Remarks:', dataKey: 'page2_remarks', default: 'ALL OK, PASSED.' },
        {
          type: 'photo', mode: 'fixed-slots', dataKey: 'photos',
          slots: [
            { key: 'overall_controller', label: 'Overall Controller Photo' },
            { key: 'name_plate', label: 'Controller Name Plate' },
            { key: 'can_io_card', label: 'CAN & I/O Card Inside Drive' },
            { key: 'harness_photo', label: 'Harness Photo' },
            { key: 'packing_photo', label: 'Packing Photo' },
          ],
        },
        { type: 'signature', roles: SIG_ROLES },
      ],
    },
  ],
};

module.exports = autonxtControllerTemplate;
module.exports.CONTROLLER_TYPE_PRESETS = CONTROLLER_TYPE_PRESETS;
module.exports.computeRemarks = computeRemarks;
```

- [ ] **Step 4: Register the template**

In `models/operations/pdi/templates/index.js`, replace the full contents with:

```js
'use strict';

const general = require('./general');
const autonxt = require('./autonxt');
const autonxtController = require('./autonxt_controller');

const TEMPLATES = [general, autonxt, autonxtController];

module.exports = Object.fromEntries(TEMPLATES.map((t) => [t.id, t]));
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest tests/pdi_autonxt_controller.test.js`
Expected: PASS — all 7 tests green.

- [ ] **Step 6: Run the full existing PDI test suite to confirm nothing else broke**

Run: `npx jest tests/pdi_`
Expected: PASS — every existing PDI test file (general/autonxt/batches/finalized-edit/delete) still passes unchanged. This file only adds a new, additive template id; nothing about `general`/`autonxt` changes.

- [ ] **Step 7: Commit**

```bash
git add models/operations/pdi/templates/autonxt_controller.js models/operations/pdi/templates/index.js tests/pdi_autonxt_controller.test.js
git commit -m "feat: add AutoNXT Controller PDI template (Section A parameter check, Section B general check, 5 photo slots)"
```

---

### Task 2: Batch finalize — generalize the serial-number requirement

**Files:**
- Modify: `models/operations/pdiReportBatches.js:148-159`
- Modify: `controllers/operations/pdiReportBatches.controller.js:72`
- Test: `tests/pdi_report_batches.test.js`

- [ ] **Step 1: Write the failing test**

Add this test to `tests/pdi_report_batches.test.js`, in the same `describe('finalizeBatch', ...)` block that already contains the `'fails the whole batch ... missing motor_sr_no'` test (mirror its exact shape, just for the controller template and field):

```js
  it('fails the whole batch before marking anything Completed if one report is missing controller_sr_no (autonxt_controller template)', async () => {
    mockState.poolQueryImpl = async (sql) => {
      if (/SELECT [\s\S]*FROM pdi_report_batches WHERE batch_id/.test(sql)) {
        return { rows: [{ batch_id: 101, template_id: 'autonxt_controller', pdi_no: 'PDI-2026-001', lot_quantity: 2, status: 'In Progress' }] };
      }
      if (/SELECT [\s\S]*FROM pre_dispatch_inspection_reports WHERE batch_id/.test(sql)) {
        return {
          rows: [
            reportRow(1, { template_id: 'autonxt_controller', data: { pdi_no: 'PDI-2026-001', controller_sr_no: 'SR1' } }),
            reportRow(2, { template_id: 'autonxt_controller', data: { pdi_no: 'PDI-2026-001' /* no controller_sr_no */ } }),
          ],
        };
      }
      return { rows: [], rowCount: 0 };
    };
    await expect(PdiReportBatches.finalizeBatch(101)).rejects.toMatchObject({ code: 'CONTROLLER_SR_NO_REQUIRED' });
    expect(mockUpload).not.toHaveBeenCalled();

    const updateCalls = mockClient.query.mock.calls.filter(([sql]) => /UPDATE pre_dispatch_inspection_reports/.test(sql));
    expect(updateCalls).toHaveLength(0);
  });

  it('an autonxt_controller batch with every controller_sr_no set does NOT require motor_sr_no', async () => {
    mockState.poolQueryImpl = async (sql) => {
      if (/SELECT [\s\S]*FROM pdi_report_batches WHERE batch_id/.test(sql)) {
        return { rows: [{ batch_id: 101, template_id: 'autonxt_controller', pdi_no: 'PDI-2026-001', lot_quantity: 1, status: 'In Progress' }] };
      }
      if (/SELECT [\s\S]*FROM pre_dispatch_inspection_reports WHERE batch_id/.test(sql)) {
        return {
          rows: [reportRow(1, {
            template_id: 'autonxt_controller',
            template_version: 1,
            data: { pdi_no: 'PDI-2026-001', controller_sr_no: 'SR1' },
          })],
        };
      }
      return { rows: [], rowCount: 0 };
    };
    mockUpload.mockResolvedValue({ id: 'drive-file-1' });
    const result = await PdiReportBatches.finalizeBatch(101);
    expect(result.payload.status).toBe('Completed');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/pdi_report_batches.test.js -t "controller_sr_no"`
Expected: FAIL — the current code always throws `MOTOR_SR_NO_REQUIRED` regardless of `template_id`, so the first new test gets the wrong error code and the second new test throws instead of succeeding.

- [ ] **Step 3: Generalize the check in the model**

In `models/operations/pdiReportBatches.js`, replace the per-report validation loop (currently lines 148-159):

```js
    for (const report of reports) {
      if (!report.data?.pdi_no) {
        const err = new Error(`Report ${report.report_id} (lot ${report.lot_index}) is missing pdi_no.`);
        err.code = 'PDI_NO_REQUIRED';
        throw err;
      }
      if (!report.data?.motor_sr_no) {
        const err = new Error(`Report ${report.report_id} (lot ${report.lot_index}) is missing motor_sr_no.`);
        err.code = 'MOTOR_SR_NO_REQUIRED';
        throw err;
      }
    }
```

with:

```js
    // A batch is homogeneous -- createBatch stamps every linked report with
    // the same template_id -- so which serial-number field is required is
    // decided once from the batch itself, not per report.
    const srNoField = batch.template_id === 'autonxt_controller' ? 'controller_sr_no' : 'motor_sr_no';
    const srNoErrorCode = batch.template_id === 'autonxt_controller' ? 'CONTROLLER_SR_NO_REQUIRED' : 'MOTOR_SR_NO_REQUIRED';

    for (const report of reports) {
      if (!report.data?.pdi_no) {
        const err = new Error(`Report ${report.report_id} (lot ${report.lot_index}) is missing pdi_no.`);
        err.code = 'PDI_NO_REQUIRED';
        throw err;
      }
      if (!report.data?.[srNoField]) {
        const err = new Error(`Report ${report.report_id} (lot ${report.lot_index}) is missing ${srNoField}.`);
        err.code = srNoErrorCode;
        throw err;
      }
    }
```

- [ ] **Step 4: Map the new error code to a 400 in the controller**

In `controllers/operations/pdiReportBatches.controller.js`, in `exports.finalizeBatch`'s catch block, add one line right after the existing `MOTOR_SR_NO_REQUIRED` mapping:

```js
    if (error.code === 'MOTOR_SR_NO_REQUIRED') return res.status(400).json({ error: error.message, code: error.code });
    if (error.code === 'CONTROLLER_SR_NO_REQUIRED') return res.status(400).json({ error: error.message, code: error.code });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest tests/pdi_report_batches.test.js`
Expected: PASS — all tests in the file, including the two new ones and the pre-existing `motor_sr_no` test (which must still pass unchanged for `template_id: 'autonxt'`, proving the generalization didn't break the existing behavior).

- [ ] **Step 6: Commit**

```bash
git add models/operations/pdiReportBatches.js controllers/operations/pdiReportBatches.controller.js tests/pdi_report_batches.test.js
git commit -m "feat: require controller_sr_no (not motor_sr_no) before finalizing an AutoNXT Controller batch"
```

---

### Task 3: Confirm finalized-report editing needs zero new backend code

**Files:** None modified — a verification-only task.

- [ ] **Step 1: Confirm `patchReport`/`deleteReport` have no template_id branches**

Run:
```bash
grep -n "template_id" models/operations/pdiReports.js
```
Expected: the only matches are in `createReport`/`resolveTemplateVersion`/`#toPayload` (reading/storing whatever `template_id` was given) — none in `patchReport`, `deleteReport`, the revision-tracking logic, or the permission/conflict checks (`FINALIZED_REPORT_FORBIDDEN`, `REPORT_VERSION_CONFLICT`). If any such branch exists, stop and report it — the spec assumed this logic is fully template-agnostic, and if that's wrong, this plan needs a new task before continuing, not a silent workaround.

- [ ] **Step 2: Note the result**

If confirmed (expected outcome): no code change needed here. A report with `template_id: 'autonxt_controller'` already gets permission-gated editing, `revision_no` tracking, and the full `pdi_report_revisions` audit trail for free, the same as `general` and `autonxt` reports do today. This gets exercised for real in Task 7's live verification, not re-implemented here.

---

### Task 4: Web — `AutoNXTControllerGeneratorForm.jsx`

**Files:**
- Create: `CRM/src/components/admin/AutoNXTControllerGeneratorForm.jsx`

This mirrors `CRM/src/components/admin/AutoNXTGeneratorForm.jsx` closely: the image-upload/crop pipeline (`ImageUploadCard`, `CropModal`, `fileToDataUri`, `loadImage`, `cropAndCompress`), the revision-aware save/finalize machinery (`finalizedEditExtras`, `handleSaveError`, `handleSave`, `handleFinalize`, `handleOpen`, `handleClose`), and the overall open/modal/tabs structure are copied verbatim from that file — none of that is template-specific. What's different: no tolerance/`SPEC_DEFAULTS` machinery at all (replaced by exact-match parameter rows), a 2-role signature instead of 3, 5 photo slots instead of 6, and Section A is a controller-type-driven repeatable row list instead of a fixed table.

- [ ] **Step 1: Create the file**

```jsx
// CRM/src/components/admin/AutoNXTControllerGeneratorForm.jsx
import { useState, useRef, useCallback, useEffect } from 'react';
import Modal from 'react-modal';
import Cropper from 'react-easy-crop';
import axios from 'axios';
import { useSearchParams } from 'react-router-dom';
import { Download, FileText, ClipboardCheck, Image as ImageIcon, X, Camera } from 'lucide-react';
import { useNotify } from '../../hooks/useNotify';

Modal.setAppElement('#root');

const API_URL = import.meta.env.VITE_BACKEND_URL || '';

// Same image pipeline as AutoNXTGeneratorForm.jsx / PDIGeneratorForm.jsx —
// duplicated rather than shared, matching this project's deliberate choice
// to keep each PDI template's form as its own standalone component.
const MAX_RAW_IMAGE_BYTES = 20 * 1024 * 1024;
const CROP_ASPECT = 4 / 3;
const COMPRESS_MAX_DIM = 1600;
const COMPRESS_QUALITY = 0.85;

const fileToDataUri = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });

const loadImage = (src) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to decode image'));
    img.src = src;
  });

async function cropAndCompress(imageSrc, cropPixels) {
  const img = await loadImage(imageSrc);
  const { x, y, width, height } = cropPixels;
  let outW = width;
  let outH = height;
  if (Math.max(outW, outH) > COMPRESS_MAX_DIM) {
    const scale = COMPRESS_MAX_DIM / Math.max(outW, outH);
    outW = Math.round(outW * scale);
    outH = Math.round(outH * scale);
  }
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, x, y, width, height, 0, 0, outW, outH);

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Failed to encode image'))), 'image/jpeg', COMPRESS_QUALITY);
  });
  return fileToDataUri(blob);
}

// ── Keys MUST match CRM_BACKEND/models/operations/pdi/templates/
// autonxt_controller.js exactly (same duplicated-not-shared convention as
// AutoNXTGeneratorForm.jsx's own row/section definitions). ──
const CONTROLLER_TYPE_PRESETS = {
  CASHV38140: [
    { parameter: 'F01.00', specification: '11' },
    { parameter: 'F01.01', specification: '1' },
    { parameter: 'F01.02', specification: '2' },
    { parameter: 'F01.09', specification: '90' },
    { parameter: 'F01.10', specification: '90' },
    { parameter: 'F01.12', specification: '90' },
    { parameter: 'F01.22', specification: '5' },
    { parameter: 'F01.23', specification: '14' },
    { parameter: 'F02.00', specification: '1' },
    { parameter: 'F02.01', specification: '6' },
    { parameter: 'F02.02', specification: '32' },
    { parameter: 'F02.03', specification: '90' },
    { parameter: 'F02.04', specification: '1800' },
    { parameter: 'F02.05', specification: '270' },
    { parameter: 'F02.06', specification: '60' },
    { parameter: 'F02.07', specification: '1' },
    { parameter: 'F05.50', specification: '8.5' },
    { parameter: 'F05.52', specification: '50' },
    { parameter: 'F10.01', specification: '100' },
    { parameter: 'F10.43', specification: '0' },
    { parameter: 'F10.17', specification: '250' },
    { parameter: 'F10.21', specification: '10' },
    { parameter: 'F10.28', specification: '110' },
    { parameter: 'F10.30', specification: '200' },
    { parameter: 'F10.31', specification: '0001' },
    { parameter: 'F10.32', specification: '0001' },
    { parameter: 'F10.34', specification: '1.0' },
    { parameter: 'F10.35', specification: '100' },
    { parameter: 'F10.50', specification: '3' },
    { parameter: 'F10.57', specification: '1' },
    { parameter: 'F07.10', specification: '1' },
    { parameter: 'F07.12', specification: '0.000' },
    { parameter: 'F07.23', specification: '0.00' },
    { parameter: 'F03.15', specification: '100' },
    { parameter: 'F01.13', specification: '37.50' },
  ],
};
const DEFAULT_CONTROLLER_TYPE = 'CASHV38140';

const CONTROLLER_GENERAL_CHECK_ROWS = [
  { key: 'can_card',        label: 'CAN CARD CHECK',            spec: 'Go/NG', method: 'VI' },
  { key: 'io_card',         label: 'I/O CARD CHECK',            spec: 'Go/NG', method: 'VI' },
  { key: 'power_connector', label: 'Power Connector check',     spec: 'Go/NG', method: 'VI' },
  { key: 'pin14_connector', label: '14PIN Connector check',     spec: 'Go/NG', method: 'VI' },
  { key: 'resolver_conn',   label: 'Resolver connector',        spec: 'Go/NG', method: 'VI' },
  { key: 'rj45_connector',  label: 'Rj45 connector check',      spec: 'Go/NG', method: 'VI' },
  { key: 'harness_check',   label: 'HARNESS CHECK',             spec: 'Go/NG', method: 'VI' },
  { key: 'drive_on_key',    label: 'DRIVE ON WHEN KEY S/W ON',  spec: 'Go/NG', method: 'TESTING' },
  { key: 'run_750_rpm',     label: 'RUN @750 RPM WHEN START',   spec: 'Go/NG', method: 'TESTING' },
  { key: 'physical_check',  label: 'PHYSICAL CHECK',            spec: 'Go/NG', method: 'VI' },
];

const PHOTO_SLOTS = [
  { key: 'overall_controller', label: 'Overall Controller Photo' },
  { key: 'name_plate', label: 'Controller Name Plate' },
  { key: 'can_io_card', label: 'CAN & I/O Card Inside Drive' },
  { key: 'harness_photo', label: 'Harness Photo' },
  { key: 'packing_photo', label: 'Packing Photo' },
];

const MEASURED_OPTIONS = ['GO', 'NG', 'NA'];

// Mirrors CRM_BACKEND/models/operations/pdi/templates/autonxt_controller.js's
// computeRemarks exactly (same duplicated-rather-than-shared convention as
// every other PDI template formula in this codebase). An explicit
// `remarksOverride` (set via the Remarks dropdown below, currently only
// ever 'NA') always wins; otherwise OK/NG is derived from an exact
// (trimmed) string match between Measured and Specification.
function computeRemarks(row) {
  if (row.remarksOverride) return row.remarksOverride;
  const measured = String(row.measured ?? '').trim();
  if (!measured) return '';
  const specification = String(row.specification ?? '').trim();
  return measured === specification ? 'OK' : 'NG';
}

// Recomputes every row's final `remarks` string right before sending — this
// is the actual save-time source of truth, same principle as AutoNXT
// Motor's withComputedSpecDisplays. `remarksOverride` is kept in the sent
// row (not stripped) so reloading the report round-trips whether a row was
// manually set to NA.
function withComputedParameterRows(data) {
  return {
    ...data,
    parameter_rows: (data.parameter_rows || []).map((row) => ({ ...row, remarks: computeRemarks(row) })),
  };
}

const seedParameterRows = (type) =>
  (CONTROLLER_TYPE_PRESETS[type] || []).map((r) => ({ ...r, measured: '', remarksOverride: null }));

const todayIST = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());

const initChecklist = (rows) => Object.fromEntries(rows.map((r) => [r.key, { measured: 'GO' }]));

const defaultForm = () => ({
  customer_name: '', date: todayIST(), product_id: '', drawing_no: '',
  product_specifications: '', pdi_no: '', controller_sr_no: '', controller_type: DEFAULT_CONTROLLER_TYPE,
  parameter_rows: seedParameterRows(DEFAULT_CONTROLLER_TYPE),
  general_check: initChecklist(CONTROLLER_GENERAL_CHECK_ROWS),
  page1_remarks: 'ALL OK, PASSED.',
  page2_remarks: 'ALL OK, PASSED.',
  prepared_by: '', approved_by: '',
  photos: Object.fromEntries(PHOTO_SLOTS.map((s) => [s.key, []])),
});

const INPUT_CLS =
  'w-full border border-navy-100 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold-400';
const SELECT_CLS =
  'border border-navy-100 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold-400';
const TH_CLS = 'py-2 px-2 text-xs font-semibold text-navy-800 bg-navy-50 border border-navy-100 whitespace-nowrap';
const TD_CLS = 'py-1 px-1 border border-navy-100 text-sm text-gray-500 text-center';

// Multi-image version, ported from AutoNXTGeneratorForm.jsx's own copy
// (same "duplicated rather than shared" convention).
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

function CropModal({ imageSrc, onCancel, onApply }) {
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState(null);
  const [busy, setBusy] = useState(false);
  const { notifyError } = useNotify();

  const handleCropComplete = useCallback((_area, pixels) => {
    setCroppedAreaPixels(pixels);
  }, []);

  const handleApply = async () => {
    if (!croppedAreaPixels) return;
    setBusy(true);
    try {
      const dataUri = await cropAndCompress(imageSrc, croppedAreaPixels);
      onApply(dataUri);
    } catch {
      notifyError('Failed to process image. Please try a different photo.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      isOpen
      onRequestClose={onCancel}
      overlayClassName="fixed inset-0 bg-navy-900/50 flex items-center justify-center z-[60] p-4"
      className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-auto outline-none max-h-[95vh] overflow-y-auto"
      contentLabel="Crop Image"
    >
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
        <h3 className="font-display text-base font-semibold text-navy-800">Adjust photo</h3>
        <button type="button" onClick={onCancel} className="text-gray-400 hover:text-navy-800 text-xl leading-none transition-colors">&times;</button>
      </div>
      <div className="relative bg-gray-900" style={{ height: 320 }}>
        <Cropper
          image={imageSrc}
          crop={crop}
          zoom={zoom}
          aspect={CROP_ASPECT}
          onCropChange={setCrop}
          onZoomChange={setZoom}
          onCropComplete={handleCropComplete}
        />
      </div>
      <div className="px-5 py-4 space-y-3">
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Zoom</label>
          <input
            type="range"
            min={1}
            max={3}
            step={0.01}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="w-full"
          />
        </div>
        <div className="flex justify-end gap-3">
          <button type="button" onClick={onCancel} className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors text-sm">
            Cancel
          </button>
          <button
            type="button"
            onClick={handleApply}
            disabled={busy || !croppedAreaPixels}
            className="px-4 py-2 bg-navy-800 text-white rounded-lg hover:bg-navy-700 transition-colors disabled:opacity-50 text-sm font-semibold"
          >
            {busy ? 'Processing...' : 'Apply'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export default function AutoNXTControllerGeneratorForm() {
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState(false);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState('parameters');
  const [form, setForm] = useState(defaultForm);
  const [reportId, setReportId] = useState(null);
  const [hasSaved, setHasSaved] = useState(false);
  const [revisionNo, setRevisionNo] = useState(null);
  const [reportStatus, setReportStatus] = useState(null);
  const [hasConflict, setHasConflict] = useState(false);
  const { notifySuccess, notifyError } = useNotify();
  const abortRef = useRef(null);

  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const [searchParams, setSearchParams] = useSearchParams();

  useEffect(() => {
    const resumeId = searchParams.get('report');
    if (!resumeId) return;

    (async () => {
      const token = localStorage.getItem('token');
      if (!token) { notifyError('Please log in first.'); setSearchParams({}, { replace: true }); return; }
      try {
        const response = await axios.get(`${API_URL}/api/pdi/reports/${resumeId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const report = response.data;
        const base = defaultForm();
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
        setReportId(report.report_id);
        setRevisionNo(report.revision_no ?? null);
        setReportStatus(report.status ?? null);
        setHasSaved(true);
        setHasConflict(false);
        setActiveTab('parameters');
        setIsOpen(true);
      } catch (err) {
        notifyError(err.response?.data?.error || 'Could not load that PDI report.');
      } finally {
        setSearchParams({}, { replace: true });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setField = useCallback((field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  }, []);

  const setChecklistField = useCallback((section, key, subfield, value) => {
    setForm((prev) => ({
      ...prev,
      [section]: { ...prev[section], [key]: { ...prev[section][key], [subfield]: value } },
    }));
  }, []);

  // Changing Controller Type reseeds Section A from that type's preset —
  // this wipes any already-entered Measured values for the OLD type's rows,
  // which is correct: the two types' parameter lists aren't the same rows
  // with different specs, they're a genuinely different list. Expected
  // workflow is to pick the type once, up front, before filling anything in.
  const updateControllerType = useCallback((type) => {
    setForm((prev) => ({ ...prev, controller_type: type, parameter_rows: seedParameterRows(type) }));
  }, []);

  const updateParameterRow = useCallback((idx, field, value) => {
    setForm((prev) => {
      const rows = [...prev.parameter_rows];
      rows[idx] = { ...rows[idx], [field]: value };
      return { ...prev, parameter_rows: rows };
    });
  }, []);

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

  const handleOpen = async () => {
    if (opening) return;
    const token = localStorage.getItem('token');
    if (!token) { notifyError('Please log in first.'); return; }
    setOpening(true);
    try {
      const response = await axios.post(`${API_URL}/api/pdi/reports`, { template_id: 'autonxt_controller', inspection_date: todayIST() }, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setReportId(response.data.report_id);
      setRevisionNo(response.data.revision_no ?? null);
      setReportStatus(response.data.status ?? null);
      setHasSaved(false);
      setHasConflict(false);
      setForm(defaultForm());
      setActiveTab('parameters');
      setIsOpen(true);
    } catch (err) {
      notifyError(err.response?.data?.error || 'Could not start a new PDI report.');
    } finally {
      setOpening(false);
    }
  };

  const inspectedByValue = () => (form.prepared_by || '').trim() || undefined;

  // Omits `status` and adds `expected_revision` when the loaded report is
  // already Completed — same pattern as AutoNXTGeneratorForm.jsx (this logic
  // is fully template-agnostic, copied verbatim).
  const finalizedEditExtras = () =>
    reportStatus === 'Completed' ? { expected_revision: revisionNo } : { status: 'In Progress' };

  const handleSaveError = async (err) => {
    const code = err.response?.data?.code;
    if (code === 'FINALIZED_REPORT_FORBIDDEN') {
      notifyError('You don’t have permission to edit a finalized report.');
      return;
    }
    if (code === 'REPORT_VERSION_CONFLICT') {
      notifyError('This report changed since you loaded it. Close and reopen it to see the latest version before saving again.');
      setHasConflict(true);
      if (!reportId) return;
      try {
        const token = localStorage.getItem('token');
        const response = await axios.get(`${API_URL}/api/pdi/reports/${reportId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        setRevisionNo(response.data.revision_no ?? null);
        setReportStatus(response.data.status ?? null);
      } catch {
        // If the reload itself fails, the next save attempt will just hit
        // the same 409 again and re-trigger this same path.
      }
      return;
    }
    notifyError(err.response?.data?.error || 'Failed to save progress.');
  };

  const handleSave = async () => {
    if (!reportId) return;
    const token = localStorage.getItem('token');
    if (!token) { notifyError('Please log in first.'); return; }
    setSaving(true);
    try {
      const { photos, ...data } = form;
      const response = await axios.patch(`${API_URL}/api/pdi/reports/${reportId}`, {
        data: withComputedParameterRows(data), photos, inspected_by: inspectedByValue(),
        inspection_date: form.date || undefined,
        ...finalizedEditExtras(),
      }, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setRevisionNo(response.data.revision_no ?? revisionNo);
      setHasSaved(true);
      notifySuccess('Progress saved.');
    } catch (err) {
      await handleSaveError(err);
    } finally {
      setSaving(false);
    }
  };

  const handleFinalize = async (e) => {
    e.preventDefault();
    if (!form.customer_name.trim()) { notifyError('Customer name is required.'); return; }
    if (!form.pdi_no.trim()) { notifyError('PDI No. is required.'); return; }
    if (!reportId) { notifyError('Report not initialized yet — please close and reopen the form.'); return; }

    const token = localStorage.getItem('token');
    if (!token) { notifyError('Please log in first.'); return; }

    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);

    try {
      const { photos, ...data } = form;
      const saveResponse = await axios.patch(`${API_URL}/api/pdi/reports/${reportId}`, {
        data: withComputedParameterRows(data), photos, inspected_by: inspectedByValue(),
        inspection_date: form.date || undefined,
        ...finalizedEditExtras(),
      }, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      setRevisionNo(saveResponse.data.revision_no ?? revisionNo);
      setHasSaved(true);

      const response = await axios.post(`${API_URL}/api/pdi/reports/${reportId}/finalize`, {}, {
        headers: { Authorization: `Bearer ${token}` },
        responseType: 'blob',
        signal: controller.signal,
      });

      const blob = new Blob([response.data], { type: 'application/pdf' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `PDI_${form.pdi_no.replace(/[^a-zA-Z0-9_-]/g, '_')}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      notifySuccess('PDI finalized and PDF downloaded successfully.');
      setIsOpen(false);
      setReportId(null);
      setHasSaved(false);
    } catch (err) {
      if (err.name === 'CanceledError' || err.name === 'AbortError') return;
      const code = err.response?.data?.code;
      if (code === 'FINALIZED_REPORT_FORBIDDEN' || code === 'REPORT_VERSION_CONFLICT') {
        await handleSaveError(err);
        return;
      }
      if (err.response?.data instanceof Blob) {
        try {
          const text = await err.response.data.text();
          const parsed = JSON.parse(text);
          notifyError(parsed.error || text || 'Failed to finalize PDI.');
        } catch {
          notifyError('Failed to finalize PDI.');
        }
      } else {
        notifyError(err.response?.data?.error || 'Failed to finalize PDI.');
      }
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  };

  const handleClose = async () => {
    if (abortRef.current) abortRef.current.abort();
    if (reportId && !hasSaved) {
      try {
        const token = localStorage.getItem('token');
        await axios.delete(`${API_URL}/api/pdi/reports/${reportId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch (err) {
        console.error('Failed to clean up unsaved PDI draft:', err);
      }
    }
    setIsOpen(false);
    setReportId(null);
    setHasSaved(false);
  };

  return (
    <div className="max-w-7xl mx-auto space-y-4">
      <div className="max-w-3xl mx-auto">
        <div
          onClick={handleOpen}
          className="bg-white rounded-xl shadow-sm p-5 sm:p-8 cursor-pointer border-2 border-dashed border-navy-100 hover:border-gold-400 transition-colors flex items-center gap-4 sm:gap-6"
        >
          <div className="p-3 sm:p-4 bg-navy-50 rounded-xl shrink-0">
            <ClipboardCheck size={40} className="text-gold-600" />
          </div>
          <div className="min-w-0">
            <h2 className="text-xl sm:text-2xl font-bold text-navy-800">New AutoNXT Controller Pre-Dispatch Inspection</h2>
            <p className="text-gray-500 mt-1">
              Fill in controller parameter checks and generate a 2-page PDI report PDF (Format No: CASPL/QA/F/26)
            </p>
            <span className="inline-block mt-3 px-4 py-1.5 bg-gold-500 text-navy-900 rounded-lg text-sm font-semibold">
              + Create PDI
            </span>
          </div>
        </div>

        <p className="text-center text-gray-400 text-sm mt-6">
          Click the card above to open the PDI form and generate the PDF
        </p>
        <p className="text-center text-sm mt-2">
          <a href="/pdi-generator/autonxt-controller-batch" className="text-gold-600 hover:underline font-medium">
            Creating several controllers in one lot? Use batch creation instead →
          </a>
        </p>
      </div>

      <Modal
        isOpen={isOpen}
        onRequestClose={handleClose}
        overlayClassName="fixed inset-0 bg-navy-900/50 flex items-start justify-center z-50 overflow-y-auto py-4 sm:py-8"
        className="bg-white rounded-2xl shadow-2xl w-full min-w-0 max-w-5xl mx-4 outline-none"
        contentLabel="AutoNXT Controller PDI Generator Form"
      >
        <form onSubmit={handleFinalize}>
          <div className="flex items-center justify-between gap-3 px-4 sm:px-8 py-4 sm:py-5 border-b border-gray-100">
            <div className="flex items-center gap-3">
              <FileText className="text-gold-600" size={24} />
              <div>
                <h2 className="font-display text-xl font-bold text-navy-800">Pre-Dispatch Inspection (PDI) — AutoNXT Controller</h2>
                <p className="text-xs text-gray-400">Format No: CASPL/QA/F/26 · Rev. No:01 · Eff. Dt:20-06-2025</p>
              </div>
            </div>
            <button type="button" onClick={handleClose} className="shrink-0 px-2 text-gray-400 hover:text-navy-800 text-2xl leading-none transition-colors">&times;</button>
          </div>

          <div className="px-4 sm:px-8 py-5 sm:py-6 space-y-6 max-h-[62vh] sm:max-h-[80vh] overflow-y-auto">

            {/* ── Header fields ── */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-navy-800 mb-1">Customer Name <span className="text-red-500">*</span></label>
                <input className={INPUT_CLS} value={form.customer_name} onChange={(e) => setField('customer_name', e.target.value)} placeholder="e.g. Autonxt" />
              </div>
              <div>
                <label className="block text-sm font-medium text-navy-800 mb-1">Date</label>
                <input type="date" className={INPUT_CLS} value={form.date} onChange={(e) => setField('date', e.target.value)} />
              </div>
              <div>
                <label className="block text-sm font-medium text-navy-800 mb-1">Product ID</label>
                <input className={INPUT_CLS} value={form.product_id} onChange={(e) => setField('product_id', e.target.value)} />
              </div>
              <div>
                <label className="block text-sm font-medium text-navy-800 mb-1">Drawing No.</label>
                <input className={INPUT_CLS} value={form.drawing_no} onChange={(e) => setField('drawing_no', e.target.value)} />
              </div>
              <div>
                <label className="block text-sm font-medium text-navy-800 mb-1">Product Specifications</label>
                <input className={INPUT_CLS} value={form.product_specifications} onChange={(e) => setField('product_specifications', e.target.value)} />
              </div>
              <div>
                <label className="block text-sm font-medium text-navy-800 mb-1">PDI No. <span className="text-red-500">*</span></label>
                <input className={INPUT_CLS} value={form.pdi_no} onChange={(e) => setField('pdi_no', e.target.value)} placeholder="e.g. CASPL-QA-PDI-202509008" />
              </div>
              <div>
                <label className="block text-sm font-medium text-navy-800 mb-1">Controller Sr.No</label>
                <input className={INPUT_CLS} value={form.controller_sr_no} onChange={(e) => setField('controller_sr_no', e.target.value)} placeholder="e.g. 2500-00184" />
              </div>
              <div>
                <label className="block text-sm font-medium text-navy-800 mb-1">Controller Type</label>
                <select className={SELECT_CLS + ' w-full'} value={form.controller_type} onChange={(e) => updateControllerType(e.target.value)}>
                  {Object.keys(CONTROLLER_TYPE_PRESETS).map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
              </div>
            </div>

            {/* ── Tabs ── */}
            <div className="border-b border-navy-100">
              <nav className="flex gap-1">
                {[
                  { key: 'parameters', label: 'Parameter Check (Pg 1)' },
                  { key: 'general', label: 'General Check (Pg 2)' },
                  { key: 'photos', label: 'Photos (Pg 2)' },
                ].map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setActiveTab(tab.key)}
                    className={`px-5 py-2.5 text-sm font-medium rounded-t-lg border-b-2 transition-colors ${
                      activeTab === tab.key
                        ? 'border-navy-800 text-navy-800 bg-navy-50'
                        : 'border-transparent text-gray-500 hover:text-navy-700 hover:bg-navy-50/60'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </nav>
            </div>

            {/* ── Parameter Check Tab ── */}
            {activeTab === 'parameters' && (
              <div className="space-y-5">
                <div>
                  <h3 className="text-sm font-semibold text-navy-800 mb-2">A. Parameter Check</h3>
                  <div className="overflow-x-auto rounded-lg border border-navy-100">
                    <table className="w-full text-left">
                      <thead>
                        <tr>
                          <th className={TH_CLS}>S.No</th>
                          <th className={TH_CLS}>Parameter</th>
                          <th className={TH_CLS}>Specification</th>
                          <th className={TH_CLS}>Measured Value</th>
                          <th className={TH_CLS}>Remarks</th>
                        </tr>
                      </thead>
                      <tbody>
                        {form.parameter_rows.map((row, idx) => {
                          const computed = computeRemarks(row);
                          return (
                            <tr key={`${row.parameter}-${idx}`} className={idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                              <td className={TD_CLS}>{idx + 1}</td>
                              <td className={TD_CLS}>{row.parameter}</td>
                              <td className={TD_CLS}>{row.specification}</td>
                              <td className="py-1 px-1 border border-navy-100">
                                <input
                                  className={`${INPUT_CLS} ${computed === 'NG' ? 'border-red-500 bg-red-50' : ''}`}
                                  value={row.measured}
                                  onChange={(e) => updateParameterRow(idx, 'measured', e.target.value)}
                                />
                              </td>
                              <td className="py-1 px-1 border border-navy-100">
                                <select
                                  className={SELECT_CLS}
                                  value={row.remarksOverride || 'auto'}
                                  onChange={(e) => updateParameterRow(idx, 'remarksOverride', e.target.value === 'auto' ? null : e.target.value)}
                                >
                                  <option value="auto">{computed || '—'}</option>
                                  <option value="NA">NA</option>
                                </select>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-navy-800 mb-1">Page 1 Remarks</label>
                  <textarea
                    rows={2}
                    className={INPUT_CLS}
                    value={form.page1_remarks}
                    onChange={(e) => setField('page1_remarks', e.target.value)}
                  />
                </div>
              </div>
            )}

            {/* ── General Check Tab ── */}
            {activeTab === 'general' && (
              <div className="space-y-5">
                <div>
                  <h3 className="text-sm font-semibold text-navy-800 mb-2">B. General Check</h3>
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
                        {CONTROLLER_GENERAL_CHECK_ROWS.map((row) => (
                          <tr key={row.key} className="border-t border-navy-100 hover:bg-navy-50/60 transition-colors">
                            <td className="py-2 px-3 text-sm text-gray-700">{row.label}</td>
                            <td className={TD_CLS}>{row.spec}</td>
                            <td className={TD_CLS}>{row.method}</td>
                            <td className="py-1 px-2 border border-navy-100 text-center">
                              <select
                                className={SELECT_CLS}
                                value={form.general_check[row.key].measured}
                                onChange={(e) => setChecklistField('general_check', row.key, 'measured', e.target.value)}
                              >
                                {MEASURED_OPTIONS.map((o) => <option key={o}>{o}</option>)}
                              </select>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-navy-800 mb-1">Page 2 Remarks</label>
                  <textarea
                    rows={2}
                    className={INPUT_CLS}
                    value={form.page2_remarks}
                    onChange={(e) => setField('page2_remarks', e.target.value)}
                  />
                </div>
              </div>
            )}

            {/* ── Photos Tab ── */}
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

            {/* ── Signature (2-way: one preparer, one approver — no electrical/mechanical split) ── */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 border-t border-gray-100 pt-4">
              <div>
                <label className="block text-sm font-medium text-navy-800 mb-1">Prepared By</label>
                <input className={INPUT_CLS} value={form.prepared_by} onChange={(e) => setField('prepared_by', e.target.value)} placeholder="Name" />
              </div>
              <div>
                <label className="block text-sm font-medium text-navy-800 mb-1">Approved By</label>
                <input className={INPUT_CLS} value={form.approved_by} onChange={(e) => setField('approved_by', e.target.value)} placeholder="Name" />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:flex sm:justify-between gap-3 px-4 sm:px-8 py-4 border-t border-gray-100 bg-gray-50 rounded-b-2xl">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || loading || hasConflict}
              className="px-5 py-2.5 bg-navy-800 text-white rounded-lg hover:bg-navy-700 transition-colors disabled:opacity-50 text-sm font-semibold"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
            <div className="contents sm:flex sm:gap-3">
              <button type="button" onClick={handleClose} className="px-5 py-2.5 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors text-sm">
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading || hasConflict}
                className="col-span-2 sm:col-auto flex items-center justify-center gap-2 px-6 py-2.5 bg-gold-500 text-navy-900 rounded-lg hover:bg-gold-400 transition-colors disabled:opacity-50 text-sm font-semibold"
              >
                <Download size={16} />
                {loading ? 'Finalizing...' : 'Finalize & Generate PDF'}
              </button>
            </div>
          </div>
        </form>
      </Modal>

      {cropTarget && (
        <CropModal imageSrc={cropTarget.imageSrc} onCancel={cancelCrop} onApply={applyCroppedImage} />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Lint**

Run: `cd CRM && npx eslint src/components/admin/AutoNXTControllerGeneratorForm.jsx`
Expected: no errors. (This project lints, not full-builds, as the fast local check — confirmed from this session's established workflow.)

- [ ] **Step 3: Commit**

```bash
cd CRM
git add src/components/admin/AutoNXTControllerGeneratorForm.jsx
git commit -m "feat: add AutoNXT Controller single-report generator form to the web admin app"
```

---

### Task 5: Web — `AutoNXTControllerBatchForm.jsx`

**Files:**
- Create: `CRM/src/components/admin/AutoNXTControllerBatchForm.jsx`

A near-direct fork of `AutoNXTBatchForm.jsx` — same two-mode-in-one-component structure (creation form / batch overview), same API calls, just `template_id: 'autonxt_controller'`, the per-report list showing `controller_sr_no` instead of `motor_sr_no`, and "controller(s)" instead of "motor(s)" in the summary line.

- [ ] **Step 1: Create the file**

```jsx
// CRM/src/components/admin/AutoNXTControllerBatchForm.jsx
import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ClipboardCheck, Layers, Eye, Download } from 'lucide-react';
import axios from 'axios';
import { useNotify } from '../../hooks/useNotify';

const API_URL = import.meta.env.VITE_BACKEND_URL || '';

const INPUT_CLS =
  'w-full border border-navy-100 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold-400';

const SHARED_FIELDS = [
  { key: 'customer_name', label: 'Customer name', placeholder: 'e.g. Autonxt' },
  { key: 'product_id', label: 'Product ID', placeholder: 'e.g. CASHV-38140' },
  { key: 'product_specifications', label: 'Product specifications', placeholder: 'e.g. 384V 140A CONTROLLER' },
  { key: 'drawing_no', label: 'Drawing number', placeholder: 'e.g. CASPL-XXXX' },
  { key: 'controller_type', label: 'Controller type', placeholder: 'e.g. CASHV38140' },
];

const emptyForm = () => ({
  pdi_no: '', quantity: '',
  customer_name: '', product_id: '', product_specifications: '', drawing_no: '', controller_type: '',
});

export default function AutoNXTControllerBatchForm() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { notifySuccess, notifyError } = useNotify();
  const [form, setForm] = useState(emptyForm());
  const [creating, setCreating] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [batch, setBatch] = useState(null);
  const [loadingBatch, setLoadingBatch] = useState(false);

  const batchId = searchParams.get('batch');

  const loadBatch = useCallback(async (id) => {
    const token = localStorage.getItem('token');
    if (!token) { notifyError('Please log in first.'); return; }
    setLoadingBatch(true);
    try {
      const response = await axios.get(`${API_URL}/api/pdi/report-batches/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setBatch(response.data);
    } catch (err) {
      notifyError(err.response?.data?.error || 'Could not load that batch.');
    } finally {
      setLoadingBatch(false);
    }
  }, [notifyError]);

  useEffect(() => {
    if (batchId) loadBatch(batchId);
  }, [batchId, loadBatch]);

  const setField = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!form.pdi_no.trim()) { notifyError('PDI No. is required.'); return; }
    const quantity = Number(form.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) {
      notifyError('Quantity must be a whole number between 1 and 50.');
      return;
    }
    const token = localStorage.getItem('token');
    if (!token) { notifyError('Please log in first.'); return; }
    setCreating(true);
    try {
      const optional = Object.fromEntries(
        SHARED_FIELDS.map(({ key }) => [key, form[key].trim()]).filter(([, v]) => Boolean(v))
      );
      const response = await axios.post(`${API_URL}/api/pdi/report-batches`, {
        template_id: 'autonxt_controller', pdi_no: form.pdi_no.trim(), quantity, ...optional,
      }, {
        headers: { Authorization: `Bearer ${token}` },
      });
      notifySuccess(`Batch created with ${quantity} linked report(s).`);
      navigate(`/pdi-generator/autonxt-controller-batch?batch=${response.data.batch_id}`, { replace: true });
    } catch (err) {
      notifyError(err.response?.data?.error || 'Could not create this batch.');
    } finally {
      setCreating(false);
    }
  };

  const handleFinalizeBatch = async () => {
    if (!batch) return;
    const token = localStorage.getItem('token');
    if (!token) { notifyError('Please log in first.'); return; }
    setFinalizing(true);
    try {
      const response = await axios.post(`${API_URL}/api/pdi/report-batches/${batch.batch_id}/finalize`, {}, {
        headers: { Authorization: `Bearer ${token}` },
        responseType: 'blob',
      });
      const blob = new Blob([response.data], { type: 'application/pdf' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `PDI_BATCH_${String(batch.pdi_no || batch.batch_id).replace(/[^a-zA-Z0-9_-]/g, '_')}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      notifySuccess('Batch finalized and combined PDF downloaded.');
      await loadBatch(batch.batch_id);
    } catch (err) {
      if (err.response?.data instanceof Blob) {
        try {
          const text = await err.response.data.text();
          const parsed = JSON.parse(text);
          notifyError(parsed.error || text || 'Failed to finalize batch.');
        } catch {
          notifyError('Failed to finalize batch.');
        }
      } else {
        notifyError(err.response?.data?.error || 'Failed to finalize batch.');
      }
    } finally {
      setFinalizing(false);
    }
  };

  const handleDownloadBatchPdf = async () => {
    if (!batch) return;
    const token = localStorage.getItem('token');
    try {
      const response = await axios.get(`${API_URL}/api/pdi/report-batches/${batch.batch_id}/pdf`, {
        headers: { Authorization: `Bearer ${token}` },
        responseType: 'blob',
      });
      const blob = new Blob([response.data], { type: 'application/pdf' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `PDI_BATCH_${String(batch.pdi_no || batch.batch_id).replace(/[^a-zA-Z0-9_-]/g, '_')}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      notifyError(err.response?.data?.error || 'Could not download the batch PDF.');
    }
  };

  if (batchId) {
    if (loadingBatch || !batch) {
      return <div className="max-w-5xl mx-auto p-8 text-center text-gray-400">Loading batch…</div>;
    }
    const allFinalized = batch.status === 'Completed';
    return (
      <div className="max-w-5xl mx-auto space-y-4 p-4">
        <div className="bg-white rounded-xl shadow-sm p-5 sm:p-6">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h2 className="text-xl font-bold text-navy-800">Batch {batch.pdi_no}</h2>
              <p className="text-gray-500 text-sm mt-1">
                {batch.lot_quantity} controller(s) · {batch.status}
                {batch.customer_name ? ` · ${batch.customer_name}` : ''}
              </p>
            </div>
            {allFinalized ? (
              <button
                type="button"
                onClick={handleDownloadBatchPdf}
                className="flex items-center gap-2 px-4 py-2 bg-navy-800 text-white rounded-lg text-sm font-semibold hover:bg-navy-900"
              >
                <Download size={16} /> Download Combined PDF
              </button>
            ) : (
              <button
                type="button"
                onClick={handleFinalizeBatch}
                disabled={finalizing}
                className="flex items-center gap-2 px-4 py-2 bg-gold-500 text-navy-900 rounded-lg text-sm font-semibold hover:bg-gold-400 disabled:opacity-50"
              >
                <ClipboardCheck size={16} /> {finalizing ? 'Finalizing…' : 'Finalize Batch'}
              </button>
            )}
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm divide-y divide-gray-100">
          {batch.reports.map((r) => (
            <div key={r.report_id} className="flex items-center justify-between gap-3 px-5 py-3">
              <div className="min-w-0">
                <span className="font-semibold text-navy-800">Lot {r.lot_index}/{batch.lot_quantity}</span>
                <span className="text-gray-400 text-sm ml-2">
                  {r.controller_sr_no ? `Sr. No. ${r.controller_sr_no}` : 'No serial number yet'}
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className={`text-xs px-2 py-1 rounded-full ${r.status === 'Completed' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}`}>
                  {r.status}
                </span>
                <button
                  type="button"
                  onClick={() => navigate(`/pdi-generator/autonxt-controller?report=${r.report_id}`)}
                  className="p-2 hover:bg-navy-50 rounded-full text-navy-800"
                  title="Open this report"
                  aria-label={`Open report for lot ${r.lot_index}`}
                >
                  <Eye size={18} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-4">
      <form onSubmit={handleCreate} className="bg-white rounded-xl shadow-sm p-5 sm:p-8 space-y-4">
        <div className="flex items-center gap-3">
          <Layers className="text-gold-600" size={28} />
          <h2 className="text-xl font-bold text-navy-800">Create AutoNXT Controller Batch Lot</h2>
        </div>
        <p className="text-gray-500 text-sm">
          Creates several linked PDI reports sharing the same PDI No. and lot-wide fields. Fill in each controller&rsquo;s checklist afterward.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-navy-800 mb-1">PDI No. *</label>
            <input className={INPUT_CLS} value={form.pdi_no} onChange={(e) => setField('pdi_no', e.target.value)} />
          </div>
          <div>
            <label className="block text-sm font-medium text-navy-800 mb-1">Quantity (1-50) *</label>
            <input type="number" min="1" max="50" className={INPUT_CLS} value={form.quantity} onChange={(e) => setField('quantity', e.target.value)} />
          </div>
          {SHARED_FIELDS.map(({ key, label, placeholder }) => (
            <div key={key}>
              <label className="block text-sm font-medium text-navy-800 mb-1">{label}</label>
              <input className={INPUT_CLS} placeholder={placeholder} value={form[key]} onChange={(e) => setField(key, e.target.value)} />
            </div>
          ))}
        </div>
        <button
          type="submit"
          disabled={creating}
          className="px-5 py-2.5 bg-gold-500 text-navy-900 rounded-lg font-semibold hover:bg-gold-400 disabled:opacity-50"
        >
          {creating ? 'Creating…' : 'Create Batch'}
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Lint**

Run: `cd CRM && npx eslint src/components/admin/AutoNXTControllerBatchForm.jsx`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd CRM
git add src/components/admin/AutoNXTControllerBatchForm.jsx
git commit -m "feat: add AutoNXT Controller batch creation/overview form to the web admin app"
```

---

### Task 6: Web — routes

**Files:**
- Modify: `CRM/src/routeConfig.jsx`

- [ ] **Step 1: Add the imports**

Right after the existing AutoNXT imports (currently lines 37-38):

```jsx
import AutoNXTGeneratorForm from "./components/admin/AutoNXTGeneratorForm";
import AutoNXTBatchForm from "./components/admin/AutoNXTBatchForm";
import AutoNXTControllerGeneratorForm from "./components/admin/AutoNXTControllerGeneratorForm";
import AutoNXTControllerBatchForm from "./components/admin/AutoNXTControllerBatchForm";
```

- [ ] **Step 2: Add the routes**

Right after the existing `/pdi-generator/autonxt-batch` route entry (currently lines 243-247):

```jsx
  {
    path: "/pdi-generator/autonxt-controller",
    allowedRoles: ["admin", "production"],
    component: AutoNXTControllerGeneratorForm,
  },
  {
    path: "/pdi-generator/autonxt-controller-batch",
    allowedRoles: ["admin", "production"],
    component: AutoNXTControllerBatchForm,
  },
```

- [ ] **Step 3: Lint**

Run: `cd CRM && npx eslint src/routeConfig.jsx`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
cd CRM
git add src/routeConfig.jsx
git commit -m "feat: wire up AutoNXT Controller routes in the web admin app"
```

---

### Task 7: Live verification (controller-personal, not a subagent)

Not a subagent task — the controller runs this directly against the real production backend, same safety pattern used for every prior live-verification round this session (clearly-named throwaway data, deleted afterward).

- [ ] **Step 1: Confirm both deploys are live**

Push both repos' commits (only after the user explicitly asks for a push — do not push as part of this step without that go-ahead). Once pushed, confirm via the GitHub Actions API that both the CRM_BACKEND and CRM deploy workflows succeeded against the exact pushed commit SHAs (same `curl https://api.github.com/repos/<org>/<repo>/actions/runs` pattern used earlier this session).

- [ ] **Step 2: Create a throwaway single report**

Via the live web app (or a direct API call against production, same pattern as prior rounds): create a report with `template_id: 'autonxt_controller'`, `customer_name: 'LIVE-VERIFY-DELETE-ME'`, `controller_type: 'CASHV38140'`. Confirm `parameter_rows` is seeded with all 35 preset rows.

- [ ] **Step 3: Fill in and finalize it**

Set every row's Measured value equal to its Specification (expect `OK` on every row), fill in `controller_sr_no`, the Section B checklist, at least one photo per slot, and Prepared By/Approved By. Finalize. Render the resulting PDF to PNG (same `pdf-to-png.ps1` + `msedge --headless --print-to-pdf` pipeline used earlier this session) and visually compare page 1 and page 2 against the actual reference document's layout (header fields, the 35-row Parameter Check table with OK remarks, the General Check table, the 5 photo slots, signature blocks on both pages).

- [ ] **Step 4: Confirm a mismatched row flags NG**

Edit one row's Measured value to differ from its Specification before finalizing a second throwaway report (or via a PATCH on the first, pre-finalize) — confirm the Remarks column computes `NG` and the cell renders flagged/red in the rendered PDF, matching the same red-highlight convention used elsewhere (AutoNXT/General's tolerance flags).

- [ ] **Step 5: Confirm the NA override persists**

Set one row's Remarks dropdown to `NA`, save, reload the report, confirm the dropdown still shows `NA` (not reverted to the auto-computed value) and the rendered PDF prints `NA` for that row.

- [ ] **Step 6: Create and finalize a throwaway batch**

Create a 2-unit batch (`template_id: 'autonxt_controller'`, clearly-named `pdi_no`). Leave one linked report's `controller_sr_no` blank and attempt to finalize the batch — confirm `400 CONTROLLER_SR_NO_REQUIRED`, naming the correct report/lot index, and that neither report nor the batch got marked `Completed` (re-`GET` the batch, confirm status is still not `Completed`). Fill in the missing field, finalize again, confirm success and a correctly combined 2-unit PDF.

- [ ] **Step 7: Confirm finalized-report editing works for this template with no template-specific bugs**

Edit the now-Completed single report from Step 3 with a valid `expected_revision` (confirm success, `revision_no` increments, a `pdi_report_revisions` snapshot is created) and with a stale one (confirm `409 REPORT_VERSION_CONFLICT`). Confirm an unpermitted role gets `403 FINALIZED_REPORT_FORBIDDEN`.

- [ ] **Step 8: Clean up**

Delete every throwaway report and the throwaway batch created in this task. Confirm (via a final `GET` list or direct query) that none of the `LIVE-VERIFY-DELETE-ME`-named data remains.

- [ ] **Step 9: Report results**

Summarize what was verified and any issues found/fixed to the user. If anything was fixed as a result of this step, it gets its own task/commit before this plan is considered done — this step is verification, not where new fixes silently land unrecorded.
