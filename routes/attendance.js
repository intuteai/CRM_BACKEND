const express = require('express');
const { Attendance } = require('../models/attendance');
const redis = require('../config/redis');
const { authenticateToken, checkPermission } = require('../middleware/auth');
const logger = require('../utils/logger');
const pool = require('../config/db');
const router = express.Router({ mergeParams: true });

// ──────────────────────────────────────────────────────────────
// Helper: "today" in IST as YYYY-MM-DD (matches DB local date)
// ──────────────────────────────────────────────────────────────
const todayIST = () => {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date()); // 'YYYY-MM-DD'
};

// === PERSONAL ATTENDANCE (Employee) ===
router.get(
  '/',
  authenticateToken,
  checkPermission('attendance_history', 'can_read'),
  async (req, res) => {
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
        // Model expects a Date or null for cursor; keep as Date if provided
        cursor: cursor ? new Date(cursor) : null,
        user_id: req.user.user_id,
      });

      // Records are already formatted by the model as local strings.
      // We only append a timezone hint for the client.
      const processedRows = attendanceRecords.map((record) => ({
        ...record, // date, check_in_time, check_out_time, created_at are strings
        timezone: 'Asia/Kolkata',
      }));

      const response = {
        attendance: processedRows,
        total,
        // Keep ISO for cursor if it's a Date; otherwise pass-through.
        nextCursor: nextCursor
          ? (nextCursor instanceof Date ? nextCursor.toISOString() : nextCursor)
          : null,
      };

      await redis.setEx(cacheKey, 300, JSON.stringify(response));
      res.json(response);
    } catch (error) {
      logger.error(
        `Error fetching attendance for user ${req.user.user_id}: ${error.message}`,
        { stack: error.stack }
      );
      res.status(500).json({ error: 'Server error', code: 'SERVER_ERROR' });
    }
  }
);

