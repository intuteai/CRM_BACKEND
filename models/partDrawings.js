const pool = require('../config/db');
const logger = require('../utils/logger');

class PartDrawings {
  static async getAll({ limit = 10, offset = 0, search = '' }) {
    const client = await pool.connect();
    try {
      // Query for paginated data
      const dataQuery = `
        SELECT pd.sr_no AS "srNo", pd.drawing_id AS "drawingId", 
               pd.item_name AS "itemName", pd.drawing_link AS "drawingLink", 
               pd.product_id AS "productId", pd.updated_at AS "updatedAt",
               i.product_name AS "productName"
        FROM part_drawings pd
        LEFT JOIN inventory i ON pd.product_id = i.product_id
        WHERE $3 = '' OR (
          pd.sr_no::text ILIKE $3 OR
          pd.drawing_id::text ILIKE $3 OR
          pd.item_name ILIKE $3 OR
          i.product_name ILIKE $3 OR
          pd.product_id::text ILIKE $3
        )
        ORDER BY pd.updated_at DESC
        LIMIT $1 OFFSET $2
      `;
      // Query for total count
      const countQuery = `
        SELECT COUNT(*) AS total
        FROM part_drawings pd
        LEFT JOIN inventory i ON pd.product_id = i.product_id
        WHERE $1 = '' OR (
          pd.sr_no::text ILIKE $1 OR
          pd.drawing_id::text ILIKE $1 OR
          pd.item_name ILIKE $1 OR
          i.product_name ILIKE $1 OR
          pd.product_id::text ILIKE $1
        )
      `;
      const searchPattern = `%${search}%`;
      const [dataResult, countResult] = await Promise.all([
        client.query(dataQuery, [limit, offset, searchPattern]),
        client.query(countQuery, [searchPattern])
      ]);

      return {
        drawings: dataResult.rows,
        total: parseInt(countResult.rows[0].total, 10)
      };
    } finally {
      client.release();
    }
  }

  static async create({ drawing_link, product_id }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Insert into part_drawings
      const insertQuery = `
        INSERT INTO part_drawings (product_id, drawing_link)
        VALUES ($1, $2)
        RETURNING *
      `;
      const insertValues = [product_id, drawing_link || null];
      const { rows: drawingRows } = await client.query(insertQuery, insertValues);

      await client.query('COMMIT');
      logger.info(`Created new part drawing for product ${product_id}`);
      return drawingRows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Transaction failed in part drawing creation: ${error.message}`);
      throw error;
    } finally {
      client.release();
    }
  }

  static async update(srNo, updateData) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get current record
      const getCurrentQuery = 'SELECT * FROM part_drawings WHERE sr_no = $1';
      const { rows: currentData } = await client.query(getCurrentQuery, [srNo]);

      if (currentData.length === 0) {
        throw new Error(`Part drawing with sr_no ${srNo} not found`);
      }

      // Prepare update data
      const current = currentData[0];
      const drawing_link = updateData.drawing_link !== undefined ? 
        updateData.drawing_link : current.drawing_link;
      const product_id = updateData.product_id !== undefined ? 
        updateData.product_id : current.product_id;

      // Update part_drawings
      const updateQuery = `
        UPDATE part_drawings 
        SET drawing_link = $1, product_id = $2, updated_at = NOW()
        WHERE sr_no = $3
        RETURNING *
      `;
      const updateValues = [drawing_link || null, product_id, srNo];
      const { rows } = await client.query(updateQuery, updateValues);

      await client.query('COMMIT');
      logger.info(`Updated part drawing ${srNo}`);
      return rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Transaction failed in part drawing update: ${error.message}`);
      throw error;
    } finally {
      client.release();
    }
  }

  static async delete(srNo) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get record before deletion
      const getQuery = `SELECT * FROM part_drawings WHERE sr_no = $1`;
      const { rows: items } = await client.query(getQuery, [srNo]);

      if (items.length === 0) {
        throw new Error(`Part drawing with sr_no ${srNo} not found`);
      }

      const deleteQuery = 'DELETE FROM part_drawings WHERE sr_no = $1 RETURNING *';
      const { rows } = await client.query(deleteQuery, [srNo]);

      await client.query('COMMIT');
      logger.info(`Deleted part drawing ${srNo}`);
      return rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Transaction failed in part drawing deletion: ${error.message}`);
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = PartDrawings;