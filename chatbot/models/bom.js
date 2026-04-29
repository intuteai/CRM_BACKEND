const pool = require('../../config/db');

class BOMChatbot {
  static async getAllForChatbot(limit = 10) {
    const { rows } = await pool.query(
      `SELECT
         b.bom_id,
         i.product_name,
         i.product_code,
         COUNT(bm.bom_material_id)::int AS material_count,
         COALESCE(SUM(bm.total_value), 0)::numeric(15,2) AS total_bom_value,
         TO_CHAR(b.created_at, 'YYYY-MM-DD') AS created_at
       FROM bill_of_materials b
       LEFT JOIN inventory i ON b.product_id = i.product_id
       LEFT JOIN bom_materials bm ON b.bom_id = bm.bom_id
       GROUP BY b.bom_id, i.product_name, i.product_code, b.created_at
       ORDER BY b.created_at DESC
       LIMIT $1`,
      [limit]
    );
    return rows;
  }

  static async countForChatbot() {
    const { rows } = await pool.query(
      `SELECT
         COUNT(DISTINCT b.bom_id)::int AS total_boms,
         COUNT(bm.bom_material_id)::int AS total_materials_used,
         COALESCE(SUM(bm.total_value), 0)::numeric(15,2) AS total_value
       FROM bill_of_materials b
       LEFT JOIN bom_materials bm ON b.bom_id = bm.bom_id`
    );
    return rows[0];
  }

  static async getMostComplexForChatbot(limit = 10) {
    const { rows } = await pool.query(
      `SELECT
         b.bom_id,
         i.product_name,
         i.product_code,
         COUNT(bm.bom_material_id)::int AS material_count,
         COALESCE(SUM(bm.total_value), 0)::numeric(15,2) AS total_bom_value
       FROM bill_of_materials b
       LEFT JOIN inventory i ON b.product_id = i.product_id
       LEFT JOIN bom_materials bm ON b.bom_id = bm.bom_id
       GROUP BY b.bom_id, i.product_name, i.product_code
       ORDER BY material_count DESC
       LIMIT $1`,
      [limit]
    );
    return rows;
  }

  static async getRecentlyUpdatedForChatbot(limit = 10) {
    const { rows } = await pool.query(
      `SELECT
         b.bom_id,
         i.product_name,
         i.product_code,
         COUNT(bm.bom_material_id)::int AS material_count,
         TO_CHAR(b.updated_at, 'YYYY-MM-DD') AS updated_at
       FROM bill_of_materials b
       LEFT JOIN inventory i ON b.product_id = i.product_id
       LEFT JOIN bom_materials bm ON b.bom_id = bm.bom_id
       WHERE b.updated_at IS NOT NULL
       GROUP BY b.bom_id, i.product_name, i.product_code, b.updated_at
       ORDER BY b.updated_at DESC
       LIMIT $1`,
      [limit]
    );
    return rows;
  }

  static async getHighValueForChatbot(limit = 10) {
    const { rows } = await pool.query(
      `SELECT
         b.bom_id,
         i.product_name,
         i.product_code,
         COUNT(bm.bom_material_id)::int AS material_count,
         COALESCE(SUM(bm.total_value), 0)::numeric(15,2) AS total_bom_value
       FROM bill_of_materials b
       LEFT JOIN inventory i ON b.product_id = i.product_id
       LEFT JOIN bom_materials bm ON b.bom_id = bm.bom_id
       GROUP BY b.bom_id, i.product_name, i.product_code
       ORDER BY total_bom_value DESC
       LIMIT $1`,
      [limit]
    );
    return rows;
  }
}

module.exports = { BOMChatbot };
