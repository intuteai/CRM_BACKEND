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

  // "Active" means the *latest* version is currently active — not merely that
  // some past version once was. A naive `WHERE status='active' ORDER BY
  // version DESC LIMIT 1` finds the highest-versioned row that happens to be
  // active, which is wrong the moment a template is archived: the archive
  // itself inserts a newer row (status='archived'), but that query would
  // still ignore it and keep returning the older active version underneath —
  // silently un-archiving it for every caller (this exact bug already existed
  // in listActive() and was fixed there; getActive() had the same bug and
  // went unnoticed because nothing had exercised archive-then-fetch until a
  // dedicated regression test did). Every caller relies on this being correct:
  // the public definition endpoint must 404 once archived, and report
  // creation (resolveTemplateVersion) must stop accepting the template once
  // archived — both silently kept working against the stale version without
  // this fix.
  static async getActive(id) {
    const latest = await this.getLatest(id);
    return latest && latest.status === 'active' ? latest : null;
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

  // Hard-deletes every version row for this id. Only safe when no report was
  // ever generated from it (the controller checks this first) — a report
  // pins to a specific (template_id, template_version) and re-fetches that
  // row on every PDF render/regeneration, so deleting out from under one
  // would break it. Archiving remains the only removal path once a template
  // has report history.
  static async deleteAll(id) {
    await pool.query(`DELETE FROM pdi_templates WHERE id = $1`, [id]);
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
