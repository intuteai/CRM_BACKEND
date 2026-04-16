const pool = require('../config/db');

class MotorRecipe {

  static async upsert({ customer_id, product_id, num_turns, num_coils, notes }) {
    const query = `
      INSERT INTO motor_recipes (customer_id, product_id, num_turns, num_coils, notes)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT ON CONSTRAINT uq_motor_recipes_customer_product
      DO UPDATE SET
        num_turns  = EXCLUDED.num_turns,
        num_coils  = EXCLUDED.num_coils,
        notes      = EXCLUDED.notes,
        updated_at = now()
      RETURNING *
    `;
    const { rows } = await pool.query(query, [customer_id, product_id, num_turns, num_coils, notes ?? null]);
    return rows[0];
  }

  static async getByCustomer(customer_id) {
    const query = `
      SELECT
        mr.*,
        u.name        AS customer_name,
        i.product_name,
        i.product_code
      FROM motor_recipes mr
      JOIN customers c  ON mr.customer_id = c.customer_id
      JOIN users u      ON c.user_id       = u.user_id
      JOIN inventory i  ON mr.product_id   = i.product_id
      WHERE mr.customer_id = $1
      ORDER BY mr.updated_at DESC
    `;
    const { rows } = await pool.query(query, [customer_id]);
    return rows;
  }

  static async getOne(customer_id, product_id) {
    const query = `
      SELECT
        mr.*,
        u.name        AS customer_name,
        i.product_name,
        i.product_code
      FROM motor_recipes mr
      JOIN customers c  ON mr.customer_id = c.customer_id
      JOIN users u      ON c.user_id       = u.user_id
      JOIN inventory i  ON mr.product_id   = i.product_id
      WHERE mr.customer_id = $1 AND mr.product_id = $2
    `;
    const { rows } = await pool.query(query, [customer_id, product_id]);
    return rows[0] || null;
  }

  static async getAll({ limit = 50, offset = 0 }) {
    const [result, countResult] = await Promise.all([
      pool.query(`
        SELECT
          mr.*,
          u.name        AS customer_name,
          i.product_name,
          i.product_code
        FROM motor_recipes mr
        JOIN customers c  ON mr.customer_id = c.customer_id
        JOIN users u      ON c.user_id       = u.user_id
        JOIN inventory i  ON mr.product_id   = i.product_id
        ORDER BY mr.updated_at DESC
        LIMIT $1 OFFSET $2
      `, [limit, offset]),
      pool.query('SELECT COUNT(*) FROM motor_recipes'),
    ]);
    return {
      data: result.rows,
      total: parseInt(countResult.rows[0].count, 10),
      limit,
      offset,
    };
  }

  static async delete(customer_id, product_id) {
    const { rows } = await pool.query(
      `DELETE FROM motor_recipes WHERE customer_id = $1 AND product_id = $2 RETURNING *`,
      [customer_id, product_id]
    );
    if (!rows.length) throw Object.assign(new Error('Recipe not found'), { status: 404, code: 'NOT_FOUND' });
    return rows[0];
  }
}

module.exports = MotorRecipe;