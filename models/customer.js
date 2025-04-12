const pool = require('../config/db');
const User = require('./user');

class Customer {
  static async create({
    name,
    email,
    contact_person,
    city,
    phone,
    gst,
    shipping_address,
    billing_address,
  }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      const userResult = await User.create({ name, email, role_id: 2 });
      const user = userResult.user;

      const query = `
        INSERT INTO customers (user_id, contact_person, city, phone, gst, shipping_address, billing_address, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        RETURNING customer_id, user_id, contact_person, city, phone, gst, shipping_address, billing_address
      `;
      const result = await client.query(query, [
        user.user_id, // Adjusted to match user.js output
        contact_person,
        city,
        phone,
        gst || null,
        shipping_address,
        billing_address,
      ]);

      await client.query('COMMIT');
      
      const customer = result.rows[0];
      return {
        id: customer.customer_id,
        user_id: customer.user_id,
        name,
        email,
        contact_person: customer.contact_person,
        city: customer.city,
        phone: customer.phone,
        gst: customer.gst,
        shipping_address: customer.shipping_address,
        billing_address: customer.billing_address,
        orders: 0,
        queries: 0,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async getCustomers({ limit = 10, offset = 0 }) {
    const query = `
      SELECT 
        c.customer_id AS id, 
        u.name, 
        u.email, 
        c.contact_person, 
        c.city, 
        c.phone, 
        c.gst, 
        c.shipping_address, 
        c.billing_address,
        COUNT(DISTINCT o.order_id)::INTEGER AS orders,
        COUNT(DISTINCT q.query_id)::INTEGER AS queries
      FROM customers c
      JOIN users u ON c.user_id = u.user_id
      LEFT JOIN orders o ON u.user_id = o.user_id
      LEFT JOIN queries q ON u.user_id = q.user_id
      GROUP BY c.customer_id, u.name, u.email, c.contact_person, c.city, c.phone, c.gst, c.shipping_address, c.billing_address
      LIMIT $1 OFFSET $2
    `;
    const countQuery = 'SELECT COUNT(*) FROM customers';
    const [result, countResult] = await Promise.all([
      pool.query(query, [limit, offset]),
      pool.query(countQuery),
    ]);
    return {
      data: result.rows,
      total: parseInt(countResult.rows[0].count, 10),
      limit,
      offset,
    };
  }

  static async getCustomerByUserId(userId) {
    const query = `
      SELECT 
        c.customer_id AS id, 
        u.name, 
        u.email, 
        c.contact_person, 
        c.city, 
        c.phone, 
        c.gst, 
        c.shipping_address, 
        c.billing_address,
        COUNT(DISTINCT o.order_id)::INTEGER AS orders,
        COUNT(DISTINCT q.query_id)::INTEGER AS queries
      FROM customers c
      JOIN users u ON c.user_id = u.user_id
      LEFT JOIN orders o ON u.user_id = o.user_id
      LEFT JOIN queries q ON u.user_id = q.user_id
      WHERE c.user_id = $1
      GROUP BY c.customer_id, u.name, u.email, c.contact_person, c.city, c.phone, c.gst, c.shipping_address, c.billing_address
    `;
    const result = await pool.query(query, [userId]);
    return result.rows[0] || null;
  }

  static async update(customerId, {
    name,
    email,
    contact_person,
    city,
    phone,
    gst,
    shipping_address,
    billing_address,
  }) {
    const query = `
      UPDATE customers c
      SET contact_person = $1, city = $2, phone = $3, gst = $4, shipping_address = $5, billing_address = $6
      FROM users u
      WHERE c.user_id = u.user_id AND c.customer_id = $7
      RETURNING c.customer_id AS id, u.name, u.email, c.contact_person, c.city, c.phone, c.gst, c.shipping_address, c.billing_address
    `;
    const userUpdateQuery = 'UPDATE users SET name = $1, email = $2 WHERE user_id = (SELECT user_id FROM customers WHERE customer_id = $3)';

    const [customerResult] = await Promise.all([
      pool.query(query, [contact_person, city, phone, gst || null, shipping_address, billing_address, customerId]),
      pool.query(userUpdateQuery, [name, email, customerId]),
    ]);

    if (customerResult.rows.length === 0) {
      throw Object.assign(new Error('Customer not found'), { status: 404, code: 'NOT_FOUND' });
    }

    const updatedCustomer = customerResult.rows[0];
    return await this.getCustomerByUserId(updatedCustomer.user_id);
  }
}

module.exports = Customer;