const pool = require('../../config/db');
const logger = require('../../utils/logger');
const PDIGenerator = require('./pdi_generator');
const { uploadBufferToDrivePrivate, deleteDriveFile } = require('../../services/googleDrive');
const templates = require('./pdi/templates');
const AuthoredTemplates = require('./pdi/authoredTemplates');

// Every template's signature roles follow the same naming convention this
// whole dialect already uses everywhere (General's prepared_by/approved_by,
// AutoNXT's prepared_by_electrical/prepared_by_mechanical/approved_by, and
// any admin-authored template — its role keys are auto-slugified from labels
// like "Prepared By" via CRM/src/utils/pdiTemplateSlug.js, landing on the
// same pattern). So rather than hardcode per-template field lists, this scans
// whatever keys the report's own data actually has. AutoNXT's two preparer
// roles both match "prepared" and get joined, since there's no single name
// to prefer between them.
function extractSignerNames(data) {
  if (!data || typeof data !== 'object') return { prepared_by: null, approved_by: null };
  const pick = (pattern) =>
    Object.entries(data)
      .filter(([key, value]) => pattern.test(key) && typeof value === 'string' && value.trim())
      .map(([, value]) => value.trim());
  const prepared = pick(/prepared/i);
  const approved = pick(/approved/i);
  return {
    prepared_by: prepared.length ? prepared.join(' / ') : null,
    approved_by: approved.length ? approved.join(' / ') : null,
  };
}

