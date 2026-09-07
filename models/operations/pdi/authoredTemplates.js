'use strict';

const pool = require('../../../config/db');

class AuthoredTemplates {
  static async create({ id, name, definition, createdBy }) {
    const result = await pool.query(`
      INSERT INTO pdi_templates (id, version, name, status, definition, created_by)
      VALUES ($1, 1, $2, 'draft', $3, $4)
      RETURNING *
    `, [id, name, JSON.stringify(definition), createdBy || null]);
    return result.rows[0];
  }

  static async getLatest(id) {
    const result = await pool.query(
      `SELECT * FROM pdi_templates WHERE id = $1 ORDER BY version DESC LIMIT 1`,
      [id]
    );
    return result.rows[0] || null;
  }

  static async getByVersion(id, version) {
    if (version == null) return null;
    const result = await pool.query(
      `SELECT * FROM pdi_templates WHERE id = $1 AND version = $2`,
      [id, version]
    );
    return result.rows[0] || null;
  }

  static async getActive(id) {
    const result = await pool.query(
      `SELECT * FROM pdi_templates WHERE id = $1 AND status = 'active' ORDER BY version DESC LIMIT 1`,
      [id]
    );
    return result.rows[0] || null;
  }

  // One row per id, its latest version IF it's ACTIVE — for the public template picker.
  static async listActive() {
    const result = await pool.query(`
      SELECT id, name, version
      FROM (
        SELECT DISTINCT ON (id) id, name, version, status
        FROM pdi_templates
        ORDER BY id, version DESC
      ) latest
      WHERE status = 'active'
    `);
    return result.rows;
  }

  // One row per id, its latest version regardless of status — for the admin list page.
  static async listAll() {
    const result = await pool.query(`
      SELECT DISTINCT ON (id) id, name, version, status, created_at
      FROM pdi_templates
      ORDER BY id, version DESC
    `);
    return result.rows;
  }

  static async idExists(id) {
    const result = await pool.query(`SELECT 1 FROM pdi_templates WHERE id = $1 LIMIT 1`, [id]);
    return result.rows.length > 0;
  }

  // Append-only save: always inserts a new version row. `name`/`definition`/`status`
  // default to the latest version's values when omitted, so callers can bump just
  // one field (e.g. publish only changes status) without resending everything.
  static async saveNewVersion(id, { name, definition, status } = {}) {
    const latest = await this.getLatest(id);
    if (!latest) throw new Error('Template not found');
    const nextVersion = latest.version + 1;
    const result = await pool.query(`
      INSERT INTO pdi_templates (id, version, name, status, definition, created_by)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [
      id,
      nextVersion,
      name ?? latest.name,
      status ?? latest.status,
      JSON.stringify(definition ?? latest.definition),
      latest.created_by,
    ]);
    return result.rows[0];
  }
}

module.exports = AuthoredTemplates;
