const pool = require('../config/db');
const logger = require('../utils/logger');

class Attendance {
  static async getAll({ limit = 10, cursor = null, user_id }) {
    const query = `
      SELECT attendance_id, user_id, date, check_in_time, check_out_time, present_absent, online_office, wfh, created_at 
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
      console.log('Raw database rows:', result.rows);
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

  static async createOrUpdate(user_id, { date, check_in_time, check_out_time, present_absent, online_office, wfh }, io) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: [existingRecord] } = await client.query(
        'SELECT attendance_id FROM attendance WHERE user_id = $1 AND date = $2',
        [user_id, date || new Date().toISOString().split('T')[0]]
      );

      let attendance;
      if (existingRecord) {
        const { rows: [updatedRecord] } = await client.query(
          `UPDATE attendance 
           SET check_in_time = $1, check_out_time = $2, present_absent = $3, online_office = $4, wfh = $5, created_at = CURRENT_TIMESTAMP 
           WHERE attendance_id = $6 
           RETURNING attendance_id, user_id, date, check_in_time, check_out_time, present_absent, online_office, wfh, created_at`,
          [check_in_time || null, check_out_time || null, present_absent, online_office, wfh || false, existingRecord.attendance_id]
        );
        attendance = updatedRecord;
        logger.info(`Updated attendance for user_id: ${user_id}, date: ${attendance.date}`);
      } else {
        const { rows: [newRecord] } = await client.query(
          `INSERT INTO attendance (user_id, date, check_in_time, check_out_time, present_absent, online_office, wfh) 
           VALUES ($1, $2, $3, $4, $5, $6, $7) 
           RETURNING attendance_id, user_id, date, check_in_time, check_out_time, present_absent, online_office, wfh, created_at`,
          [user_id, date || new Date().toISOString().split('T')[0], check_in_time || null, check_out_time || null, present_absent, online_office, wfh || false]
        );
        attendance = newRecord;
        logger.info(`Created attendance for user_id: ${user_id}, date: ${attendance.date}`);
      }

      await client.query('COMMIT');

      if (io) {
        io.emit('attendanceMarked', {
          attendance_id: attendance.attendance_id,
          user_id: attendance.user_id,
          date: attendance.date,
          check_in_time: attendance.check_in_time ? attendance.check_in_time.toISOString() : null,
          check_out_time: attendance.check_out_time ? attendance.check_out_time.toISOString() : null,
          present_absent: attendance.present_absent,
          online_office: attendance.online_office,
          wfh: attendance.wfh,
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
}

module.exports = { Attendance };