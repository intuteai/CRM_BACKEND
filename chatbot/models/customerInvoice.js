const pool = require('../../config/db');

class CustomerInvoiceChatbot {
  static async getAllForChatbot(limit = 10) {
    const { rows } = await pool.query(
      `SELECT
         ci.invoice_id,
         ci.invoice_number,
         TO_CHAR(ci.issue_date, 'YYYY-MM-DD') AS issue_date,
         ci.total_value,
         COALESCE(u.name, 'N/A') AS customer_name,
         COALESCE(o.status, 'N/A') AS order_status
       FROM customer_invoices ci
       LEFT JOIN customers c ON ci.customer_id = c.customer_id
       LEFT JOIN users u ON c.user_id = u.user_id
       LEFT JOIN orders o ON ci.order_id = o.order_id
       ORDER BY ci.issue_date DESC, ci.invoice_id DESC
       LIMIT $1`,
      [limit]
    );
    return rows;
  }

  static async countForChatbot() {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS total_invoices,
              COALESCE(SUM(total_value), 0)::numeric(15,2) AS total_value
       FROM customer_invoices`
    );
    return rows[0];
  }

  static async getHighValueForChatbot(threshold = 50000, limit = 10) {
    const { rows } = await pool.query(
      `SELECT
         ci.invoice_id,
         ci.invoice_number,
         TO_CHAR(ci.issue_date, 'YYYY-MM-DD') AS issue_date,
         ci.total_value,
         COALESCE(u.name, 'N/A') AS customer_name
       FROM customer_invoices ci
       LEFT JOIN customers c ON ci.customer_id = c.customer_id
       LEFT JOIN users u ON c.user_id = u.user_id
       WHERE ci.total_value >= $1
       ORDER BY ci.total_value DESC
       LIMIT $2`,
      [threshold, limit]
    );
    return rows;
  }

  static async getThisMonthForChatbot(limit = 10) {
    const { rows } = await pool.query(
      `SELECT
         ci.invoice_id,
         ci.invoice_number,
         TO_CHAR(ci.issue_date, 'YYYY-MM-DD') AS issue_date,
         ci.total_value,
         COALESCE(u.name, 'N/A') AS customer_name
       FROM customer_invoices ci
       LEFT JOIN customers c ON ci.customer_id = c.customer_id
       LEFT JOIN users u ON c.user_id = u.user_id
       WHERE DATE_TRUNC('month', ci.issue_date) = DATE_TRUNC('month', NOW())
       ORDER BY ci.issue_date DESC
       LIMIT $1`,
      [limit]
    );
    return rows;
  }

  static async getTotalValueSummaryForChatbot() {
    const { rows } = await pool.query(
      `SELECT
         COUNT(*)::int AS total_invoices,
         COALESCE(SUM(total_value), 0)::numeric(15,2) AS total_value,
         COALESCE(AVG(total_value), 0)::numeric(15,2) AS avg_value,
         COALESCE(MAX(total_value), 0)::numeric(15,2) AS max_value,
         COALESCE(MIN(total_value), 0)::numeric(15,2) AS min_value
       FROM customer_invoices`
    );
    return rows[0];
  }

  static async getMonthlyTrendForChatbot() {
    const { rows } = await pool.query(
      `SELECT
         TO_CHAR(DATE_TRUNC('month', issue_date), 'Mon YYYY') AS month,
         COUNT(*)::int AS invoice_count,
         SUM(total_value)::numeric(15,2) AS total_value
       FROM customer_invoices
       WHERE issue_date >= NOW() - INTERVAL '6 months'
       GROUP BY DATE_TRUNC('month', issue_date)
       ORDER BY DATE_TRUNC('month', issue_date) DESC`
    );
    return rows;
  }
}

module.exports = { CustomerInvoiceChatbot };
