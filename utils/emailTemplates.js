// utils/emailTemplates.js

/**
 * Helper to generate priority badge styles
 */
function getPriorityBadge(priority) {
  const lower = (priority || '').toLowerCase();
  if (lower === 'low')    return { bg: '#d1fae5', color: '#065f46', text: '● Low' };
  if (lower === 'medium') return { bg: '#fef3c7', color: '#92400e', text: '● Medium' };
  if (lower === 'high')   return { bg: '#fee2e2', color: '#991b1b', text: '● High' };
  if (lower === 'urgent') return { bg: '#fecaca', color: '#7f1d1d', text: '⚠ Urgent' };
  return { bg: '#e5e7eb', color: '#4b5563', text: '● ' + (priority || 'Unknown') };
}

/**
 * HTML template for daily due-tomorrow reminders (multiple tasks)
 */
function generateDueTomorrowReminderHtml({ userName, tomorrowDate, tasks }) {
  const taskCount = tasks.length;

  const taskCards = tasks.map(task => {
    const badge = getPriorityBadge(task.priority);
    return `
      <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="margin-top:20px;">
        <tr>
          <td style="background:#f7fafc;border:2px solid #e2e8f0;border-radius:12px;padding:24px;">
            <h3 style="margin:0 0 16px;font-size:19px;font-weight:600;color:#2d3748;line-height:1.4;">
              ${task.summary}
            </h3>
            <div style="margin-bottom:20px;">
              <span style="display:inline-block;padding:6px 14px;background:${badge.bg};color:${badge.color};border-radius:20px;font-size:13px;font-weight:600;margin-right:12px;">
                ${badge.text}
              </span>
              <span style="display:inline-block;padding:6px 14px;background:#e6fffa;color:#234e52;border-radius:20px;font-size:13px;font-weight:600;">
                ${task.status}
              </span>
            </div>
            <a href="https://intute.biz/activities/${task.id}"
               style="display:inline-block;padding:14px 28px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:600;box-shadow:0 4px 14px rgba(102,126,234,0.4);">
              View Details →
            </a>
          </td>
        </tr>
      </table>
    `;
  }).join('');

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Task Reminder - Due Tomorrow</title>
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;background:#f0f4f8;color:#1a202c;">
  <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background:#f0f4f8;padding:40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="640" border="0" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,0.1);">
          
          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#667eea 0%,#764ba2 50%,#f093fb 100%);padding:40px 40px 60px 40px;">
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td style="width:40%;vertical-align:top;">
                    <img src="https://www.intute.in/assets/intuteLogo-CcO7TiMq.png" 
                         alt="Intute.ai" 
                         style="width:180px;height:auto;display:block;margin-top:8px;" />
                  </td>
                  <td style="width:60%;text-align:center;vertical-align:middle;">
                    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;">
                      <div style="width:100px;height:100px;background:rgba(255,255,255,0.25);border-radius:50%;display:flex;align-items:center;justify-content:center;margin-bottom:20px;box-shadow:0 6px 16px rgba(0,0,0,0.2);">
                        <span style="font-size:60px;line-height:1;color:white;">⏰</span>
                      </div>
                      <h1 style="margin:0 0 8px;color:#ffffff;font-size:32px;font-weight:700;letter-spacing:-0.5px;">
                        Tasks Due Tomorrow
                      </h1>
                      <p style="margin:0;color:rgba(255,255,255,0.95);font-size:18px;font-weight:500;">
                        ${tomorrowDate}
                      </p>
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Greeting -->
          <tr>
            <td style="padding:48px 40px 32px;">
              <h2 style="margin:0 0 16px;font-size:26px;font-weight:700;color:#1a202c;">
                Hi ${userName} 👋
              </h2>
              <p style="margin:0 0 8px;font-size:17px;line-height:1.7;color:#4a5568;">
                You have <strong style="color:#667eea;font-weight:600;">${taskCount} task${taskCount === 1 ? '' : 's'}</strong> that ${taskCount === 1 ? 'needs' : 'need'} your attention tomorrow.
              </p>
              <p style="margin:0;font-size:15px;line-height:1.7;color:#718096;">
                Let's make sure you're prepared to tackle ${taskCount === 1 ? 'it' : 'them'}!
              </p>
            </td>
          </tr>

          <!-- Tasks -->
          <tr>
            <td style="padding:0 40px 40px;">
              ${taskCards}
            </td>
          </tr>

          <!-- Motivational -->
          <tr>
            <td style="padding:40px;background:linear-gradient(to right,#f0f7ff,#f0f4ff);border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;text-align:center;">
              <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#4a5568;font-weight:500;">
                💡 <strong>Pro Tip:</strong> Review these tasks tonight to plan your tomorrow effectively
              </p>
              <a href="https://intute.biz/" style="display:inline-block;padding:14px 32px;background:#ffffff;color:#667eea;text-decoration:none;border-radius:8px;font-size:15px;font-weight:600;border:2px solid #667eea;">
                Open Dashboard
              </a>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:40px;text-align:center;">
              <p style="margin:0 0 20px;font-size:14px;color:#718096;line-height:1.6;">
                Stay organized, stay productive.<br>
                Your success is our mission.
              </p>
            </td>
          </tr>

          <!-- Legal -->
          <tr>
            <td style="padding:24px 40px;text-align:center;background:#f7fafc;border-top:1px solid #e2e8f0;">
              <p style="margin:0 0 8px;font-size:12px;color:#a0aec0;line-height:1.5;">
                © 2026 Intute.ai. All rights reserved.
              </p>
              <p style="margin:0;font-size:11px;color:#cbd5e0;line-height:1.5;">
                This is an automated reminder from your Intute ERP system.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
}

