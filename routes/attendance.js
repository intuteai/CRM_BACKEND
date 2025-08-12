const express = require('express');
const { Attendance } = require('../models/attendance');
const redis = require('../config/redis');
const { authenticateToken, checkPermission } = require('../middleware/auth');
const logger = require('../utils/logger');
const pool = require('../config/db');
const router = express.Router({ mergeParams: true });

router.get('/', authenticateToken, checkPermission('attendance_history', 'can_read'), async (req, res, next) => {
  const { limit = 10, cursor, force_refresh = false } = req.query;

  try {
    const parsedLimit = Math.min(parseInt(limit, 10), 100);
    const cacheKey = `attendance_${parsedLimit}_${cursor || 'null'}_${req.user.user_id}`;

    if (force_refresh === 'true') await redis.del(cacheKey);

    const cached = await redis.get(cacheKey);
    if (cached && force_refresh !== 'true') {
      logger.info(`Cache hit for ${cacheKey}`);
      return res.json(JSON.parse(cached));
    }

    const { data: attendanceRecords, total, nextCursor } = await Attendance.getAll({
      limit: parsedLimit,
      cursor: cursor ? new Date(cursor) : null,
      user_id: req.user.user_id,
    });

    const processedRows = attendanceRecords.map((record) => ({
      attendance_id: record.attendance_id,
      user_id: record.user_id,
      date: record.date,
      check_in_time: record.check_in_time ? record.check_in_time.toISOString() : null,
      check_out_time: record.check_out_time ? record.check_out_time.toISOString() : null,
      present_absent: record.present_absent,
      online_office: record.online_office,
      wfh: record.wfh,
      created_at: record.created_at.toISOString(),
      timezone: 'Asia/Kolkata',
    }));

    console.log('Processed attendance records:', processedRows);

    const response = { attendance: processedRows, total, nextCursor: nextCursor ? nextCursor.toISOString() : null };
    await redis.setEx(cacheKey, 300, JSON.stringify(response));
    res.json(response);
  } catch (error) {
    logger.error(`Error fetching attendance for user ${req.user.user_id}: ${error.message}`, { stack: error.stack });
    res.status(500).json({ error: 'Server error', code: 'SERVER_ERROR' });
  }
});

router.post('/', authenticateToken, checkPermission('mark_attendance', 'can_write'), async (req, res, next) => {
  try {
    const { date, check_in_time, check_out_time, present_absent, online_office, wfh } = req.body;

    if (!present_absent) {
      return res.status(400).json({ error: 'Status is required', code: 'ATTENDANCE_MISSING_FIELDS' });
    }

    if (!['present', 'absent'].includes(present_absent)) {
      return res.status(400).json({ error: 'Invalid status: must be present or absent', code: 'ATTENDANCE_INVALID_STATUS' });
    }

    const today = new Date().toISOString().split('T')[0];
    if (date !== today) {
      return res.status(400).json({ error: 'Date must be today', code: 'ATTENDANCE_INVALID_DATE' });
    }

    const { rows: [existingRecord] } = await pool.query(
      'SELECT check_in_time, check_out_time, present_absent FROM attendance WHERE user_id = $1 AND date = $2',
      [req.user.user_id, date]
    );

    if (present_absent === 'absent') {
      // Allow null fields for absent status
      if (check_in_time || check_out_time || online_office || wfh) {
        return res.status(400).json({ error: 'When absent, check-in, check-out, online_office, and wfh must be null', code: 'ATTENDANCE_INVALID_ABSENT_FIELDS' });
      }
    } else {
      // Validate fields for present status
      if (!online_office) {
        return res.status(400).json({ error: 'Work location is required for present status', code: 'ATTENDANCE_MISSING_FIELDS' });
      }
      if (!['online', 'office'].includes(online_office)) {
        return res.status(400).json({ error: 'Invalid work location: must be online or office', code: 'ATTENDANCE_INVALID_LOCATION' });
      }
      if (check_in_time && existingRecord) {
        return res.status(400).json({ error: 'Check-in already recorded for today', code: 'ATTENDANCE_ALREADY_CHECKED_IN' });
      }
      if (check_out_time && (!existingRecord || !existingRecord.check_in_time)) {
        return res.status(400).json({ error: 'Cannot check out without a prior check-in', code: 'ATTENDANCE_NO_CHECK_IN' });
      }
      if (check_out_time && existingRecord && existingRecord.check_out_time) {
        return res.status(400).json({ error: 'Check-out already recorded for today', code: 'ATTENDANCE_ALREADY_CHECKED_OUT' });
      }
      if (check_out_time && check_in_time && new Date(check_out_time) <= new Date(check_in_time)) {
        return res.status(400).json({ error: 'Check-out time must be after check-in time', code: 'ATTENDANCE_INVALID_TIME' });
      }
    }

    const attendance = await Attendance.createOrUpdate(
      req.user.user_id,
      { date, check_in_time, check_out_time, present_absent, online_office, wfh },
      req.io
    );

    const response = {
      attendance_id: attendance.attendance_id,
      user_id: attendance.user_id,
      date: attendance.date,
      check_in_time: attendance.check_in_time ? attendance.check_in_time.toISOString() : null,
      check_out_time: attendance.check_out_time ? attendance.check_out_time.toISOString() : null,
      present_absent: attendance.present_absent,
      online_office: attendance.online_office,
      wfh: attendance.wfh,
      created_at: attendance.created_at.toISOString(),
      timezone: 'Asia/Kolkata',
    };

    setImmediate(async () => {
      try {
        const cacheKeys = await redis.keys(`attendance_*_${req.user.user_id}`);
        if (cacheKeys.length) await redis.del(cacheKeys);
        logger.info(`Cleared cache for attendance after marking for user_id: ${req.user.user_id}`);
      } catch (err) {
        logger.error('Cache invalidation error', err);
      }
    });

    req.io.emit('attendanceMarked', { user_id: req.user.user_id });
    res.status(201).json(response);
  } catch (error) {
    logger.error(`Error marking attendance for user ${req.user.user_id}: ${error.message}`, { stack: error.stack });
    res.status(error.status || 400).json({ error: error.message, code: 'ATTENDANCE_ERROR' });
  }
});

module.exports = router;