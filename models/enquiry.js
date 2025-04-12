const pool = require('../config/db');

class Enquiry {
  // Create a new enquiry
  static async create(
    {
      enquiry_id,
      company_name,
      contact_person,
      mail_id,
      phone_no,
      items_required,
      status,
      last_discussion,
      next_interaction,
    },
    io
  ) {
    const query = `
      INSERT INTO enquiries (
        enquiry_id, company_name, contact_person, mail_id, phone_no, 
        items_required, status, last_discussion, next_interaction
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `;
    const values = [
      enquiry_id || null,
      company_name || null,
      contact_person || null,
      mail_id || null,
      phone_no || null,
      items_required || null,
      status || 'Pending',
      last_discussion ? new Date(last_discussion).toISOString() : null,
      next_interaction ? new Date(next_interaction).toISOString() : null,
    ];
    try {
      const result = await pool.query(query, values);
      const enquiry = result.rows[0];
      if (io) {
        io.emit('enquiryUpdate', {
          enquiry_id: enquiry.enquiry_id,
          status: enquiry.status,
          last_discussion: enquiry.last_discussion,
          next_interaction: enquiry.next_interaction,
        });
      }
      return enquiry;
    } catch (error) {
      throw error;
    }
  }

  // Get all enquiries with cursor-based pagination
  static async getAll({ limit = 10, cursor = null }) {
    let query = `
      SELECT 
        sr_no, enquiry_id, company_name, contact_person, mail_id, 
        phone_no, items_required, status, last_discussion, next_interaction,
        created_at, updated_at
      FROM enquiries
      WHERE ($1::text IS NULL OR created_at < $1::timestamp)
      ORDER BY created_at DESC, enquiry_id DESC
      LIMIT $2
    `;
    const values = [cursor, limit];
    const totalQuery = 'SELECT COUNT(*) FROM enquiries';
    const [result, totalResult] = await Promise.all([
      pool.query(query, values),
      pool.query(totalQuery),
    ]);
    console.log('Enquiries queried:', result.rows);
    return {
      data: result.rows,
      total: parseInt(totalResult.rows[0].count, 10),
      cursor: result.rows.length > 0 ? result.rows[result.rows.length - 1].created_at : null,
    };
  }

  // Get a single enquiry by enquiry_id
  static async getById(enquiryId) {
    const query = `
      SELECT 
        sr_no, enquiry_id, company_name, contact_person, mail_id, 
        phone_no, items_required, status, last_discussion, next_interaction,
        created_at, updated_at
      FROM enquiries
      WHERE enquiry_id = $1
    `;
    const result = await pool.query(query, [enquiryId]);
    if (result.rows.length === 0) {
      throw new Error('Enquiry not found');
    }
    return result.rows[0];
  }

  // Update an enquiry
  static async update(
    enquiryId,
    {
      company_name,
      contact_person,
      mail_id,
      phone_no,
      items_required,
      status,
      last_discussion,
      next_interaction,
    },
    io
  ) {
    const query = `
      UPDATE enquiries
      SET 
        company_name = $1,
        contact_person = $2,
        mail_id = $3,
        phone_no = $4,
        items_required = $5,
        status = $6,
        last_discussion = $7,
        next_interaction = $8,
        updated_at = CURRENT_TIMESTAMP
      WHERE enquiry_id = $9
      RETURNING *
    `;
    const values = [
      company_name || null,
      contact_person || null,
      mail_id || null,
      phone_no || null,
      items_required || null,
      status || 'Pending',
      last_discussion ? new Date(last_discussion).toISOString() : null,
      next_interaction ? new Date(next_interaction).toISOString() : null,
      enquiryId,
    ];
    try {
      const result = await pool.query(query, values);
      if (result.rows.length === 0) {
        throw new Error('Enquiry not found');
      }
      const enquiry = result.rows[0];
      if (io) {
        io.emit('enquiryUpdate', {
          enquiry_id: enquiry.enquiry_id,
          status: enquiry.status,
          last_discussion: enquiry.last_discussion,
          next_interaction: enquiry.next_interaction,
        });
      }
      return enquiry;
    } catch (error) {
      throw error;
    }
  }

  // Delete an enquiry
  static async delete(enquiryId, io) {
    const query = 'DELETE FROM enquiries WHERE enquiry_id = $1 RETURNING *';
    try {
      const result = await pool.query(query, [enquiryId]);
      if (result.rows.length === 0) {
        throw new Error('Enquiry not found');
      }
      const enquiry = result.rows[0];
      if (io) {
        io.emit('enquiryUpdate', { enquiry_id: enquiry.enquiry_id, status: 'Deleted' });
      }
      return enquiry;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = Enquiry;