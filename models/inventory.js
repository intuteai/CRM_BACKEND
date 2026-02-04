// models/inventory.js
const pool = require('../config/db');

function normalizeInventoryRow(row) {
  if (!row) return null;
  const product_id = row.product_id ?? row.productId ?? row.id ?? null;
  const product_name = (row.product_name ?? row.productName ?? row.name ?? row.product_code ?? '') + '';

  return {
    product_id,
    product_name,
    stock_quantity: row.stock_quantity ?? 0,
    price: row.price ?? null,
    description: row.description ?? null,
    product_code: row.product_code ?? null,
    returnable_qty: row.returnable_qty ?? 0,
    created_at: row.created_at ?? null,

    // camelCase aliases
    productId: product_id,
    productName: product_name,
    stockQuantity: row.stock_quantity ?? 0,
    returnableQty: row.returnable_qty ?? 0,

    // Include availability fields if present (from getInventoryWithAvailability)
    reserved_quantity: row.reserved_quantity ?? undefined,
    available_quantity: row.available_quantity ?? undefined,

    __raw: row,
  };
}

class Inventory {
  // --------------------------------------------------
  // CREATE PRODUCT (physical stock only)
  // --------------------------------------------------
  static async create(
    { product_name, stock_quantity, price, description, product_code, returnable_qty = 0 },
    io
  ) {
    if (stock_quantity < 0) {
      throw new Error('stock_quantity cannot be negative');
    }
    if (returnable_qty < 0) {
      throw new Error('returnable_qty cannot be negative');
    }

    const query = `
      INSERT INTO inventory
        (product_name, stock_quantity, price, description, product_code, returnable_qty)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `;
    const { rows } = await pool.query(query, [
      product_name,
      stock_quantity,
      price,
      description,
      product_code,
      returnable_qty,
    ]);

    const product = normalizeInventoryRow(rows[0]);

    if (io) {
      io.emit('stockUpdate', {
        product_id: product.product_id,
        stock_quantity: product.stock_quantity,
        returnable_qty: product.returnable_qty,
      });
    }

    return product;
  }

  // --------------------------------------------------
  // READ
  // --------------------------------------------------
  static async getAll({ limit = 10, offset = 0 }) {
    const [result, countResult] = await Promise.all([
      pool.query('SELECT * FROM inventory ORDER BY product_id DESC LIMIT $1 OFFSET $2', [limit, offset]),
      pool.query('SELECT COUNT(*) FROM inventory'),
    ]);

    return {
      data: result.rows.map(normalizeInventoryRow),
      total: parseInt(countResult.rows[0].count, 10),
    };
  }

  // --------------------------------------------------
  // UPDATE - CRITICAL FIX: Simplified to always update all fields
  // This fixes the issue where stock_quantity wasn't updating
  // --------------------------------------------------
  static async update(productId, updateData, isAdmin = false) {
    console.log('🔧 Inventory.update called:', { productId, updateData, isAdmin });

    if (isAdmin) {
      // Admin can update everything including stock quantities
      const {
        product_name,
        price,
        description,
        product_code,
        stock_quantity,
        returnable_qty
      } = updateData;

      // Simple, direct update - no COALESCE tricks
      const query = `
        UPDATE inventory
        SET product_name = $1,
            price = $2,
            description = $3,
            product_code = $4,
            stock_quantity = $5,
            returnable_qty = $6
        WHERE product_id = $7
        RETURNING *
      `;

      console.log('🔧 Executing admin update with values:', [
        product_name,
        price,
        description,
        product_code,
        stock_quantity,
        returnable_qty,
        productId
      ]);

      const { rows } = await pool.query(query, [
        product_name,
        price,
        description,
        product_code,
        stock_quantity,
        returnable_qty,
        productId,
      ]);

      if (!rows.length) {
        throw new Error('Product not found');
      }

      console.log('✅ Admin update successful:', rows[0]);
      return normalizeInventoryRow(rows[0]);
    }

    // Regular user - metadata only
    const { product_name, price, description, product_code } = updateData;

    const query = `
      UPDATE inventory
      SET product_name = $1,
          price = $2,
          description = $3,
          product_code = $4
      WHERE product_id = $5
      RETURNING *
    `;

    const { rows } = await pool.query(query, [
      product_name,
      price,
      description,
      product_code,
      productId,
    ]);

    if (!rows.length) {
      throw new Error('Product not found');
    }
    return normalizeInventoryRow(rows[0]);
  }

