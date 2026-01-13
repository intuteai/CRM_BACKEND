// jobs/daily-due-reminders.js
const cron = require('node-cron');
const pool = require('../config/db');
const { sendEmail } = require('../utils/email');
const { generateDueTomorrowReminderHtml } = require('../utils/emailTemplates');

console.log('[DAILY REMINDER] Job file loaded - scheduled for 11:00 AM IST');

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
      day: 'numeric'
    });

    console.log(`[DAILY REMINDER] Running at ${today.toLocaleString('en-IN')} | Looking for tasks due on ${tomorrowStr}`);

    const query = `
      SELECT 
        a.id,
        a.summary,
        a.priority,
        a.status,
        a.due_date,
        u.user_id,
        u.name,
        u.email
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
      console.log('[DAILY REMINDER] No unfinished tasks due tomorrow');
      return;
    }

    console.log(`[DAILY REMINDER] Found ${rows.length} unfinished tasks due tomorrow`);

    // Group by user
    const tasksByUser = {};

    for (const row of rows) {
      const email = row.email.trim();
      if (!tasksByUser[email]) {
        tasksByUser[email] = {
          name: row.name || 'Team Member',
          tasks: []
        };
      }
      tasksByUser[email].tasks.push({
        id: row.id,
        summary: row.summary,
        priority: row.priority,
        status: row.status
      });
    }

    // Send emails
    for (const [email, data] of Object.entries(tasksByUser)) {
      const taskCount = data.tasks.length;
      const subject = `Reminder: ${taskCount} task${taskCount === 1 ? '' : 's'} due tomorrow`;

      // Plain text fallback
      const taskListText = data.tasks.map(t => 
        `• ${t.summary} (Priority: ${t.priority}, Status: ${t.status})\n  View: https://intute.biz/activities/${t.id}`
      ).join('\n\n');

      const text = 
        `Hello ${data.name},\n\n` +
        `The following task${taskCount === 1 ? ' is' : 's are'} due tomorrow (${tomorrowStr}):\n\n` +
        `${taskListText}\n\n` +
        `Please make sure to complete them on time!\n\n` +
        `Best regards,\nIntute ERP Team`;

      // Beautiful HTML
      const html = generateDueTomorrowReminderHtml({
        userName: data.name,
        tomorrowDate: tomorrowFormatted,
        taskCount,
        tasks: data.tasks
      });

      console.log(`[DAILY REMINDER] Sending reminder to ${email} (${taskCount} task${taskCount === 1 ? '' : 's'})`);

      await sendEmail({
        to: email,
        subject,
        text,
        html
      });
    }

    console.log('[DAILY REMINDER] All reminders processed successfully');
  } catch (error) {
    console.error('[DAILY REMINDER] Error:', error.message);
  }
}

// Schedule
cron.schedule('0 11 * * *', sendDueTomorrowReminders, {
  timezone: 'Asia/Kolkata'
});

console.log('[DAILY REMINDER] Cron scheduled → 11:00 AM IST every day');
