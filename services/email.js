const nodemailer = require('nodemailer');
require('dotenv').config();
const logger = require('../utils/logger');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

transporter.verify((error) => {
  if (error) {
    logger.error('Email transporter verification failed: ' + error.message);
  } else {
    logger.info('Email transporter ready and verified');
  }
});

const sendEmail = async ({ to, subject, text = '', html = '' }) => {
  if (!to || typeof to !== 'string' || !to.trim()) {
    logger.error('sendEmail: invalid or missing recipient', { to });
    return false;
  }

  if (!subject || typeof subject !== 'string' || !subject.trim()) {
    logger.error('sendEmail: missing or invalid subject');
    return false;
  }

  if (!text && !html) {
    logger.error('sendEmail: no content (text or html) provided');
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

    logger.info(`Email sent to ${recipient} | Message-ID: ${info.messageId}`);
    return true;
  } catch (err) {
    logger.error(`Email failed to ${recipient}: ${err.message}`);
    return false;
  }
};

module.exports = { sendEmail };