// Collects a PDFKit document's output into a single Buffer.
function bufferPdf(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

function reportColumns(prefix = '') {
  const p = prefix ? `${prefix}.` : '';
  return `
    ${p}report_id, ${p}sr_no, ${p}customer_id, ${p}order_id, ${p}status,
    ${p}inspected_by, ${p}inspection_date, ${p}template_id, ${p}template_version, ${p}drive_file_id,
    ${p}data, ${p}photos
  `;
}

class PdiReports {
  static #toPayload(row) {
    return {
      report_id: row.report_id,
      sr_no: row.sr_no,
      status: row.status,
      template_id: row.template_id,
      template_version: row.template_version,
      customer_id: row.customer_id,
      order_id: row.order_id,
      inspected_by: row.inspected_by,
      inspection_date: row.inspection_date,
      report_link: `/api/pdi/reports/${row.report_id}/pdf`,
      drive_file_id: row.drive_file_id,
      data: row.data,
      photos: row.photos,
    };
  }

  // Resolves a caller-supplied template_id into the exact (template_id, template_version)
  // pair to store on a new report. Code-registered templates (general, autonxt, ...)
  // aren't versioned at the DB level, so template_version stays null for them; a
  // DB-authored template pins to whichever version is currently 'active'. This lives
  // here (not just in the controller) so ANY future caller of createReport gets this
  // validation enforced automatically, rather than needing to duplicate the check
  // before calling in — see the code review on commit 878869e for why this matters.
  static async resolveTemplateVersion(templateId) {
    const id = templateId || 'general';
    if (templates[id]) return { templateId: id, templateVersion: null };
    const active = await AuthoredTemplates.getActive(id);
    if (!active) throw new Error(`Unknown PDI template: ${id}`);
    return { templateId: id, templateVersion: active.version };
  }

  static async createReport({ customer_id, order_id, inspected_by, inspection_date, data, photos, template_id }, io) {
    const { templateId, templateVersion } = await this.resolveTemplateVersion(template_id);
    const { prepared_by, approved_by } = extractSignerNames(data);
    const result = await pool.query(`
      INSERT INTO pre_dispatch_inspection_reports
        (customer_id, order_id, status, inspected_by, inspection_date, template_id, template_version, data, photos, prepared_by, approved_by)
      VALUES ($1, $2, 'Pending', $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING ${reportColumns()}
    `, [
      customer_id || null,
      order_id || null,
      inspected_by || null,
      inspection_date ? new Date(inspection_date).toISOString() : null,
      templateId,
      templateVersion,
      JSON.stringify(data || {}),
      JSON.stringify(photos || []),
      prepared_by,
      approved_by,
    ]);

    const payload = this.#toPayload(result.rows[0]);
    if (io?.emit) io.emit('pdiReportUpdate', { report_id: payload.report_id, status: payload.status });
    return payload;
  }

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
  static async duplicateReport(reportId, inspectedBy, io) {
    const source = await this.getById(reportId);
    const sourceData = source.data || {};

    // Reset: pdi_no, date, every table's rows, every signature field, general
    // check results. Keep everything else (Header-level identity/spec fields).
    // Field names differ per hard-coded template, so the reset set is keyed by
    // template_id — General and AutoNXT each define their own per-run fields.
    const RESET_KEYS_BY_TEMPLATE = {
      general: [
        'pdi_no', 'date',
        'rows', // General's electrical/mechanical motor rows
        'prepared_by', 'approved_by', // General's signatures
        'general_electrical', 'general_mechanical', // General's fixed GO/NG checks
        'electrical_remarks', 'mechanical_remarks', // per-run remarks, not batch spec
      ],
      autonxt: [
        'pdi_no', 'date', 'motor_sr_no',
        'performance_test', 'general_check', 'physical_parameters', // AutoNXT's measured checklists
        'page1_remarks', 'page2_remarks', // per-run remarks, not batch spec
        'prepared_by_electrical', 'prepared_by_mechanical', 'approved_by', // AutoNXT's signatures
      ],
    };
    // Admin-authored templates aren't in this map yet — their per-run fields
    // are admin-defined (arbitrary dataKeys per section), so only pdi_no/date
    // reset for those; everything else still carries forward unchanged.
    const resetKeys = new Set(RESET_KEYS_BY_TEMPLATE[source.template_id] || ['pdi_no', 'date']);
    const newData = {};
    for (const [key, value] of Object.entries(sourceData)) {
      if (!resetKeys.has(key)) newData[key] = value;
    }

    return this.createReport({
      customer_id: source.customer_id,
      order_id: source.order_id,
      inspected_by: inspectedBy,
      data: newData,
      photos: [],
      template_id: source.template_id,
    }, io);
  }

  static async getById(reportId) {
    const _id = Number(reportId);
    if (!Number.isFinite(_id)) throw new Error('Report not found');
    const result = await pool.query(`SELECT ${reportColumns()} FROM pre_dispatch_inspection_reports WHERE report_id = $1`, [_id]);
    if (result.rows.length === 0) throw new Error('Report not found');
    return this.#toPayload(result.rows[0]);
  }

  static async patchReport(reportId, fields, io) {
    const _id = Number(reportId);
    if (!Number.isFinite(_id)) throw new Error('Report not found');

    const sets = [];
    const values = [];
    let i = 1;

    if (fields.status !== undefined) { sets.push(`status = $${i++}`); values.push(fields.status); }
    if (fields.inspected_by !== undefined) { sets.push(`inspected_by = $${i++}`); values.push(fields.inspected_by || null); }
    if (fields.inspection_date !== undefined) {
      sets.push(`inspection_date = $${i++}`);
      values.push(fields.inspection_date ? new Date(fields.inspection_date).toISOString() : null);
    }
    if (fields.customer_id !== undefined) { sets.push(`customer_id = $${i++}`); values.push(fields.customer_id || null); }
    if (fields.order_id !== undefined) { sets.push(`order_id = $${i++}`); values.push(fields.order_id || null); }
    if (fields.data !== undefined) {
      sets.push(`data = $${i++}`);
      values.push(JSON.stringify(fields.data));
      // Keep the denormalized signer columns in sync with data on every write
      // that touches it -- these two columns can never legitimately drift
      // from what data actually contains.
      const { prepared_by, approved_by } = extractSignerNames(fields.data);
      sets.push(`prepared_by = $${i++}`); values.push(prepared_by);
      sets.push(`approved_by = $${i++}`); values.push(approved_by);
    }
    if (fields.photos !== undefined) { sets.push(`photos = $${i++}`); values.push(JSON.stringify(fields.photos)); }

    if (sets.length === 0) return this.getById(_id);

    values.push(_id);
    const result = await pool.query(`
      UPDATE pre_dispatch_inspection_reports
      SET ${sets.join(', ')}
      WHERE report_id = $${i}
      RETURNING ${reportColumns()}
    `, values);
    if (result.rows.length === 0) throw new Error('Report not found');

    const payload = this.#toPayload(result.rows[0]);
    if (io?.emit) io.emit('pdiReportUpdate', { report_id: payload.report_id, status: payload.status });
    return payload;
  }

  static async listReports({ limit = 10, cursor = null, status = null } = {}) {
    const _limit = Math.min(Math.max(Number(limit) || 10, 1), 100);

    // Ordered by report_id (creation order), not inspection_date. inspection_date
    // is a business field the inspector types in by hand -- it's routinely
    // backdated, entered late, or left blank on an abandoned draft, none of
    // which has anything to do with when the report was actually created. Sorting
    // by it made the Sr. No column (which IS creation order, and reads to anyone
    // looking at the table as "the order") jump around unpredictably relative to
    // the rows above and below it. report_id is monotonic and never null, so the
    // cursor is a single plain value -- no compound sort_key, no NULL handling.
    const cursorReportId = cursor ? parseInt(String(cursor), 10) : null;

    const query = `
      SELECT
        pdi.report_id, pdi.sr_no, pdi.customer_id, pdi.order_id, pdi.status,
        pdi.inspected_by, pdi.inspection_date, pdi.template_id,
        pdi.prepared_by, pdi.approved_by,
        pdi.data->>'pdi_no' AS pdi_no,
        pdi.data->>'customer_name' AS form_customer_name,
        u.name AS linked_customer_name
      FROM pre_dispatch_inspection_reports pdi
      LEFT JOIN customers c ON pdi.customer_id = c.customer_id
      LEFT JOIN users u ON c.user_id = u.user_id
      WHERE ($1::int IS NULL OR pdi.report_id < $1)
      AND ($3::text IS NULL OR pdi.status = $3)
      ORDER BY pdi.report_id DESC
      LIMIT $2
    `;
    const values = [Number.isNaN(cursorReportId) ? null : cursorReportId, _limit + 1, status || null];
    const countQuery = `SELECT COUNT(*)::int AS count FROM pre_dispatch_inspection_reports WHERE ($1::text IS NULL OR status = $1)`;

    const [result, totalResult] = await Promise.all([
      pool.query(query, values),
      pool.query(countQuery, [status || null]),
    ]);

    const hasMore = result.rows.length > _limit;
    const rows = hasMore ? result.rows.slice(0, _limit) : result.rows;
    const nextCursor = hasMore ? String(rows[rows.length - 1].report_id) : null;

    return {
      data: rows.map((row) => ({
        report_id: row.report_id,
        sr_no: row.sr_no,
        status: row.status,
        template_id: row.template_id,
        customer_id: row.customer_id,
        order_id: row.order_id,
        pdi_no: row.pdi_no || null,
        // Prefer the name typed on the report itself (the common, free-form case)
        // over a linked CRM customer record (rare in this flow, but still honored
        // if one's actually attached).
        customer_name: row.form_customer_name || row.linked_customer_name || null,
        inspected_by: row.inspected_by,
        prepared_by: row.prepared_by,
        approved_by: row.approved_by,
        inspection_date: row.inspection_date,
        report_link: `/api/pdi/reports/${row.report_id}/pdf`,
      })),
      total: parseInt(totalResult.rows[0].count, 10),
      cursor: nextCursor,
    };
  }

  static async finalizeReport(reportId, io) {
    const report = await this.getById(reportId);
    // photos live in their own column, not report.data — the generator reads
    // data.photos, so it has to be merged in here or PDFs render with none.
    const pdfBuffer = await bufferPdf(await PDIGenerator.generate(report.template_id, report.template_version, { ...(report.data || {}), photos: report.photos || [] }));

    // Best-effort Drive backup — same reasoning as InvoiceRecords.create: a
    // "generated" report can always be regenerated from its stored data, so a
    // Drive outage shouldn't block finalizing.
    let driveFileId = report.drive_file_id || null;
    try {
      const safeNo = String(report.data?.pdi_no || report.report_id).replace(/[^a-zA-Z0-9_-]/g, '_');
      const uploaded = await uploadBufferToDrivePrivate(pdfBuffer, 'application/pdf', `PDI_${safeNo}.pdf`);
      driveFileId = uploaded.id;
    } catch (e) {
      logger.warn(`Drive backup failed for PDI report ${reportId}: ${e.message}`);
    }

    const result = await pool.query(`
      UPDATE pre_dispatch_inspection_reports
      SET status = 'Completed', drive_file_id = COALESCE($1, drive_file_id)
      WHERE report_id = $2
      RETURNING ${reportColumns()}
    `, [driveFileId, Number(reportId)]);

    const payload = this.#toPayload(result.rows[0]);
    if (io?.emit) io.emit('pdiReportUpdate', { report_id: payload.report_id, status: payload.status });
    return { payload, pdfBuffer };
  }

  static async getPdfBuffer(reportId) {
    const report = await this.getById(reportId);
    return bufferPdf(await PDIGenerator.generate(report.template_id, report.template_version, { ...(report.data || {}), photos: report.photos || [] }));
  }

  static async deleteReport(reportId, io) {
    const _id = Number(reportId);
    if (!Number.isFinite(_id)) throw new Error('Report not found');
    const result = await pool.query(
      'DELETE FROM pre_dispatch_inspection_reports WHERE report_id = $1 RETURNING report_id, drive_file_id',
      [_id]
    );
    if (result.rows.length === 0) throw new Error('Report not found');

    const driveFileId = result.rows[0].drive_file_id;
    if (driveFileId) {
      try { await deleteDriveFile(driveFileId); }
      catch (e) { logger.warn(`Drive cleanup failed for PDI report ${_id} (file ${driveFileId}): ${e.message}`); }
    }

    if (io?.emit) io.emit('pdiReportUpdate', { report_id: _id, status: 'Deleted' });
    return { report_id: _id };
  }

  // Used to guard authored-template deletion: a template with report history
  // can't be hard-deleted (its rows are still needed to re-render those reports).
  static async countByTemplateId(templateId) {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS count FROM pre_dispatch_inspection_reports WHERE template_id = $1`,
      [templateId]
    );
    return result.rows[0].count;
  }
}

module.exports = PdiReports;
