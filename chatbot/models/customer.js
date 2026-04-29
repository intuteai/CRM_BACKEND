const pool = require('../../config/db');

class CustomerChatbot {
  static async getAllForChatbot(limit = 10) {
    const { rows } = await pool.query(
      `SELECT
         c.customer_id,
         TRIM(u.name) AS name,
         u.email,
         c.city,
         c.phone,
         COUNT(DISTINCT o.order_id)::int AS total_orders
       FROM customers c
       JOIN users u ON c.user_id = u.user_id
       LEFT JOIN orders o ON u.user_id = o.user_id
       GROUP BY c.customer_id, u.name, u.email, c.city, c.phone
       ORDER BY c.customer_id DESC
       LIMIT $1`,
      [limit]
    );
    return rows;
  }

  static async countForChatbot() {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS total_customers FROM customers`
    );
    return rows[0];
  }

  static async getTopByOrdersForChatbot(limit = 10) {
    const { rows } = await pool.query(
      `SELECT
         c.customer_id,
         TRIM(u.name) AS name,
         c.city,
         COUNT(DISTINCT o.order_id)::int AS total_orders
       FROM customers c
       JOIN users u ON c.user_id = u.user_id
       LEFT JOIN orders o ON u.user_id = o.user_id
       GROUP BY c.customer_id, u.name, c.city
       ORDER BY total_orders DESC
       LIMIT $1`,
      [limit]
    );
    return rows;
  }

  static async getWithNoOrdersForChatbot(limit = 10) {
    const { rows } = await pool.query(
      `SELECT
         c.customer_id,
         TRIM(u.name) AS name,
         u.email,
         c.city,
         c.phone
       FROM customers c
       JOIN users u ON c.user_id = u.user_id
       LEFT JOIN orders o ON u.user_id = o.user_id
       WHERE o.order_id IS NULL
       ORDER BY c.customer_id DESC
       LIMIT $1`,
      [limit]
    );
    return rows;
  }

  static async getByCityForChatbot() {
    const { rows } = await pool.query(
      `SELECT
         COALESCE(c.city, 'Unknown') AS city,
         COUNT(*)::int AS customer_count
       FROM customers c
       GROUP BY c.city
       ORDER BY customer_count DESC
       LIMIT 15`
    );
    return rows;
  }

  static async getRecentForChatbot(limit = 10) {
    const { rows } = await pool.query(
      `SELECT
         c.customer_id,
         TRIM(u.name) AS name,
         u.email,
         c.city,
         TO_CHAR(c.created_at, 'YYYY-MM-DD') AS joined_date
       FROM customers c
       JOIN users u ON c.user_id = u.user_id
       ORDER BY c.created_at DESC
       LIMIT $1`,
      [limit]
    );
    return rows;
  }

  static async getOrderStatusBreakdownForChatbot() {
    const { rows } = await pool.query(
      `SELECT
         o.status,
         COUNT(DISTINCT o.order_id)::int AS order_count,
         COUNT(DISTINCT o.user_id)::int AS customer_count
       FROM orders o
       GROUP BY o.status
       ORDER BY order_count DESC`
    );
    return rows;
  }
}

module.exports = { CustomerChatbot };
