const pool = require('../config/db');

class Pdi {
  // Create a new PDI report
  static async create({ customer_id, order_id, status, inspected_by, inspection_date, report_link }, io) {
    const query = `
      INSERT INTO pre_dispatch_inspection_reports (
        customer_id, order_id, status, inspected_by, inspection_date, report_link
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `;
    const values = [
      customer_id || null,
      order_id || null,
      status || 'Pending',
      inspected_by || null,
      inspection_date ? new Date(inspection_date).toISOString() : null,
      report_link || null
    ];
    try {
      const result = await pool.query(query, values);
      const report = result.rows[0];
      if (io) {
        io.emit('pdiUpdate', {
          report_id: report.report_id,
          status: report.status,
          inspection_date: report.inspection_date,
          report_link: report.report_link
        });
      }
      return report;
    } catch (error) {
      throw error;
    }
  }

  // Get all PDI reports with cursor-based pagination
  static async getAll({ limit = 10, cursor = null }) {
    let query = `
      SELECT 
        pdi.sr_no, pdi.customer_id, pdi.order_id, pdi.report_id, pdi.status, 
        pdi.inspected_by, pdi.inspection_date, pdi.report_link,
        u.name AS customer_name,
        o.status AS order_status
      FROM pre_dispatch_inspection_reports pdi
      LEFT JOIN customers c ON pdi.customer_id = c.customer_id
      LEFT JOIN users u ON c.user_id = u.user_id
      LEFT JOIN orders o ON pdi.order_id = o.order_id
      WHERE ($1::text IS NULL OR pdi.inspection_date < $1::timestamp)
      ORDER BY pdi.inspection_date DESC, pdi.report_id DESC
      LIMIT $2
    `;
    const values = [cursor, limit];
    const totalQuery = 'SELECT COUNT(*) FROM pre_dispatch_inspection_reports';
    const [result, totalResult] = await Promise.all([
      pool.query(query, values),
      pool.query(totalQuery),
    ]);
    console.log('PDI reports queried:', result.rows);
    return {
      data: result.rows,
      total: parseInt(totalResult.rows[0].count, 10),
      cursor: result.rows.length > 0 ? result.rows[result.rows.length - 1].inspection_date : null,
    };
  }

  // Get a single PDI report by report_id
  static async getById(reportId) {
    const query = `
      SELECT 
        pdi.sr_no, pdi.customer_id, pdi.order_id, pdi.report_id, pdi.status, 
        pdi.inspected_by, pdi.inspection_date, pdi.report_link,
        u.name AS customer_name,
        o.status AS order_status
      FROM pre_dispatch_inspection_reports pdi
      LEFT JOIN customers c ON pdi.customer_id = c.customer_id
      LEFT JOIN users u ON c.user_id = u.user_id
      LEFT JOIN orders o ON pdi.order_id = o.order_id
      WHERE pdi.report_id = $1
    `;
    const result = await pool.query(query, [reportId]);
    if (result.rows.length === 0) {
      throw new Error('Report not found');
    }
    return result.rows[0];
  }

  // Update a PDI report
  static async update(reportId, { customer_id, order_id, status, inspected_by, inspection_date, report_link }, io) {
    const query = `
      UPDATE pre_dispatch_inspection_reports
      SET 
        customer_id = $1,
        order_id = $2,
        status = $3,
        inspected_by = $4,
        inspection_date = $5,
        report_link = $6
      WHERE report_id = $7
      RETURNING *
    `;
    const values = [
      customer_id || null,
      order_id || null,
      status || 'Pending',
      inspected_by || null,
      inspection_date ? new Date(inspection_date).toISOString() : null,
      report_link || null,
      reportId
    ];
    try {
      const result = await pool.query(query, values);
      if (result.rows.length === 0) {
        throw new Error('Report not found');
      }
      const report = result.rows[0];
      if (io) {
        io.emit('pdiUpdate', {
          report_id: report.report_id,
          status: report.status,
          inspection_date: report.inspection_date,
          report_link: report.report_link
        });
      }
      return report;
    } catch (error) {
      throw error;
    }
  }

  // Delete a PDI report
  static async delete(reportId, io) {
    const query = 'DELETE FROM pre_dispatch_inspection_reports WHERE report_id = $1 RETURNING *';
    try {
      const result = await pool.query(query, [reportId]);
      if (result.rows.length === 0) {
        throw new Error('Report not found');
      }
      const report = result.rows[0];
      if (io) {
        io.emit('pdiUpdate', { report_id: report.report_id, status: 'Deleted' });
      }
      return report;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = Pdi;