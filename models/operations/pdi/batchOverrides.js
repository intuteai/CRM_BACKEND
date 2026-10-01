'use strict';

const pool = require('../../../config/db');

// A real multi-motor AutoNXT lot repeats these five fields identically
// across every linked report -- optionally seeded once at batch creation,
// and (mirroring pdi_no's own authoritative-at-render behavior) kept
// consistent across the whole lot at render time even if an individual
// report's own data drifts. Shared between pdiReportBatches.js (the
// combined-PDF route, which already applied this) and pdiReports.js (the
// individual-PDF route, which didn't -- see getActiveBatchOverride below)
// as a separate leaf module specifically because pdiReportBatches.js
// already requires pdiReports.js, so the reverse require would be circular.
const SHARED_FIELDS = ['customer_name', 'product_id', 'product_specifications', 'drawing_no', 'controller_type'];

function pickSharedFields(source) {
  const picked = {};
  for (const f of SHARED_FIELDS) {
    if (source[f]) picked[f] = source[f];
  }
  return picked;
}

// null if the report isn't a batch member, or its batch isn't Completed yet
// -- a non-Completed batch's shared fields aren't authoritative over
// anything yet (finalizeBatch/getBatchPdfForDownload only ever apply this
// override on an already-Completed batch).
async function getActiveBatchOverride(reportId) {
  const { rows } = await pool.query(`
    SELECT b.pdi_no, b.customer_name, b.product_id, b.product_specifications, b.drawing_no, b.controller_type
    FROM pre_dispatch_inspection_reports r
    JOIN pdi_report_batches b ON b.batch_id = r.batch_id AND b.status = 'Completed'
    WHERE r.report_id = $1
  `, [reportId]);
  if (rows.length === 0) return null;
  return { pdi_no: rows[0].pdi_no, ...pickSharedFields(rows[0]) };
}

module.exports = { SHARED_FIELDS, pickSharedFields, getActiveBatchOverride };
