const nodemailer = require('nodemailer');
require('dotenv').config();

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

transporter.verify((error, success) => {
  if (error) {
    console.error('[EMAIL] Transporter verification failed:', error.message);
  } else {
    console.log('[EMAIL] Transporter ready and verified');
  }
});

const sendEmail = async ({ to, subject, text = '', html = '' }) => {
  if (!to) {
    console.error('[EMAIL ERROR] No recipient (to) provided');
    return false;
  }

  if (typeof to !== 'string' || !to.trim()) {
    console.error('[EMAIL ERROR] Invalid recipient:', to);
    return false;
  }

  if (!subject || typeof subject !== 'string' || !subject.trim()) {
    console.error('[EMAIL ERROR] Missing or invalid subject');
    return false;
  }

  if (!text && !html) {
    console.error('[EMAIL ERROR] No content (text or html) provided');
    return false;
  }

  const recipient = to.trim();
  const finalText = text.trim();
  const finalHtml = html.trim() || finalText;

  try {
    const info = await transporter.sendMail({
      from: `"Task Manager" <${process.env.EMAIL_USER}>`,
      to: recipient,
      subject,
      text: finalText,
      html: finalHtml,
    });

    console.log(`[EMAIL SUCCESS] Sent to: ${recipient} | Message ID: ${info.messageId}`);
    return true;
  } catch (err) {
    console.error('[EMAIL FAILED] to:', recipient, err.message);
    return false;
  }
};

module.exports = { sendEmail };
