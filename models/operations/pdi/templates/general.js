'use strict';

const { CW, fmtDate } = require('../primitives');

const GCH   = 14;
const REM_H = 40;
const SIG_H = 36;

const ECOLS = [
  { key: 'sno',                label: 'S. No',              w: 22, align: 'center' },
  { key: 'motor_sr_no',        label: 'Motor Sr. No',       w: 56, align: 'center' },
  { key: 'voltage',            label: 'Voltage',            w: 32, align: 'center' },
  { key: 'direction',          label: 'F / R',              w: 26, align: 'center' },
  { key: 'current_standard',   label: 'Current\nStandard',  w: 40, align: 'center' },
  { key: 'current_measured',   label: 'Current\nMeasured',  w: 40, align: 'center' },
  { key: 'rpm_specified',      label: 'RPM\nSPECIFIED',     w: 42, align: 'center' },
  { key: 'rpm_measured',       label: 'RPM\nMEASURED',      w: 42, align: 'center' },
  { key: 'electrical_remarks', label: 'Remarks',            align: 'left' },
];

const MCOLS = [
  { key: 'sno',                 label: 'S. No',               w: 26, align: 'center' },
  { key: 'motor_sr_no',         label: 'Motor\nSr. No',       w: 52, align: 'center' },
  { key: 'motor_length',        label: 'Motor\nLength',       w: 44, align: 'center' },
  { key: 'shaft_length',        label: 'Shaft O/P\nD/Length', w: 50, align: 'center' },
  { key: 'mounting_pcd',        label: 'PCD',                 w: 40, align: 'center', group: 'Mounting Holes' },
  { key: 'mtg',                 label: 'MTG',                 w: 50, align: 'center', group: 'Mounting Holes' },
  { key: 'key_dim_result',      label: 'Key\nDim.',           w: 34, align: 'center' },
  { key: 'locating_dia_result', label: 'Locating\nDia.',      w: 38, align: 'center' },
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

const activeRowsFilter = (r) => r && String(r.motor_sr_no || '').trim();

const SIG_ROLES = [
  { key: 'prepared_by', label: 'Prepared By' },
  { key: 'approved_by', label: 'Approved By' },
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
          specRow: { fill: '#fffde7', firstColLabel: 'Specification', build: buildSpecVals },
          footerHeight: (data) => GCH * (1 + mechChecks(data).length) + 6 + REM_H + 6 + SIG_H + 8,
        },
        {
          type: 'table', gap: 6,
          mode: 'fixed', dataKey: 'general_mechanical',
          fixedRows: mechChecks, columns: checksColumns(), headerHeight: 14, rowHeight: 14,
        },
        { type: 'text', gap: 8, label: 'Remarks:', dataKey: 'mechanical_remarks', default: 'ALL MOTORS OK, PASSED.' },
        { type: 'signature', roles: SIG_ROLES },
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
