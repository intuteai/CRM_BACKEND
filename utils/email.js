// utils/email.js
const nodemailer = require('nodemailer');
require('dotenv').config();

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,   // Must be App Password (16 chars, no spaces)
  },
  // Uncomment if you have certificate/TLS issues (rare)
  // tls: { rejectUnauthorized: false },
});

// Verify transporter once on startup (helpful for debugging)
transporter.verify((error, success) => {
  if (error) {
    console.error('[EMAIL] Transporter verification failed:', error.message);
  } else {
    console.log('[EMAIL] Transporter ready and verified');
  }
});

const sendEmail = async ({ to, subject, text = '', html = '' }) => {
  // Strong validation to prevent "No recipients defined"
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

  // Normalize input
  const recipient = to.trim();
  const finalText = text.trim();
  const finalHtml = html.trim() || finalText; // fallback to text if no html

  console.log(`[EMAIL] Preparing to send to: ${recipient}`);
  console.log(`[EMAIL] Subject: ${subject}`);
  console.log(`[EMAIL] Text length: ${finalText.length}, HTML length: ${finalHtml.length}`);

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
    console.error('[EMAIL FAILED] to:', recipient);
    console.error('Error details:', err.message);
    if (err.response) {
      console.error('SMTP response:', err.response);
    }
    return false;
  }
};

module.exports = { sendEmail };