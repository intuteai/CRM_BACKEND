'use strict';

const { CW, fmtDate } = require('../primitives');
const { checkTolerance, parseForwardReverse } = require('../tolerance');

const GCH   = 14;
const REM_H = 40;
const SIG_H = 36;

const ECOLS = [
  { key: 'sno',                label: 'S. No',                    w: 22, align: 'center' },
  { key: 'motor_sr_no',        label: 'Motor Sr. No',             w: 56, align: 'center' },
  { key: 'voltage',            label: 'Voltage',                  w: 32, align: 'center' },
  { key: 'current_measured',   label: 'Current\nMeasured F/R',    w: 50, align: 'center',
    isOutOfTolerance: (row, data) => {
      const { forward, reverse } = parseForwardReverse(row.current_measured);
      return checkTolerance(forward, data.spec_current_standard, data.spec_current_tol_mode, data.spec_current_tol, data.spec_current_tol_minus).outOfRange
          || checkTolerance(reverse, data.spec_current_standard, data.spec_current_tol_mode, data.spec_current_tol, data.spec_current_tol_minus).outOfRange;
    } },
  { key: 'rpm_measured',       label: 'RPM\nMeasured F/R',        w: 50, align: 'center',
    isOutOfTolerance: (row, data) => {
      const { forward, reverse } = parseForwardReverse(row.rpm_measured);
      return checkTolerance(forward, data.spec_rpm_specified, data.spec_rpm_tol_mode, data.spec_rpm_tol, data.spec_rpm_tol_minus).outOfRange
          || checkTolerance(reverse, data.spec_rpm_specified, data.spec_rpm_tol_mode, data.spec_rpm_tol, data.spec_rpm_tol_minus).outOfRange;
    } },
  { key: 'electrical_remarks', label: 'Remarks',                  align: 'left' },
];

const MCOLS = [
  { key: 'sno',                 label: 'S. No',               w: 26, align: 'center' },
  { key: 'motor_sr_no',         label: 'Motor\nSr. No',       w: 52, align: 'center' },
  { key: 'motor_length',        label: 'Motor\nLength',       w: 44, align: 'center',
    isOutOfTolerance: (row, data) => checkTolerance(row.motor_length, data.spec_motor_length, data.spec_motor_length_tol_mode, data.spec_motor_length_tol, data.spec_motor_length_tol_minus).outOfRange },
  { key: 'shaft_length',         label: 'Shaft\nLength',       w: 40, align: 'center',
    isOutOfTolerance: (row, data) => checkTolerance(row.shaft_length, data.spec_shaft_length, data.spec_shaft_length_tol_mode, data.spec_shaft_length_tol, data.spec_shaft_length_tol_minus).outOfRange },
  { key: 'shaft_diameter',       label: 'Shaft\nDiameter',     w: 40, align: 'center',
    isOutOfTolerance: (row, data) => checkTolerance(row.shaft_diameter, data.spec_shaft_diameter, data.spec_shaft_diameter_tol_mode, data.spec_shaft_diameter_tol, data.spec_shaft_diameter_tol_minus).outOfRange },
  { key: 'mounting_pcd',        label: 'PCD',                 w: 40, align: 'center', group: 'Mounting Holes',
    isOutOfTolerance: (row, data) => checkTolerance(row.mounting_pcd, data.spec_mounting_pcd, data.spec_mounting_pcd_tol_mode, data.spec_mounting_pcd_tol, data.spec_mounting_pcd_tol_minus).outOfRange },
  { key: 'mtg',                 label: 'MTG',                 w: 50, align: 'center', group: 'Mounting Holes' },
  { key: 'key_dim_result',      label: 'Key\nDim.',           w: 34, align: 'center' },
  { key: 'locating_dia_result', label: 'Locating\nDia.',      w: 38, align: 'center',
    isOutOfTolerance: (row, data) => checkTolerance(row.locating_dia_result, data.spec_locating_dia, data.spec_locating_dia_tol_mode, data.spec_locating_dia_tol, data.spec_locating_dia_tol_minus).outOfRange },
  { key: 'mechanical_remarks',  label: 'Remarks',             align: 'left' },
];

function checksColumns() {
  return [
    { label: 'General Check', w: Math.round(CW * 0.5), align: 'left',   value: (row) => row.label },
    { label: 'Specified',     w: 55,                    align: 'center', value: () => 'Go/NG' },
    { label: 'Measured',      w: 55,                    align: 'center', value: (row, sectionData) => (sectionData[row.key] || {}).measured || 'GO' },
    { label: 'Remarks',                                 align: 'center', value: (row, sectionData) => (sectionData[row.key] || {}).remarks || 'OK' },
  ];
}

