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
//
// SAFETY: this does a bulk read then, per report, an unconditional whole-
// row `data` overwrite from that stale snapshot -- no revision/version
// check (deliberately, per the design spec: this isn't a user edit). If an
// AutoNXT report is being actively edited through the app while this runs,
// that edit can be silently clobbered. Run during a maintenance window /
// low-traffic period, not during business hours.
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
  const tolStr = String(tol ?? '').trim();
  const tolMinusStr = String(tolMinus ?? '').trim();
  if (tolMode === 'bilateral') {
    return `${prefix}${nominalStr} (${tolStr} TO ${tolMinusStr})`;
  }
  return `${prefix}${nominalStr}±${tolStr}${tolMode === '%' ? '%' : ''}${unit}`;
}

async function run() {
  console.log(DRY_RUN ? 'DRY RUN -- no writes will be made.\n' : 'LIVE RUN -- this will write to the database.\n');

  const { rows: reports } = await pool.query(
    `SELECT report_id, status, data FROM pre_dispatch_inspection_reports WHERE template_id = $1`,
    ['autonxt']
  );
  console.log(`Found ${reports.length} AutoNXT report(s).\n`);

  let reportsChanged = 0;
  let fieldsChanged = 0;
  let reportsRerendered = 0;
  let wouldRerenderCount = 0;

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

    const wouldRerender = report.status === 'Completed' && changedFieldsForThisReport.length > 0;
    if (wouldRerender) {
      wouldRerenderCount++;
    }

    if (changedFieldsForThisReport.length > 0 && DRY_RUN && wouldRerender) {
      console.log(`  (would re-render PDF + re-upload to Drive on a real run)`);
    }

    if (!DRY_RUN && changedFieldsForThisReport.length > 0) {
      await pool.query(
        `UPDATE pre_dispatch_inspection_reports SET data = $1 WHERE report_id = $2`,
        [JSON.stringify(newData), report.report_id]
      );

      if (wouldRerender) {
        await PdiReports.reRenderFinalizedReportForMaintenance(report.report_id);
        reportsRerendered++;
        console.log(`  -> Requested PDF re-render (reRenderFinalizedReportForMaintenance does not report success/failure directly -- check server logs for "PDI report re-rendered after finalized edit" or "Re-render ... failed" lines for report ${report.report_id} to confirm it actually succeeded).`);
      }
    }
  }

  console.log(`\n${reportsChanged} of ${reports.length} report(s) had at least one field change (${fieldsChanged} field(s) total).`);
  if (!DRY_RUN) {
    console.log(`${reportsRerendered} finalized report(s) had their PDF re-rendered.`);
  } else {
    console.log(`${wouldRerenderCount} finalized report(s) would have their PDF re-rendered on a real run.`);
    console.log('Dry run only -- nothing was written. Re-run without --dry-run to apply.');
  }

  await pool.end();
}

run().catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});
