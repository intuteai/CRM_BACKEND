const pool = require('../config/db');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

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
    logger.info(`Creating enquiry with provided enquiry_id: ${enquiry_id || 'none'}`);

    // Generate enquiry_id if not provided (e.g., ENQ2025002)
    let generatedEnquiryId = enquiry_id;
    if (!generatedEnquiryId) {
      const year = new Date().getFullYear();
      const maxAttempts = 10;

      try {
        for (let attempts = 0; attempts < maxAttempts; attempts++) {
          const randomNum = Math.floor(1000 + Math.random() * 9000);
          generatedEnquiryId = `ENQ${year}${randomNum}`;
          logger.info(`Attempting to generate enquiry_id: ${generatedEnquiryId}`);

          const checkQuery = 'SELECT 1 FROM enquiries WHERE enquiry_id = $1';
          const checkResult = await pool.query(checkQuery, [generatedEnquiryId]);
          if (checkResult.rows.length === 0) {
            logger.info(`Generated unique enquiry_id: ${generatedEnquiryId}`);
            break;
          }

          if (attempts === maxAttempts - 1) {
            // Fallback to UUID to avoid failure
            generatedEnquiryId = `ENQ${year}-${uuidv4().slice(0, 8)}`;
            logger.warn(`Using UUID fallback for enquiry_id: ${generatedEnquiryId}`);
            const fallbackCheck = await pool.query(checkQuery, [generatedEnquiryId]);
            if (fallbackCheck.rows.length > 0) {
              logger.error('UUID fallback enquiry_id already exists');
              throw new Error('Unable to generate a unique enquiry ID');
            }
          }
        }
      } catch (error) {
        logger.error(`Error generating enquiry_id: ${error.message}`, error.stack);
        throw new Error('Failed to generate enquiry ID due to database error');
      }
    }

    // Ensure generatedEnquiryId is valid
    if (!generatedEnquiryId || typeof generatedEnquiryId !== 'string') {
      logger.error('generatedEnquiryId is invalid before INSERT', { generatedEnquiryId });
      throw new Error('Internal error: Invalid enquiry ID generated');
    }

    const query = `
      INSERT INTO enquiries (
        enquiry_id, company_name, contact_person, mail_id, phone_no, 
        items_required, status, last_discussion, next_interaction
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `;
    const values = [
      generatedEnquiryId,
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
      logger.info(`Inserting enquiry with enquiry_id: ${generatedEnquiryId}`);
      const result = await pool.query(query, values);
      const enquiry = result.rows[0];
      logger.info(`Enquiry created successfully: ${enquiry.enquiry_id}`);

      if (io) {
        io.emit('enquiryUpdate', {
          enquiry_id: enquiry.enquiry_id,
          company_name: enquiry.company_name,
          contact_person: enquiry.contact_person,
          mail_id: enquiry.mail_id,
          phone_no: enquiry.phone_no,
          items_required: enquiry.items_required,
          status: enquiry.status,
          last_discussion: enquiry.last_discussion,
          next_interaction: enquiry.next_interaction,
        });
      }
      return enquiry;
    } catch (error) {
      logger.error(`Error inserting enquiry: ${error.message}`, error.stack);
      if (error.code === '23502') {
        throw new Error(`Null value in column "${error.column}" violates not-null constraint`);
      }
      if (error.code === '23505') {
        throw new Error('Enquiry ID already exists');
      }
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
    try {
      const [result, totalResult] = await Promise.all([
        pool.query(query, values),
        pool.query(totalQuery),
      ]);
      logger.info(`Fetched ${result.rows.length} enquiries`);
      return {
        data: result.rows,
        total: parseInt(totalResult.rows[0].count, 10),
        cursor: result.rows.length > 0 ? result.rows[result.rows.length - 1].created_at : null,
      };
    } catch (error) {
      logger.error(`Error fetching enquiries: ${error.message}`, error.stack);
      throw error;
    }
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
    try {
      const result = await pool.query(query, [enquiryId]);
      if (result.rows.length === 0) {
        throw new Error('Enquiry not found');
      }
      logger.info(`Fetched enquiry: ${enquiryId}`);
      return result.rows[0];
    } catch (error) {
      logger.error(`Error fetching enquiry ${enquiryId}: ${error.message}`, error.stack);
      throw error;
    }
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
      logger.info(`Enquiry updated: ${enquiry.enquiry_id}`);
      if (io) {
        io.emit('enquiryUpdate', {
          enquiry_id: enquiry.enquiry_id,
          company_name: enquiry.company_name,
          contact_person: enquiry.contact_person,
          mail_id: enquiry.mail_id,
          phone_no: enquiry.phone_no,
          items_required: enquiry.items_required,
          status: enquiry.status,
          last_discussion: enquiry.last_discussion,
          next_interaction: enquiry.next_interaction,
        });
      }
      return enquiry;
    } catch (error) {
      logger.error(`Error updating enquiry ${enquiryId}: ${error.message}`, error.stack);
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
      logger.info(`Enquiry deleted: ${enquiry.enquiry_id}`);
      if (io) {
        io.emit('enquiryUpdate', { enquiry_id: enquiry.enquiry_id, status: 'Deleted' });
      }
      return enquiry;
    } catch (error) {
      logger.error(`Error deleting enquiry ${enquiryId}: ${error.message}`, error.stack);
      throw error;
    }
  }
}

module.exports = Enquiry;