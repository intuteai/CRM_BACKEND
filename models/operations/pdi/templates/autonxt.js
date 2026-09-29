'use strict';

const { CW, fmtDate } = require('../primitives');
const { checkTolerance } = require('../tolerance');

/* ── Section A: Performance Test @ No Load — fixed 8-row table,
      2 grouped column-pairs (BEMF, Running Current), RPM/spec values are
      template-fixed per row; only the two "Measured" columns are filled
      in per-inspection. ── */
const PERFORMANCE_ROWS = [
  { key: 'rpm_500',  rpm: 500,  sourceVoltage: '560V', bemfSpec: '79.0±3%',  currentSpec: '6.0±2.0A', method: 'Test Report' },
  { key: 'rpm_1000', rpm: 1000, sourceVoltage: '560V', bemfSpec: '155.0±3%', currentSpec: '6.0±2.0A', method: 'Test Report' },
  { key: 'rpm_1500', rpm: 1500, sourceVoltage: '560V', bemfSpec: '227.0±3%', currentSpec: '3.0±1.0A', method: 'Test Report' },
  { key: 'rpm_1800', rpm: 1800, sourceVoltage: '560V', bemfSpec: '270.0±3%', currentSpec: '3.0±1.0A', method: 'Test Report' },
  { key: 'rpm_2000', rpm: 2000, sourceVoltage: '560V', bemfSpec: '-', currentSpec: '-', method: 'Test Report' },
  { key: 'rpm_2200', rpm: 2200, sourceVoltage: '560V', bemfSpec: '-', currentSpec: '-', method: 'Test Report' },
  { key: 'rpm_2500', rpm: 2500, sourceVoltage: '560V', bemfSpec: '-', currentSpec: '-', method: 'Test Report' },
  { key: 'rpm_3000', rpm: 3000, sourceVoltage: '560V', bemfSpec: '-', currentSpec: '-', method: 'Test Report' },
];

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
// exactly as it always has.
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

/* ── Section B: General Check — fixed 7-row checklist. Specification and
      Measurement Method are template-fixed per row; Measurement (Go/NG
      result) is filled in per-inspection, defaulting to 'GO'. ── */
const GENERAL_CHECK_ROWS = [
  { key: 'shield_plate',      sno: 1, label: 'Shield Plate check',               spec: 'Go/NG',                   method: 'VI' },
  { key: 'shield_grounding',  sno: 2, label: 'Shield Grounding',                 spec: 'Go/NG',                   method: 'VI' },
  { key: 'power_conn_insul',  sno: 3, label: 'Power connector Insulation Check', spec: 'Go/NG',                   method: 'MM, Test Report' },
  { key: 'phase_resistance',  sno: 4, label: 'Phase Resistance check',           spec: 'Go/NG',                   method: 'Ohmmeter' },
  { key: 'motor_insulation',  sno: 5, label: 'Motor Insulation Check',           spec: 'Go/NG',                   method: 'MM, Test Report' },
  { key: 'temp_sensor',       sno: 6, label: 'Temp. Sensor check',               spec: 'Go/NG',                   method: 'MM, Test Report' },
  { key: 'high_voltage',      sno: 7, label: 'High Voltage Breakdown Test',      spec: 'Tested Upto 1200V Go/NG', method: 'Megger' },
];

function generalCheckColumns() {
  return [
    { label: 'Sr.No', w: 30, align: 'center', value: (row) => row.sno },
    { label: 'Parameter', w: 160, align: 'left', value: (row) => row.label },
    { label: 'Specification', w: 130, align: 'center', value: (row) => row.spec },
    { label: 'Measurement', w: 90, align: 'center', value: (row, sectionData) => (sectionData[row.key] || {}).measured || 'GO' },
    { label: 'Measurement Method', align: 'center', value: (row) => row.method },
  ];
}

/* ── Section C: Physical Parameters — fixed 25-row checklist, same
      shape as Section B (Specification/Method fixed, Measurement filled
      in per-inspection defaulting to 'GO'). Multi-fact specs are
      flattened to one comma-joined line since table cells render single-
      line with ellipsis truncation, not multi-line wrapping. ── */
