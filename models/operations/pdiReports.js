const pool = require('../../config/db');
const logger = require('../../utils/logger');
const PDIGenerator = require('./pdi_generator');
const { uploadBufferToDrivePrivate, deleteDriveFile } = require('../../services/googleDrive');

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

  static async createReport({ customer_id, order_id, inspected_by, inspection_date, data, photos, template_id, template_version }, io) {
    const result = await pool.query(`
      INSERT INTO pre_dispatch_inspection_reports
        (customer_id, order_id, status, inspected_by, inspection_date, template_id, template_version, data, photos)
      VALUES ($1, $2, 'Pending', $3, $4, $5, $6, $7, $8)
      RETURNING ${reportColumns()}
    `, [
      customer_id || null,
      order_id || null,
      inspected_by || null,
      inspection_date ? new Date(inspection_date).toISOString() : null,
      template_id || 'general',
      template_version ?? null,
      JSON.stringify(data || {}),
      JSON.stringify(photos || []),
    ]);

    const payload = this.#toPayload(result.rows[0]);
    if (io?.emit) io.emit('pdiReportUpdate', { report_id: payload.report_id, status: payload.status });
    return payload;
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
    if (fields.data !== undefined) { sets.push(`data = $${i++}`); values.push(JSON.stringify(fields.data)); }
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

    // Cursor encodes "<report_id>:<sort_key>" — see models/operations/pdi.js's
    // getAll() for why: inspection_date is nullable and rows can tie, so a
    // plain single-column cursor either stalls on NULLs or drops tied rows.
    let cursorReportId = null;
    let cursorSortKey = null;
    if (cursor) {
      const sepIdx = String(cursor).indexOf(':');
      if (sepIdx > 0) {
        const parsedId = parseInt(String(cursor).slice(0, sepIdx), 10);
        if (!isNaN(parsedId)) {
          cursorReportId = parsedId;
          cursorSortKey = String(cursor).slice(sepIdx + 1);
        }
      }
    }

    const query = `
      SELECT
        pdi.report_id, pdi.sr_no, pdi.customer_id, pdi.order_id, pdi.status,
        pdi.inspected_by, pdi.inspection_date, pdi.template_id,
        pdi.data->>'pdi_no' AS pdi_no,
        pdi.data->>'customer_name' AS form_customer_name,
        u.name AS linked_customer_name,
        COALESCE(pdi.inspection_date, 'infinity'::timestamp)::text AS sort_key
      FROM pre_dispatch_inspection_reports pdi
      LEFT JOIN customers c ON pdi.customer_id = c.customer_id
      LEFT JOIN users u ON c.user_id = u.user_id
      WHERE (
        $1::text IS NULL
        OR COALESCE(pdi.inspection_date, 'infinity'::timestamp) < $1::timestamp
        OR (COALESCE(pdi.inspection_date, 'infinity'::timestamp) = $1::timestamp AND pdi.report_id < $2)
      )
      AND ($4::text IS NULL OR pdi.status = $4)
      ORDER BY COALESCE(pdi.inspection_date, 'infinity'::timestamp) DESC, pdi.report_id DESC
      LIMIT $3
    `;
    const values = [cursorSortKey, cursorReportId, _limit + 1, status || null];
    const countQuery = `SELECT COUNT(*)::int AS count FROM pre_dispatch_inspection_reports WHERE ($1::text IS NULL OR status = $1)`;

    const [result, totalResult] = await Promise.all([
      pool.query(query, values),
      pool.query(countQuery, [status || null]),
    ]);

    const hasMore = result.rows.length > _limit;
    const rows = hasMore ? result.rows.slice(0, _limit) : result.rows;
    const nextCursor = hasMore ? `${rows[rows.length - 1].report_id}:${rows[rows.length - 1].sort_key}` : null;

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
}

module.exports = PdiReports;
