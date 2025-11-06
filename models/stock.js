const pool = require('../config/db');

class Stock {
  // --------------------------------------------------------------
  // 1. GET ALL (now returns location)
  // --------------------------------------------------------------
  static async getAll({ limit = 10, offset = 0 }) {
    const query = `
      SELECT 
        product_id      AS "productId",
        stock_quantity  AS "stockQuantity",
        price,
        created_at      AS "createdAt",
        product_name    AS "productName",
        description,
        product_code    AS "productCode",
        qty_required    AS "qtyRequired",
        location        AS "location"
      FROM raw_materials
      ORDER BY product_id ASC
      LIMIT $1 OFFSET $2
    `;
    const totalQuery = 'SELECT COUNT(*) FROM raw_materials';
    try {
      const [itemsResult, totalResult] = await Promise.all([
        pool.query(query, [limit, offset]),
        pool.query(totalQuery),
      ]);
      return {
        data: itemsResult.rows,
        total: parseInt(totalResult.rows[0].count, 10),
      };
    } catch (error) {
      console.error('Error querying raw_materials:', error);
      throw error;
    }
  }

  // --------------------------------------------------------------
  // 2. CREATE (accept location)
  // --------------------------------------------------------------
  static async create({
    productName,
    description,
    productCode,
    price,
    stockQuantity,
    qtyRequired,
    location,          // <-- NEW
  }) {
    const query = `
      INSERT INTO raw_materials (
        product_name, description, product_code, price,
        stock_quantity, qty_required, created_at, location
      ) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, $7)
      RETURNING
        product_id      AS "productId",
        stock_quantity  AS "stockQuantity",
        price,
        created_at      AS "createdAt",
        product_name    AS "productName",
        description,
        product_code    AS "productCode",
        qty_required    AS "qtyRequired",
        location        AS "location"
    `;
    const values = [
      productName,
      description || null,
      productCode,
      price,
      stockQuantity ?? 0,
      qtyRequired ?? 0,
      location || null,          // <-- NEW
    ];
    try {
      const { rows } = await pool.query(query, values);
      return rows[0];
    } catch (error) {
      console.error('Error creating stock item:', error);
      throw error;
    }
  }

  // --------------------------------------------------------------
  // 3. UPDATE (accept location)
  // --------------------------------------------------------------
  static async update(productId, {
    productName,
    description,
    productCode,
    price,
    stockQuantity,
    qtyRequired,
    location,          // <-- NEW
  }) {
    const query = `
      UPDATE raw_materials
      SET
        product_name   = $1,
        description    = $2,
        product_code   = $3,
        price          = $4,
        stock_quantity = COALESCE($5, stock_quantity),
        qty_required   = $6,
        location       = $7
      WHERE product_id = $8
      RETURNING
        product_id      AS "productId",
        stock_quantity  AS "stockQuantity",
        price,
        created_at      AS "createdAt",
        product_name    AS "productName",
        description,
        product_code    AS "productCode",
        qty_required    AS "qtyRequired",
        location        AS "location"
    `;
    const values = [
      productName,
      description || null,
      productCode,
      price,
      stockQuantity !== undefined ? stockQuantity : null,
      qtyRequired ?? 0,
      location !== undefined ? location : null,   // <-- NEW
      productId,
    ];
    try {
      const { rows } = await pool.query(query, values);
      if (rows.length === 0) {
        throw new Error('Stock item not found');
      }
      return rows[0];
    } catch (error) {
      console.error(`Error updating stock item ${productId}:`, error);
      throw error;
    }
  }

  // --------------------------------------------------------------
  // 4. DELETE (unchanged)
  // --------------------------------------------------------------
  static async delete(productId) {
    const query = `
      DELETE FROM raw_materials
      WHERE product_id = $1
      RETURNING product_id AS "productId"
    `;
    try {
      const { rows } = await pool.query(query, [productId]);
      if (rows.length === 0) {
        throw new Error('Stock item not found');
      }
      return rows[0];
    } catch (error) {
      console.error(`Error deleting stock item ${productId}:`, error);
      throw error;
    }
  }

  // --------------------------------------------------------------
  // 5. ADJUST STOCK (unchanged)
  // --------------------------------------------------------------
  static async adjustStock({ productId, quantity, reason, userId }) {
    const adjustQuery = `
      UPDATE raw_materials
      SET stock_quantity = stock_quantity + $1
      WHERE product_id = $2
      RETURNING product_id AS "productId", stock_quantity AS "stockQuantity"
    `;
    const logQuery = `
      INSERT INTO stock_adjustments (product_id, quantity, reason, created_by, created_at)
      VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
    `;
    try {
      await pool.query('BEGIN');
      const { rows: adjustRows } = await pool.query(adjustQuery, [quantity, productId]);
      if (adjustRows.length === 0) {
        throw new Error('Stock item not found');
      }
      await pool.query(logQuery, [productId, quantity, reason || null, userId || null]);
      await pool.query('COMMIT');
      return adjustRows[0];
    } catch (error) {
      await pool.query('ROLLBACK');
      console.error(`Error adjusting stock for product ${productId}:`, error);
      throw error;
    }
  }
}

module.exports = Stock;