const cron = require('node-cron');
const pool = require('../config/db');
const { sendEmail } = require('../utils/email');
const { generateDailyTaskSummaryHtml } = require('../utils/emailTemplates');

const MANAGER_EMAIL = process.env.MANAGER_DAILY_REPORT_EMAIL;

// ===================== HELPERS =====================

function getISTDate() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
}

function isWeekendIST() {
  return getISTDate().getDay() === 0 || getISTDate().getDay() === 6;
}

function formatDateLong(date) {
  return date.toLocaleDateString('en-IN', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

// ===================== CORE LOGIC =====================

async function runDailyTaskSummary({ isEvening }) {
  if (isWeekendIST()) {
    console.log('[DAILY SUMMARY] Weekend — skipping');
    return;
  }

  const today = getISTDate();
  const todayStr = today.toISOString().split('T')[0];
  const todayFormatted = formatDateLong(today);

  console.log(`[DAILY SUMMARY] Running ${isEvening ? 'EVENING' : 'MORNING'} | ${todayStr}`);

  try {
    // ── Get active employees ──
    const usersRes = await pool.query(`
      SELECT user_id, name, email
      FROM users
      WHERE user_id IN (45, 69, 70, 71, 72, 73)
        AND email IS NOT NULL
      ORDER BY name ASC
    `);

    const users = usersRes.rows;
    if (users.length === 0) {
      console.log('[DAILY SUMMARY] No users with email found');
      return;
    }

    const userMap = new Map();
    const userTasks = new Map();

    for (const u of users) {
      userMap.set(u.user_id, { name: u.name, email: u.email });
      userTasks.set(u.user_id, { completedToday: [], pending: [] });
    }

    // ── Fetch tasks ──
    const tasksRes = await pool.query(`
      SELECT
        a.id,
        a.summary,
        a.status,
        a.priority,
        a.updated_at,
        a.due_date,
        aa.user_id
      FROM activities a
      JOIN activity_assignees aa ON aa.activity_id = a.id
      WHERE a.status IN ('todo', 'in_progress', 'done')
      ORDER BY a.updated_at DESC, a.created_at DESC
    `);

    // Pre-group tasks by id
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
      const assignees = task.user_ids
        .map(uid => userMap.get(uid)?.name)
        .filter(Boolean);

      const displaySummary = assignees.length > 0
        ? `${task.summary} → ${assignees.join(', ')}`
        : task.summary;

      const baseTask = {
        id: task.id,
        summary: displaySummary,
        priority: task.priority,
      };

      let isRelevant = false;

      // Distribute to employees
      for (const uid of task.user_ids) {
        if (!userTasks.has(uid)) continue;
        isRelevant = true;

        const bucket = userTasks.get(uid);

        // Evening: completed today
        if (isEvening && task.status === 'done') {
          const doneDate = new Date(task.updated_at).toISOString().split('T')[0];
          if (doneDate === todayStr) {
            bucket.completedToday.push({ ...baseTask, completedAt: 'Today' });
          }
        }

        // Pending (both morning & evening)
        if (task.status !== 'done') {
          bucket.pending.push({
            ...baseTask,
            status: task.status,
            dueDate: task.due_date
              ? new Date(task.due_date).toLocaleDateString('en-IN')
              : 'No due date',
          });
        }
      }

      // Manager global view (once per task)
      if (isRelevant) {
        if (isEvening && task.status === 'done') {
          const doneDate = new Date(task.updated_at).toISOString().split('T')[0];
          if (doneDate === todayStr) {
            managerCompleted.push({ ...baseTask, completedAt: 'Today' });
          }
        }
        if (task.status !== 'done') {
          managerPending.push({
            ...baseTask,
            status: task.status,
            dueDate: task.due_date
              ? new Date(task.due_date).toLocaleDateString('en-IN')
              : 'No due date',
          });
        }
      }
    }

    // ── Manager email ───────────────────────────────────────
    if (MANAGER_EMAIL) {
      const managerData = {
        managerName: 'Akshay',
        date: todayFormatted,
        pendingTasks: managerPending,
      };

      // Only add completedTasks for evening
      if (isEvening) {
        managerData.completedTasks = managerCompleted;
      }

      await sendEmail({
        to: MANAGER_EMAIL,
        subject: `Daily Task Summary – ${isEvening ? 'Evening' : 'Morning'} (${todayFormatted})`,
        text: 'Team daily task summary',
        html: generateDailyTaskSummaryHtml(managerData),
      });

      console.log('[DAILY SUMMARY] Manager email sent');
    }

    // ── Employee emails ─────────────────────────────────────
    for (const user of users) {
      const bucket = userTasks.get(user.user_id) || { completedToday: [], pending: [] };

      // Optional: skip users with zero activity (uncomment if desired)
      // if (bucket.completedToday.length === 0 && bucket.pending.length === 0) continue;

      const userData = {
        managerName: user.name,
        date: todayFormatted,
        pendingTasks: bucket.pending,
      };

      // Only add completedTasks for evening
      if (isEvening) {
        userData.completedTasks = bucket.completedToday;
      }

      await sendEmail({
        to: user.email,
        subject: `Your Tasks – ${isEvening ? 'Evening' : 'Morning'} (${todayFormatted})`,
        text: 'Your daily task update',
        html: generateDailyTaskSummaryHtml(userData),
      });
    }

    console.log(`[DAILY SUMMARY] ${users.length} employee emails sent`);
    console.log('[DAILY SUMMARY] Job completed successfully');
  } catch (err) {
    console.error('[DAILY SUMMARY] Error:', err.stack || err.message);
  }
}

// ===================== CRON SCHEDULES =====================

// Morning – 11:00 AM IST
cron.schedule(
  '0 11 * * *',
  () => runDailyTaskSummary({ isEvening: false }),
  { timezone: 'Asia/Kolkata' }
);

// Evening – 6:30 PM IST
cron.schedule(
  '30 18 * * *',
  () => runDailyTaskSummary({ isEvening: true }),
  { timezone: 'Asia/Kolkata' }
);

console.log('[DAILY SUMMARY] Cron scheduled → 11:00 AM & 6:30 PM IST (weekdays only)');