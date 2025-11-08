// models/payslip.js
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const converter = require('number-to-words');
const logger = require('../utils/logger');
const svgToPDF = require('svg-to-pdfkit');

/* ===========================
   Helpers
   =========================== */
function withFont(doc, fontName, fontSize, fn) {
  doc.save();
  if (fontName) doc.font(fontName);
  if (fontSize) doc.fontSize(fontSize);
  const res = fn();
  doc.restore();
  return res;
}
function measureHeight(doc, text, width, fontName, fontSize, lineGap = 2) {
  const s = String(text ?? '');
  return withFont(doc, fontName, fontSize, () =>
    doc.heightOfString(s, { width, lineGap })
  );
}
function needPageBreak(doc, y, neededHeight, marginBottom = 40) {
  const bottom = doc.page.height - marginBottom;
  return y + neededHeight > bottom;
}
function truncateToWidth(doc, txt, maxWidth, fontName, fontSize) {
  let s = String(txt ?? '');
  return withFont(doc, fontName, fontSize, () => {
    while (s.length > 1 && doc.widthOfString(s) > maxWidth) s = s.slice(0, -1);
    return s;
  });
}

/* ===========================
   Fonts
   =========================== */
const FONT_DIR = path.join(__dirname, '../assets/fonts');
function registerFonts(doc) {
  const reg = (name, file) => {
    const p = path.join(FONT_DIR, file);
    if (fs.existsSync(p)) {
      try { doc.registerFont(name, p); return true; }
      catch (e) { logger.warn(`Failed to register font ${name}: ${e.message}`); return false; }
    } else { logger.warn(`Font file missing: ${file}`); return false; }
  };
  const hasRegular = reg('Roboto', 'Roboto-Regular.ttf');
  const hasBold    = reg('Roboto-Bold', 'Roboto-Bold.ttf');
  const hasMedium  = reg('Roboto-Medium', 'Roboto-Medium.ttf');

  doc.font('Roboto',        hasRegular ? 'Roboto'        : 'Helvetica');
  doc.font('Roboto-Bold',   hasBold    ? 'Roboto-Bold'   : 'Helvetica-Bold');
  doc.font('Roboto-Medium', hasMedium  ? 'Roboto-Medium' : 'Helvetica');
}

/* ===========================
   Section drawers
   =========================== */
function drawSectionHeader(doc, x, y, width, title, colors) {
  const h = 28;                                   // reduced a bit
  const grad = doc.linearGradient(x, y, x, y + h);
  grad.stop(0, colors.primary).stop(1, colors.secondary);
  doc.roundedRect(x, y, width, h, 6).fill(grad);
  withFont(doc, 'Roboto-Bold', 11, () => {
    doc.fillColor(colors.white).text(title, x + 12, y + 7);
  });
  return h;
}
function drawTableRow(doc, x, y, width, col1W, label, amount, colors, opts = {}) {
  const labelFont = opts.labelFont || 'Roboto';
  const labelSize = opts.labelSize || 10;
  const amountFont = opts.amountFont || 'Roboto-Medium';
  const amountSize = opts.amountSize || 10;
  const lineGap = opts.lineGap ?? 1.2;
  const paddingX = 10;
  const paddingY = 5;                             // reduced

  const labelW = col1W - paddingX * 2;
  const amountBoxW = 110;

  const labelH = measureHeight(doc, label || '', labelW, labelFont, labelSize, lineGap);
  const amountText = amount != null && Number.isFinite(Number(amount)) ? Number(amount).toFixed(2) : '';
  const amountH = measureHeight(doc, amountText, amountBoxW, amountFont, amountSize, lineGap);
  const contentH = Math.max(labelH, amountH);
  const rowH = Math.max(22, Math.ceil(contentH) + paddingY * 2);

  doc.save();
  doc.fillColor(colors.light).opacity(0.5);
  doc.rect(x, y, width, rowH).fill();
  doc.restore();

  withFont(doc, labelFont, labelSize, () => {
    doc.fillColor(colors.text).text(String(label || ''), x + paddingX, y + paddingY, { width: labelW, lineGap });
  });

  withFont(doc, amountFont, amountSize, () => {
    const rightEdge = x + width - paddingX;
    const w = doc.widthOfString(amountText);
    doc.fillColor(colors.text).text(amountText, rightEdge - w, y + paddingY, { lineBreak: false });
  });

  doc.save();
  doc.moveTo(x, y + rowH).lineTo(x + width, y + rowH)
     .strokeColor(colors.borderLight).lineWidth(1).stroke();
  doc.restore();

  return rowH;
}

