const pool = require('../config/db');
const logger = require('../utils/logger');

class EmployeeDetails {
  // ── GET ALL EMPLOYEES ─────────────────────────────────────────
  static async getAll({
    limit = 20,
    cursor = null,
    search = null,
    employee_id = null,
    orgRoles = [],
  }) {
    if (orgRoles.length === 0) throw new Error('orgRoles required');

    let query = `
      SELECT
        ed.employee_id,
        ed.phone_number,
        to_char(ed.date_of_joining, 'YYYY-MM-DD') AS date_of_joining,
        ed.address,
        u.user_id,
        u.name,
        u.email,
        u.role_id,
        r.role_name,
        to_char(ed.created_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS created_at,
        to_char(ed.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS updated_at,
        ed.created_at AS created_at_raw
      FROM employee_details ed
      INNER JOIN users u ON ed.user_id = u.user_id
      INNER JOIN roles r ON u.role_id = r.role_id
      WHERE u.role_id = ANY($1::int[])
    `;

    let countQuery = `
      SELECT COUNT(*)
      FROM employee_details ed
      INNER JOIN users u ON ed.user_id = u.user_id
      WHERE u.role_id = ANY($1::int[])
    `;

    const values = [orgRoles];
    const countValues = [orgRoles];
    let idx = 2;
    let cidx = 2;

    if (search) {
      const searchParam = `%${search}%`;
      query += ` AND (u.name ILIKE $${idx} OR u.email ILIKE $${idx} OR ed.employee_id ILIKE $${idx})`;
      countQuery += ` AND (u.name ILIKE $${cidx} OR u.email ILIKE $${cidx} OR ed.employee_id ILIKE $${cidx})`;
      values.push(searchParam);
      countValues.push(searchParam);
      idx++;
      cidx++;
    }

    if (employee_id) {
      query += ` AND ed.employee_id = $${idx++}`;
      countQuery += ` AND ed.employee_id = $${cidx++}`;
      values.push(employee_id);
      countValues.push(employee_id);
    }

    if (cursor) {
      query += ` AND ed.created_at < $${idx++}`;
      values.push(new Date(cursor));
    }

    query += ` ORDER BY ed.created_at DESC LIMIT $${idx}`;
    values.push(limit);

    try {
      const [result, countResult] = await Promise.all([
        pool.query(query, values),
        pool.query(countQuery, countValues),
      ]);

      const data = result.rows.map(r => ({
        employee_id: r.employee_id,
        user_id: r.user_id,
        name: r.name,
        email: r.email,
        role_id: r.role_id,
        role_name: r.role_name,
        phone_number: r.phone_number,
        date_of_joining: r.date_of_joining,
        address: r.address,
        created_at: r.created_at,
        updated_at: r.updated_at,
      }));

      const nextCursor = result.rows.length === limit
        ? result.rows[result.rows.length - 1].created_at_raw
        : null;

      return { data, total: parseInt(countResult.rows[0].count, 10), nextCursor };
    } catch (error) {
      logger.error('Error in EmployeeDetails.getAll:', error);
      throw error;
    }
  }

  // ── GET SINGLE EMPLOYEE ───────────────────────────────────────
  static async getOne({ employee_id, orgRoles = [] }) {
    if (orgRoles.length === 0) throw new Error('orgRoles required');

    const query = `
      SELECT
        ed.employee_id,
        ed.phone_number,
        to_char(ed.date_of_joining, 'YYYY-MM-DD') AS date_of_joining,
        ed.address,
        u.user_id,
        u.name,
        u.email,
        u.role_id,
        r.role_name,
        to_char(ed.created_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS created_at,
        to_char(ed.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS updated_at
      FROM employee_details ed
      INNER JOIN users u ON ed.user_id = u.user_id
      INNER JOIN roles r ON u.role_id = r.role_id
      WHERE ed.employee_id = $1
        AND u.role_id = ANY($2::int[])
    `;

    try {
      const { rows } = await pool.query(query, [employee_id, orgRoles]);
      return rows[0] || null;
    } catch (error) {
      logger.error(`Error in EmployeeDetails.getOne for ${employee_id}:`, error);
      throw error;
    }
  }

  // ── UPDATE EMPLOYEE DETAIL ────────────────────────────────────
  static async update({ employee_id, phone_number, date_of_joining, address, orgRoles = [] }) {
    if (orgRoles.length === 0) throw new Error('orgRoles required');

    const check = await pool.query(
      `SELECT ed.employee_id FROM employee_details ed
       INNER JOIN users u ON ed.user_id = u.user_id
       WHERE ed.employee_id = $1 AND u.role_id = ANY($2::int[])`,
      [employee_id, orgRoles]
    );
    if (check.rows.length === 0) return null;

    const query = `
      UPDATE employee_details SET
        phone_number    = COALESCE($1, phone_number),
        date_of_joining = COALESCE($2, date_of_joining),
        address         = COALESCE($3, address)
      WHERE employee_id = $4
      RETURNING
        employee_id,
        user_id,
        phone_number,
        to_char(date_of_joining, 'YYYY-MM-DD') AS date_of_joining,
        address,
        to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS created_at,
        to_char(updated_at,  'YYYY-MM-DD"T"HH24:MI:SS') AS updated_at
    `;

    try {
      const { rows: [row] } = await pool.query(query, [
        phone_number || null,
        date_of_joining || null,
        address || null,
        employee_id,
      ]);
      return row || null;
    } catch (error) {
      logger.error(`Error in EmployeeDetails.update for ${employee_id}:`, error);
      throw error;
    }
  }
}

module.exports = { EmployeeDetails };