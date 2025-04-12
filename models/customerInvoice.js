const pool = require('../config/db');

class CustomerInvoice {
  static async create({ customer_id, order_id, invoice_number, issue_date, total_value, link_pdf }, io) {
    const query = `
      INSERT INTO customer_invoices (
        customer_id, order_id, invoice_number, issue_date, total_value, link_pdf
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `;
    const values = [
      customer_id || null,
      order_id || null,
      invoice_number || `INV-${Date.now()}`,
      issue_date ? new Date(issue_date).toISOString() : new Date().toISOString(),
      total_value || 0.00,
      link_pdf || null
    ];
    try {
      const result = await pool.query(query, values);
      const invoice = result.rows[0];
      if (io) {
        io.emit('invoiceUpdate', {
          invoice_id: invoice.invoice_id,
          invoice_number: invoice.invoice_number,
          total_value: invoice.total_value,
          issue_date: invoice.issue_date
        });
      }
      return invoice;
    } catch (error) {
      throw error;
    }
  }

  static async getAll({ limit = 10, cursor = null }) {
    let query = `
      SELECT 
        ci.invoice_id, ci.sr_no, ci.invoice_number, ci.issue_date, ci.total_value, 
        ci.link_pdf, ci.order_id, ci.customer_id,
        u.name AS customer_name,
        o.status AS order_status
      FROM customer_invoices ci
      LEFT JOIN customers c ON ci.customer_id = c.customer_id
      LEFT JOIN users u ON c.user_id = u.user_id
      LEFT JOIN orders o ON ci.order_id = o.order_id
      WHERE ($1::text IS NULL OR ci.issue_date < $1::timestamp)
      ORDER BY ci.issue_date DESC, ci.invoice_id DESC
      LIMIT $2
    `;
    const values = [cursor, limit];
    const totalQuery = 'SELECT COUNT(*) FROM customer_invoices';
    try {
      const [result, totalResult] = await Promise.all([
        pool.query(query, values),
        pool.query(totalQuery),
      ]);
      console.log('Customer invoices queried:', result.rows);
      return {
        data: result.rows,
        total: parseInt(totalResult.rows[0].count, 10),
        cursor: result.rows.length > 0 ? result.rows[result.rows.length - 1].issue_date : null,
      };
    } catch (error) {
      console.error('Error in getAll:', error);
      throw error;
    }
  }

  static async getById(invoiceId) {
    const query = `
      SELECT 
        ci.invoice_id, ci.sr_no, ci.invoice_number, ci.issue_date, ci.total_value, 
        ci.link_pdf, ci.order_id, ci.customer_id,
        u.name AS customer_name,
        o.status AS order_status
      FROM customer_invoices ci
      LEFT JOIN customers c ON ci.customer_id = c.customer_id
      LEFT JOIN users u ON c.user_id = u.user_id
      LEFT JOIN orders o ON ci.order_id = o.order_id
      WHERE ci.invoice_id = $1
    `;
    try {
      const result = await pool.query(query, [invoiceId]);
      if (result.rows.length === 0) {
        throw new Error('Invoice not found');
      }
      return result.rows[0];
    } catch (error) {
      console.error('Error in getById:', error);
      throw error;
    }
  }

  static async update(invoiceId, { customer_id, order_id, invoice_number, issue_date, link_pdf }, io) {
    const query = `
      UPDATE customer_invoices
      SET 
        customer_id = $1,
        order_id = $2,
        invoice_number = $3,
        issue_date = $4,
        link_pdf = $5,
        updated_at = CURRENT_TIMESTAMP
      WHERE invoice_id = $6
      RETURNING *
    `;
    const values = [
      customer_id || null,
      order_id || null,
      invoice_number || null,
      issue_date ? new Date(issue_date).toISOString() : null,
      link_pdf || null,
      invoiceId
    ];
    try {
      const result = await pool.query(query, values);
      if (result.rows.length === 0) {
        throw new Error('Invoice not found');
      }
      const invoice = result.rows[0];
      if (io) {
        io.emit('invoiceUpdate', {
          invoice_id: invoice.invoice_id,
          invoice_number: invoice.invoice_number,
          total_value: invoice.total_value,
          issue_date: invoice.issue_date
        });
      }
      return invoice;
    } catch (error) {
      console.error('Error in update:', error);
      throw error;
    }
  }

  static async delete(invoiceId, io) {
    const query = 'DELETE FROM customer_invoices WHERE invoice_id = $1 RETURNING *';
    try {
      const result = await pool.query(query, [invoiceId]);
      if (result.rows.length === 0) {
        throw new Error('Invoice not found');
      }
      const invoice = result.rows[0];
      if (io) {
        io.emit('invoiceUpdate', { invoice_id: invoice.invoice_id, status: 'Deleted' });
      }
      return invoice;
    } catch (error) {
      console.error('Error in delete:', error);
      throw error;
    }
  }
}

module.exports = { CustomerInvoice };