const cron = require('node-cron');
const pool = require('../config/db');
const { sendEmail } = require('../services/email');
const { generateDueTomorrowReminderHtml } = require('../utils/emailTemplates');
const logger = require('../utils/logger');

async function sendDueTomorrowReminders() {
  try {
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    const tomorrowStr = tomorrow.toISOString().split('T')[0];
    const tomorrowFormatted = tomorrow.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    logger.info(`[Daily Reminder] Running | Looking for tasks due on ${tomorrowStr}`);

    const query = `
      SELECT
        a.id, a.summary, a.priority, a.status, a.due_date,
        u.user_id, u.name, u.email
      FROM activities a
      JOIN activity_assignees aa ON aa.activity_id = a.id
      JOIN users u ON u.user_id = aa.user_id
      WHERE a.due_date = $1
        AND a.status IN ('todo', 'in_progress')
        AND u.email IS NOT NULL
      ORDER BY u.user_id, a.id
    `;

    const { rows } = await pool.query(query, [tomorrowStr]);

    if (rows.length === 0) {
      logger.info('[Daily Reminder] No unfinished tasks due tomorrow — skipping');
      return;
    }

    logger.info(`[Daily Reminder] Found ${rows.length} unfinished task(s) due tomorrow`);

    const tasksByUser = {};
    for (const row of rows) {
      const email = row.email.trim();
      if (!tasksByUser[email]) {
        tasksByUser[email] = { name: row.name || 'Team Member', tasks: [] };
      }
      tasksByUser[email].tasks.push({
        id: row.id,
        summary: row.summary,
        priority: row.priority,
        status: row.status,
      });
    }

    for (const [email, data] of Object.entries(tasksByUser)) {
      const taskCount = data.tasks.length;
      const subject = `Reminder: ${taskCount} task${taskCount === 1 ? '' : 's'} due tomorrow`;

      const taskListText = data.tasks.map(t =>
        `• ${t.summary} (Priority: ${t.priority}, Status: ${t.status})\n  View: https://intute.biz/activities/${t.id}`
      ).join('\n\n');

      const text =
        `Hello ${data.name},\n\n` +
        `The following task${taskCount === 1 ? ' is' : 's are'} due tomorrow (${tomorrowStr}):\n\n` +
        `${taskListText}\n\n` +
        `Please make sure to complete them on time!\n\nBest regards,\nIntute ERP Team`;

      const html = generateDueTomorrowReminderHtml({
        userName: data.name,
        tomorrowDate: tomorrowFormatted,
        taskCount,
        tasks: data.tasks,
      });

      logger.info(`[Daily Reminder] Sending to ${email} (${taskCount} task${taskCount === 1 ? '' : 's'})`);
      await sendEmail({ to: email, subject, text, html });
    }

    logger.info('[Daily Reminder] All reminders dispatched successfully');
  } catch (error) {
    logger.error('[Daily Reminder] Error: ' + error.message);
  }
}

cron.schedule('0 11 * * *', sendDueTomorrowReminders, { timezone: 'Asia/Kolkata' });
logger.info('Daily due-tomorrow reminder job scheduled (11:00 AM IST)');
