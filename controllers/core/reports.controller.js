const pool = require('../../config/db');

exports.orderSummary = async (req, res, next) => {
  const { limit = 10, offset = 0 } = req.query;
  try {
    const query = `
      SELECT o.order_id, o.status, o.payment_status, o.created_at, u.name AS user_name,
             COUNT(oi.order_item_id) AS item_count, SUM(oi.quantity * oi.price) AS total_amount
      FROM orders o
      JOIN users u ON o.user_id = u.user_id
      JOIN order_items oi ON o.order_id = oi.order_id
      GROUP BY o.order_id, o.status, o.payment_status, o.created_at, u.name
      ORDER BY o.created_at DESC
      LIMIT $1 OFFSET $2
    `;
    const countQuery = 'SELECT COUNT(DISTINCT o.order_id) FROM orders o JOIN order_items oi ON o.order_id = oi.order_id';
    const [result, countResult] = await Promise.all([pool.query(query, [parseInt(limit), parseInt(offset)]), pool.query(countQuery)]);
    res.json({ data: result.rows, total: parseInt(countResult.rows[0].count, 10) });
  } catch (error) {
    next(error);
  }
};

exports.inventoryStatus = async (req, res, next) => {
  try {
    const result = await pool.query('SELECT product_name, stock_quantity, price, created_at FROM inventory WHERE stock_quantity < 10 ORDER BY stock_quantity ASC');
    res.json({ data: result.rows, total: result.rows.length });
  } catch (error) {
    next(error);
  }
};
