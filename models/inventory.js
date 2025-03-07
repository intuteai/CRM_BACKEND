const pool = require('../config/db');
const { sendEmail } = require('../utils/email');

class Inventory {
  static async create({ product_name, stock_quantity, price }, io) {
    const query = `
      INSERT INTO inventory (product_name, stock_quantity, price)
      VALUES ($1, $2, $3) RETURNING *
    `;
    const result = await pool.query(query, [product_name, stock_quantity, price]);
    const product = result.rows[0];
    if (stock_quantity < 10) {
      await sendEmail('admin@example.com', 'Low Stock Alert', `${product_name} stock is low: ${stock_quantity}`);
    }
    io.emit('stockUpdate', { product_id: product.product_id, stock_quantity });
    return product;
  }

  static async getAll({ limit = 10, offset = 0 }) {
    const query = 'SELECT * FROM inventory LIMIT $1 OFFSET $2';
    const countQuery = 'SELECT COUNT(*) FROM inventory';
    const [result, countResult] = await Promise.all([pool.query(query, [limit, offset]), pool.query(countQuery)]);
    return { data: result.rows, total: parseInt(countResult.rows[0].count, 10) };
  }
}

module.exports = Inventory;