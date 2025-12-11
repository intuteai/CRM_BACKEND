// models/inventory.js
const pool = require('../config/db');

function normalizeInventoryRow(row) {
  if (!row) return null;
  const product_id = row.product_id ?? row.productId ?? row.id ?? null;
  const product_name = (row.product_name ?? row.productName ?? row.name ?? row.product_code ?? '') + '';
  return {
    // canonical snake_case (used by many parts of your backend)
    product_id,
    product_name,
    stock_quantity: row.stock_quantity ?? row.stockQuantity ?? 0,
    price: row.price ?? null,
    description: row.description ?? null,
    product_code: row.product_code ?? row.productCode ?? null,
    returnable_qty: row.returnable_qty ?? row.returnableQty ?? 0,
    created_at: row.created_at ?? row.createdAt ?? null,
    // also provide camelCase aliases so existing callers won't break
    productId: product_id,
    productName: product_name,
    stockQuantity: row.stock_quantity ?? row.stockQuantity ?? 0,
    returnableQty: row.returnable_qty ?? row.returnableQty ?? 0,
    __raw: row,
  };
}

class Inventory {
  static async create({ product_name, stock_quantity, price, description, product_code, returnable_qty = 0 }, io) {
    const query = `
      INSERT INTO inventory (product_name, stock_quantity, price, description, product_code, returnable_qty)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
    `;
    const result = await pool.query(query, [product_name, stock_quantity, price, description, product_code, returnable_qty]);
    const product = normalizeInventoryRow(result.rows[0]);

    // emit both stock and returnable qty so clients can update UI
    if (io) io.emit('stockUpdate', { product_id: product.product_id, stock_quantity: product.stock_quantity, returnable_qty: product.returnable_qty });
    return product;
  }

  static async getAll({ limit = 10, offset = 0 }) {
    const query = 'SELECT * FROM inventory LIMIT $1 OFFSET $2';
    const countQuery = 'SELECT COUNT(*) FROM inventory';
    const [result, countResult] = await Promise.all([
      pool.query(query, [limit, offset]),
      pool.query(countQuery)
    ]);

    const rows = (result.rows || []).map(normalizeInventoryRow);
    return { data: rows, total: parseInt(countResult.rows[0].count, 10) };
  }

  static async update(productId, { product_name, stock_quantity, price, description, product_code, returnable_qty = 0 }) {
    const query = `
      UPDATE inventory 
      SET product_name = $1, stock_quantity = $2, price = $3, description = $4, product_code = $5, returnable_qty = $6, created_at = CURRENT_TIMESTAMP
      WHERE product_id = $7
      RETURNING *
    `;
    const values = [product_name, stock_quantity, price, description, product_code, returnable_qty, productId];
    const { rows } = await pool.query(query, values);
    if (rows.length === 0) {
      throw new Error('Product not found');
    }
    return normalizeInventoryRow(rows[0]);
  }

  static async delete(productId, io) {
    const query = 'DELETE FROM inventory WHERE product_id = $1 RETURNING *';
    const result = await pool.query(query, [productId]);
    if (result.rows.length === 0) {
      throw new Error('Product not found');
    }
    const product = normalizeInventoryRow(result.rows[0]);
    if (io) io.emit('stockUpdate', { product_id: product.product_id, stock_quantity: 0, returnable_qty: 0 });
    return product;
  }

  static async syncPriceWithPriceList(productId, price) {
    const query = `
      UPDATE price_list 
      SET price = $1, updated_at = CURRENT_TIMESTAMP
      WHERE product_id = $2
      RETURNING *
    `;
    const { rows } = await pool.query(query, [price, productId]);
    return rows[0];
  }
}

module.exports = Inventory;
