const pool = require('../config/db');
const logger = require('../utils/logger');

// ──────────────────────────────────────────────────────────────
// Helper: Format JS Date → local ISO-like string (no Z)
// (Used only for socket payload in createOrUpdate fallback)
// ──────────────────────────────────────────────────────────────
const formatTimeLocal = (timestamp) => {
  if (!timestamp) return null;
  const d = new Date(timestamp);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const seconds = String(d.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
};

class Attendance {
  // === PERSONAL ATTENDANCE (Employee) ===
  static async getAll({ limit = 10, cursor = null, user_id }) {
    // Order and cursor both on created_at for stable pagination
    const query = `
      SELECT
        attendance_id,
        user_id,
        to_char(date, 'YYYY-MM-DD') AS date,
        to_char(check_in_time,  'YYYY-MM-DD"T"HH24:MI:SS') AS check_in_time,
        to_char(check_out_time, 'YYYY-MM-DD"T"HH24:MI:SS') AS check_out_time,
        present_absent,
        mode,
        -- formatted created_at for UI
        to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS created_at,
        -- raw created_at for cursoring
        created_at AS created_at_raw
      FROM attendance
      WHERE user_id = $1
        AND ($2::timestamp IS NULL OR created_at < $2)
      ORDER BY created_at DESC
      LIMIT $3
    `;
    const countQuery = `SELECT COUNT(*) FROM attendance WHERE user_id = $1`;
    const values = [user_id, cursor ? new Date(cursor) : null, limit];

    try {
      const [result, countResult] = await Promise.all([
        pool.query(query, values),
        pool.query(countQuery, [user_id]),
      ]);

      logger.info(
        `Fetched attendance for user_id=${user_id}, count=${result.rows.length}`
      );

      // Prepare payload for UI; keep strings as-is
      const rows = result.rows.map(r => ({
        attendance_id: r.attendance_id,
        user_id: r.user_id,
        date: r.date, // 'YYYY-MM-DD'
        check_in_time: r.check_in_time || null,   // 'YYYY-MM-DDTHH:mm:ss'
        check_out_time: r.check_out_time || null, // 'YYYY-MM-DDTHH:mm:ss'
        present_absent: r.present_absent,
        mode: r.mode,
        created_at: r.created_at, // 'YYYY-MM-DDTHH:mm:ss'
        // created_at_raw not exposed to API; used only for cursor below
      }));

      const nextCursor = result.rows.length
        ? result.rows[result.rows.length - 1].created_at_raw
        : null;

      return {
        data: rows,
        total: parseInt(countResult.rows[0].count, 10),
        nextCursor,
      };
    } catch (error) {
      logger.error(
        `Error fetching attendance for user_id=${user_id}: ${error.message}`,
        { stack: error.stack }
      );
      throw error;
    }
  }

  // === MARK ATTENDANCE (Create or Update) ===
  static async createOrUpdate(
    user_id,
    { date, check_in_time, check_out_time, present_absent, mode },
    io
  ) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const today = new Date().toISOString().split('T')[0];
      const targetDate = date || today;

      const { rows: [existingRecord] } = await client.query(
        'SELECT attendance_id FROM attendance WHERE user_id = $1 AND date = $2::date',
        [user_id, targetDate]
      );

      // Normalized inputs: allow nulls; DB is IST-local
      const inTime  = check_in_time  || null;
      const outTime = check_out_time || null;
      const workMode = mode || 'office';

      let saved;
      if (existingRecord) {
        const { rows: [updated] } = await client.query(
          `
          UPDATE attendance
             SET check_in_time   = $1,
                 check_out_time  = $2,
                 present_absent  = $3,
                 mode            = $4,
                 created_at      = CURRENT_TIMESTAMP
           WHERE attendance_id   = $5
       RETURNING
                 attendance_id,
                 user_id,
                 to_char(date, 'YYYY-MM-DD') AS date,
                 to_char(check_in_time,  'YYYY-MM-DD"T"HH24:MI:SS') AS check_in_time,
                 to_char(check_out_time, 'YYYY-MM-DD"T"HH24:MI:SS') AS check_out_time,
                 present_absent,
                 mode,
                 to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS created_at
          `,
          [inTime, outTime, present_absent, workMode, existingRecord.attendance_id]
        );
        saved = updated;
        logger.info(`Updated attendance user_id=${user_id} date=${saved.date}`);
      } else {
        const { rows: [inserted] } = await client.query(
          `
          INSERT INTO attendance
                  (user_id, date, check_in_time, check_out_time, present_absent, mode)
           VALUES ($1,      $2::date, $3,            $4,             $5,           $6)
       RETURNING
                 attendance_id,
                 user_id,
                 to_char(date, 'YYYY-MM-DD') AS date,
                 to_char(check_in_time,  'YYYY-MM-DD"T"HH24:MI:SS') AS check_in_time,
                 to_char(check_out_time, 'YYYY-MM-DD"T"HH24:MI:SS') AS check_out_time,
                 present_absent,
                 mode,
                 to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS created_at
          `,
          [user_id, targetDate, inTime, outTime, present_absent, workMode]
        );
        saved = inserted;
        logger.info(`Created attendance user_id=${user_id} date=${saved.date}`);
      }

      await client.query('COMMIT');

      // Fetch user name for socket
      const { rows: [user] } = await pool.query(
        'SELECT name FROM users WHERE user_id = $1',
        [user_id]
      );

      // Socket payload (strings already, but keep fallback)
      if (io) {
        io.emit('attendanceMarked', {
          attendance_id: saved.attendance_id,
          user_id: saved.user_id,
          date: saved.date, // 'YYYY-MM-DD'
          check_in_time: saved.check_in_time || null,
          check_out_time: saved.check_out_time || null,
          present_absent: saved.present_absent,
          mode: saved.mode,
          name: user?.name || 'Unknown',
          created_at: saved.created_at,
        });
      }

      // Return strings for API layer as well
      return saved;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(
        `Error creating/updating attendance for user_id=${user_id}: ${error.message}`,
        { stack: error.stack }
      );
      throw error;
    } finally {
      client.release();
    }
  }

  // === HR ATTENDANCE SUMMARY (All Employees) ===
  static async getHRSummary({
    limit = 20,
    cursor = null,
    date = null,
    search = null,
    employee_id = null
  }) {
    let query = `
      SELECT
        a.attendance_id,
        a.user_id,
        to_char(a.date, 'YYYY-MM-DD') AS date,
        to_char(a.check_in_time,  'YYYY-MM-DD"T"HH24:MI:SS') AS check_in,
        to_char(a.check_out_time, 'YYYY-MM-DD"T"HH24:MI:SS') AS check_out,
        a.present_absent AS status,
        a.mode,
        u.name,
        u.email,
        ed.employee_id,
        ed.phone_number,
        to_char(a.created_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS created_at,
        a.created_at AS created_at_raw
      FROM attendance a
      JOIN users u ON a.user_id = u.user_id
      LEFT JOIN employee_details ed ON u.user_id = ed.user_id
      WHERE 1=1
    `;
    const values = [];
    let idx = 1;

    // Date filter: exact DATE (no UTC math)
    if (date) {
      query += ` AND a.date = $${idx++}::date`;
      values.push(date);
    }

    // Search filter
    if (search) {
      query += ` AND (u.name ILIKE $${idx} OR u.email ILIKE $${idx} OR ed.employee_id ILIKE $${idx})`;
      values.push(`%${search}%`);
      idx++;
    }

    // Employee ID filter
    if (employee_id) {
      query += ` AND ed.employee_id = $${idx++}`;
      values.push(employee_id);
    }

    // Cursor for pagination (created_at)
    if (cursor) {
      query += ` AND a.created_at < $${idx++}`;
      values.push(new Date(cursor));
    }

    // Order & Limit: match cursor (created_at DESC)
    query += ` ORDER BY a.created_at DESC, u.name ASC LIMIT $${idx}`;
    values.push(limit);

    // Count query mirrors filters (without cursor/limit/order)
    let countQuery = `
      SELECT COUNT(*)
      FROM attendance a
      JOIN users u ON a.user_id = u.user_id
      LEFT JOIN employee_details ed ON u.user_id = ed.user_id
      WHERE 1=1
    `;
    const countValues = [];
    let cidx = 1;

    if (date) {
      countQuery += ` AND a.date = $${cidx++}::date`;
      countValues.push(date);
    }
    if (search) {
      countQuery += ` AND (u.name ILIKE $${cidx} OR u.email ILIKE $${cidx} OR ed.employee_id ILIKE $${cidx})`;
      countValues.push(`%${search}%`);
      cidx++;
    }
    if (employee_id) {
      countQuery += ` AND ed.employee_id = $${cidx++}`;
      countValues.push(employee_id);
    }

    try {
      const [result, countResult] = await Promise.all([
        pool.query(query, values),
        pool.query(countQuery, countValues),
      ]);

      const data = result.rows.map(r => ({
        attendance_id: r.attendance_id,
        user_id: r.user_id,
        name: r.name,
        email: r.email,
        employee_id: r.employee_id,
        phone: r.phone_number,
        date: r.date,            // 'YYYY-MM-DD'
        check_in: r.check_in || null,    // 'YYYY-MM-DDTHH:mm:ss'
        check_out: r.check_out || null,  // 'YYYY-MM-DDTHH:mm:ss'
        status: r.status,
        mode: r.mode,
        created_at: r.created_at, // 'YYYY-MM-DDTHH:mm:ss'
      }));

      const nextCursor = result.rows.length
        ? result.rows[result.rows.length - 1].created_at_raw
        : null;

      return {
        data,
        total: parseInt(countResult.rows[0].count, 10),
        nextCursor,
      };
    } catch (error) {
      logger.error('Error in getHRSummary:', error);
      throw error;
    }
  }
}

module.exports = { Attendance };
