const pool = require('../../config/db');

class Order {
  static async getAllOrdersForChatbot(limit = 10) {
    const { rows } = await pool.query(
      `
      SELECT
        o.order_id,
        o.status,
        o.payment_status,
        TO_CHAR(o.target_delivery_date, 'YYYY-MM-DD') AS target_delivery_date,
        o.created_at,
        TRIM(u.name) AS customer_name
      FROM orders o
      JOIN users u ON o.user_id = u.user_id
      ORDER BY o.created_at DESC
      LIMIT $1
      `,
      [limit]
    );

    return rows;
  }

  static async getOrdersByStatusForChatbot(status, limit = 10) {
    const { rows } = await pool.query(
      `
      SELECT
        o.order_id,
        o.status,
        o.payment_status,
        TO_CHAR(o.target_delivery_date, 'YYYY-MM-DD') AS target_delivery_date,
        o.created_at,
        TRIM(u.name) AS customer_name
      FROM orders o
      JOIN users u ON o.user_id = u.user_id
      WHERE o.status = $1
      ORDER BY o.created_at DESC
      LIMIT $2
      `,
      [status, limit]
    );

    return rows;
  }

  static async countOrdersByStatusForChatbot() {
    const { rows } = await pool.query(
      `
      SELECT
        status,
        COUNT(*)::int AS count
      FROM orders
      GROUP BY status
      ORDER BY status ASC
      `
    );

    return rows;
  }
}

module.exports = { Order };
