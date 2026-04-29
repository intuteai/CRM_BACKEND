const pool = require('../../config/db');

class RawMaterialChatbot {
  static async getAllForChatbot(limit = 10) {
    const { rows } = await pool.query(
      `SELECT
         product_id,
         product_name,
         product_code,
         stock_quantity,
         qty_required,
         price,
         location
       FROM raw_materials
       ORDER BY product_id ASC
       LIMIT $1`,
      [limit]
    );
    return rows;
  }

  static async countForChatbot() {
    const { rows } = await pool.query(
      `SELECT
         COUNT(*)::int AS total_materials,
         SUM(stock_quantity)::int AS total_stock,
         COUNT(*) FILTER (WHERE stock_quantity = 0)::int AS out_of_stock,
         COUNT(*) FILTER (WHERE stock_quantity < qty_required)::int AS below_required
       FROM raw_materials`
    );
    return rows[0];
  }

  static async getLowStockForChatbot(limit = 10) {
    const { rows } = await pool.query(
      `SELECT
         product_id,
         product_name,
         product_code,
         stock_quantity,
         qty_required,
         location
       FROM raw_materials
       WHERE stock_quantity < qty_required
       ORDER BY (qty_required - stock_quantity) DESC
       LIMIT $1`,
      [limit]
    );
    return rows;
  }

  static async getOutOfStockForChatbot(limit = 10) {
    const { rows } = await pool.query(
      `SELECT
         product_id,
         product_name,
         product_code,
         qty_required,
         location
       FROM raw_materials
       WHERE stock_quantity = 0
       ORDER BY product_name ASC
       LIMIT $1`,
      [limit]
    );
    return rows;
  }

  static async getByLocationForChatbot() {
    const { rows } = await pool.query(
      `SELECT
         COALESCE(location, 'Unassigned') AS location,
         COUNT(*)::int AS material_count,
         SUM(stock_quantity)::int AS total_stock
       FROM raw_materials
       GROUP BY location
       ORDER BY material_count DESC
       LIMIT 15`
    );
    return rows;
  }

  static async getMostNeededForChatbot(limit = 10) {
    const { rows } = await pool.query(
      `SELECT
         product_id,
         product_name,
         product_code,
         stock_quantity,
         qty_required,
         (qty_required - stock_quantity) AS shortfall,
         location
       FROM raw_materials
       WHERE qty_required > stock_quantity
       ORDER BY (qty_required - stock_quantity) DESC
       LIMIT $1`,
      [limit]
    );
    return rows;
  }

  static async getMaterialValueForChatbot() {
    const { rows } = await pool.query(
      `SELECT
         COUNT(*)::int AS total_materials,
         SUM(stock_quantity)::int AS total_units,
         COALESCE(SUM(stock_quantity * price), 0)::numeric(15,2) AS total_value,
         COALESCE(AVG(price), 0)::numeric(15,2) AS avg_price
       FROM raw_materials
       WHERE price IS NOT NULL`
    );
    return rows[0];
  }
}

module.exports = { RawMaterialChatbot };
