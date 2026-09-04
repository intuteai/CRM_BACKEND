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
}

module.exports = PdiReports;