  // --------------------------------------------------
  // DELETE PRODUCT (GUARDED)
  // --------------------------------------------------
  static async delete(productId, io) {
    // Check for active holds
    const holdCheck = await pool.query(
      `SELECT 1 FROM inventory_holds WHERE product_id = $1 AND status = 'ACTIVE' LIMIT 1`,
      [productId]
    );
    if (holdCheck.rows.length) {
      throw new Error('Cannot delete product with active inventory holds');
    }

    // Check stock is zero
    const stockCheck = await pool.query(
      `SELECT stock_quantity, returnable_qty FROM inventory WHERE product_id = $1`,
      [productId]
    );
    if (!stockCheck.rows.length) {
      throw new Error('Product not found');
    }

    const { stock_quantity, returnable_qty } = stockCheck.rows[0];
    if (stock_quantity !== 0 || returnable_qty !== 0) {
      throw new Error('Cannot delete product with non-zero stock');
    }

    // Safe to delete
    const { rows } = await pool.query(
      'DELETE FROM inventory WHERE product_id = $1 RETURNING *',
      [productId]
    );

    const product = normalizeInventoryRow(rows[0]);
    if (io) {
      io.emit('stockUpdate', {
        product_id: product.product_id,
        stock_quantity: 0,
        returnable_qty: 0,
      });
    }

    return product;
  }

  // --------------------------------------------------
  // CREATE HOLD (BLOCK / RESERVE)
  // --------------------------------------------------
  static async createHold({
    product_id,
    quantity,
    reason,
    reference_type = null,
    reference_value = null,
    created_by = null,
  }) {
    if (quantity <= 0) {
      throw new Error('Hold quantity must be > 0');
    }

    const query = `
      INSERT INTO inventory_holds
        (product_id, quantity, reason, reference_type, reference_value, created_by)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `;

    const { rows } = await pool.query(query, [
      product_id,
      quantity,
      reason,
      reference_type,
      reference_value,
      created_by,
    ]);

    return rows[0];
  }

  // --------------------------------------------------
  // RELEASE HOLD
  // --------------------------------------------------
  static async releaseHold(hold_id) {
    const query = `
      UPDATE inventory_holds
      SET status = 'RELEASED',
          released_at = NOW()
      WHERE hold_id = $1
        AND status = 'ACTIVE'
      RETURNING *
    `;

    const { rows } = await pool.query(query, [hold_id]);

    if (!rows.length) {
      throw new Error('Hold not found or already released');
    }

    return rows[0];
  }

  // --------------------------------------------------
  // GET ACTIVE HOLDS FOR PRODUCT
  // --------------------------------------------------
  static async getActiveHoldsByProduct(productId) {
    const query = `
      SELECT *
      FROM inventory_holds
      WHERE product_id = $1
        AND status = 'ACTIVE'
      ORDER BY created_at DESC
    `;
    const { rows } = await pool.query(query, [productId]);
    return rows;
  }

  // --------------------------------------------------
  // INVENTORY WITH AVAILABILITY (MOST IMPORTANT)
  // --------------------------------------------------
  static async getInventoryWithAvailability({ limit = 10, offset = 0 }) {
    const query = `
      SELECT
        i.*,
        COALESCE(SUM(h.quantity), 0) AS reserved_quantity,
        (i.stock_quantity - COALESCE(SUM(h.quantity), 0)) AS available_quantity
      FROM inventory i
      LEFT JOIN inventory_holds h
        ON h.product_id = i.product_id
       AND h.status = 'ACTIVE'
      GROUP BY i.product_id
      ORDER BY i.product_id DESC
      LIMIT $1 OFFSET $2
    `;

    const { rows } = await pool.query(query, [limit, offset]);
    return rows.map(normalizeInventoryRow);
  }

  // --------------------------------------------------
  // PRICE SYNC HELPER
  // --------------------------------------------------
  static async syncPriceWithPriceList(productId, price) {
    const { rows } = await pool.query(
      `UPDATE price_list SET price = $1, updated_at = NOW() WHERE product_id = $2 RETURNING *`,
      [price, productId]
    );
    return rows[0];
  }
}

module.exports = Inventory;