/**
 * HTML template for DAILY TASK SUMMARY
 * → Completed Today section is only rendered when completedTasks is provided (i.e. evening reports)
 */
function generateDailyTaskSummaryHtml({ managerName, date, completedTasks, pendingTasks }) {
  const pendingCount = pendingTasks?.length ?? 0;

  const pendingItems = pendingCount === 0
    ? '<p style="margin:12px 0;font-size:15px;color:#718096;">No pending tasks at this time.</p>'
    : pendingTasks.map(task => {
        const badge = getPriorityBadge(task.priority);
        return `
          <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="margin:16px 0;">
            <tr>
              <td style="background:#f7fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px 20px;">
                <div style="font-size:16px;font-weight:600;color:#2d3748;">
                  ${task.summary}
                </div>
                <div style="margin:10px 0;">
                  <span style="display:inline-block;padding:5px 12px;background:${badge.bg};color:${badge.color};border-radius:16px;font-size:13px;font-weight:600;margin-right:10px;">
                    ${badge.text}
                  </span>
                  <span style="display:inline-block;padding:5px 12px;background:#e5e7eb;color:#4b5563;border-radius:16px;font-size:13px;">
                    ${task.status || 'Pending'}
                  </span>
                </div>
                <div style="font-size:14px;color:#4a5568;">
                  Due: ${task.dueDate || 'No due date'}
                </div>
              </td>
            </tr>
          </table>
        `;
      }).join('');

  // Completed section — only rendered if completedTasks was passed
  let completedSection = '';
  if (completedTasks !== undefined) {
    const completedCount = completedTasks.length ?? 0;
    const completedItems = completedCount === 0
      ? '<p style="margin:12px 0;font-size:15px;color:#718096;">No tasks completed today.</p>'
      : completedTasks.map(task => `
          <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="margin:16px 0;">
            <tr>
              <td style="background:#f0fdf4;border:1px solid #86efac;border-radius:10px;padding:16px 20px;">
                <div style="font-size:16px;font-weight:600;color:#166534;">
                  ${task.summary}
                </div>
                <div style="margin-top:8px;font-size:13px;color:#4b5563;">
                  Completed • ${task.completedAt || 'Today'}
                </div>
              </td>
            </tr>
          </table>
        `).join('');

    completedSection = `
      <tr>
        <td style="padding:0 40px 20px;">
          <h3 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#166534;">
            ✅ Completed Today (${completedCount})
          </h3>
          ${completedItems}
        </td>
      </tr>
    `;
  }

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Daily Task Summary - ${date}</title>
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;background:#f0f4f8;color:#1a202c;">
  <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background:#f0f4f8;padding:40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="640" border="0" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,0.1);">
          
          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#667eea 0%,#764ba2 50%,#f093fb 100%);padding:40px 40px 60px 40px;">
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td style="width:40%;vertical-align:top;">
                    <img src="https://www.intute.in/assets/intuteLogo-CcO7TiMq.png" 
                         alt="Intute.ai" 
                         style="width:180px;height:auto;display:block;margin-top:8px;" />
                  </td>
                  <td style="width:60%;text-align:center;vertical-align:middle;">
                    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;">
                      <div style="width:100px;height:100px;background:rgba(255,255,255,0.25);border-radius:50%;display:flex;align-items:center;justify-content:center;margin-bottom:20px;box-shadow:0 6px 16px rgba(0,0,0,0.2);">
                        <span style="font-size:60px;line-height:1;color:white;">📊</span>
                      </div>
                      <h1 style="margin:0 0 8px;color:#ffffff;font-size:32px;font-weight:700;letter-spacing:-0.5px;">
                        Daily Task Summary
                      </h1>
                      <p style="margin:0;color:rgba(255,255,255,0.95);font-size:18px;font-weight:500;">
                        ${date}
                      </p>
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Greeting -->
          <tr>
            <td style="padding:48px 40px 24px;">
              <h2 style="margin:0 0 16px;font-size:26px;font-weight:700;color:#1a202c;">
                Hi ${managerName} 👋
              </h2>
              <p style="margin:0 0 16px;font-size:17px;line-height:1.7;color:#4a5568;">
                Here's a quick overview of team activity for today.
              </p>
            </td>
          </tr>

          <!-- Completed Today – only shown in evening reports -->
          ${completedSection}

          <!-- Pending Tasks -->
          <tr>
            <td style="padding:${completedSection ? '20px' : '0'} 40px 40px;">
              <h3 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#991b1b;">
                🕒 Pending Tasks (${pendingCount})
              </h3>
              ${pendingItems}
            </td>
          </tr>

          <!-- CTA -->
          <tr>
            <td style="padding:40px;background:linear-gradient(to right,#f0f7ff,#f0f4ff);border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;text-align:center;">
              <a href="https://intute.biz/" 
                 style="display:inline-block;padding:14px 32px;background:#667eea;color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:600;box-shadow:0 4px 14px rgba(102,126,234,0.3);">
                View Full Report → 
              </a>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:40px;text-align:center;">
              <p style="margin:0 0 20px;font-size:14px;color:#718096;line-height:1.6;">
                Stay organized, stay productive.<br>
                Your success is our mission.
              </p>
            </td>
          </tr>

          <!-- Legal -->
          <tr>
            <td style="padding:24px 40px;text-align:center;background:#f7fafc;border-top:1px solid #e2e8f0;">
              <p style="margin:0 0 8px;font-size:12px;color:#a0aec0;line-height:1.5;">
                © 2026 Intute.ai. All rights reserved.
              </p>
              <p style="margin:0;font-size:11px;color:#cbd5e0;line-height:1.5;">
                This is an automated daily summary from your Intute ERP system.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
}

