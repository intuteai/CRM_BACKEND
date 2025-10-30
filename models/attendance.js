const pool = require('../config/db');
const logger = require('../utils/logger');

class Attendance {
  // === PERSONAL ATTENDANCE (Employee) ===
  static async getAll({ limit = 10, cursor = null, user_id }) {
    const query = `
      SELECT attendance_id, user_id, date, check_in_time, check_out_time, present_absent, mode, created_at 
      FROM attendance 
      WHERE user_id = $1 AND ($2::timestamp IS NULL OR created_at < $2) 
      ORDER BY date DESC 
      LIMIT $3
    `;
    const countQuery = 'SELECT COUNT(*) FROM attendance WHERE user_id = $1';
    const values = [user_id, cursor, limit];

    try {
      const [result, countResult] = await Promise.all([
        pool.query(query, values),
        pool.query(countQuery, [user_id]),
      ]);

      logger.info(`Fetched attendance for user_id: ${user_id}, count: ${result.rows.length}`);

      return {
        data: result.rows,
        total: parseInt(countResult.rows[0].count, 10),
        nextCursor: result.rows.length ? result.rows[result.rows.length - 1].created_at : null,
      };
    } catch (error) {
      logger.error(`Error fetching attendance for user_id: ${user_id}: ${error.message}`, { stack: error.stack });
      throw error;
    }
  }

  // === MARK ATTENDANCE (Create or Update) ===
  static async createOrUpdate(user_id, { date, check_in_time, check_out_time, present_absent, mode }, io) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const today = new Date().toISOString().split('T')[0];
      const targetDate = date || today;

      const { rows: [existingRecord] } = await client.query(
        'SELECT attendance_id FROM attendance WHERE user_id = $1 AND date = $2',
        [user_id, targetDate]
      );

      let attendance;
      if (existingRecord) {
        const { rows: [updatedRecord] } = await client.query(
          `UPDATE attendance 
           SET check_in_time = $1, check_out_time = $2, present_absent = $3, mode = $4, created_at = CURRENT_TIMESTAMP 
           WHERE attendance_id = $5 
           RETURNING attendance_id, user_id, date, check_in_time, check_out_time, present_absent, mode, created_at`,
          [check_in_time || null, check_out_time || null, present_absent, mode || 'office', existingRecord.attendance_id]
        );
        attendance = updatedRecord;
        logger.info(`Updated attendance for user_id: ${user_id}, date: ${attendance.date}`);
      } else {
        const { rows: [newRecord] } = await client.query(
          `INSERT INTO attendance (user_id, date, check_in_time, check_out_time, present_absent, mode) 
           VALUES ($1, $2, $3, $4, $5, $6) 
           RETURNING attendance_id, user_id, date, check_in_time, check_out_time, present_absent, mode, created_at`,
          [user_id, targetDate, check_in_time || null, check_out_time || null, present_absent, mode || 'office']
        );
        attendance = newRecord;
        logger.info(`Created attendance for user_id: ${user_id}, date: ${attendance.date}`);
      }

      await client.query('COMMIT');

      // Fetch user name for socket
      const { rows: [user] } = await pool.query('SELECT name FROM users WHERE user_id = $1', [user_id]);

      if (io) {
        io.emit('attendanceMarked', {
          attendance_id: attendance.attendance_id,
          user_id: attendance.user_id,
          date: attendance.date,
          check_in_time: attendance.check_in_time ? attendance.check_in_time.toISOString() : null,
          check_out_time: attendance.check_out_time ? attendance.check_out_time.toISOString() : null,
          present_absent: attendance.present_absent,
          mode: attendance.mode,
          name: user?.name || 'Unknown',
        });
      }

      return attendance;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Error creating/updating attendance for user_id: ${user_id}: ${error.message}`, { stack: error.stack });
      throw error;
    } finally {
      client.release();
    }
  }

  // === HR ATTENDANCE SUMMARY (All Employees) ===
  static async getHRSummary({ limit = 20, cursor = null, date = null, search = null, employee_id = null }) {
    let query = `
      SELECT 
        a.attendance_id, a.user_id, a.date, a.check_in_time, a.check_out_time, 
        a.present_absent, a.mode, a.created_at,
        u.name, u.email, ed.employee_id, ed.phone_number
      FROM attendance a
      JOIN users u ON a.user_id = u.user_id
      LEFT JOIN employee_details ed ON u.user_id = ed.user_id
      WHERE 1=1
    `;
    const values = [];
    let idx = 1;

    // Date filter: Full day in UTC
    if (date) {
      const start = new Date(date + 'T00:00:00.000Z');
      const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
      query += ` AND a.date >= $${idx++} AND a.date < $${idx++}`;
      values.push(start, end);
    }

    // Search filter
    if (search) {
      query += ` AND (
        u.name ILIKE $${idx} OR 
        u.email ILIKE $${idx} OR 
        ed.employee_id ILIKE $${idx}
      )`;
      values.push(`%${search}%`);
      idx++;
    }

    // Employee ID filter
    if (employee_id) {
      query += ` AND ed.employee_id = $${idx++}`;
      values.push(employee_id);
    }

    // Cursor for pagination
    if (cursor) {
      const cursorDate = new Date(cursor);
      query += ` AND a.created_at < $${idx++}`;
      values.push(cursorDate);
    }

    // Order & Limit
    query += ` ORDER BY a.date DESC, u.name ASC LIMIT $${idx}`;
    values.push(limit);

    // Count Query
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
      const start = new Date(date + 'T00:00:00.000Z');
      const end = new Date(start.getTime() + 86400000);
      countQuery += ` AND a.date >= $${cidx++} AND a.date < $${cidx++}`;
      countValues.push(start, end);
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
        date: r.date.toLocaleDateString('en-CA'), // ← FIXED: 2025-10-30 (IST)
        check_in: r.check_in_time ? r.check_in_time.toISOString() : null,
        check_out: r.check_out_time ? r.check_out_time.toISOString() : null,
        status: r.present_absent,
        mode: r.mode,
      }));

      const nextCursor = result.rows.length === limit
        ? result.rows[result.rows.length - 1].created_at.toISOString()
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