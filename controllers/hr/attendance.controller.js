const { Attendance } = require('../../models/hr/attendance');
const redis = require('../../config/redis');
const pool = require('../../config/db');
const logger = require('../../utils/logger');

const IA_ROLES = [11, 12];
const COM_ROLES = [9, 10];

function getOrgRoles(roleId) {
  if (IA_ROLES.includes(roleId)) return IA_ROLES;
  if (COM_ROLES.includes(roleId)) return COM_ROLES;
  return [];
}

const todayIST = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

exports.getPersonal = async (req, res) => {
  const { limit = 10, cursor, force_refresh = false } = req.query;
  try {
    const parsedLimit = Math.min(parseInt(limit, 10), 100);
    const cacheKey = `attendance_${parsedLimit}_${cursor || 'null'}_${req.user.user_id}`;
    if (force_refresh === 'true') await redis.del(cacheKey);
    const cached = await redis.get(cacheKey);
    if (cached && force_refresh !== 'true') { logger.info(`Cache hit: ${cacheKey}`); return res.json(JSON.parse(cached)); }
    const { data: attendanceRecords, total, nextCursor } = await Attendance.getAll({ limit: parsedLimit, cursor: cursor ? new Date(cursor) : null, user_id: req.user.user_id });
    const response = { attendance: attendanceRecords.map(r => ({ ...r, timezone: 'Asia/Kolkata' })), total, nextCursor: nextCursor ? (nextCursor instanceof Date ? nextCursor.toISOString() : nextCursor) : null };
    await redis.setEx(cacheKey, 10, JSON.stringify(response));
    res.json(response);
  } catch (error) {
    logger.error(`Error fetching personal attendance: ${error.message}`, { stack: error.stack });
    res.status(500).json({ error: 'Server error', code: 'SERVER_ERROR' });
  }
};

exports.markAttendance = async (req, res) => {
  try {
    const { date, check_in_time, check_out_time, present_absent, mode } = req.body;
    if (!present_absent || !['present', 'absent'].includes(present_absent)) return res.status(400).json({ error: 'Invalid status', code: 'ATTENDANCE_INVALID_STATUS' });
    const today = todayIST();
    if (date !== today) return res.status(400).json({ error: 'Date must be today', code: 'ATTENDANCE_INVALID_DATE' });
    const { rows: [existingRecord] } = await pool.query('SELECT check_in_time, check_out_time, present_absent FROM attendance WHERE user_id = $1 AND date = $2::date', [req.user.user_id, date]);
    if (present_absent === 'absent') {
      if (check_in_time || check_out_time || mode) return res.status(400).json({ error: 'Absent records must have null times/mode', code: 'ATTENDANCE_INVALID_ABSENT_FIELDS' });
    } else {
      if (!mode || !['office', 'remote'].includes(mode)) return res.status(400).json({ error: 'Valid work mode required', code: 'ATTENDANCE_INVALID_MODE' });
      if (check_in_time && existingRecord?.check_in_time) return res.status(400).json({ error: 'Already checked in today', code: 'ATTENDANCE_ALREADY_CHECKED_IN' });
      if (check_out_time && !existingRecord?.check_in_time) return res.status(400).json({ error: 'Cannot check out without check-in', code: 'ATTENDANCE_NO_CHECK_IN' });
      if (check_out_time && existingRecord?.check_out_time) return res.status(400).json({ error: 'Already checked out today', code: 'ATTENDANCE_ALREADY_CHECKED_OUT' });
      if (check_out_time && check_in_time && new Date(check_out_time) <= new Date(check_in_time)) return res.status(400).json({ error: 'Check-out must be after check-in', code: 'ATTENDANCE_INVALID_TIME' });
    }
    const attendance = await Attendance.createOrUpdate(req.user.user_id, { date, check_in_time, check_out_time, present_absent, mode }, req.io);
    const response = { attendance_id: attendance.attendance_id, user_id: attendance.user_id, date: attendance.date, check_in_time: attendance.check_in_time || null, check_out_time: attendance.check_out_time || null, present_absent: attendance.present_absent, mode: attendance.mode, created_at: attendance.created_at, timezone: 'Asia/Kolkata' };
    setImmediate(async () => {
      try {
        const personalKeys = await redis.keys(`attendance_*_${req.user.user_id}`);
        const hrKeys = await redis.keys('hr_attendance_summary_*');
        const allKeys = [...personalKeys, ...hrKeys];
        if (allKeys.length > 0) await redis.del(allKeys);
      } catch (err) { logger.error('Cache invalidation failed', err); }
    });
    res.status(201).json(response);
  } catch (error) {
    logger.error(`Mark attendance error: ${error.message}`, { stack: error.stack });
    res.status(error.status || 400).json({ error: error.message || 'Failed to mark attendance' });
  }
};

exports.getHRSummary = async (req, res) => {
  const { limit = 20, cursor, date, search, force_refresh = false } = req.query;
  try {
    const parsedLimit = Math.min(parseInt(limit, 10), 100);
    const currentToday = todayIST();
    const isTodayView = !date || date === currentToday;
    const orgRoles = getOrgRoles(req.user.role_id);
    if (orgRoles.length === 0) return res.status(403).json({ error: 'Not authorized to view attendance summary' });
    if (isTodayView || force_refresh === 'true') {
      const { data, total, nextCursor } = await Attendance.getHRSummary({ limit: parsedLimit, cursor: cursor ? new Date(cursor) : null, date, search, orgRoles });
      return res.json({ attendance: data, total, nextCursor: nextCursor ? new Date(nextCursor).toISOString() : null });
    }
    const cacheKey = `hr_attendance_summary_${parsedLimit}_${cursor || 'null'}_${date || 'all'}_${search || 'none'}_roles_${orgRoles.join('_')}`;
    const cached = await redis.get(cacheKey);
    if (cached) { logger.info(`Cache hit (non-today): ${cacheKey}`); return res.json(JSON.parse(cached)); }
    const { data, total, nextCursor } = await Attendance.getHRSummary({ limit: parsedLimit, cursor: cursor ? new Date(cursor) : null, date, search, orgRoles });
    const response = { attendance: data, total, nextCursor: nextCursor ? new Date(nextCursor).toISOString() : null };
    await redis.setEx(cacheKey, 30, JSON.stringify(response));
    res.json(response);
  } catch (error) {
    logger.error(`HR Summary error: ${error.message}`, { stack: error.stack });
    res.status(500).json({ error: 'Server error', code: 'HR_ATTENDANCE_SUMMARY_ERROR' });
  }
};
