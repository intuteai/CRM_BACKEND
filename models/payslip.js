// models/payslip.js
const PDFDocument = require('pdfkit');
const path = require('path');
const converter = require('number-to-words');
const logger = require('../utils/logger');

class Payslip {
  static #toNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  static #safeEmit(io, event, payload) {
    if (!io || typeof io.emit !== 'function') return;
    try { io.emit(event, payload); } catch (err) {
      logger.warn('Socket emit failed:', err.message);
    }
  }

  static generate(data, io) {
    if (!data?.employee?.name || !data?.period) {
      throw new Error('Employee name and pay period are required');
    }

    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    const stream = doc;

    const greenBg = '#ecfdf5';
    const greenText = '#065f46';
    const lightGray = '#f3f4f6';

    try {
      // === LOGO ===
      const logoPath = path.join(__dirname, '../assets/image.png');
      try {
        doc.image(logoPath, 40, 20, { width: 70 });
      } catch (err) {
        logger.warn('Logo not found, skipping...');
      }

      // === HEADER ===
      doc.fontSize(14).font('Helvetica-Bold')
         .text('Intute AI Technologies (OPC) Pvt. Ltd.', 120, 28);
      doc.fontSize(10).font('Helvetica')
         .text('A-5, Sector 68 Noida, 201301 India', 120, 45);
      doc.fontSize(12).font('Helvetica-Bold')
         .text('Payslip For the Month', 400, 28, { align: 'right' });
      doc.fontSize(14)
         .text(data.period, 400, 48, { align: 'right' });

      // === EMPLOYEE SUMMARY BOX ===
      doc.rect(40, 80, 520, 90).lineWidth(1).stroke();
      let y = 95;
      const leftX = 50;

      doc.fontSize(11).font('Helvetica-Bold').text('EMPLOYEE SUMMARY', leftX, y);
      y += 20;

      // === FIXED: No chaining ===
      doc.font('Helvetica')
         .text(`Employee Name : ${data.employee.name}`, leftX, y);
      y += 18;
      doc.text(`Employee ID   : ${data.employee.id || ''}`, leftX, y);
      y += 18;
      doc.text(`Pay Period     : ${data.period}`, leftX, y);
      y += 18;
      doc.text(`Pay Date       : ${data.payDate || ''}`, leftX, y);

      // === GREEN NET PAY BOX ===
      doc.fillColor(greenBg).roundedRect(440, 100, 120, 60, 8).fill();
      doc.fillColor(greenText).fontSize(16).font('Helvetica-Bold')
         .text(`Rs. ${this.#toNumber(data.netPay).toFixed(2)}`, 455, 115);
      doc.fontSize(10).text('Total Net Pay', 455, 135);

      // === PAID / LOP DAYS ===
      doc.roundedRect(440, 170, 120, 40, 8).lineWidth(1).stroke();
      doc.fillColor('#000000').fontSize(10)
         .text(`Paid Days : ${data.paidDays || 0}`, 450, 180);
      doc.text(`LOP Days  : ${data.lopDays || 0}`, 450, 195);

      // === EARNINGS & DEDUCTIONS TABLE ===
      y = 230;
      const col1 = 40, col2 = 200, col3 = 300, col4 = 460;

      doc.font('Helvetica-Bold').fontSize(11)
         .text('EARNINGS', col1, y)
         .text('AMOUNT', col2, y)
         .text('DEDUCTIONS', col3, y)
         .text('AMOUNT', col4, y);

      y += 15;
      doc.moveTo(col1, y).lineTo(560, y).dash(2, { space: 2 }).stroke();
      y += 10;

      const earnings = Array.isArray(data.earnings) ? data.earnings : [];
      const deductions = Array.isArray(data.deductions) ? data.deductions : [];
      const maxRows = Math.max(earnings.length, deductions.length);
      let gross = 0, totalDed = 0;

      for (let i = 0; i < maxRows; i++) {
        const e = earnings[i];
        const d = deductions[i];

        if (e) {
          const amt = this.#toNumber(e.amount);
          gross += amt;
          doc.font('Helvetica')
             .text(e.label || '', col1, y)
             .text(`Rs. ${amt.toFixed(2)}`, col2, y);
        }
        if (d) {
          const amt = this.#toNumber(d.amount);
          totalDed += amt;
          doc.text(d.label || '', col3, y)
             .text(`Rs. ${amt.toFixed(2)}`, col4, y);
        }
        y += 18;
      }

      y += 10;
      doc.moveTo(col1, y).lineTo(560, y).dash(2, { space: 2 }).stroke();
      y += 15;

      doc.font('Helvetica-Bold')
         .text('Gross Earnings', col1, y)
         .text(`Rs. ${gross.toFixed(2)}`, col2, y)
         .text('Total Deductions', col3, y)
         .text(`Rs. ${totalDed.toFixed(2)}`, col4, y);

      // === TOTAL NET PAYABLE BAR ===
      y += 40;
      doc.fillColor(lightGray).rect(40, y, 520, 40).fill();
      doc.fillColor('#000000').fontSize(12).font('Helvetica-Bold')
         .text('TOTAL NET PAYABLE', 50, y + 12);
      doc.fontSize(10)
         .text('Gross Earnings - Total Deductions', 50, y + 28);
      doc.fontSize(12)
         .text(`Rs. ${this.#toNumber(data.netPay).toFixed(2)}`, 450, y + 20, { align: 'right' });

      // === AMOUNT IN WORDS ===
      y += 70;
      const net = Math.round(this.#toNumber(data.netPay));
      const words = net > 0 ? converter.toWords(net) : 'zero';
      const capitalized = words.charAt(0).toUpperCase() + words.slice(1);
      doc.fontSize(10).font('Helvetica-Oblique')
         .text(`Amount in Words : Indian Rupee ${capitalized} Only`, 40, y, { align: 'center', width: 520 });

      // === EMIT EVENT ===
      const payload = {
        filename: `PAYSLIP_${data.employee.name.replace(/\s+/g, '_').toUpperCase()}_${data.period.replace(/\s+/g, '_')}.pdf`,
        generated_at: new Date().toISOString(),
        generated_by: io?.user?.user_id || null,
      };
      this.#safeEmit(io, 'payslip:generated', payload);

      doc.end();
      return stream;

    } catch (err) {
      logger.error('Payslip PDF generation failed:', err);
      throw new Error('Failed to generate PDF');
    }
  }
}

module.exports = Payslip;