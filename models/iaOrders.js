// models/iaOrders.js
const pool = require('../config/db');
const logger = require('../utils/logger');

class IAOrders {
  static #toNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }

  static #safeEmit(io, event, payload) {
    if (!io || typeof io.emit !== 'function') return;
    try { io.emit(event, payload); } catch (e) {
      logger.warn('Socket emit failed:', e.message);
    }
  }

  static #toPayload(order, items = []) {
    return {
      order_id:        order.order_id,
      customer_name:   order.customer_name,
      invoice_number:  order.invoice_number,
      dispatch_date:   order.dispatch_date,
      notes:           order.notes || '',
      created_by:      order.created_by,
      created_by_name: order.created_by_name || null,
      created_at:      order.created_at,
      updated_at:      order.updated_at,
      items: items.map(i => ({
        item_id:    i.item_id,
        vcu_serial: i.vcu_serial,
        vcu_make:   i.vcu_make,
        vcu_model:  i.vcu_model,
        hmi_imei:   i.hmi_imei   || null,
        hmi_make:   i.hmi_make   || null,
        hmi_model:  i.hmi_model  || null,
      })),
    };
  }

  static #validateItem(item) {
    const { vcu_serial, vcu_make, vcu_model } = item;
    if (!vcu_serial?.trim()) throw new Error('VCU serial is required');
    if (!vcu_make?.trim())   throw new Error('VCU make is required');
    if (!vcu_model?.trim())  throw new Error('VCU model is required');

    // HMI is optional — but if any HMI field is provided, all must be provided
    const hasHmi = item.hmi_imei?.trim() || item.hmi_make?.trim() || item.hmi_model?.trim();
    if (hasHmi) {
      if (!item.hmi_imei?.trim())  throw new Error('HMI IMEI is required when HMI details are provided');
      if (!item.hmi_make?.trim())  throw new Error('HMI make is required when HMI details are provided');
      if (!item.hmi_model?.trim()) throw new Error('HMI model is required when HMI details are provided');
    }
  }

  static async #insertItemSafe(client, order_id, item) {
    const {
      vcu_serial, vcu_make, vcu_model,
      hmi_imei = null, hmi_make = null, hmi_model = null,
    } = item;

    const hmiImei  = hmi_imei?.trim()  || null;
    const hmiMake  = hmi_make?.trim()  || null;
    const hmiModel = hmi_model?.trim() || null;

    try {
      const res = await client.query(`
        INSERT INTO ia_order_items
          (order_id, vcu_serial, vcu_make, vcu_model, hmi_imei, hmi_make, hmi_model)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING item_id, vcu_serial, vcu_make, vcu_model, hmi_imei, hmi_make, hmi_model
      `, [order_id,
          vcu_serial.trim(), vcu_make.trim(), vcu_model.trim(),
          hmiImei, hmiMake, hmiModel]);
      return res.rows[0];
    } catch (err) {
      if (err.code === '23505') {
        if (err.constraint?.includes('vcu_serial'))
          throw new Error(`VCU serial "${vcu_serial}" already exists in another order`);
        if (err.constraint?.includes('hmi_imei'))
          throw new Error(`HMI IMEI "${hmi_imei}" already exists in another order`);
        throw new Error('Duplicate serial/IMEI detected');
      }
      throw err;
    }
  }

  // ==================== CREATE ====================
  static async create({ customer_name, invoice_number, dispatch_date, notes, items = [] }, io) {
    if (!customer_name || !invoice_number || !dispatch_date)
      throw new Error('customer_name, invoice_number and dispatch_date are required');
    if (!Array.isArray(items) || items.length === 0)
      throw new Error('At least one VCU item is required');

    items.forEach(item => this.#validateItem(item));

    const createdById = io?.user?.user_id ?? null;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const orderRes = await client.query(`
        INSERT INTO ia_orders (customer_name, invoice_number, dispatch_date, notes, created_by)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING order_id, customer_name, invoice_number,
          to_char(dispatch_date, 'YYYY-MM-DD') AS dispatch_date,
          notes, created_by, created_at, updated_at
      `, [customer_name, invoice_number, dispatch_date, notes || null, createdById]);

      const order = orderRes.rows[0];
      const insertedItems = [];

      for (const item of items) {
        const row = await this.#insertItemSafe(client, order.order_id, item);
        insertedItems.push(row);
      }

      let created_by_name = null;
      if (createdById) {
        const userRes = await client.query('SELECT name FROM users WHERE user_id = $1', [createdById]);
        created_by_name = userRes.rows[0]?.name || null;
      }

      await client.query('COMMIT');

      const payload = this.#toPayload({ ...order, created_by_name }, insertedItems);
      this.#safeEmit(io, 'ia_orders:created', payload);
      return payload;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // ==================== GET ALL ====================
  static async getAll({ limit = 20, cursor = null } = {}) {
    const _limit = Math.min(Math.max(Number(limit) || 20, 1), 100);

    let cursorId = null;
    let cursorCreatedAt = null;
    if (cursor) {
      try {
        const [id, ts] = cursor.split(':');
        cursorId = parseInt(id, 10);
        cursorCreatedAt = ts;
      } catch {}
    }

    const query = `
      SELECT
        o.order_id, o.customer_name, o.invoice_number,
        to_char(o.dispatch_date, 'YYYY-MM-DD') AS dispatch_date,
        o.notes, o.created_by, u.name AS created_by_name,
        o.created_at, o.updated_at,
        COALESCE((
          SELECT JSON_AGG(
            JSON_BUILD_OBJECT(
              'item_id',    i.item_id,
              'vcu_serial', i.vcu_serial,
              'vcu_make',   i.vcu_make,
              'vcu_model',  i.vcu_model,
              'hmi_imei',   i.hmi_imei,
              'hmi_make',   i.hmi_make,
              'hmi_model',  i.hmi_model
            ) ORDER BY i.item_id
          )
          FROM ia_order_items i WHERE i.order_id = o.order_id
        ), '[]') AS items
      FROM ia_orders o
      LEFT JOIN users u ON o.created_by = u.user_id
      WHERE (
        $1::timestamp IS NULL
        OR o.created_at < $1::timestamp
        OR (o.created_at = $1::timestamp AND o.order_id < $2)
      )
      ORDER BY o.created_at DESC, o.order_id DESC
      LIMIT $3
    `;

    const [result, totalRes] = await Promise.all([
      pool.query(query, [cursorCreatedAt, cursorId, _limit]),
      pool.query('SELECT COUNT(*)::int FROM ia_orders'),
    ]);

    const data = result.rows.map(row => this.#toPayload(row, row.items || []));
    const nextCursor = data.length === _limit && data.length > 0
      ? `${data[data.length - 1].order_id}:${data[data.length - 1].created_at}`
      : null;

    return { data, total: totalRes.rows[0].count, cursor: nextCursor };
  }

  // ==================== GET BY ID ====================
  static async getById(id) {
    const _id = this.#toNumber(id);
    if (!Number.isFinite(_id)) throw new Error('Invalid order id');

    const res = await pool.query(`
      SELECT
        o.order_id, o.customer_name, o.invoice_number,
        to_char(o.dispatch_date, 'YYYY-MM-DD') AS dispatch_date,
        o.notes, o.created_by, u.name AS created_by_name,
        o.created_at, o.updated_at,
        COALESCE((
          SELECT JSON_AGG(
            JSON_BUILD_OBJECT(
              'item_id',    i.item_id,
              'vcu_serial', i.vcu_serial,
              'vcu_make',   i.vcu_make,
              'vcu_model',  i.vcu_model,
              'hmi_imei',   i.hmi_imei,
              'hmi_make',   i.hmi_make,
              'hmi_model',  i.hmi_model
            ) ORDER BY i.item_id
          )
          FROM ia_order_items i WHERE i.order_id = o.order_id
        ), '[]') AS items
      FROM ia_orders o
      LEFT JOIN users u ON o.created_by = u.user_id
      WHERE o.order_id = $1
    `, [_id]);

    if (res.rows.length === 0) throw new Error('Order not found');
    return this.#toPayload(res.rows[0], res.rows[0].items || []);
  }

  // ==================== UPDATE ====================
  static async update(id, { customer_name, invoice_number, dispatch_date, notes, items }, io) {
    const _id = this.#toNumber(id);
    if (!Number.isFinite(_id)) throw new Error('Invalid order id');

    if (Array.isArray(items)) items.forEach(item => this.#validateItem(item));

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const fields = [];
      const values = [];
      let idx = 1;

      if (customer_name  !== undefined) { fields.push(`customer_name = $${idx++}`);  values.push(customer_name); }
      if (invoice_number !== undefined) { fields.push(`invoice_number = $${idx++}`); values.push(invoice_number); }
      if (dispatch_date  !== undefined) { fields.push(`dispatch_date = $${idx++}`);  values.push(dispatch_date); }
      if (notes          !== undefined) { fields.push(`notes = $${idx++}`);          values.push(notes || null); }
      fields.push(`updated_at = NOW()`);
      values.push(_id);

      if (fields.length === 1) throw new Error('No fields to update');

      const orderRes = await client.query(`
        UPDATE ia_orders SET ${fields.join(', ')}
        WHERE order_id = $${idx}
        RETURNING order_id, customer_name, invoice_number,
          to_char(dispatch_date, 'YYYY-MM-DD') AS dispatch_date,
          notes, created_by, created_at, updated_at
      `, values);

      if (orderRes.rows.length === 0) throw new Error('Order not found');

      let updatedItems;
      if (Array.isArray(items)) {
        await client.query('DELETE FROM ia_order_items WHERE order_id = $1', [_id]);
        updatedItems = [];
        for (const item of items) {
          const row = await this.#insertItemSafe(client, _id, item);
          updatedItems.push(row);
        }
      } else {
        const itemsRes = await client.query(`
          SELECT item_id, vcu_serial, vcu_make, vcu_model, hmi_imei, hmi_make, hmi_model
          FROM ia_order_items WHERE order_id = $1 ORDER BY item_id
        `, [_id]);
        updatedItems = itemsRes.rows;
      }

      const order = orderRes.rows[0];
      let created_by_name = null;
      if (order.created_by) {
        const userRes = await client.query('SELECT name FROM users WHERE user_id = $1', [order.created_by]);
        created_by_name = userRes.rows[0]?.name || null;
      }

      await client.query('COMMIT');

      const payload = this.#toPayload({ ...order, created_by_name }, updatedItems);
      this.#safeEmit(io, 'ia_orders:updated', payload);
      return payload;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // ==================== DELETE ====================
  static async delete(id, io) {
    const _id = this.#toNumber(id);
    if (!Number.isFinite(_id)) throw new Error('Invalid order id');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query(
        'DELETE FROM ia_orders WHERE order_id = $1 RETURNING order_id', [_id]
      );
      if (res.rows.length === 0) throw new Error('Order not found');
      await client.query('COMMIT');

      const payload = { order_id: res.rows[0].order_id };
      this.#safeEmit(io, 'ia_orders:deleted', payload);
      return payload;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = IAOrders;