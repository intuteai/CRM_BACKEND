const pool = require('../config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

class User {
  static async create({ name, email, password, role_id = 2 }) {
    const hashedPassword = password 
      ? await bcrypt.hash(password, 10) 
      : '$2a$10$XcmsTW5nP3mKQYQFvk7g7.DkCseqXgCxZB2Y/Kk8ExL6Kck.cRqA2'; // Default password
    
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      // Ensure sequence is ahead of max user_id
      await client.query(`
        SELECT setval('users_user_id_seq', GREATEST((SELECT MAX(user_id) FROM users) + 1, nextval('users_user_id_seq')))
      `);

      const query = `
        INSERT INTO users (name, email, password_hash, role_id, created_at)
        VALUES ($1, $2, $3, $4, NOW())
        RETURNING user_id, role_id, name, email
      `;
      const result = await client.query(query, [name, email, hashedPassword, role_id]);
      const user = result.rows[0];
      
      await client.query('COMMIT');
      
      return {
        token: jwt.sign({ user_id: user.user_id, role_id: user.role_id }, process.env.JWT_SECRET, { expiresIn: '1h' }),
        user: {
          user_id: user.user_id,
          name: user.name,
          email: user.email,
          role_id: user.role_id,
        },
      };
    } catch (error) {
      await client.query('ROLLBACK');
      if (error.code === '23505') { // PostgreSQL unique violation
        if (error.constraint === 'users_email_key') {
          throw Object.assign(new Error('Email already exists'), { status: 400, code: 'DUPLICATE_EMAIL' });
        } else if (error.constraint === 'users_pkey') {
          throw Object.assign(new Error('User ID conflict'), { status: 500, code: 'USER_ID_CONFLICT' });
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  static async findByEmail(email) {
    const query = 'SELECT user_id, name, email, password_hash, role_id FROM users WHERE email = $1';
    const result = await pool.query(query, [email]);
    return result.rows[0];
  }

  static async updatePassword(userId, oldPassword, newPassword) {
    const { rows } = await pool.query('SELECT password_hash FROM users WHERE user_id = $1', [userId]);
    const user = rows[0];

    if (!user) {
      throw Object.assign(new Error('User not found'), { status: 404, code: 'USER_NOT_FOUND' });
    }

    const isMatch = await bcrypt.compare(oldPassword, user.password_hash);
    if (!isMatch) {
      throw Object.assign(new Error('Incorrect old password'), { status: 401, code: 'AUTH_INVALID_OLD_PASSWORD' });
    }

    if (newPassword.length < 6) {
      throw Object.assign(new Error('New password must be at least 6 characters long'), {
        status: 400,
        code: 'AUTH_PASSWORD_TOO_SHORT',
      });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE user_id = $2', [hashedPassword, userId]);
  }
}

module.exports = User;