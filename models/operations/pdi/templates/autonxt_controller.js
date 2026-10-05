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
