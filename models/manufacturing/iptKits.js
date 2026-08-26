const pool = require('../../config/db');
const logger = require('../../utils/logger');

const COMPONENT_FIELDS = [
  'motor_serial', 'controller_serial', 'gearbox_serial',
  'harness_serial', 'cluster_serial', 'vcu_serial', 'dcdc_serial',
];

class IPTKits {
  static #safeEmit(io, event, payload) {
    if (!io || typeof io.emit !== 'function') return;
    try { io.emit(event, payload); } catch (e) {
      logger.warn('Socket emit failed:', e.message);
    }
  }

  static #toPayload(row) {
    const payload = {
      kit_id: row.kit_id,
      kit_serial: row.kit_serial,
      created_by: row.created_by,
      created_by_name: row.created_by_name || null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    for (const field of COMPONENT_FIELDS) payload[field] = row[field];
    return payload;
  }

  static #validate(data) {
    for (const field of COMPONENT_FIELDS) {
      if (!data[field] || !String(data[field]).trim()) {
        throw Object.assign(new Error(`${field} is required`), { field });
      }
    }
  }

  static #normalized(data) {
    const out = {};
    for (const field of COMPONENT_FIELDS) out[field] = String(data[field]).trim().toUpperCase();
    return out;
  }

  // ==================== CREATE ====================
  static async create(data, io) {
    this.#validate(data);
    const normalized = this.#normalized(data);
    const createdBy = io?.user?.user_id ?? null;

    try {
      const res = await pool.query(`
        INSERT INTO ipt_kits (
          kit_serial,
          motor_serial, controller_serial, gearbox_serial,
          harness_serial, cluster_serial, vcu_serial, dcdc_serial,
          created_by, updated_by
        )
        VALUES (
          'IPT' || lpad(nextval('ipt_kit_serial_seq')::text, 3, '0'),
          $1, $2, $3, $4, $5, $6, $7, $8, $8
        )
        RETURNING *
      `, [
        normalized.motor_serial, normalized.controller_serial, normalized.gearbox_serial,
        normalized.harness_serial, normalized.cluster_serial, normalized.vcu_serial, normalized.dcdc_serial,
        createdBy,
      ]);

      let row = res.rows[0];
      if (createdBy) {
        const u = await pool.query('SELECT name FROM users WHERE user_id = $1', [createdBy]);
        row = { ...row, created_by_name: u.rows[0]?.name || null };
      }

      const payload = this.#toPayload(row);
      this.#safeEmit(io, 'ipt_kits:created', payload);
      return payload;
    } catch (err) {
      if (err.code === '23505') {
        const field = COMPONENT_FIELDS.find((f) => err.constraint?.includes(f));
        if (field) {
          throw Object.assign(
            new Error(`${field.replace('_serial', '')} serial "${normalized[field]}" is already used in another kit`),
            { field }
          );
        }
        throw Object.assign(new Error('Duplicate serial detected'), { field: null });
      }
      throw err;
    }
  }

  // ==================== UPDATE ====================
  static async update(id, data, io) {
    this.#validate(data);
    const normalized = this.#normalized(data);
    const updatedBy = io?.user?.user_id ?? null;

    try {
      const res = await pool.query(`
        UPDATE ipt_kits SET
          motor_serial = $1, controller_serial = $2, gearbox_serial = $3,
          harness_serial = $4, cluster_serial = $5, vcu_serial = $6, dcdc_serial = $7,
          updated_by = $8, updated_at = NOW()
        WHERE kit_id = $9
        RETURNING *
      `, [
        normalized.motor_serial, normalized.controller_serial, normalized.gearbox_serial,
        normalized.harness_serial, normalized.cluster_serial, normalized.vcu_serial, normalized.dcdc_serial,
        updatedBy, id,
      ]);

      if (res.rows.length === 0) throw new Error('Kit not found');

      let row = res.rows[0];
      if (row.created_by) {
        const u = await pool.query('SELECT name FROM users WHERE user_id = $1', [row.created_by]);
        row = { ...row, created_by_name: u.rows[0]?.name || null };
      }

      const payload = this.#toPayload(row);
      this.#safeEmit(io, 'ipt_kits:updated', payload);
      return payload;
    } catch (err) {
      if (err.code === '23505') {
        const field = COMPONENT_FIELDS.find((f) => err.constraint?.includes(f));
        if (field) {
          throw Object.assign(
            new Error(`${field.replace('_serial', '')} serial "${normalized[field]}" is already used in another kit`),
            { field }
          );
        }
        throw Object.assign(new Error('Duplicate serial detected'), { field: null });
      }
      throw err;
    }
  }

  // ==================== DELETE ====================
  static async delete(id, io) {
    const res = await pool.query('DELETE FROM ipt_kits WHERE kit_id = $1 RETURNING kit_id', [id]);
    if (res.rows.length === 0) throw new Error('Kit not found');
    const payload = { kit_id: res.rows[0].kit_id };
    this.#safeEmit(io, 'ipt_kits:deleted', payload);
    return payload;
  }

  // ==================== GET ALL ====================
  static async getAll({ limit = 20, cursor = null, search = '' } = {}) {
    const _limit = Math.min(Math.max(Number(limit) || 20, 1), 100);

    let cursorId = null;
    let cursorCreatedAt = null;
    if (cursor) {
      const sepIdx = cursor.indexOf(':');
      if (sepIdx > 0) {
        cursorId = parseInt(cursor.slice(0, sepIdx), 10);
        cursorCreatedAt = cursor.slice(sepIdx + 1);
      }
    }

    const searchTerm = search?.trim() ? `%${search.trim().toUpperCase()}%` : null;
    const buildSearchClause = (idx) =>
      COMPONENT_FIELDS.map((f) => `k.${f} ILIKE $${idx}`).concat([`k.kit_serial ILIKE $${idx}`]).join(' OR ');

    const query = `
      SELECT k.*, u.name AS created_by_name,
        to_char(k.created_at, 'YYYY-MM-DD HH24:MI:SS.US') AS created_at_cursor
      FROM ipt_kits k
      LEFT JOIN users u ON k.created_by = u.user_id
      WHERE (
        $1::text IS NULL
        OR to_char(k.created_at, 'YYYY-MM-DD HH24:MI:SS.US') < $1::text
        OR (to_char(k.created_at, 'YYYY-MM-DD HH24:MI:SS.US') = $1::text AND k.kit_id < $2)
      )
      AND ($4::text IS NULL OR ${buildSearchClause(4)})
      ORDER BY k.created_at DESC, k.kit_id DESC
      LIMIT $3
    `;

    const countQuery = `
      SELECT COUNT(*)::int FROM ipt_kits k
      WHERE ($1::text IS NULL OR ${buildSearchClause(1)})
    `;

    // Fetch one extra row beyond the page size so we can tell whether a next page
    // actually exists, instead of assuming a full page always means there's more.
    const [result, totalRes] = await Promise.all([
      pool.query(query, [cursorCreatedAt, cursorId, _limit + 1, searchTerm]),
      pool.query(countQuery, [searchTerm]),
    ]);

    const hasMore = result.rows.length > _limit;
    const rows = hasMore ? result.rows.slice(0, _limit) : result.rows;
    const data = rows.map((row) => this.#toPayload(row));
    const nextCursor = hasMore
      ? `${rows[rows.length - 1].kit_id}:${rows[rows.length - 1].created_at_cursor}`
      : null;

    return { data, total: totalRes.rows[0].count, cursor: nextCursor };
  }

  // ==================== GET BY ID ====================
  static async getById(id) {
    const res = await pool.query(`
      SELECT k.*, u.name AS created_by_name
      FROM ipt_kits k
      LEFT JOIN users u ON k.created_by = u.user_id
      WHERE k.kit_id = $1
    `, [id]);
    if (res.rows.length === 0) throw new Error('Kit not found');
    return this.#toPayload(res.rows[0]);
  }
}

module.exports = IPTKits;
