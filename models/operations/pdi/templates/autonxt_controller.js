'use strict';

const { fmtDate, END_OF_REPORT_H } = require('../primitives');

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
// spec_<id>_display (withComputedSpecDisplays), and is recomputed here at
// render time (mirrored in CRM's AutoNXTControllerGeneratorForm.jsx and the
// mobile app). A stored remark other than OK/NG (e.g. a manual NA) is an
// override and wins; a stored OK/NG is always recomputed, so a stale OK can't
// hide a mismatch. Otherwise it's a match between Measured and Specification
// -- numeric when both are plain decimals (1 = 0001 = 1.0, 37.5 = 37.50),
// else an exact trimmed string match -- not a tolerance range, since this is
// firmware-parameter verification, not a physical dimension. A row with no
// Measured value yet renders blank rather than a premature NG.
const DECIMAL_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;
function computeRemarks(row) {
  const r = row && typeof row === 'object' ? row : {};
  const explicit = String(r.remarks ?? '').trim();
  if (explicit && !/^(ok|ng)$/i.test(explicit)) return explicit;
  const m = String(r.measured ?? '').trim();
  if (!m) return '';
  const s = String(r.specification ?? '').trim();
  if (DECIMAL_RE.test(m) && DECIMAL_RE.test(s)) return Number(m) === Number(s) ? 'OK' : 'NG';
  return m === s ? 'OK' : 'NG';
}

const isRowObject = (r) => !!r && typeof r === 'object' && !Array.isArray(r);
const str = (v) => String(v ?? '');

const PARAMETER_CHECK_COLUMNS = [
  { label: 'S.NO', w: 60, align: 'center', key: 'sno' },
  { label: 'PARAMETER', w: 107, align: 'center', value: (row) => str(row.parameter) },
  { label: 'SPECIFICATION', w: 108, align: 'center', value: (row) => str(row.specification) },
  {
    label: 'MEASURED VALUE', w: 108, align: 'center',
    value: (row) => str(row.measured),
    isOutOfTolerance: (row) => computeRemarks(row) === 'NG',
  },
  {
    label: 'REMARKS', align: 'center',
    value: (row) => computeRemarks(row),
    isOutOfTolerance: (row) => computeRemarks(row) === 'NG',
  },
];

function hasParameterNg(data) {
  const rows = Array.isArray(data.parameter_rows) ? data.parameter_rows : [];
  return rows.some((r) => isRowObject(r) && computeRemarks(r) === 'NG');
}

function generalCheckMeasured(data, key) {
  const gc = data.general_check;
  if (!isRowObject(gc)) return undefined;
  const entry = gc[key];
  return isRowObject(entry) ? entry.measured : undefined;
}

const isNg = (v) => str(v).trim().toUpperCase() === 'NG';

function hasGeneralCheckNg(data) {
  const gc = data.general_check;
  if (!isRowObject(gc)) return false;
  return Object.values(gc).some((e) => isRowObject(e) && isNg(e.measured));
}

const PASSED_TEXT = 'ALL OK, PASSED.';

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
    { label: 'Sr.No', w: 40, align: 'center', value: (row) => str(row.sno) },
    { label: 'Parameter', w: 150, align: 'center', value: (row) => str(row.label) },
    { label: 'Specification', w: 100, align: 'center', value: (row) => str(row.spec) },
    {
      label: 'Measurement', w: 100, align: 'center',
      value: (row, sectionData, data) => {
        const m = str(generalCheckMeasured(data, row.key));
        return m.trim() ? m : 'GO';
      },
      isOutOfTolerance: (row, data) => isNg(generalCheckMeasured(data, row.key)),
    },
    { label: 'Measurement Method', align: 'center', value: (row) => str(row.method) },
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

// Shorter than the renderer's default photo height so the 5-photo page 2 (3
// photo rows) still fits the signature and END OF REPORT above the page number.
const PHOTO_IMG_H = 140;

const autonxtControllerTemplate = {
  id: 'autonxt_controller',
  name: 'AutoNXT Controller PDI',
  version: 1,
  pageNumberPad: 2,
  endOfReport: true,
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
          title: 'A. PARAMETER CHECK:',
          mode: 'repeatable', dataKey: 'parameter_rows',
          filterRow: isRowObject,
          columns: PARAMETER_CHECK_COLUMNS, headerHeight: 14, rowHeight: 14,
          footerHeight: () => REM_H + 8 + SIG_H + 8,
        },
        {
          type: 'text', gap: 8, label: 'Remarks:', dataKey: 'page1_remarks',
          default: (d) => (hasParameterNg(d) ? '' : PASSED_TEXT),
        },
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
        {
          type: 'text', gap: 8, label: 'Remarks:', dataKey: 'page2_remarks',
          default: (d) => (hasGeneralCheckNg(d) ? '' : PASSED_TEXT),
        },
        {
          type: 'photo', mode: 'fixed-slots', dataKey: 'photos',
          imgHeight: PHOTO_IMG_H,
          footerHeight: SIG_H + END_OF_REPORT_H,
          slots: [
            { key: 'overall_controller', label: 'Overall Controller Photo' },
            { key: 'name_plate', label: 'Controller Name Plate' },
            { key: 'can_io_card', label: 'CAN & I/O Card Inside Drive' },
            { key: 'harness_photo', label: 'Harness Photo' },
            { key: 'packing_photo', label: 'Packing Photo' },
          ],
        },
        { type: 'signature', roles: SIG_ROLES, reserveBelow: END_OF_REPORT_H },
      ],
    },
  ],
};

module.exports = autonxtControllerTemplate;
module.exports.CONTROLLER_TYPE_PRESETS = CONTROLLER_TYPE_PRESETS;
module.exports.computeRemarks = computeRemarks;