/**
 * HTML template for NEW TASK ASSIGNMENT notification (single task)
 */
function generateNewTaskAssignmentHtml({
  userName,
  taskSummary,
  priority,
  status,
  dueDate = 'No due date',
  taskId,
  createdBy = 'System'
}) {
  const badge = getPriorityBadge(priority);

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>New Task Assigned to You</title>
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;background:#f0f4f8;color:#1a202c;">
  <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background:#f0f4f8;padding:40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="640" border="0" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,0.1);">
          
          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#667eea 0%,#764ba2 50%,#f093fb 100%);padding:40px 40px 60px 40px;">
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td style="width:40%;vertical-align:top;">
                    <img src="https://www.intute.in/assets/intuteLogo-CcO7TiMq.png" 
                         alt="Intute.ai" 
                         style="width:180px;height:auto;display:block;margin-top:8px;" />
                  </td>
                  <td style="width:60%;text-align:center;vertical-align:middle;">
                    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;">
                      <div style="width:100px;height:100px;background:rgba(255,255,255,0.25);border-radius:50%;display:flex;align-items:center;justify-content:center;margin-bottom:20px;box-shadow:0 6px 16px rgba(0,0,0,0.2);">
                        <span style="font-size:60px;line-height:1;color:white;">✨</span>
                      </div>
                      <h1 style="margin:0 0 8px;color:#ffffff;font-size:32px;font-weight:700;letter-spacing:-0.5px;">
                        New Task Assigned
                      </h1>
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Greeting -->
          <tr>
            <td style="padding:48px 40px 24px;">
              <h2 style="margin:0 0 16px;font-size:26px;font-weight:700;color:#1a202c;">
                Hi ${userName} 👋
              </h2>
              <p style="margin:0 0 16px;font-size:17px;line-height:1.7;color:#4a5568;">
                You've been assigned a new task!
              </p>
            </td>
          </tr>

          <!-- Task Card -->
          <tr>
            <td style="padding:0 40px 40px;">
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td style="background:#f7fafc;border:2px solid #e2e8f0;border-radius:12px;padding:24px;">
                    <h3 style="margin:0 0 16px;font-size:19px;font-weight:600;color:#2d3748;line-height:1.4;">
                      ${taskSummary}
                    </h3>
                    <div style="margin-bottom:20px;">
                      <span style="display:inline-block;padding:6px 14px;background:${badge.bg};color:${badge.color};border-radius:20px;font-size:13px;font-weight:600;margin-right:12px;">
                        ${badge.text}
                      </span>
                      <span style="display:inline-block;padding:6px 14px;background:#e6fffa;color:#234e52;border-radius:20px;font-size:13px;font-weight:600;">
                        ${status}
                      </span>
                    </div>
                    <div style="margin-bottom:24px;font-size:15px;color:#4a5568;line-height:1.6;">
                      Due Date: <strong>${dueDate}</strong><br>
                      Assigned by: <strong>${createdBy}</strong>
                    </div>
                    <a href="https://intute.biz/activities/${taskId}"
                       style="display:inline-block;padding:14px 28px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:600;box-shadow:0 4px 14px rgba(102,126,234,0.4);">
                      View & Start Task →
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Motivational / CTA -->
          <tr>
            <td style="padding:40px;background:linear-gradient(to right,#f0f7ff,#f0f4ff);border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;text-align:center;">
              <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#4a5568;font-weight:500;">
                You're all set! Take a look and get started whenever you're ready.
              </p>
              <a href="https://intute.biz/"
                 style="display:inline-block;padding:14px 32px;background:#ffffff;color:#667eea;text-decoration:none;border-radius:8px;font-size:15px;font-weight:600;border:2px solid #667eea;">
                Open Dashboard
              </a>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:40px;text-align:center;">
              <p style="margin:0 0 20px;font-size:14px;color:#718096;line-height:1.6;">
                Stay organized, stay productive.<br>
                Your success is our mission.
              </p>
            </td>
          </tr>

          <!-- Legal -->
          <tr>
            <td style="padding:24px 40px;text-align:center;background:#f7fafc;border-top:1px solid #e2e8f0;">
              <p style="margin:0 0 8px;font-size:12px;color:#a0aec0;line-height:1.5;">
                © 2026 Intute.ai. All rights reserved.
              </p>
              <p style="margin:0;font-size:11px;color:#cbd5e0;line-height:1.5;">
                This is an automated notification from your Intute ERP system.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
}

