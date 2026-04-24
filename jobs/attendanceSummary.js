const cron = require('node-cron');
const pool = require('../config/db');
const { sendEmail } = require('../services/email');
const { generateAttendanceCheckInSummaryHtml, generateAttendanceCheckOutSummaryHtml } = require('../utils/emailTemplates');
const logger = require('../utils/logger');

const MANAGER_EMAIL = process.env.MANAGER_DAILY_REPORT_EMAIL;

function getISTDate() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
}

function isWeekendIST() {
  return getISTDate().getDay() === 0;
}

function formatDateLong(date) {
  return date.toLocaleDateString('en-IN', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function calculateHours(checkIn, checkOut) {
  if (!checkIn || !checkOut) return null;
  const diff = new Date(checkOut) - new Date(checkIn);
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  return `${hours}h ${minutes}m`;
}

async function runMorningCheckInSummary() {
  if (isWeekendIST()) {
    logger.info('[Attendance Check-In] Weekend — skipping');
    return;
  }

  const today = getISTDate();
  const todayStr = today.toISOString().split('T')[0];
  const todayFormatted = formatDateLong(today);

  logger.info(`[Attendance Check-In] Running | ${todayStr}`);

  try {
    const checkInsRes = await pool.query(`
      SELECT
        a.attendance_id, a.user_id, a.check_in_time,
        u.name, ed.employee_id
      FROM attendance a
      INNER JOIN users u ON a.user_id = u.user_id
      LEFT JOIN employee_details ed ON u.user_id = ed.user_id
      WHERE a.date = $1::date
        AND a.check_in_time IS NOT NULL
        AND a.present_absent = 'present'
        AND a.user_id NOT IN (45, 69, 70, 71, 72, 73)
      ORDER BY a.check_in_time ASC
    `, [todayStr]);

    const checkIns = checkInsRes.rows.map(row => ({
      name: row.name,
      employeeId: row.employee_id || 'N/A',
      checkInTime: new Date(row.check_in_time).toLocaleTimeString('en-IN', {
        hour: '2-digit', minute: '2-digit', hour12: true,
      }),
    }));

    const totalCheckedIn = checkIns.length;

    if (MANAGER_EMAIL) {
      await sendEmail({
        to: MANAGER_EMAIL,
        subject: `Attendance Check-In Summary – ${todayFormatted}`,
        text: 'Daily check-in summary',
        html: generateAttendanceCheckInSummaryHtml({ managerName: 'Akshay', date: todayFormatted, checkIns, totalCheckedIn }),
      });
      logger.info(`[Attendance Check-In] Report sent to manager (${totalCheckedIn} check-in(s))`);
    }

    logger.info('[Attendance Check-In] Job completed successfully');
  } catch (err) {
    logger.error('[Attendance Check-In] Error: ' + (err.stack || err.message));
  }
}

async function runEveningCheckOutSummary() {
  if (isWeekendIST()) {
    logger.info('[Attendance Check-Out] Weekend — skipping');
    return;
  }

  const today = getISTDate();
  const todayStr = today.toISOString().split('T')[0];
  const todayFormatted = formatDateLong(today);

  logger.info(`[Attendance Check-Out] Running | ${todayStr}`);

  try {
    const attendanceRes = await pool.query(`
      SELECT
        a.attendance_id, a.user_id, a.check_in_time, a.check_out_time,
        u.name, ed.employee_id
      FROM attendance a
      INNER JOIN users u ON a.user_id = u.user_id
      LEFT JOIN employee_details ed ON u.user_id = ed.user_id
      WHERE a.date = $1::date
        AND a.check_in_time IS NOT NULL
        AND a.present_absent = 'present'
        AND a.user_id NOT IN (45, 69, 70, 71, 72, 73)
      ORDER BY a.check_out_time DESC NULLS LAST, a.check_in_time ASC
    `, [todayStr]);

    const checkedOut = [];
    const stillActive = [];

    for (const row of attendanceRes.rows) {
      const record = {
        name: row.name,
        employeeId: row.employee_id || 'N/A',
        checkInTime: new Date(row.check_in_time).toLocaleTimeString('en-IN', {
          hour: '2-digit', minute: '2-digit', hour12: true,
        }),
      };

      if (row.check_out_time) {
        record.checkOutTime = new Date(row.check_out_time).toLocaleTimeString('en-IN', {
          hour: '2-digit', minute: '2-digit', hour12: true,
        });
        record.hoursWorked = calculateHours(row.check_in_time, row.check_out_time);
        checkedOut.push(record);
      } else {
        stillActive.push(record);
      }
    }

    const totalCheckedOut = checkedOut.length;
    const totalStillActive = stillActive.length;

    if (MANAGER_EMAIL) {
      await sendEmail({
        to: MANAGER_EMAIL,
        subject: `Attendance Check-Out Summary – ${todayFormatted}`,
        text: 'Daily check-out summary',
        html: generateAttendanceCheckOutSummaryHtml({
          managerName: 'Akshay',
          date: todayFormatted,
          checkedOut,
          stillActive,
          totalCheckedOut,
          totalStillActive,
        }),
      });
      logger.info(`[Attendance Check-Out] Report sent to manager (${totalCheckedOut} out, ${totalStillActive} still active)`);
    }

    logger.info('[Attendance Check-Out] Job completed successfully');
  } catch (err) {
    logger.error('[Attendance Check-Out] Error: ' + (err.stack || err.message));
  }
}

cron.schedule('0 10 * * *',  runMorningCheckInSummary,   { timezone: 'Asia/Kolkata' });
cron.schedule('30 19 * * *', runEveningCheckOutSummary,  { timezone: 'Asia/Kolkata' });

logger.info('Attendance summary job scheduled (10:00 AM & 7:30 PM IST, Monday-Saturday)');
