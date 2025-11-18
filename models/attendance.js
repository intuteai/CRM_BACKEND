// models/attendance.js
const pool = require('../config/db');
const logger = require('../utils/logger');

class Attendance {
  // PERSONAL ATTENDANCE (Employee) — unchanged
  static async getAll({ limit = 10, cursor = null, user_id }) {
    const query = `
      SELECT
        attendance_id,
        user_id,
        to_char(date, 'YYYY-MM-DD') AS date,
        to_char(check_in_time,  'YYYY-MM-DD"T"HH24:MI:SS') AS check_in_time,
        to_char(check_out_time, 'YYYY-MM-DD"T"HH24:MI:SS') AS check_out_time,
        present_absent,
        mode,
        to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS created_at,
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

      const rows = result.rows.map(r => ({
        attendance_id: r.attendance_id,
        user_id: r.user_id,
        date: r.date,
        check_in_time: r.check_in_time || null,
        check_out_time: r.check_out_time || null,
        present_absent: r.present_absent,
        mode: r.mode,
        created_at: r.created_at,
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
      logger.error(`Error fetching attendance for user_id=${user_id}: ${error.message}`, { stack: error.stack });
      throw error;
    }
  }

  // MARK ATTENDANCE — FULL RICH SOCKET PAYLOAD
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
        'SELECT attendance_id, check_in_time, check_out_time FROM attendance WHERE user_id = $1 AND date = $2::date',
        [user_id, targetDate]
      );

      const inTime = check_in_time || null;
      const outTime = check_out_time || null;
      const workMode = mode || 'office';

      let saved;
      if (existingRecord) {
        const needsUpdate = 
          existingRecord.check_in_time !== inTime ||
          existingRecord.check_out_time !== outTime;

        if (needsUpdate) {
          const { rows: [updated] } = await client.query(
            `UPDATE attendance SET
               check_in_time = COALESCE($1, check_in_time),
               check_out_time = COALESCE($2, check_out_time),
               present_absent = $3,
               mode = $4,
               created_at = CURRENT_TIMESTAMP
             WHERE attendance_id = $5
             RETURNING
               attendance_id, user_id,
               to_char(date, 'YYYY-MM-DD') AS date,
               to_char(check_in_time, 'YYYY-MM-DD"T"HH24:MI:SS') AS check_in_time,
               to_char(check_out_time, 'YYYY-MM-DD"T"HH24:MI:SS') AS check_out_time,
               present_absent, mode,
               to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS created_at`,
            [inTime, outTime, present_absent, workMode, existingRecord.attendance_id]
          );
          saved = updated;
        } else {
          const { rows: [existing] } = await client.query(
            `SELECT attendance_id, user_id,
                    to_char(date, 'YYYY-MM-DD') AS date,
                    to_char(check_in_time, 'YYYY-MM-DD"T"HH24:MI:SS') AS check_in_time,
                    to_char(check_out_time, 'YYYY-MM-DD"T"HH24:MI:SS') AS check_out_time,
                    present_absent, mode,
                    to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS created_at
             FROM attendance WHERE attendance_id = $1`,
            [existingRecord.attendance_id]
          );
          saved = existing;
        }
      } else {
        const { rows: [inserted] } = await client.query(
          `INSERT INTO attendance (user_id, date, check_in_time, check_out_time, present_absent, mode)
           VALUES ($1, $2::date, $3, $4, $5, $6)
           RETURNING
             attendance_id, user_id,
             to_char(date, 'YYYY-MM-DD') AS date,
             to_char(check_in_time, 'YYYY-MM-DD"T"HH24:MI:SS') AS check_in_time,
             to_char(check_out_time, 'YYYY-MM-DD"T"HH24:MI:SS') AS check_out_time,
             present_absent, mode,
             to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS created_at`,
          [user_id, targetDate, inTime, outTime, present_absent, workMode]
        );
        saved = inserted;
      }

      await client.query('COMMIT');

      // Fetch full user details for rich socket event
      const { rows: [fullUser] } = await pool.query(
        `SELECT u.name, u.email, ed.employee_id
         FROM users u
         LEFT JOIN employee_details ed ON u.user_id = ed.user_id
         WHERE u.user_id = $1`,
        [user_id]
      );

      // Emit FULL rich payload — frontend uses this directly
      if (io) {
        io.emit('attendanceMarked', {
          attendance_id: saved.attendance_id,
          user_id: saved.user_id,
          name: fullUser?.name || 'Unknown',
          email: fullUser?.email || null,
          employee_id: fullUser?.employee_id || null,
          date: saved.date,
          check_in: saved.check_in_time || null,
          check_out: saved.check_out_time || null,
          status: saved.present_absent,
          mode: saved.mode || 'office',
          created_at: saved.created_at,
        });
      }

      return saved;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Error creating/updating attendance for user_id=${user_id}: ${error.message}`, { stack: error.stack });
      throw error;
    } finally {
      client.release();
    }
  }

  // HR ATTENDANCE SUMMARY — FIXED: const → let for query strings
  static async getHRSummary({
    limit = 20,
    cursor = null,
    date = null,
    search = null,
    employee_id = null
  }) {
    // ← FIXED: Changed to let so we can append safely
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
      INNER JOIN users u ON a.user_id = u.user_id
      LEFT JOIN employee_details ed ON u.user_id = ed.user_id
      WHERE 1=1
    `;

    let countQuery = `
      SELECT COUNT(*)
      FROM attendance a
      INNER JOIN users u ON a.user_id = u.user_id
      LEFT JOIN employee_details ed ON u.user_id = ed.user_id
      WHERE 1=1
    `;

    const values = [];
    const countValues = [];
    let idx = 1;
    let cidx = 1;

    if (date) {
      query += ` AND a.date = $${idx++}::date`;
      countQuery += ` AND a.date = $${cidx++}::date`;
      values.push(date);
      countValues.push(date);
    }

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
      query += ` AND a.created_at < $${idx++}`;
      values.push(new Date(cursor));
    }

    query += ` ORDER BY a.created_at DESC LIMIT $${idx}`;
    values.push(limit);

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
        date: r.date,
        check_in: r.check_in || null,
        check_out: r.check_out || null,
        status: r.status,
        mode: r.mode,
        created_at: r.created_at,
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