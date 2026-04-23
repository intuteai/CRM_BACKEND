const express = require('express');
const router = express.Router({ mergeParams: true });
const { authenticateToken, checkPermission } = require('../../middleware/auth');
const controller = require('../../controllers/hr/attendance.controller');

router.get('/', authenticateToken, checkPermission('attendance_history', 'can_read'), controller.getPersonal);
router.post('/', authenticateToken, checkPermission('mark_attendance', 'can_write'), controller.markAttendance);
router.get('/summary', authenticateToken, checkPermission('attendance_summary', 'can_read'), controller.getHRSummary);

module.exports = router;
