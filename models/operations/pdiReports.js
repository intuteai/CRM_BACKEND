const pool = require('../../config/db');

function reportColumns(prefix = '') {
  const p = prefix ? `${prefix}.` : '';
  return `
    ${p}report_id, ${p}sr_no, ${p}customer_id, ${p}order_id, ${p}status,
    ${p}inspected_by, ${p}inspection_date, ${p}template_id, ${p}drive_file_id,
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

  static async createReport({ customer_id, order_id, inspected_by, inspection_date, data, photos }, io) {
    const result = await pool.query(`
      INSERT INTO pre_dispatch_inspection_reports
        (customer_id, order_id, status, inspected_by, inspection_date, template_id, data, photos)
      VALUES ($1, $2, 'Pending', $3, $4, 'general', $5, $6)
      RETURNING ${reportColumns()}
    `, [
      customer_id || null,
      order_id || null,
      inspected_by || null,
      inspection_date ? new Date(inspection_date).toISOString() : null,
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
        u.name AS customer_name,
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
        customer_name: row.customer_name,
        inspected_by: row.inspected_by,
        inspection_date: row.inspection_date,
        report_link: `/api/pdi/reports/${row.report_id}/pdf`,
      })),
      total: parseInt(totalResult.rows[0].count, 10),
      cursor: nextCursor,
    };
  }
}

module.exports = PdiReports;
