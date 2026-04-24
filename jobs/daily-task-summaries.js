const cron = require('node-cron');
const pool = require('../config/db');
const { sendEmail } = require('../services/email');
const { generateDailyTaskSummaryHtml } = require('../utils/emailTemplates');
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

async function runDailyTaskSummary({ isEvening }) {
  if (isWeekendIST()) {
    logger.info('[Daily Summary] Weekend — skipping');
    return;
  }

  const today = getISTDate();
  const todayStr = today.toISOString().split('T')[0];
  const todayFormatted = formatDateLong(today);

  logger.info(`[Daily Summary] Running ${isEvening ? 'EVENING' : 'MORNING'} report | ${todayStr}`);

  try {
    const usersRes = await pool.query(`
      SELECT user_id, name, email
      FROM users
      WHERE user_id IN (45, 69, 70, 71, 72, 73)
        AND email IS NOT NULL
      ORDER BY name ASC
    `);

    const users = usersRes.rows;
    if (users.length === 0) {
      logger.info('[Daily Summary] No users with email found — skipping');
      return;
    }

    const userMap = new Map();
    const userTasks = new Map();

    for (const u of users) {
      userMap.set(u.user_id, { name: u.name, email: u.email });
      userTasks.set(u.user_id, { completedToday: [], pending: [] });
    }

    const tasksRes = await pool.query(`
      SELECT
        a.id, a.summary, a.status, a.priority, a.updated_at, a.due_date, aa.user_id
      FROM activities a
      JOIN activity_assignees aa ON aa.activity_id = a.id
      WHERE a.status IN ('todo', 'in_progress', 'done')
      ORDER BY a.updated_at DESC, a.created_at DESC
    `);

    const taskGroups = new Map();
    for (const row of tasksRes.rows) {
      if (!taskGroups.has(row.id)) {
        taskGroups.set(row.id, {
          id: row.id,
          summary: row.summary,
          status: row.status,
          priority: row.priority || 'medium',
          updated_at: row.updated_at,
          due_date: row.due_date,
          user_ids: [],
        });
      }
      taskGroups.get(row.id).user_ids.push(row.user_id);
    }

    const managerCompleted = [];
    const managerPending = [];

    for (const task of taskGroups.values()) {
      const assignees = task.user_ids.map(uid => userMap.get(uid)?.name).filter(Boolean);
      const displaySummary = assignees.length > 0 ? `${task.summary} → ${assignees.join(', ')}` : task.summary;
      const baseTask = { id: task.id, summary: displaySummary, priority: task.priority };

      let isRelevant = false;
      for (const uid of task.user_ids) {
        if (!userTasks.has(uid)) continue;
        isRelevant = true;
        const bucket = userTasks.get(uid);

        if (isEvening && task.status === 'done') {
          const doneDate = new Date(task.updated_at).toISOString().split('T')[0];
          if (doneDate === todayStr) bucket.completedToday.push({ ...baseTask, completedAt: 'Today' });
        }
        if (task.status !== 'done') {
          bucket.pending.push({
            ...baseTask,
            status: task.status,
            dueDate: task.due_date ? new Date(task.due_date).toLocaleDateString('en-IN') : 'No due date',
          });
        }
      }

      if (isRelevant) {
        if (isEvening && task.status === 'done') {
          const doneDate = new Date(task.updated_at).toISOString().split('T')[0];
          if (doneDate === todayStr) managerCompleted.push({ ...baseTask, completedAt: 'Today' });
        }
        if (task.status !== 'done') {
          managerPending.push({
            ...baseTask,
            status: task.status,
            dueDate: task.due_date ? new Date(task.due_date).toLocaleDateString('en-IN') : 'No due date',
          });
        }
      }
    }

    if (MANAGER_EMAIL) {
      const managerData = { managerName: 'Akshay', date: todayFormatted, pendingTasks: managerPending };
      if (isEvening) managerData.completedTasks = managerCompleted;

      await sendEmail({
        to: MANAGER_EMAIL,
        subject: `Daily Task Summary – ${isEvening ? 'Evening' : 'Morning'} (${todayFormatted})`,
        text: 'Team daily task summary',
        html: generateDailyTaskSummaryHtml(managerData),
      });
      logger.info('[Daily Summary] Manager report sent');
    }

    for (const user of users) {
      const bucket = userTasks.get(user.user_id) || { completedToday: [], pending: [] };
      const userData = { managerName: user.name, date: todayFormatted, pendingTasks: bucket.pending };
      if (isEvening) userData.completedTasks = bucket.completedToday;

      await sendEmail({
        to: user.email,
        subject: `Your Tasks – ${isEvening ? 'Evening' : 'Morning'} (${todayFormatted})`,
        text: 'Your daily task update',
        html: generateDailyTaskSummaryHtml(userData),
      });
    }

    logger.info(`[Daily Summary] ${users.length} employee email(s) sent — job complete`);
  } catch (err) {
    logger.error('[Daily Summary] Error: ' + (err.stack || err.message));
  }
}

cron.schedule('0 9 * * *',  () => runDailyTaskSummary({ isEvening: false }), { timezone: 'Asia/Kolkata' });
cron.schedule('30 18 * * *', () => runDailyTaskSummary({ isEvening: true }),  { timezone: 'Asia/Kolkata' });

logger.info('Daily task summaries job scheduled (9:00 AM & 6:30 PM IST, weekdays)');