router.post(
  '/',
  authenticateToken,
  checkPermission('mark_attendance', 'can_write'),
  async (req, res) => {
    try {
      const { date, check_in_time, check_out_time, present_absent, mode } = req.body;

      if (!present_absent) {
        return res
          .status(400)
          .json({ error: 'Status is required', code: 'ATTENDANCE_MISSING_FIELDS' });
      }

      if (!['present', 'absent'].includes(present_absent)) {
        return res
          .status(400)
          .json({ error: 'Invalid status: must be present or absent', code: 'ATTENDANCE_INVALID_STATUS' });
      }

      // Validate date must be "today" in IST (DB is local IST)
      const today = todayIST();
      if (date !== today) {
        return res
          .status(400)
          .json({ error: 'Date must be today', code: 'ATTENDANCE_INVALID_DATE' });
      }

      // Guard rails on state transitions
      const { rows: [existingRecord] } = await pool.query(
        'SELECT check_in_time, check_out_time, present_absent FROM attendance WHERE user_id = $1 AND date = $2::date',
        [req.user.user_id, date]
      );

      if (present_absent === 'absent') {
        if (check_in_time || check_out_time || mode) {
          return res.status(400).json({
            error: 'When absent, check-in, check-out, and mode must be null',
            code: 'ATTENDANCE_INVALID_ABSENT_FIELDS',
          });
        }
      } else {
        if (!mode) {
          return res
            .status(400)
            .json({ error: 'Work mode is required for present status', code: 'ATTENDANCE_MISSING_FIELDS' });
        }
        if (!['office', 'remote'].includes(mode)) {
          return res
            .status(400)
            .json({ error: 'Invalid work mode: must be office or remote', code: 'ATTENDANCE_INVALID_MODE' });
        }
        if (check_in_time && existingRecord) {
          return res
            .status(400)
            .json({ error: 'Check-in already recorded for today', code: 'ATTENDANCE_ALREADY_CHECKED_IN' });
        }
        if (check_out_time && (!existingRecord || !existingRecord.check_in_time)) {
          return res
            .status(400)
            .json({ error: 'Cannot check out without a prior check-in', code: 'ATTENDANCE_NO_CHECK_IN' });
        }
        if (check_out_time && existingRecord && existingRecord.check_out_time) {
          return res
            .status(400)
            .json({ error: 'Check-out already recorded for today', code: 'ATTENDANCE_ALREADY_CHECKED_OUT' });
        }
        if (check_out_time && check_in_time && new Date(check_out_time) <= new Date(check_in_time)) {
          return res
            .status(400)
            .json({ error: 'Check-out time must be after check-in time', code: 'ATTENDANCE_INVALID_TIME' });
        }
      }

      const attendance = await Attendance.createOrUpdate(
        req.user.user_id,
        { date, check_in_time, check_out_time, present_absent, mode },
        req.io // model will emit a rich 'attendanceMarked' event
      );

      // The model already returns IST-formatted strings. Respond as-is.
      const response = {
        attendance_id: attendance.attendance_id,
        user_id: attendance.user_id,
        date: attendance.date, // 'YYYY-MM-DD'
        check_in_time: attendance.check_in_time || null,   // 'YYYY-MM-DDTHH:mm:ss'
        check_out_time: attendance.check_out_time || null, // 'YYYY-MM-DDTHH:mm:ss'
        present_absent: attendance.present_absent,
        mode: attendance.mode,
        created_at: attendance.created_at, // 'YYYY-MM-DDTHH:mm:ss'
        timezone: 'Asia/Kolkata',
      };

      // Invalidate cached pages for this user
      setImmediate(async () => {
        try {
          const cacheKeys = await redis.keys(`attendance_*_${req.user.user_id}`);
          if (cacheKeys.length) await redis.del(cacheKeys);
          logger.info(
            `Cleared cache for attendance after marking for user_id: ${req.user.user_id}`
          );
        } catch (err) {
          logger.error('Cache invalidation error', err);
        }
      });

      // ⚠️ Do NOT emit a second socket event here.
      // The model already emitted a detailed 'attendanceMarked' payload.
      res.status(201).json(response);
    } catch (error) {
      logger.error(
        `Error marking attendance for user ${req.user.user_id}: ${error.message}`,
        { stack: error.stack }
      );
      res.status(error.status || 400).json({ error: error.message, code: 'ATTENDANCE_ERROR' });
    }
  }
);

// === HR ATTENDANCE SUMMARY (All Employees) ===
router.get(
  '/summary',
  authenticateToken,
  checkPermission('attendance_summary', 'can_read'),
  async (req, res) => {
    const { limit = 20, cursor, date, search, force_refresh = false } = req.query;

    try {
      const parsedLimit = Math.min(parseInt(limit, 10), 100);
      const cacheKey = `hr_attendance_summary_${parsedLimit}_${cursor || 'null'}_${date || 'all'}_${search || 'none'}`;

      if (force_refresh === 'true') await redis.del(cacheKey);

      const cached = await redis.get(cacheKey);
      if (cached && force_refresh !== 'true') {
        logger.info(`Cache hit for HR summary: ${cacheKey}`);
        return res.json(JSON.parse(cached));
      }

      const { data, total, nextCursor } = await Attendance.getHRSummary({
        limit: parsedLimit,
        cursor: cursor ? new Date(cursor) : null, // model uses created_at cursor
        date,
        search,
      });

      const response = {
        attendance: data, // already IST strings from the model
        total,
        nextCursor: nextCursor
          ? (nextCursor instanceof Date ? nextCursor.toISOString() : nextCursor)
          : null,
      };

      await redis.setEx(cacheKey, 300, JSON.stringify(response));
      res.json(response);
    } catch (error) {
      logger.error(
        `HR Attendance Summary Error for user ${req.user.user_id}: ${error.message}`,
        { stack: error.stack }
      );
      res.status(500).json({ error: 'Server error', code: 'HR_ATTENDANCE_SUMMARY_ERROR' });
    }
  }
);

module.exports = router;
