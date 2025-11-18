// routes/attendance.js
const express = require('express');
const { Attendance } = require('../models/attendance');
const redis = require('../config/redis');
const { authenticateToken, checkPermission } = require('../middleware/auth');
const logger = require('../utils/logger');
const pool = require('../config/db');
const router = express.Router({ mergeParams: true });

// Helper: "today" in IST as YYYY-MM-DD
const todayIST = () => {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
};

// PERSONAL ATTENDANCE (Employee) — unchanged, perfect as-is
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
        logger.info(`Cache hit: ${cacheKey}`);
        return res.json(JSON.parse(cached));
      }

      const { data: attendanceRecords, total, nextCursor } = await Attendance.getAll({
        limit: parsedLimit,
        cursor: cursor ? new Date(cursor) : null,
        user_id: req.user.user_id,
      });

      const processedRows = attendanceRecords.map((record) => ({
        ...record,
        timezone: 'Asia/Kolkata',
      }));

      const response = {
        attendance: processedRows,
        total,
        nextCursor: nextCursor
          ? (nextCursor instanceof Date ? nextCursor.toISOString() : nextCursor)
          : null,
      };

      // Personal history: short cache is fine
      await redis.setEx(cacheKey, 10, JSON.stringify(response));
      res.json(response);
    } catch (error) {
      logger.error(`Error fetching personal attendance: ${error.message}`, { stack: error.stack });
      res.status(500).json({ error: 'Server error', code: 'SERVER_ERROR' });
    }
  }
);

// MARK ATTENDANCE — unchanged (model already emits rich payload)
router.post(
  '/',
  authenticateToken,
  checkPermission('mark_attendance', 'can_write'),
  async (req, res) => {
    try {
      const { date, check_in_time, check_out_time, present_absent, mode } = req.body;

      if (!present_absent || !['present', 'absent'].includes(present_absent)) {
        return res.status(400).json({ error: 'Invalid status', code: 'ATTENDANCE_INVALID_STATUS' });
      }

      const today = todayIST();
      if (date !== today) {
        return res.status(400).json({ error: 'Date must be today', code: 'ATTENDANCE_INVALID_DATE' });
      }

      const { rows: [existingRecord] } = await pool.query(
        'SELECT check_in_time, check_out_time, present_absent FROM attendance WHERE user_id = $1 AND date = $2::date',
        [req.user.user_id, date]
      );

      if (present_absent === 'absent') {
        if (check_in_time || check_out_time || mode) {
          return res.status(400).json({ error: 'Absent records must have null times/mode', code: 'ATTENDANCE_INVALID_ABSENT_FIELDS' });
        }
      } else {
        if (!mode || !['office', 'remote'].includes(mode)) {
          return res.status(400).json({ error: 'Valid work mode required', code: 'ATTENDANCE_INVALID_MODE' });
        }
        if (check_in_time && existingRecord?.check_in_time) {
          return res.status(400).json({ error: 'Already checked in today', code: 'ATTENDANCE_ALREADY_CHECKED_IN' });
        }
        if (check_out_time && !existingRecord?.check_in_time) {
          return res.status(400).json({ error: 'Cannot check out without check-in', code: 'ATTENDANCE_NO_CHECK_IN' });
        }
        if (check_out_time && existingRecord?.check_out_time) {
          return res.status(400).json({ error: 'Already checked out today', code: 'ATTENDANCE_ALREADY_CHECKED_OUT' });
        }
        if (check_out_time && check_in_time && new Date(check_out_time) <= new Date(check_in_time)) {
          return res.status(400).json({ error: 'Check-out must be after check-in', code: 'ATTENDANCE_INVALID_TIME' });
        }
      }

      const attendance = await Attendance.createOrUpdate(
        req.user.user_id,
        { date, check_in_time, check_out_time, present_absent, mode },
        req.io
      );

      const response = {
        attendance_id: attendance.attendance_id,
        user_id: attendance.user_id,
        date: attendance.date,
        check_in_time: attendance.check_in_time || null,
        check_out_time: attendance.check_out_time || null,
        present_absent: attendance.present_absent,
        mode: attendance.mode,
        created_at: attendance.created_at,
        timezone: 'Asia/Kolkata',
      };

      // Invalidate all relevant caches in background
      setImmediate(async () => {
        try {
          const personalKeys = await redis.keys(`attendance_*_${req.user.user_id}`);
          const hrKeys = await redis.keys('hr_attendance_summary_*');
          const allKeys = [...personalKeys, ...hrKeys];
          if (allKeys.length > 0) {
            await redis.del(allKeys);
            logger.info(`Invalidated ${allKeys.length} cache keys after attendance mark`);
          }
        } catch (err) {
          logger.error('Cache invalidation failed', err);
        }
      });

      res.status(201).json(response);
    } catch (error) {
      logger.error(`Mark attendance error: ${error.message}`, { stack: error.stack });
      res.status(error.status || 400).json({ error: error.message || 'Failed to mark attendance' });
    }
  }
);

// HR ATTENDANCE SUMMARY — SMART CACHING (THE MAGIC)
router.get(
  '/summary',
  authenticateToken,
  checkPermission('attendance_summary', 'can_read'),
  async (req, res) => {
    const { limit = 20, cursor, date, search, force_refresh = false } = req.query;

    try {
      const parsedLimit = Math.min(parseInt(limit, 10), 100);
      const currentToday = todayIST();
      const isTodayView = !date || date === currentToday;

      // TODAY'S VIEW → ALWAYS FRESH (real-time)
      if (isTodayView || force_refresh === 'true') {
        const { data, total, nextCursor } = await Attendance.getHRSummary({
          limit: parsedLimit,
          cursor: cursor ? new Date(cursor) : null,
          date,
          search,
        });

        return res.json({
          attendance: data,
          total,
          nextCursor: nextCursor ? new Date(nextCursor).toISOString() : null,
        });
      }

      // PAST DATES & SEARCH → CACHE (fast)
      const cacheKey = `hr_attendance_summary_${parsedLimit}_${cursor || 'null'}_${date || 'all'}_${search || 'none'}`;

      const cached = await redis.get(cacheKey);
      if (cached) {
        logger.info(`Cache hit (non-today): ${cacheKey}`);
        return res.json(JSON.parse(cached));
      }

      const { data, total, nextCursor } = await Attendance.getHRSummary({
        limit: parsedLimit,
        cursor: cursor ? new Date(cursor) : null,
        date,
        search,
      });

      const response = {
        attendance: data,
        total,
        nextCursor: nextCursor ? new Date(nextCursor).toISOString() : null,
      };

      // Cache for 30 seconds (past/filtered views)
      await redis.setEx(cacheKey, 30, JSON.stringify(response));
      res.json(response);
    } catch (error) {
      logger.error(`HR Summary error: ${error.message}`, { stack: error.stack });
      res.status(500).json({ error: 'Server error', code: 'HR_ATTENDANCE_SUMMARY_ERROR' });
    }
  }
);

module.exports = router;