const PHYSICAL_PARAM_ROWS = [
  { key: 'motor_total_length', sno: 1,  label: 'Motor Total Length (Incl.Hyd.Mtg)',      spec: '467.5±1.0',                               method: 'DVC' },
  { key: 'shaft_op_length',    sno: 2,  label: 'Shaft O/P Length from Mounting Surface', spec: '10.0±0.5',                                method: 'DVC' },
  { key: 'shaft_flange_mtg',   sno: 3,  label: 'Shaft Flange Mtg.',                      spec: 'PCD Ø63.0, 06Nos M10, Depth 25.0, Go/NG', method: 'DVC' },
  { key: 'locating_dia',       sno: 4,  label: 'Locating Dia.',                          spec: 'Ø180.0 (-0.01 TO -0.05)',                 method: 'DVC' },
  { key: 'mounting_details',   sno: 5,  label: 'Mounting Details.',                      spec: 'PCD Ø215.0, 08Nos M12 Depth25.0',         method: 'Gauge, DVC' },
  { key: 'hyd_mtg_shaft_dia',  sno: 6,  label: 'Hyd. Mtg Shaft Dia.',                     spec: 'Ø28.0, L32.0',                            method: 'DVC' },
  { key: 'hyd_mtg_keyway',     sno: 7,  label: 'Hyd. Mtg Keyway',                         spec: '(LxWxD)25x8x4',                           method: 'DVC' },
  { key: 'hyd_mtg_bracket',    sno: 8,  label: 'Hyd. Mtg Bracket Mtg. holes',             spec: 'PCDØ160.0mm, 08Nos M6, Depth15.0',        method: 'DVC, Gauge' },
  { key: 'm6_insert',          sno: 9,  label: 'M6 Insert Check',                         spec: 'Go/NG',                                   method: 'VI' },
  { key: 'power_conn_lock',    sno: 10, label: 'Motor Power connector Lock check',        spec: 'Go/NG',                                   method: 'VI' },
  { key: 'power_cable_length', sno: 11, label: 'Motor Power cable Length',                spec: '1400 mm',                                 method: 'MT' },
  { key: 'temp_sensor_cable',  sno: 12, label: 'Temp. Sensor Cable Length',                spec: '1400 mm',                                 method: 'MT' },
  { key: 'lc_connector',       sno: 13, label: 'LC Connector Check',                      spec: 'Go/NG',                                   method: 'VI' },
  { key: 'lc_leakage',         sno: 14, label: 'LC Leakage Test',                         spec: 'Go/NG',                                   method: 'VI' },
  { key: 'power_gland_pull',   sno: 15, label: 'Power Cable Gland Pull Check',            spec: 'Go/NG',                                   method: 'VI' },
  { key: 'bolting_check',      sno: 16, label: 'Bolting check',                           spec: 'Go/NG',                                   method: 'VI' },
  { key: 'rear_mtg_bracket',   sno: 17, label: 'Rear Mtg Bracket',                        spec: 'Go/NG',                                   method: 'VI' },
  { key: 'resolver_connector', sno: 18, label: 'Resolver connector check',                spec: 'Go/NG',                                   method: 'VI' },
  { key: 'front_oil_seal',     sno: 19, label: 'Front Oil Seal Check',                    spec: 'Go/NG',                                   method: 'VI' },
  { key: 'rear_oil_seal',      sno: 20, label: 'Rear Oil Seal Check',                     spec: 'Go/NG',                                   method: 'VI' },
  { key: 'resolver_gland',     sno: 21, label: 'Resolver Gland Pull Check',               spec: 'Go/NG',                                   method: 'VI' },
  { key: 'noise',              sno: 22, label: 'Noise',                                   spec: 'No Abnormal Noise',                       method: 'DM, VI' },
  { key: 'm12_insert',         sno: 23, label: 'M12 Insert Check',                        spec: 'Go/NG',                                   method: 'VI' },
  { key: 'name_plate',         sno: 24, label: 'Name Plate',                              spec: 'Go/NG',                                   method: 'VI' },
  { key: 'physical_damage',    sno: 25, label: 'Physical Damage',                         spec: 'No Breaks, Cracks etc.,',                 method: 'VI' },
];

