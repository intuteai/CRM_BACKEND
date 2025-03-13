const pool = require('../config/db');

class Inventory {
  static async create({ product_name, stock_quantity, price, description, product_code }, io) {
    const query = `
      INSERT INTO inventory (product_name, stock_quantity, price, description, product_code)
      VALUES ($1, $2, $3, $4, $5) RETURNING *
    `;
    const result = await pool.query(query, [product_name, stock_quantity, price, description, product_code]);
    const product = result.rows[0];
    io.emit('stockUpdate', { product_id: product.product_id, stock_quantity });
    return product;
  }

  static async getAll({ limit = 10, offset = 0 }) {
    const query = 'SELECT * FROM inventory LIMIT $1 OFFSET $2';
    const countQuery = 'SELECT COUNT(*) FROM inventory';
    const [result, countResult] = await Promise.all([
      pool.query(query, [limit, offset]),
      pool.query(countQuery)
    ]);
    return { data: result.rows, total: parseInt(countResult.rows[0].count, 10) };
  }

  static async delete(productId, io) {
    const query = 'DELETE FROM inventory WHERE product_id = $1 RETURNING *';
    const result = await pool.query(query, [productId]);
    if (result.rows.length === 0) {
      throw new Error('Product not found');
    }
    const product = result.rows[0];
    io.emit('stockUpdate', { product_id: product.product_id, stock_quantity: 0 });
    return product;
  }
}

module.exports = Inventory;