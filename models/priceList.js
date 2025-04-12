const pool = require('../config/db');
const logger = require('../utils/logger');

class PriceList {
  static async getAll({ limit = 10, offset = 0 }) {
    const query = `
      SELECT pl.price_id AS "priceId", pl.item_description AS "itemDescription", 
             pl.price, pl.created_at AS "createdAt", 
             i.product_name AS "productName", i.product_id AS "productId"
      FROM price_list pl
      JOIN inventory i ON pl.product_id = i.product_id
      ORDER BY pl.created_at DESC
      LIMIT $1 OFFSET $2
    `;
    const { rows } = await pool.query(query, [limit, offset]);
    return rows;
  }

  static async create({ item_description, price, product_id }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      // Create price list entry
      const insertQuery = `
        INSERT INTO price_list (item_description, price, product_id)
        VALUES ($1, $2, $3)
        RETURNING *
      `;
      const insertValues = [item_description, price, product_id];
      const { rows: priceRows } = await client.query(insertQuery, insertValues);
      
      // Update inventory price if needed
      if (price !== undefined && product_id) {
        const inventoryQuery = `
          UPDATE inventory 
          SET price = $1
          WHERE product_id = $2
          RETURNING product_id, product_name, price
        `;
        await client.query(inventoryQuery, [price, product_id]);
      }
      
      await client.query('COMMIT');
      logger.info(`Created new price list item for product ${product_id}`);
      return priceRows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Transaction failed in price list creation: ${error.message}`);
      throw error;
    } finally {
      client.release();
    }
  }

  static async update(priceId, updateData) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // First get the current item to ensure it exists and for partial updates
      const getCurrentQuery = 'SELECT * FROM price_list WHERE price_id = $1';
      const { rows: currentData } = await client.query(getCurrentQuery, [priceId]);
      
      if (currentData.length === 0) {
        throw new Error(`Price list item with ID ${priceId} not found`);
      }
      
      // Prepare update data by merging current and new data
      const current = currentData[0];
      const item_description = updateData.item_description !== undefined ? 
        updateData.item_description : current.item_description;
      const price = updateData.price !== undefined ? 
        updateData.price : current.price;
      const product_id = updateData.product_id !== undefined ? 
        updateData.product_id : current.product_id;
      
      // Update price list
      const updateQuery = `
        UPDATE price_list 
        SET item_description = $1, price = $2, product_id = $3, updated_at = NOW()
        WHERE price_id = $4
        RETURNING *
      `;
      const updateValues = [item_description, price, product_id, priceId];
      const { rows } = await client.query(updateQuery, updateValues);
      
      // Sync with inventory if price or product_id changed
      if ((updateData.price !== undefined || updateData.product_id !== undefined) && product_id) {
        const inventoryQuery = `
          UPDATE inventory 
          SET price = $1
          WHERE product_id = $2
          RETURNING product_id, product_name, price
        `;
        await client.query(inventoryQuery, [price, product_id]);
        logger.info(`Synchronized price update with inventory for product ${product_id}`);
      }
      
      await client.query('COMMIT');
      logger.info(`Updated price list item ${priceId}`);
      return rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Transaction failed in price list update: ${error.message}`);
      throw error;
    } finally {
      client.release();
    }
  }

  static async delete(priceId) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Get product info before deletion for possible inventory updates
      const getQuery = `SELECT * FROM price_list WHERE price_id = $1`;
      const { rows: items } = await client.query(getQuery, [priceId]);
      
      if (items.length === 0) {
        throw new Error(`Price list item with ID ${priceId} not found`);
      }
      
      const deleteQuery = 'DELETE FROM price_list WHERE price_id = $1 RETURNING *';
      const { rows } = await client.query(deleteQuery, [priceId]);
      
      await client.query('COMMIT');
      logger.info(`Deleted price list item ${priceId}`);
      return rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Transaction failed in price list deletion: ${error.message}`);
      throw error;
    } finally {
      client.release();
    }
  }

  static async syncPriceWithInventory(productId, price) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const query = `
        UPDATE inventory 
        SET price = $1
        WHERE product_id = $2
        RETURNING *
      `;
      const { rows } = await client.query(query, [price, productId]);
      
      if (rows.length === 0) {
        throw new Error(`Product with ID ${productId} not found in inventory`);
      }
      
      await client.query('COMMIT');
      logger.info(`Successfully synced price for product ${productId}`);
      return rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Failed to sync price with inventory: ${error.message}`);
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = PriceList;