// models/core/stock.js
// Raw-material master (raw_materials) and its stock-change history
// (stock_adjustments).
//
// Every write that reads a row and then changes it runs on one dedicated client
// inside BEGIN/COMMIT with SELECT ... FOR UPDATE, so two people changing the same
// material at once cannot lose each other's change. (pool.query('BEGIN') is not
// a transaction: each pool.query may run on a different connection.)
const pool = require('../../config/db');
const logger = require('../../utils/logger');

// lead_date is a DATE; to_char keeps it a plain 'YYYY-MM-DD' string so pg never
// turns it into a JS Date (which would shift the day by the server timezone).
const COLUMNS = `
  product_id, stock_quantity, price, created_at, product_name, description,
  product_code, qty_required, location, image_url, returnable_qty,
  to_char(lead_date, 'YYYY-MM-DD') AS lead_date`;

const LEAD_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const leadDateOf = (v) => (typeof v === 'string' && LEAD_DATE_RE.test(v) ? v : null);

/** A business-rule failure the controller turns into a 4xx answer. */
class StockError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StockError';
    this.code = code;
  }
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;

// pg returns numeric columns as strings; the API always answers with numbers.
const num = (v, fallback = 0) => {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

function normalizeStockRow(row) {
  if (!row) return null;
  const productId = num(row.product_id ?? row.productId, null);
  const productName = String(row.product_name ?? row.productName ?? '');
  const productCode = row.product_code ?? row.productCode ?? null;
  const stockQuantity = num(row.stock_quantity ?? row.stockQuantity);
  const price = num(row.price, null);
  const qtyRequired = num(row.qty_required ?? row.qtyRequired);
  const returnableQty = num(row.returnable_qty ?? row.returnableQty);
  const imageUrl = row.image_url ?? row.imageUrl ?? null;
  const createdAt = row.created_at ?? row.createdAt ?? null;
  const leadDate = leadDateOf(row.lead_date ?? row.leadDate);
  return {
    product_id: productId,
    product_name: productName,
    product_code: productCode,
    description: row.description ?? null,
    price,
    stock_quantity: stockQuantity,
    qty_required: qtyRequired,
    returnable_qty: returnableQty,
    location: row.location ?? null,
    image_url: imageUrl,
    created_at: createdAt,
    lead_date: leadDate,
    productId,
    productName,
    productCode,
    stockQuantity,
    qtyRequired,
    returnableQty,
    imageUrl,
    createdAt,
    leadDate,
  };
}

function normalizeAdjustmentRow(row) {
  return {
    adjustmentId: num(row.adjustment_id, null),
    productId: num(row.product_id, null),
    quantity: num(row.quantity),
    balanceAfter: row.balance_after === null || row.balance_after === undefined ? null : num(row.balance_after),
    reason: row.reason ?? null,
    source: row.source ?? null,
    createdBy: row.created_by === null || row.created_by === undefined ? null : num(row.created_by, null),
    createdByName: row.created_by_name ?? null,
    createdAt: row.created_at ?? null,
  };
}

async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error(`Stock transaction rollback failed: ${rollbackErr.message}`);
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Write one stock_adjustments row inside the caller's transaction.
 * Runs under a SAVEPOINT: if the table has not been created yet (42P01) the
 * savepoint is rolled back, a warning is logged and the stock change itself
 * still commits. Any other failure aborts the whole transaction.
 * Returns true when the row was written.
 */
async function recordAdjustment(client, { productId, quantity, balanceAfter, reason, source, userId }) {
  await client.query('SAVEPOINT stock_audit');
  try {
    await client.query(
      `INSERT INTO stock_adjustments
         (product_id, quantity, balance_after, reason, source, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)`,
      [productId, quantity, balanceAfter, reason || null, source, userId || null]
    );
    await client.query('RELEASE SAVEPOINT stock_audit');
    return true;
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT stock_audit');
    if (err.code === '42P01') {
      logger.warn(`stock_adjustments table missing; stock change on product ${productId} was not audited (run the 2026-11-20 migration)`);
      return false;
    }
    throw err;
  }
}

async function findPartNumberOwner(db, partNumber, excludeId = null) {
  const params = [partNumber];
  let sql = 'SELECT product_id, product_name FROM raw_materials WHERE part_number = $1';
  if (excludeId !== null && excludeId !== undefined) {
    sql += ' AND product_id <> $2';
    params.push(excludeId);
  }
  const { rows } = await db.query(sql, params);
  return rows[0] || null;
}

function partNumberTakenError(partNumber, owner) {
  return new StockError(
    'PART_NUMBER_TAKEN',
    `Part Number ${partNumber} is already used by ${owner.product_name} (#${owner.product_id})`
  );
}

async function lockRow(client, productId) {
  const { rows } = await client.query(
    `SELECT ${COLUMNS} FROM raw_materials WHERE product_id = $1 FOR UPDATE`,
    [productId]
  );
  if (rows.length === 0) throw new StockError('NOT_FOUND', 'Stock item not found');
  return rows[0];
}

class Stock {
  static async getAll({ limit = 10, offset = 0 } = {}) {
    const [items, total] = await Promise.all([
      pool.query(`SELECT ${COLUMNS} FROM raw_materials ORDER BY product_id ASC LIMIT $1 OFFSET $2`, [limit, offset]),
      pool.query('SELECT COUNT(*) FROM raw_materials'),
    ]);
    return {
      data: (items.rows || []).map(normalizeStockRow),
      total: parseInt(total.rows[0].count, 10),
    };
  }

  static async getById(productId) {
    const { rows } = await pool.query(`SELECT ${COLUMNS} FROM raw_materials WHERE product_id = $1`, [productId]);
    return rows.length ? normalizeStockRow(rows[0]) : null;
  }

  /**
   * Create a material. With partNumberAuto the next product_id is reserved
   * first and the part number becomes that id (0171, 0172, ...), so the number
   * is known before the insert and cannot collide with a guess. When the id is
   * over 9999 or its part number is already taken, the requested code is kept
   * and a warning is returned.
   * Returns { item, partNumberWarning }.
   */
  static async create(fields, { userId } = {}) {
    return withTransaction(async (client) => {
      let productCode = fields.productCode;
      let productId = null;
      let partNumberWarning = null;

      if (fields.partNumberAuto) {
        const { rows: [seq] } = await client.query("SELECT nextval('raw_materials_product_id_seq') AS id");
        productId = Number(seq.id);
        if (productId > 9999) {
          partNumberWarning = 'Product ID exceeds 9999, so the Part Number could not be auto-assigned. Please check it.';
        } else {
          const autoPart = String(productId).padStart(4, '0');
          if (autoPart !== productCode.slice(0, 4)) {
            const owner = await findPartNumberOwner(client, autoPart);
            if (owner) {
              partNumberWarning = `Part Number ${autoPart} is already used by ${owner.product_name} (#${owner.product_id}); kept ${productCode.slice(0, 4)} instead.`;
            } else {
              productCode = autoPart + productCode.slice(4);
            }
          }
        }
      }

      const partNumber = productCode.slice(0, 4);
      const owner = await findPartNumberOwner(client, partNumber);
      if (owner) throw partNumberTakenError(partNumber, owner);

      const values = [
        fields.productName,
        fields.description ?? null,
        productCode,
        fields.price,
        fields.stockQuantity ?? 0,
        fields.qtyRequired ?? 0,
        fields.location ?? null,
        fields.imageUrl ?? null,
        fields.returnableQty ?? 0,
        fields.leadDate ?? null,
      ];
      let sql;
      if (productId !== null) {
        values.push(productId);
        sql = `INSERT INTO raw_materials
            (product_name, description, product_code, price, stock_quantity, qty_required,
             location, image_url, returnable_qty, lead_date, product_id, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, $11, CURRENT_TIMESTAMP)
          RETURNING ${COLUMNS}`;
      } else {
        sql = `INSERT INTO raw_materials
            (product_name, description, product_code, price, stock_quantity, qty_required,
             location, image_url, returnable_qty, lead_date, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, CURRENT_TIMESTAMP)
          RETURNING ${COLUMNS}`;
      }
      const { rows: [row] } = await client.query(sql, values);
      const item = normalizeStockRow(row);

      if (item.stockQuantity !== 0) {
        await recordAdjustment(client, {
          productId: item.productId,
          quantity: item.stockQuantity,
          balanceAfter: item.stockQuantity,
          reason: 'Initial stock',
          source: 'create',
          userId,
        });
      }
      return { item, partNumberWarning };
    });
  }

  /**
   * Update a material. Name, code and price are always written; every other
   * field that was not sent (undefined) keeps its stored value. A stock change
   * is recorded in stock_adjustments.
   */
  static async update(productId, fields, { userId } = {}) {
    return withTransaction(async (client) => {
      const cur = await lockRow(client, productId);

      const partNumber = fields.productCode.slice(0, 4);
      const owner = await findPartNumberOwner(client, partNumber, productId);
      if (owner) throw partNumberTakenError(partNumber, owner);

      const keep = (key, column) => (fields[key] !== undefined ? fields[key] : cur[column]);
      const oldStock = num(cur.stock_quantity);
      const newStock = fields.stockQuantity !== undefined ? round2(fields.stockQuantity) : oldStock;

      const { rows: [row] } = await client.query(
        `UPDATE raw_materials SET
           product_name = $1, description = $2, product_code = $3, price = $4,
           stock_quantity = $5, qty_required = $6, location = $7, image_url = $8,
           returnable_qty = $9, lead_date = $10::date
         WHERE product_id = $11
         RETURNING ${COLUMNS}`,
        [
          fields.productName,
          keep('description', 'description'),
          fields.productCode,
          fields.price,
          newStock,
          keep('qtyRequired', 'qty_required'),
          keep('location', 'location'),
          keep('imageUrl', 'image_url'),
          keep('returnableQty', 'returnable_qty'),
          keep('leadDate', 'lead_date'),
          productId,
        ]
      );

      const delta = round2(newStock - oldStock);
      if (delta !== 0) {
        await recordAdjustment(client, {
          productId,
          quantity: delta,
          balanceAfter: newStock,
          reason: fields.stockChangeReason || 'Edited in stock form',
          source: 'edit',
          userId,
        });
      }
      return normalizeStockRow(row);
    });
  }

  static async delete(productId) {
    const { rows } = await pool.query('DELETE FROM raw_materials WHERE product_id = $1 RETURNING product_id', [productId]);
    if (rows.length === 0) throw new StockError('NOT_FOUND', 'Stock item not found');
    return { product_id: rows[0].product_id, productId: rows[0].product_id };
  }

  /** Add (quantity > 0) or remove (quantity < 0) stock. Never goes below 0. */
  static async adjustStock({ productId, quantity, reason, userId }) {
    return withTransaction(async (client) => {
      const cur = await lockRow(client, productId);
      const oldStock = num(cur.stock_quantity);
      const newStock = round2(oldStock + quantity);
      if (newStock < 0) {
        throw new StockError('INSUFFICIENT_STOCK', `Cannot remove ${Math.abs(quantity)}: only ${oldStock} in stock`);
      }
      const { rows: [row] } = await client.query(
        `UPDATE raw_materials SET stock_quantity = $1 WHERE product_id = $2 RETURNING ${COLUMNS}`,
        [newStock, productId]
      );
      await recordAdjustment(client, {
        productId,
        quantity: round2(quantity),
        balanceAfter: newStock,
        reason: reason || null,
        source: 'adjust',
        userId,
      });
      return normalizeStockRow(row);
    });
  }

  /** Move returned units back into stock: stock += q, returnable -= q. */
  static async acceptReturn({ productId, quantity, userId }) {
    return withTransaction(async (client) => {
      const cur = await lockRow(client, productId);
      const returnable = num(cur.returnable_qty);
      if (quantity > returnable) {
        throw new StockError(
          'RETURN_EXCEEDS_RETURNABLE',
          `Cannot accept more than the returnable quantity (${returnable})`
        );
      }
      const newStock = round2(num(cur.stock_quantity) + quantity);
      const newReturnable = round2(returnable - quantity);
      const { rows: [row] } = await client.query(
        `UPDATE raw_materials SET stock_quantity = $1, returnable_qty = $2
         WHERE product_id = $3 RETURNING ${COLUMNS}`,
        [newStock, newReturnable, productId]
      );
      await recordAdjustment(client, {
        productId,
        quantity: round2(quantity),
        balanceAfter: newStock,
        reason: 'Return accepted',
        source: 'return',
        userId,
      });
      return normalizeStockRow(row);
    });
  }

  /** Newest-first stock history. available:false until the migration has run. */
  static async getAdjustments(productId, limit = 20) {
    try {
      const { rows } = await pool.query(
        `SELECT sa.adjustment_id, sa.product_id, sa.quantity, sa.balance_after, sa.reason,
                sa.source, sa.created_by, sa.created_at, u.name AS created_by_name
         FROM stock_adjustments sa
         LEFT JOIN users u ON u.user_id = sa.created_by
         WHERE sa.product_id = $1
         ORDER BY sa.created_at DESC, sa.adjustment_id DESC
         LIMIT $2`,
        [productId, limit]
      );
      return { available: true, data: rows.map(normalizeAdjustmentRow) };
    } catch (err) {
      if (err.code === '42P01') return { available: false, data: [] };
      throw err;
    }
  }

  static async setImageUrl(productId, imageUrl) {
    const { rows } = await pool.query(
      `UPDATE raw_materials SET image_url = $1 WHERE product_id = $2 RETURNING ${COLUMNS}`,
      [imageUrl, productId]
    );
    return rows.length ? normalizeStockRow(rows[0]) : null;
  }
}

Stock.StockError = StockError;
Stock.normalizeStockRow = normalizeStockRow;
Stock.recordAdjustment = recordAdjustment;

module.exports = Stock;
