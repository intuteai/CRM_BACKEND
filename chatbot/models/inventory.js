const pool = require('../../config/db');

class InventoryChatbot {
  static async getAllForChatbot(limit = 10) {
    const { rows } = await pool.query(
      `SELECT
         product_id,
         product_name,
         product_code,
         stock_quantity,
         returnable_qty,
         price
       FROM inventory
       ORDER BY product_id DESC
       LIMIT $1`,
      [limit]
    );
    return rows;
  }

  static async countForChatbot() {
    const { rows } = await pool.query(
      `SELECT
         COUNT(*)::int AS total_products,
         SUM(stock_quantity)::int AS total_stock,
         COUNT(*) FILTER (WHERE stock_quantity = 0)::int AS out_of_stock,
         COUNT(*) FILTER (WHERE stock_quantity > 0 AND stock_quantity <= 10)::int AS low_stock
       FROM inventory`
    );
    return rows[0];
  }

  static async getLowStockForChatbot(threshold = 10, limit = 10) {
    const { rows } = await pool.query(
      `SELECT
         product_id,
         product_name,
         product_code,
         stock_quantity,
         price
       FROM inventory
       WHERE stock_quantity > 0 AND stock_quantity <= $1
       ORDER BY stock_quantity ASC
       LIMIT $2`,
      [threshold, limit]
    );
    return rows;
  }

  static async getOutOfStockForChatbot(limit = 10) {
    const { rows } = await pool.query(
      `SELECT
         product_id,
         product_name,
         product_code,
         stock_quantity
       FROM inventory
       WHERE stock_quantity = 0
       ORDER BY product_name ASC
       LIMIT $1`,
      [limit]
    );
    return rows;
  }

  static async getTopByStockForChatbot(limit = 10) {
    const { rows } = await pool.query(
      `SELECT
         product_id,
         product_name,
         product_code,
         stock_quantity,
         price
       FROM inventory
       ORDER BY stock_quantity DESC
       LIMIT $1`,
      [limit]
    );
    return rows;
  }

  static async getWithActiveHoldsForChatbot(limit = 10) {
    const { rows } = await pool.query(
      `SELECT
         i.product_id,
         i.product_name,
         i.product_code,
         i.stock_quantity,
         COALESCE(SUM(h.quantity), 0)::int AS reserved_qty,
         (i.stock_quantity - COALESCE(SUM(h.quantity), 0))::int AS available_qty
       FROM inventory i
       JOIN inventory_holds h ON h.product_id = i.product_id AND h.status = 'ACTIVE'
       GROUP BY i.product_id, i.product_name, i.product_code, i.stock_quantity
       ORDER BY reserved_qty DESC
       LIMIT $1`,
      [limit]
    );
    return rows;
  }

  static async getInventoryValueForChatbot() {
    const { rows } = await pool.query(
      `SELECT
         COUNT(*)::int AS total_products,
         SUM(stock_quantity)::int AS total_units,
         COALESCE(SUM(stock_quantity * price), 0)::numeric(15,2) AS total_value,
         COALESCE(AVG(price), 0)::numeric(15,2) AS avg_price
       FROM inventory
       WHERE price IS NOT NULL`
    );
    return rows[0];
  }
}

module.exports = { InventoryChatbot };