/* ===========================
   Payslip
   =========================== */
class Payslip {
  static #toNumber(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
  static #safeEmit(io, event, payload) { if (!io?.emit) return; try { io.emit(event, payload); } catch(e) { logger.warn('Socket emit failed:', e.message); } }

  static generate(data, io) {
    if (!data?.employee?.name || !data?.period) {
      throw new Error('Employee name and pay period are required');
    }

    const doc = new PDFDocument({ margin: 0, size: 'A4' });
    const stream = doc;
    registerFonts(doc);

    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;
    const margin = 40;
    const marginBottom = 40;
    const contentWidth = pageWidth - 2 * margin;

    const c = {
      primary: '#0f172a',
      secondary: '#1e40af',
      accent: '#0891b2',
      success: '#059669',
      warning: '#d97706',
      light: '#f8fafc',
      lightBlue: '#eff6ff',
      border: '#cbd5e1',
      borderLight: '#e2e8f0',
      text: '#0f172a',
      textMuted: '#64748b',
      white: '#ffffff',
    };

    try {
      /* ===== Background & header band ===== */
      doc.rect(0, 0, pageWidth, pageHeight).fill(c.white);
      doc.rect(0, 0, pageWidth, 6).fill(c.secondary);
      const headerGrad = doc.linearGradient(0, 0, pageWidth, 96);
      headerGrad.stop(0, c.lightBlue).stop(1, c.white);
      doc.rect(0, 6, pageWidth, 90).fill(headerGrad);

      /* ===== Logo ===== */
      const logoPng = path.join(__dirname, '../assets/image.png');
      let logoExists = false;
      if (fs.existsSync(logoPng)) {
        const logoX = margin;
        const logoY = 12;
        const logoWidth = 100;
        const logoHeight = 100;
        doc.image(logoPng, logoX, logoY, { width: logoWidth, height: logoHeight });
        logoExists = true;
      } else {
        logger.warn('Logo file missing: assets/image.png');
      }

      /* ===== Company + PAYSLIP pill ===== */
      const companyX = logoExists ? margin + 110 : margin;
      const companyNameMaxW = Math.max(320, (pageWidth - margin) - (companyX + 180));
      const companyName = 'Intute AI Technologies (OPC) Pvt. Ltd.';
      const companyTitle = truncateToWidth(doc, companyName, companyNameMaxW, 'Roboto-Bold', 18);

      const companyTopY = 32;
      const companyAddrY = 54;

      const pillW = 140;
      const pillH = 36;
      const pillR = 18;
      let pillX = pageWidth - margin - pillW;
      let pillY = 32;

      const companyTextRight = companyX + withFont(doc, 'Roboto-Bold', 18, () => doc.widthOfString(companyTitle));
      if (pillX < companyTextRight + 16) pillY = 70;

      withFont(doc, 'Roboto-Bold', 18, () => {
        doc.fillColor(c.primary).text(companyTitle, companyX, companyTopY, { width: companyNameMaxW });
      });
      withFont(doc, 'Roboto', 9.5, () => {
        doc.fillColor(c.textMuted).text('A-5, Sector 68, Noida - 201301, India', companyX, companyAddrY);
      });

      doc.save();
      doc.fillColor(c.secondary);
      doc.roundedRect(pillX, pillY, pillW, pillH, pillR).fill();
      doc.restore();

      withFont(doc, 'Roboto-Bold', 13, () => {
        doc.fillColor(c.white).text('PAYSLIP', pillX, pillY + 9, { width: pillW, align: 'center' });
      });

      /* ===== Employee Card ===== */
      const empRows = [
        [ ['Employee Name', String(data.employee.name)], ['Employee ID', String(data.employee.id || 'N/A')] ],
        [ ['Pay Period', String(data.period)], ['Pay Date', String(data.payDate || new Date().toLocaleDateString('en-IN'))] ],
      ];
      const cardHeaderH = 28;
      const cardY = 120;

      const leftX = margin + 18;
      const rightX = margin + 290;
      const labelW = 110;
      const valWLeft = 150;
      const valWRight = 170;
      const rowsH = empRows.map(row => {
        const lh = measureHeight(doc, row[0][1], valWLeft, 'Roboto-Bold', 10, 1);
        const rh = measureHeight(doc, row[1][1], valWRight, 'Roboto-Bold', 10, 1);
        return Math.max(20, Math.ceil(Math.max(lh, rh)) + 6);
      }).reduce((a, b) => a + b, 0);
      const cardHeight = cardHeaderH + 6 + rowsH + 6;

      doc.save();
      doc.fillColor(c.primary).opacity(0.05);
      doc.roundedRect(margin + 2, cardY + 2, contentWidth, cardHeight, 8).fill();
      doc.restore();

      doc.roundedRect(margin, cardY, contentWidth, cardHeight, 8)
         .lineWidth(1).strokeColor(c.border).fillAndStroke(c.white);

      doc.rect(margin, cardY, contentWidth, cardHeaderH).fill(c.light);
      doc.save();
      doc.moveTo(margin, cardY + cardHeaderH).lineTo(margin + contentWidth, cardY + cardHeaderH)
         .strokeColor(c.borderLight).lineWidth(1).stroke();
      doc.restore();
      withFont(doc, 'Roboto-Bold', 12, () => {
        doc.fillColor(c.secondary).text('EMPLOYEE DETAILS', margin + 18, cardY + 7);
      });

      let y = cardY + cardHeaderH + 6;
      const drawKV = (row, yy) => {
        const lh = measureHeight(doc, row[0][1], valWLeft, 'Roboto-Bold', 10, 1);
        const rh = measureHeight(doc, row[1][1], valWRight, 'Roboto-Bold', 10, 1);
        const h = Math.max(20, Math.ceil(Math.max(lh, rh)) + 6);

        withFont(doc, 'Roboto-Medium', 10, () => {
          doc.fillColor(c.textMuted).text(`${row[0][0]}:`, leftX, yy);
          doc.fillColor(c.textMuted).text(`${row[1][0]}:`, rightX, yy);
        });
        withFont(doc, 'Roboto-Bold', 10, () => {
          doc.fillColor(c.text).text(row[0][1], leftX + labelW, yy, { width: valWLeft, lineGap: 1 });
          doc.fillColor(c.text).text(row[1][1], rightX + labelW, yy, { width: valWRight, lineGap: 1 });
        });
        return h;
      };
      empRows.forEach(r => { y += drawKV(r, y); });
      y += 12;   // reduced gap

      /* ===== EARNINGS ===== */
      y += drawSectionHeader(doc, margin, y, contentWidth, 'EARNINGS', c);

      const earnings = Array.isArray(data.earnings) ? data.earnings : [];
      const earningsLabelColW = contentWidth - 110;

      earnings.forEach(row => {
        const label = String(row?.label || '');
        const amount = Number.isFinite(Number(row?.amount)) ? Number(row.amount) : null;
        y += drawTableRow(doc, margin, y, contentWidth, earningsLabelColW, label, amount, c,
          { labelFont: 'Roboto', labelSize: 10, amountFont: 'Roboto-Medium', amountSize: 10, lineGap: 1.2 });
      });
      if (earnings.length === 0) y += drawTableRow(doc, margin, y, contentWidth, contentWidth - 110, '', null, c);
      y += 8;   // reduced

      /* ===== DEDUCTIONS ===== */
      y += drawSectionHeader(doc, margin, y, contentWidth, 'DEDUCTIONS', c);

      const deductions = Array.isArray(data.deductions) ? data.deductions : [];
      const deductionsLabelColW = contentWidth - 110;

      deductions.forEach(row => {
        const label = String(row?.label || '');
        const amount = Number.isFinite(Number(row?.amount)) ? Number(row.amount) : null;
        y += drawTableRow(doc, margin, y, contentWidth, deductionsLabelColW, label, amount, c,
          { labelFont: 'Roboto', labelSize: 10, amountFont: 'Roboto-Medium', amountSize: 10, lineGap: 1.2 });
      });
      if (deductions.length === 0) y += drawTableRow(doc, margin, y, contentWidth, contentWidth - 110, '', null, c);
      y += 8;

      /* ===== Totals ===== */
      const totalsBarH = 36;
      let gross = 0, totalDed = 0;
      earnings.forEach(e => { if (Number.isFinite(Number(e.amount))) gross += Number(e.amount); });
      deductions.forEach(d => { if (Number.isFinite(Number(d.amount))) totalDed += Number(d.amount); });

      doc.rect(margin, y, contentWidth, totalsBarH).fill(c.primary);
      withFont(doc, 'Roboto-Bold', 11, () => {
        doc.fillColor(c.white).text('GROSS EARNINGS', margin + 14, y + 11);
        const gStr = gross.toFixed(2);
        const gW = doc.widthOfString(gStr);
        doc.text(gStr, margin + contentWidth/2 - 14 - gW, y + 11, { lineBreak: false });

        doc.text('TOTAL DEDUCTIONS', margin + contentWidth/2 + 14, y + 11);
        const dStr = totalDed.toFixed(2);
        const dW = doc.widthOfString(dStr);
        doc.text(dStr, margin + contentWidth - 14 - dW, y + 11, { lineBreak: false });
      });
      doc.save();
      doc.strokeColor('#ffffff').opacity(0.25).lineWidth(1);
      doc.moveTo(margin + contentWidth/2, y).lineTo(margin + contentWidth/2, y + totalsBarH).stroke();
      doc.restore();
      y += totalsBarH + 12;

      /* ===== NET PAY CARD ===== */
      {
        const cardPadX = 18;
        const cardPadTop = 12;
        const cardPadBottom = 12;
        const headerPillH = 24, headerPillR = 12, headerPillW = 120, headerPillPadX = 10;

        const labelSize = 11;
        const amountSize = 20;
        const subSize = 9;
        const lineGap = 1.1;

        const netPay = Math.max(0, gross - totalDed);
        const amountStr = `₹ ${netPay.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        const subtext = 'Net of all earnings and deductions';

        const contentW = contentWidth - cardPadX * 2;
        const amountH = measureHeight(doc, amountStr, contentW, 'Roboto-Bold', amountSize, lineGap);
        const subH    = measureHeight(doc, subtext, contentW, 'Roboto', subSize, 1.0);

        const gapAfterPill = 6;
        const gapAfterAmount = 4;

        const netBlockH = cardPadTop + headerPillH + gapAfterPill
                        + Math.ceil(amountH) + gapAfterAmount
                        + Math.ceil(subH) + cardPadBottom;

        doc.save();
        doc.fillColor(c.primary).opacity(0.05);
        doc.roundedRect(margin + 2, y + 2, contentWidth, netBlockH, 10).fill();
        doc.restore();

        doc.save();
        doc.roundedRect(margin, y, contentWidth, netBlockH, 10).fill(c.white);
        doc.lineWidth(1).strokeColor(c.borderLight).stroke();
        doc.restore();

        const pillX = margin + cardPadX;
        const pillY = y + cardPadTop;
        doc.save();
        doc.fillColor('#e6fffb');
        doc.roundedRect(pillX, pillY, headerPillW, headerPillH, headerPillR).fill();
        doc.restore();

        const tokenR = 8;
        const tokenCX = pillX + headerPillPadX + tokenR;
        const tokenCY = pillY + headerPillH / 2;
        doc.save();
        doc.fillColor('#a7f3d0');
        doc.circle(tokenCX, tokenCY, tokenR).fill();
        doc.restore();

        withFont(doc, 'Roboto-Bold', labelSize, () => {
          const rupeeW = doc.widthOfString('₹');
          const rupeeX = tokenCX - rupeeW / 2;
          const rupeeY = tokenCY - labelSize * 0.7 / 2;
          doc.fillColor(c.primary).text('₹', rupeeX, rupeeY, { lineBreak: false });
        });

        const labelX = pillX + headerPillPadX + tokenR * 2 + 6;
        withFont(doc, 'Roboto-Bold', labelSize, () => {
          const labelY = tokenCY - labelSize * 0.7 / 2;
          doc.fillColor(c.accent).text('NET PAY', labelX, labelY, { lineBreak: false });
        });

        const amtX = margin + cardPadX;
        const amtY = pillY + headerPillH + gapAfterPill;
        withFont(doc, 'Roboto-Bold', amountSize, () => {
          doc.fillColor(c.primary).text(amountStr, amtX, amtY, { width: contentW, lineGap, ellipsis: false });
        });

        const subY = amtY + Math.ceil(amountH) + gapAfterAmount;
        withFont(doc, 'Roboto', subSize, () => {
          doc.fillColor(c.textMuted).text(subtext, amtX, subY, { width: contentW, lineGap: 1.0 });
        });

        y += netBlockH + 12;
      }

      /* ===== Amount in words ===== */
      const netPayRounded = Math.round(Math.max(0, gross - totalDed));
      const words = netPayRounded > 0 ? converter.toWords(netPayRounded) : 'zero';
      const inWords = `Rupees ${words.charAt(0).toUpperCase() + words.slice(1)} Only`;

      const wordsBoxH = 44;
      doc.save();
      doc.lineWidth(1.1).strokeColor(c.accent).fill('#ecfeff');
      doc.roundedRect(margin, y, contentWidth, wordsBoxH, 7).fillAndStroke();
      doc.restore();

      withFont(doc, 'Roboto-Bold', 10, () => {
        doc.fillColor(c.accent).text('AMOUNT IN WORDS', margin + 14, y + 9);
      });
      withFont(doc, 'Roboto-Medium', 10, () => {
        doc.fillColor(c.text).text(inWords, margin + 14, y + 24, { width: contentWidth - 28, align: 'center' });
      });
      y += wordsBoxH + 8;

      /* ===== FINAL STAMP + FOOTER (single-page guarantee) ===== */
      const stampPath = path.join(__dirname, '../assets/stamp.png');
      const stampExists = fs.existsSync(stampPath);
      const stampH = stampExists ? 85 : 0;
      const stampGap = stampExists ? 20 : 20;
      const footerH = 45;   // line + text + bottom bar

      const totalBottom = stampH + stampGap + footerH + 20; // extra safety

      // If we are too close to the bottom, pull everything up a little
      if (needPageBreak(doc, y, totalBottom, marginBottom)) {
        const pullUp = (y + totalBottom) - (pageHeight - marginBottom);
        y -= pullUp;   // move previous content up
      }

      // Stamp
      if (stampExists) {
        const stampW = 150;
        const stampX = (pageWidth - stampW) / 2;
        doc.image(stampPath, stampX, y, { width: stampW, height: stampH });
        y += stampH + stampGap;
      } else {
        logger.warn('Stamp file missing: assets/stamp.png');
        y += stampGap;
      }

      // Footer line
      doc.save();
      doc.moveTo(margin, y).lineTo(pageWidth - margin, y)
         .strokeColor(c.borderLight).lineWidth(1).stroke();
      doc.restore();

      y += 12;
      const now = new Date().toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' });
      withFont(doc, 'Roboto', 8, () => {
        doc.fillColor(c.textMuted).text(`Generated on ${now}`, 0, y, { align: 'center', width: pageWidth });
      });

      // Bottom coloured bar (always on the same page)
      doc.rect(0, pageHeight - 5, pageWidth, 5).fill(c.secondary);

      const payload = {
        filename: `PAYSLIP_${String(data.employee.name).replace(/\s+/g, '_').toUpperCase()}_${String(data.period).replace(/\s+/g, '_')}.pdf`,
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