// Same enrichment approach as performanceRows above. Only the 3 rows present
// in SPEC_DEFAULTS get specDisplay/specOutOfTolerance computed; the other 22
// rows' row.spec/row.method (their fixed literal text) pass through
// untouched, and physicalParamColumns' Specification column falls back to
// row.spec for them.
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

const autonxtTemplate = {
  id: 'autonxt',
  name: 'AutoNXT Motor PDI',
  version: 1,
  pages: [
    {
      // Page 1 — header, Performance Test, General Check, remarks (no signature on this page)
      sections: [
        {
          type: 'header', gap: 6,
          companyName: 'Compage Automation Systems Pvt.Ltd.,',
          formatNo: 'CASPL/QA/F/23', revNo: '00', effDate: '30/03/2024',
          extraFormatLines: ['REV DT: 11/10/2024'],
          logoAsset: 'compage_header_left.png',
          rLabelW: 80,
          infoFields: [
            ['Customer Name:', (d) => d.customer_name || '', 'Dt:', (d) => d.date ? fmtDate(new Date(d.date)) : ''],
            ['Product ID:', (d) => d.product_id || '', 'Dwg. No:', (d) => d.drawing_no || ''],
            ['Product Specifications:', (d) => d.product_specifications || '', 'PDI No:', (d) => d.pdi_no || ''],
            ['Motor Sr.No:', (d) => d.motor_sr_no || '', 'Controller Type:', (d) => d.controller_type || ''],
          ],
        },
        {
          type: 'table', gap: 6,
          title: 'A. Performance Test @ No Load :',
          mode: 'fixed', dataKey: 'performance_test',
          fixedRows: performanceRows, columns: performanceColumns(),
          headerHeight: 36, rowHeight: 14,
        },
        {
          type: 'table', gap: 6,
          title: 'B. General Check',
          mode: 'fixed', dataKey: 'general_check',
          fixedRows: () => GENERAL_CHECK_ROWS, columns: generalCheckColumns(),
          headerHeight: 14, rowHeight: 14,
        },
        { type: 'text', label: 'Remarks:', dataKey: 'page1_remarks', default: 'ALL OK, PASSED.' },
      ],
    },
    {
      // Page 2 — Physical Parameters, remarks, THEN the one signature block
      // for the whole report (3-way: Electrical + Mechanical preparers, one approver)
      sections: [
        {
          type: 'table', gap: 6,
          title: 'C. Physical Parameters:',
          mode: 'fixed', dataKey: 'physical_parameters',
          fixedRows: physicalParamRows, columns: physicalParamColumns(),
          headerHeight: 14, rowHeight: 14,
        },
        { type: 'text', gap: 8, label: 'Remarks:', dataKey: 'page2_remarks', default: 'ALL OK, PASSED.' },
        {
          type: 'signature',
          roles: [
            { key: 'prepared_by_electrical', label: 'Prepared By - Electrical' },
            { key: 'prepared_by_mechanical', label: 'Prepared By - Mechanical' },
            { key: 'approved_by', label: 'Approved By' },
          ],
        },
      ],
    },
    {
      // Page 3 — Photos, 6 fixed labeled slots (not freeform, unlike General)
      sections: [
        {
          type: 'photo', mode: 'fixed-slots', dataKey: 'photos',
          slots: [
            { key: 'overall_motor', label: 'Overall Motor Photo' },
            { key: 'name_plate', label: 'Motor Name Plate' },
            { key: 'sr_no_marked', label: 'Motor Sr. No Punched / Marked on Body' },
            { key: 'power_cable_shielding', label: 'Power Cable shielding' },
            { key: 'resolver_cable', label: 'Resolver cable Shielding and Connector' },
            { key: 'front_rear_view', label: 'Motor Front view/ Rear View' },
          ],
        },
      ],
    },
  ],
};

module.exports = autonxtTemplate;
module.exports.SPEC_DEFAULTS = SPEC_DEFAULTS;
module.exports.specDisplay = specDisplay;
module.exports.specOutOfTolerance = specOutOfTolerance;