/**
 * HTML template for MORNING ATTENDANCE CHECK-IN SUMMARY
 */
function generateAttendanceCheckInSummaryHtml({ managerName, date, checkIns, totalCheckedIn }) {
  const checkInRows = totalCheckedIn === 0
    ? '<tr><td colspan="3" style="padding:20px;text-align:center;color:#718096;font-size:15px;">No check-ins recorded yet.</td></tr>'
    : checkIns.map(employee => `
        <tr>
          <td style="padding:16px 20px;border-bottom:1px solid #e2e8f0;font-size:15px;font-weight:600;color:#2d3748;">
            ${employee.name}
          </td>
          <td style="padding:16px 20px;border-bottom:1px solid #e2e8f0;font-size:14px;color:#4a5568;text-align:center;">
            ${employee.employeeId}
          </td>
          <td style="padding:16px 20px;border-bottom:1px solid #e2e8f0;font-size:14px;color:#4a5568;text-align:center;">
            ${employee.checkInTime}
          </td>
        </tr>
      `).join('');

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Attendance Check-In Summary - ${date}</title>
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;background:#f0f4f8;color:#1a202c;">
  <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background:#f0f4f8;padding:40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="640" border="0" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,0.1);">
          
          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#10b981 0%,#059669 50%,#047857 100%);padding:40px 40px 60px 40px;">
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td style="width:40%;vertical-align:top;">
                    <img src="https://www.intute.in/assets/intuteLogo-CcO7TiMq.png" 
                         alt="Intute.ai" 
                         style="width:180px;height:auto;display:block;margin-top:8px;" />
                  </td>
                  <td style="width:60%;text-align:center;vertical-align:middle;">
                    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;">
                      <div style="width:100px;height:100px;background:rgba(255,255,255,0.25);border-radius:50%;display:flex;align-items:center;justify-content:center;margin-bottom:20px;box-shadow:0 6px 16px rgba(0,0,0,0.2);">
                        <span style="font-size:60px;line-height:1;color:white;">📍</span>
                      </div>
                      <h1 style="margin:0 0 8px;color:#ffffff;font-size:32px;font-weight:700;letter-spacing:-0.5px;">
                        Check-Ins Summary
                      </h1>
                      <p style="margin:0;color:rgba(255,255,255,0.95);font-size:18px;font-weight:500;">
                        ${date}
                      </p>
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Greeting -->
          <tr>
            <td style="padding:48px 40px 24px;">
              <h2 style="margin:0 0 16px;font-size:26px;font-weight:700;color:#1a202c;">
                Hi ${managerName} 👋
              </h2>
              <p style="margin:0 0 16px;font-size:17px;line-height:1.7;color:#4a5568;">
                Here's today's check-in report.
              </p>
            </td>
          </tr>

          <!-- Summary Stats -->
          <tr>
            <td style="padding:0 40px 32px;">
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td style="background:linear-gradient(135deg,#d1fae5 0%,#a7f3d0 100%);border-radius:12px;padding:24px;text-align:center;">
                    <div style="font-size:42px;font-weight:700;color:#065f46;margin-bottom:8px;">
                      ${totalCheckedIn}
                    </div>
                    <div style="font-size:15px;font-weight:600;color:#047857;text-transform:uppercase;letter-spacing:0.5px;">
                      Employees Checked In
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Check-Ins Table -->
          <tr>
            <td style="padding:0 40px 40px;">
              <h3 style="margin:0 0 20px;font-size:22px;font-weight:700;color:#065f46;">
                ✅ Checked In Today
              </h3>
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background:#f7fafc;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
                <thead>
                  <tr style="background:#10b981;">
                    <th style="padding:16px 20px;text-align:left;font-size:13px;font-weight:700;color:#ffffff;text-transform:uppercase;letter-spacing:0.5px;">
                      Name
                    </th>
                    <th style="padding:16px 20px;text-align:center;font-size:13px;font-weight:700;color:#ffffff;text-transform:uppercase;letter-spacing:0.5px;">
                      Employee ID
                    </th>
                    <th style="padding:16px 20px;text-align:center;font-size:13px;font-weight:700;color:#ffffff;text-transform:uppercase;letter-spacing:0.5px;">
                      Check-In Time
                    </th>
                  </tr>
                </thead>
                <tbody>
                  ${checkInRows}
                </tbody>
              </table>
            </td>
          </tr>

          <!-- CTA -->
          <tr>
            <td style="padding:40px;background:linear-gradient(to right,#f0f7ff,#f0f4ff);border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;text-align:center;">
              <a href="https://intute.biz/attendance" 
                 style="display:inline-block;padding:14px 32px;background:#10b981;color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:600;box-shadow:0 4px 14px rgba(16,185,129,0.3);">
                View Full Attendance → 
              </a>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:40px;text-align:center;">
              <p style="margin:0 0 20px;font-size:14px;color:#718096;line-height:1.6;">
                Track your team's attendance in real-time.<br>
                Your success is our mission.
              </p>
            </td>
          </tr>

          <!-- Legal -->
          <tr>
            <td style="padding:24px 40px;text-align:center;background:#f7fafc;border-top:1px solid #e2e8f0;">
              <p style="margin:0 0 8px;font-size:12px;color:#a0aec0;line-height:1.5;">
                © 2026 Intute.ai. All rights reserved.
              </p>
              <p style="margin:0;font-size:11px;color:#cbd5e0;line-height:1.5;">
                This is an automated morning summary from your Intute ERP system.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
}

