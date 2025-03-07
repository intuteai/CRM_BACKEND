const pool = require('../config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

class User {
  static async create({ name, email, password, role_id = 2 }) {
    const hashedPassword = await bcrypt.hash(password, 10);
    const query = `
      INSERT INTO users (name, email, password_hash, role_id)
      VALUES ($1, $2, $3, $4) RETURNING user_id, role_id
    `;
    const result = await pool.query(query, [name, email, hashedPassword, role_id]);
    const user = result.rows[0];
    return {
      token: jwt.sign({ user_id: user.user_id, role_id: user.role_id }, process.env.JWT_SECRET, { expiresIn: '1h' }),
    };
  }

  static async findByEmail(email) {
    const query = 'SELECT * FROM users WHERE email = $1';
    const result = await pool.query(query, [email]);
    return result.rows[0];
  }

  static async getCustomers({ limit = 10, offset = 0 }) {
    const query = 'SELECT user_id, name, email FROM users WHERE role_id = 2 LIMIT $1 OFFSET $2';
    const countQuery = 'SELECT COUNT(*) FROM users WHERE role_id = 2';
    const [result, countResult] = await Promise.all([
      pool.query(query, [limit, offset]),
      pool.query(countQuery),
    ]);
    return { data: result.rows, total: parseInt(countResult.rows[0].count, 10) };
  }

  static async update(id, { name, email }) {
    const query = 'UPDATE users SET name = $1, email = $2 WHERE user_id = $3 AND role_id = 2 RETURNING *';
    const result = await pool.query(query, [name, email, id]);
    if (result.rows.length === 0) {
      throw Object.assign(new Error('Customer not found'), { status: 404, code: 'NOT_FOUND' });
    }
    return result.rows[0];
  }
}

module.exports = User;