const ELEC_CHECKS = [
  { key: 'sound',            label: 'All Motors Sound' },
  { key: 'high_voltage',     label: 'All Motors High Voltage Breakdown Check' },
  { key: 'insulation',       label: 'All Motors Insulation Check' },
  { key: 'phase_resistance', label: 'All Motors Phase Resistance Check' },
  { key: 'hall_sensor',      label: 'All Motors Hall Sensor Connector Check' },
];

function mechChecks(data) {
  const powerCableLength  = data.power_cable_length  || '1250±50mm';
  const sensorCableLength = data.sensor_cable_length || '1250±50mm';
  return [
    { key: 'power_cable',     label: `All Motor Power Cable Length ${powerCableLength}` },
    { key: 'sensor_cable',    label: `All Motor Sensor Cable Length ${sensorCableLength}` },
    { key: 'bolt_tightening', label: 'All Motor Bolt Tightening Check' },
    { key: 'paint_check',     label: 'All Motor Paint Check (If Applicable)' },
  ];
}

// No hardcoded fallbacks for the numeric fields (motor_length, shaft_length,
// shaft_diameter, mounting_pcd, locating_dia_result) — a template reused
// across many product lines was never correctly served by one
// silently-reused default, so these are required per-PDI entries now. MTG
// and Key Dim. keep their informational/GO-NG defaults since they're not
// numeric specs.
//
// The app (1.0.8+) sends the specification pre-formatted -- "50 ±0.5",
// "3000 ±5%", "50.0 +0.1/-0.2" -- per field (spec_X_display) alongside the
// plain nominal (spec_X) it always sent. It is printed EXACTLY as sent: the
// accepted range ("(49.5 – 50.5)") is deliberately not part of it (product
// owner's request), and nothing here builds text from the tolerance fields.
// A report saved by 1.0.7 or earlier has only the plain nominal.
function buildSpecVals(data) {
  return {
    motor_length:        data.spec_motor_length_display   || data.spec_motor_length   || '',
    shaft_length:        data.spec_shaft_length_display    || data.spec_shaft_length   || '',
    shaft_diameter:      data.spec_shaft_diameter_display  || data.spec_shaft_diameter || '',
    mounting_pcd:        data.spec_mounting_pcd_display    || data.spec_mounting_pcd   || '',
    mtg:                 data.spec_mtg            || '1.M6 / 2.Ø8.0',
    key_dim_result:      data.spec_key_dim        || 'Go/NG',
    locating_dia_result: data.spec_locating_dia_display || data.spec_locating_dia   || '',
  };
}

// Electrical table's spec row — one Current Standard + RPM Specified nominal
// shared by every motor row in this PDI, mirroring the Mechanical table's own
// spec-row pattern (buildSpecVals above). Same display/nominal fallback as
// buildSpecVals. Keyed by the *column* each value renders under
// (current_measured, rpm_measured), not by field semantics — same convention
// buildSpecVals uses.
function buildElecSpecVals(data) {
  return {
    current_measured: data.spec_current_display || data.spec_current_standard || '',
    rpm_measured:      data.spec_rpm_display      || data.spec_rpm_specified    || '',
  };
}

const activeRowsFilter = (r) => r && String(r.motor_sr_no || '').trim();

const SIG_ROLES = [
  { key: 'prepared_by', label: 'Prepared By' },
  { key: 'approved_by', label: 'Approved By' },
];

// Mechanical page's own signatures (app 1.0.8+). A report saved before that
// has only the one shared prepared_by/approved_by — fall back to it so an
// old report still prints the same name on both pages, as before. `??` (not
// `||`): an empty string on a 1.0.8+ report means the user left it blank on
// purpose, and must not fall back to the Electrical name.
const MECH_SIG_ROLES = [
  { key: 'prepared_by_mechanical', label: 'Prepared By',
    value: (d) => d.prepared_by_mechanical ?? d.prepared_by ?? '' },
  { key: 'approved_by_mechanical', label: 'Approved By',
    value: (d) => d.approved_by_mechanical ?? d.approved_by ?? '' },
];

