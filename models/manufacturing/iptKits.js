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
}

module.exports = IPTKits;
