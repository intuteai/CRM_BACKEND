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

module.exports = {
  generateDueTomorrowReminderHtml,
  generateNewTaskAssignmentHtml
};