const generalTemplate = {
  id: 'general',
  name: 'General',
  version: 1,
  pages: [
    {
      // Page 1 — Electrical Check
      sections: [
        {
          type: 'header', gap: 6,
          companyName: 'Compage Automation Systems Pvt.Ltd.,',
          formatNo: 'CASPL/QA/F/14', revNo: '00', effDate: '01/01/2022',
          logoAsset: 'compage_header_left.png',
          infoFields: [
            ['Customer Name:', (d) => d.customer_name || '', 'Dt:', (d) => d.date ? fmtDate(new Date(d.date)) : ''],
            ['Product ID:', (d) => d.product_id || '', 'Dwg. No:', (d) => d.drawing_no || ''],
            ['Product Specifications:', (d) => d.product_specifications || '', 'PDI No:', (d) => d.pdi_no || ''],
          ],
        },
        {
          type: 'table', gap: 6,
          mode: 'repeatable', dataKey: 'rows', filterRow: activeRowsFilter,
          columns: ECOLS, headerHeight: 28, rowHeight: 14,
          // labelSpan: 2 -- the S.No and Motor Sr.No columns are always blank
          // in a spec row (buildElecSpecVals has no value for either), so the
          // "Specification" label can use both without displacing anything.
          // At just the S.No column's own width it was forced into a single
          // line and ellipsis-truncated to "Spe…" regardless of the label
          // text -- widening the text wouldn't have fixed that on its own.
          // No fixed height: the row sizes itself to its text (see drawSpecRow),
          // so a short "10 ±0.5" stays a normal one-line row.
          specRow: { fill: '#fffde7', firstColLabel: 'Specification', labelSpan: 2, build: buildElecSpecVals },
          footerHeight: () => GCH * (1 + ELEC_CHECKS.length) + 6 + REM_H + 6 + SIG_H + 8,
        },
        {
          type: 'table', gap: 6,
          mode: 'fixed', dataKey: 'general_electrical',
          fixedRows: () => ELEC_CHECKS, columns: checksColumns(), headerHeight: 14, rowHeight: 14,
        },
        { type: 'text', gap: 8, label: 'Remarks:', dataKey: 'electrical_remarks', default: 'ALL MOTORS OK, PASSED.' },
        { type: 'signature', roles: SIG_ROLES },
      ],
    },
    {
      // Page 2 — Mechanical Check
      sections: [
        {
          type: 'image',
          title: 'Mechanical Dimensional Check sheet',
          dataKey: 'drawing_image', height: 100,
          placeholder: {
            text: (d) => `[Motor Technical Drawing — Dwg No: ${d.drawing_no || '____'}]`,
            annotations: [
              { text: 'PCD ø152.74 ±0.10', x: 6, y: 6, w: 120, size: 6.5 },
              { text: 'Temp. & Hall Sensor Cable 1250±50 mm · 8Pin Connector', xFrac: 0.35, y: 6, wFrac: 0.4, size: 6.5, align: 'center' },
              { text: 'Motor Power Cable 1250±50 mm', xFrac: 0.35, y: 16, wFrac: 0.4, size: 6.5, align: 'center' },
            ],
          },
        },
        {
          type: 'table', gap: 6,
          mode: 'repeatable', dataKey: 'rows', filterRow: activeRowsFilter,
          columns: MCOLS, headerHeight: 36, rowHeight: 14,
          // No fixed height: a bilateral "50.0 +0.1/-0.2" in Locating Dia.'s
          // 38pt-wide column wraps, a "250 ±1" doesn't, and the row is as tall
          // as its tallest cell (see drawSpecRow).
          specRow: { fill: '#fffde7', firstColLabel: 'Specification', labelSpan: 2, build: buildSpecVals },
          footerHeight: (data) => GCH * (1 + mechChecks(data).length) + 6 + REM_H + 6 + SIG_H + 8,
        },
        {
          type: 'table', gap: 6,
          mode: 'fixed', dataKey: 'general_mechanical',
          fixedRows: mechChecks, columns: checksColumns(), headerHeight: 14, rowHeight: 14,
        },
        { type: 'text', gap: 8, label: 'Remarks:', dataKey: 'mechanical_remarks', default: 'ALL MOTORS OK, PASSED.' },
        { type: 'signature', roles: MECH_SIG_ROLES },
      ],
    },
    {
      // Page 3 — Photos
      sections: [
        { type: 'photo', mode: 'freeform', dataKey: 'photos' },
      ],
    },
  ],
};

module.exports = generalTemplate;
