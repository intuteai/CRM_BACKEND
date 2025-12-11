// models/stock.js
const pool = require('../config/db');

function normalizeStockRow(row) {
  if (!row) return null;
  // rows from your queries currently come as camelCase (productId, productName).
  // provide both canonical snake_case and camelCase for safety.
  const product_id = row.product_id ?? row.productId ?? row.productId ?? null;
  const product_name = (row.product_name ?? row.productName ?? row.name ?? row.product_code ?? '') + '';

  return {
    // snake_case canonical
    product_id,
    product_name,
    stock_quantity: row.stock_quantity ?? row.stockQuantity ?? 0,
    price: row.price ?? null,
    created_at: row.created_at ?? row.createdAt ?? null,
    description: row.description ?? null,
    product_code: row.product_code ?? row.productCode ?? null,
    qty_required: row.qty_required ?? row.qtyRequired ?? 0,
    location: row.location ?? null,
    image_url: row.image_url ?? row.imageUrl ?? null,
    returnable_qty: row.returnable_qty ?? row.returnableQty ?? 0,
    // camelCase aliases kept for compatibility
    productId: product_id,
    productName: product_name,
    stockQuantity: row.stock_quantity ?? row.stockQuantity ?? 0,
    qtyRequired: row.qty_required ?? row.qtyRequired ?? 0,
    imageUrl: row.image_url ?? row.imageUrl ?? null,
    returnableQty: row.returnable_qty ?? row.returnableQty ?? 0,
    __raw: row,
  };
}

class Stock {
  // --------------------------------------------------------------
  // 1. GET ALL (returns both snake_case and camelCase)
  // --------------------------------------------------------------
  static async getAll({ limit = 10, offset = 0 }) {
    const query = `
      SELECT 
        product_id,
        stock_quantity,
        price,
        created_at,
        product_name,
        description,
        product_code,
        qty_required,
        location,
        image_url,
        returnable_qty
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

      const rows = (itemsResult.rows || []).map(normalizeStockRow);
      return {
        data: rows,
        total: parseInt(totalResult.rows[0].count, 10),
      };
    } catch (error) {
      console.error('Error querying raw_materials:', error);
      throw error;
    }
  }

  // --------------------------------------------------------------
  // 2. CREATE
  // --------------------------------------------------------------
  static async create({
    productName,
    description,
    productCode,
    price,
    stockQuantity,
    qtyRequired,
    location,
    imageUrl,      // optional
    returnableQty, // optional (numeric)
  }) {
    const query = `
      INSERT INTO raw_materials (
        product_name,
        description,
        product_code,
        price,
        stock_quantity,
        qty_required,
        created_at,
        location,
        image_url,
        returnable_qty
      ) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, $7, $8, $9)
      RETURNING
        product_id,
        stock_quantity,
        price,
        created_at,
        product_name,
        description,
        product_code,
        qty_required,
        location,
        image_url,
        returnable_qty
    `;

    const values = [
      productName,
      description || null,
      productCode,
      price,
      stockQuantity ?? 0,
      qtyRequired ?? 0,
      location || null,
      imageUrl || null,
      returnableQty !== undefined ? returnableQty : 0,
    ];

    try {
      const { rows } = await pool.query(query, values);
      return normalizeStockRow(rows[0]);
    } catch (error) {
      console.error('Error creating stock item:', error);
      throw error;
    }
  }

  // --------------------------------------------------------------
  // 3. UPDATE
  // --------------------------------------------------------------
  static async update(productId, {
    productName,
    description,
    productCode,
    price,
    stockQuantity,
    qtyRequired,
    location,
    imageUrl,      // optional - if undefined, keep existing
    returnableQty, // optional - if undefined, keep existing
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
        location       = $7,
        image_url      = COALESCE($8, image_url),
        returnable_qty = COALESCE($9, returnable_qty)
      WHERE product_id = $10
      RETURNING
        product_id,
        stock_quantity,
        price,
        created_at,
        product_name,
        description,
        product_code,
        qty_required,
        location,
        image_url,
        returnable_qty
    `;

    const values = [
      productName,
      description || null,
      productCode,
      price,
      stockQuantity !== undefined ? stockQuantity : null,
      qtyRequired ?? 0,
      location !== undefined ? location : null,
      imageUrl !== undefined ? imageUrl : null,
      returnableQty !== undefined ? returnableQty : null,
      productId,
    ];

    try {
      const { rows } = await pool.query(query, values);
      if (rows.length === 0) {
        throw new Error('Stock item not found');
      }
      return normalizeStockRow(rows[0]);
    } catch (error) {
      console.error(`Error updating stock item ${productId}:`, error);
      throw error;
    }
  }

  // --------------------------------------------------------------
  // 4. DELETE
  // --------------------------------------------------------------
  static async delete(productId) {
    const query = `
      DELETE FROM raw_materials
      WHERE product_id = $1
      RETURNING product_id
    `;
    try {
      const { rows } = await pool.query(query, [productId]);
      if (rows.length === 0) {
        throw new Error('Stock item not found');
      }
      // return normalized minimal info
      return { product_id: rows[0].product_id, productId: rows[0].product_id };
    } catch (error) {
      console.error(`Error deleting stock item ${productId}:`, error);
      throw error;
    }
  }

  // --------------------------------------------------------------
  // 5. ADJUST STOCK
  // --------------------------------------------------------------
  static async adjustStock({ productId, quantity, reason, userId }) {
    const adjustQuery = `
      UPDATE raw_materials
      SET stock_quantity = stock_quantity + $1
      WHERE product_id = $2
      RETURNING product_id, stock_quantity
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

      await pool.query(logQuery, [
        productId,
        quantity,
        reason || null,
        userId || null,
      ]);

      await pool.query('COMMIT');

      // return normalized row (minimal)
      return { product_id: adjustRows[0].product_id, stock_quantity: adjustRows[0].stock_quantity, productId: adjustRows[0].product_id, stockQuantity: adjustRows[0].stock_quantity };
    } catch (error) {
      await pool.query('ROLLBACK');
      console.error(`Error adjusting stock for product ${productId}:`, error);
      throw error;
    }
  }
}

module.exports = Stock;
