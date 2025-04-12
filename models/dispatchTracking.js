const pool = require('../config/db');

class DispatchTracking {
  static async getAll({ limit = 10, offset = 0 }) {
    const query = `
      SELECT tracking_id, sr_no, order_id, docket_number, dispatch_date, delivery_date, status, 
             created_at, updated_at
      FROM dispatch_tracking_details
      ORDER BY sr_no ASC
      LIMIT $1 OFFSET $2
    `;
    const { rows } = await pool.query(query, [limit, offset]);
    return rows;
  }

  static async update(trackingId, { tracking_id, docket_number, dispatch_date, delivery_date, status }) {
    const query = `
      UPDATE dispatch_tracking_details 
      SET 
        tracking_id = COALESCE($1, tracking_id),
        docket_number = COALESCE($2, docket_number),
        dispatch_date = COALESCE($3, dispatch_date),
        delivery_date = COALESCE($4, delivery_date),
        status = COALESCE($5, status)
      WHERE tracking_id = $6
      RETURNING *
    `;
    const values = [tracking_id, docket_number, dispatch_date, delivery_date, status, trackingId];
    const { rows } = await pool.query(query, values);
    return rows[0];
  }

  static async delete(trackingId) {
    const query = 'DELETE FROM dispatch_tracking_details WHERE tracking_id = $1 RETURNING *';
    const { rows } = await pool.query(query, [trackingId]);
    return rows[0];
  }
}

module.exports = DispatchTracking;