/**
 * HTML template for EVENING ATTENDANCE CHECK-OUT SUMMARY
 */
function generateAttendanceCheckOutSummaryHtml({ managerName, date, checkedOut, stillActive, totalCheckedOut, totalStillActive }) {
  const checkedOutRows = totalCheckedOut === 0
    ? '<tr><td colspan="5" style="padding:20px;text-align:center;color:#718096;font-size:15px;">No check-outs recorded yet.</td></tr>'
    : checkedOut.map(employee => `
        <tr>
          <td style="padding:16px 20px;border-bottom:1px solid #e2e8f0;font-size:15px;font-weight:600;color:#2d3748;">
            ${employee.name}
          </td>
          <td style="padding:16px 20px;border-bottom:1px solid #e2e8f0;font-size:14px;color:#4a5568;text-align:center;">
            ${employee.employeeId}
          </td>
          <td style="padding:16px 20px;border-bottom:1px solid #e2e8f0;font-size:14px;color:#4a5568;text-align:center;">
            ${employee.checkInTime}
          </td>
          <td style="padding:16px 20px;border-bottom:1px solid #e2e8f0;font-size:14px;color:#4a5568;text-align:center;">
            ${employee.checkOutTime}
          </td>
          <td style="padding:16px 20px;border-bottom:1px solid #e2e8f0;font-size:14px;color:#047857;font-weight:600;text-align:center;">
            ${employee.hoursWorked}
          </td>
        </tr>
      `).join('');

  const stillActiveRows = totalStillActive === 0
    ? '<tr><td colspan="3" style="padding:20px;text-align:center;color:#718096;font-size:15px;">All employees have checked out.</td></tr>'
    : stillActive.map(employee => `
        <tr>
          <td style="padding:16px 20px;border-bottom:1px solid #fde68a;font-size:15px;font-weight:600;color:#92400e;">
            ${employee.name}
          </td>
          <td style="padding:16px 20px;border-bottom:1px solid #fde68a;font-size:14px;color:#78350f;text-align:center;">
            ${employee.employeeId}
          </td>
          <td style="padding:16px 20px;border-bottom:1px solid #fde68a;font-size:14px;color:#78350f;text-align:center;">
            ${employee.checkInTime}
          </td>
        </tr>
      `).join('');

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Attendance Check-Out Summary - ${date}</title>
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;background:#f0f4f8;color:#1a202c;">
  <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background:#f0f4f8;padding:40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="640" border="0" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,0.1);">
          
          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#3b82f6 0%,#2563eb 50%,#1d4ed8 100%);padding:40px 40px 60px 40px;">
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td style="width:40%;vertical-align:top;">
                    <img src="https://www.intute.in/assets/intuteLogo-CcO7TiMq.png" 
                         alt="Intute.ai" 
                         style="width:180px;height:auto;display:block;margin-top:8px;" />
                  </td>
                  <td style="width:60%;text-align:center;vertical-align:middle;">
                    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;">
                      <div style="width:100px;height:100px;background:rgba(255,255,255,0.25);border-radius:50%;display:flex;align-items:center;justify-content:center;margin-bottom:20px;box-shadow:0 6px 16px rgba(0,0,0,0.2);">
                        <span style="font-size:60px;line-height:1;color:white;">🏁</span>
                      </div>
                      <h1 style="margin:0 0 8px;color:#ffffff;font-size:32px;font-weight:700;letter-spacing:-0.5px;">
                        Check-Outs Summary
                      </h1>
                      <p style="margin:0;color:rgba(255,255,255,0.95);font-size:18px;font-weight:500;">
                        ${date}
                      </p>
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Greeting -->
          <tr>
            <td style="padding:48px 40px 24px;">
              <h2 style="margin:0 0 16px;font-size:26px;font-weight:700;color:#1a202c;">
                Hi ${managerName} 👋
              </h2>
              <p style="margin:0 0 16px;font-size:17px;line-height:1.7;color:#4a5568;">
                Here's today's check-out report.
              </p>
            </td>
          </tr>

          <!-- Summary Stats -->
          <tr>
            <td style="padding:0 40px 32px;">
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td style="width:48%;padding-right:2%;">
                    <div style="background:linear-gradient(135deg,#dbeafe 0%,#bfdbfe 100%);border-radius:12px;padding:24px;text-align:center;">
                      <div style="font-size:42px;font-weight:700;color:#1e40af;margin-bottom:8px;">
                        ${totalCheckedOut}
                      </div>
                      <div style="font-size:13px;font-weight:600;color:#1e3a8a;text-transform:uppercase;letter-spacing:0.5px;">
                        Checked Out
                      </div>
                    </div>
                  </td>
                  <td style="width:48%;padding-left:2%;">
                    <div style="background:linear-gradient(135deg,#fef3c7 0%,#fde68a 100%);border-radius:12px;padding:24px;text-align:center;">
                      <div style="font-size:42px;font-weight:700;color:#92400e;margin-bottom:8px;">
                        ${totalStillActive}
                      </div>
                      <div style="font-size:13px;font-weight:600;color:#78350f;text-transform:uppercase;letter-spacing:0.5px;">
                        Still Active
                      </div>
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Checked Out Table -->
          <tr>
            <td style="padding:0 40px 32px;">
              <h3 style="margin:0 0 20px;font-size:22px;font-weight:700;color:#1e40af;">
                ✅ Checked Out Today
              </h3>
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background:#f7fafc;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
                <thead>
                  <tr style="background:#3b82f6;">
                    <th style="padding:16px 20px;text-align:left;font-size:12px;font-weight:700;color:#ffffff;text-transform:uppercase;letter-spacing:0.5px;">
                      Name
                    </th>
                    <th style="padding:16px 20px;text-align:center;font-size:12px;font-weight:700;color:#ffffff;text-transform:uppercase;letter-spacing:0.5px;">
                      Emp ID
                    </th>
                    <th style="padding:16px 20px;text-align:center;font-size:12px;font-weight:700;color:#ffffff;text-transform:uppercase;letter-spacing:0.5px;">
                      Check-In
                    </th>
                    <th style="padding:16px 20px;text-align:center;font-size:12px;font-weight:700;color:#ffffff;text-transform:uppercase;letter-spacing:0.5px;">
                      Check-Out
                    </th>
                    <th style="padding:16px 20px;text-align:center;font-size:12px;font-weight:700;color:#ffffff;text-transform:uppercase;letter-spacing:0.5px;">
                      Hours
                    </th>
                  </tr>
                </thead>
                <tbody>
                  ${checkedOutRows}
                </tbody>
              </table>
            </td>
          </tr>

          <!-- Still Active Table -->
          <tr>
            <td style="padding:0 40px 40px;">
              <h3 style="margin:0 0 20px;font-size:22px;font-weight:700;color:#92400e;">
                ⏳ Still Active
              </h3>
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background:#fef3c7;border:1px solid #fde68a;border-radius:12px;overflow:hidden;">
                <thead>
                  <tr style="background:#f59e0b;">
                    <th style="padding:16px 20px;text-align:left;font-size:13px;font-weight:700;color:#ffffff;text-transform:uppercase;letter-spacing:0.5px;">
                      Name
                    </th>
                    <th style="padding:16px 20px;text-align:center;font-size:13px;font-weight:700;color:#ffffff;text-transform:uppercase;letter-spacing:0.5px;">
                      Employee ID
                    </th>
                    <th style="padding:16px 20px;text-align:center;font-size:13px;font-weight:700;color:#ffffff;text-transform:uppercase;letter-spacing:0.5px;">
                      Check-In Time
                    </th>
                  </tr>
                </thead>
                <tbody>
                  ${stillActiveRows}
                </tbody>
              </table>
            </td>
          </tr>

          <!-- CTA -->
          <tr>
            <td style="padding:40px;background:linear-gradient(to right,#f0f7ff,#f0f4ff);border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;text-align:center;">
              <a href="https://intute.biz/attendance" 
                 style="display:inline-block;padding:14px 32px;background:#3b82f6;color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:600;box-shadow:0 4px 14px rgba(59,130,246,0.3);">
                View Full Attendance → 
              </a>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:40px;text-align:center;">
              <p style="margin:0 0 20px;font-size:14px;color:#718096;line-height:1.6;">
                Track your team's attendance in real-time.<br>
                Your success is our mission.
              </p>
            </td>
          </tr>

          <!-- Legal -->
          <tr>
            <td style="padding:24px 40px;text-align:center;background:#f7fafc;border-top:1px solid #e2e8f0;">
              <p style="margin:0 0 8px;font-size:12px;color:#a0aec0;line-height:1.5;">
                © 2026 Intute.ai. All rights reserved.
              </p>
              <p style="margin:0;font-size:11px;color:#cbd5e0;line-height:1.5;">
                This is an automated evening summary from your Intute ERP system.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
}

module.exports = {
  generateDueTomorrowReminderHtml,
  generateDailyTaskSummaryHtml,
  generateNewTaskAssignmentHtml,
  generateAttendanceCheckInSummaryHtml,
  generateAttendanceCheckOutSummaryHtml
};