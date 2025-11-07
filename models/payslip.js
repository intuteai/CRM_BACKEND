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
function addDecoratedPage(doc, colors) {
  doc.addPage();
  const pageWidth = doc.page.width;
  // thin top bar + soft header
  doc.rect(0, 0, pageWidth, 6).fill(colors.secondary);
  const headerGrad = doc.linearGradient(0, 0, pageWidth, 96);
  headerGrad.stop(0, colors.lightBlue).stop(1, colors.white);
  doc.rect(0, 6, pageWidth, 90).fill(headerGrad);
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
  const h = 30;
  const grad = doc.linearGradient(x, y, x, y + h);
  grad.stop(0, colors.primary).stop(1, colors.secondary);
  doc.roundedRect(x, y, width, h, 6).fill(grad);
  withFont(doc, 'Roboto-Bold', 11, () => {
    doc.fillColor(colors.white).text(title, x + 12, y + 8);
  });
  return h;
}
function drawTableRow(doc, x, y, width, col1W, label, amount, colors, opts = {}) {
  const labelFont = opts.labelFont || 'Roboto';
  const labelSize = opts.labelSize || 10.5;
  const amountFont = opts.amountFont || 'Roboto-Medium';
  const amountSize = opts.amountSize || 10.5;
  const lineGap = opts.lineGap ?? 1.5;
  const paddingX = 10;
  const paddingY = 6;

  const labelW = col1W - paddingX * 2;
  const amountBoxW = 110;

  const labelH = measureHeight(doc, label || '', labelW, labelFont, labelSize, lineGap);
  const amountText = amount != null && Number.isFinite(Number(amount)) ? Number(amount).toFixed(2) : '';
  const amountH = measureHeight(doc, amountText, amountBoxW, amountFont, amountSize, lineGap);
  const contentH = Math.max(labelH, amountH);
  const rowH = Math.max(24, Math.ceil(contentH) + paddingY * 2);

  // background
  doc.save();
  doc.fillColor(colors.light).opacity(0.5);
  doc.rect(x, y, width, rowH).fill();
  doc.restore();

  // label
  withFont(doc, labelFont, labelSize, () => {
    doc.fillColor(colors.text).text(String(label || ''), x + paddingX, y + paddingY, { width: labelW, lineGap });
  });

  // amount right aligned
  withFont(doc, amountFont, amountSize, () => {
    const rightEdge = x + width - paddingX;
    const w = doc.widthOfString(amountText);
    doc.fillColor(colors.text).text(amountText, rightEdge - w, y + paddingY, { lineBreak: false });
  });

  // bottom divider
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
      const logoSvg = path.join(__dirname, '../assets/logo.svg');
      const logoPng = path.join(__dirname, '../assets/image.png');
      let logoExists = false;
      if (fs.existsSync(logoSvg)) {
        const svg = fs.readFileSync(logoSvg, 'utf8');
        svgToPDF(doc, svg, margin, 24, { width: 64, height: 64 });
        logoExists = true;
      } else if (fs.existsSync(logoPng)) {
        doc.image(logoPng, margin, 24, { width: 64, height: 64 });
        logoExists = true;
      }

      /* ===== Company + compact PAYSLIP pill (no overlap) ===== */
      const companyX = logoExists ? margin + 84 : margin;
      const companyNameMaxW = Math.max(320, (pageWidth - margin) - (companyX + 180)); // leave room for pill
      const companyName = 'Intute AI Technologies (OPC) Pvt. Ltd.';
      const companyTitle = truncateToWidth(doc, companyName, companyNameMaxW, 'Roboto-Bold', 18);

      const companyTopY = 34;
      const companyAddrY = 56;

      // pill
      const pillW = 140;
      const pillH = 36;
      const pillR = 18;
      let pillX = pageWidth - margin - pillW;
      let pillY = 34;

      // avoid overlap: push down if too close to company title
      const companyTextRight = companyX + withFont(doc, 'Roboto-Bold', 18, () => doc.widthOfString(companyTitle));
      if (pillX < companyTextRight + 16) pillY = 70;

      withFont(doc, 'Roboto-Bold', 18, () => {
        doc.fillColor(c.primary).text(companyTitle, companyX, companyTopY, { width: companyNameMaxW });
      });
      withFont(doc, 'Roboto', 9.5, () => {
        doc.fillColor(c.textMuted).text('A-5, Sector 68, Noida - 201301, India', companyX, companyAddrY);
      });

      // pill bg
      doc.save();
      doc.fillColor(c.secondary);
      doc.roundedRect(pillX, pillY, pillW, pillH, pillR).fill();
      doc.restore();

      // pill text
      withFont(doc, 'Roboto-Bold', 13, () => {
        doc.fillColor(c.white).text('PAYSLIP', pillX, pillY + 9, { width: pillW, align: 'center' });
      });

      /* ===== Employee Card (dynamic height) ===== */
      const empRows = [
        [ ['Employee Name', String(data.employee.name)], ['Employee ID', String(data.employee.id || 'N/A')] ],
        [ ['Pay Period', String(data.period)], ['Pay Date', String(data.payDate || new Date().toLocaleDateString('en-IN'))] ],
      ];
      const cardHeaderH = 30;
      const cardY = 120;

      const leftX = margin + 18;
      const rightX = margin + 290;
      const labelW = 110;
      const valWLeft = 150;
      const valWRight = 170;
      const rowsH = empRows.map(row => {
        const lh = measureHeight(doc, row[0][1], valWLeft, 'Roboto-Bold', 10, 1);
        const rh = measureHeight(doc, row[1][1], valWRight, 'Roboto-Bold', 10, 1);
        return Math.max(22, Math.ceil(Math.max(lh, rh)) + 8);
      }).reduce((a, b) => a + b, 0);
      const cardHeight = cardHeaderH + 8 + rowsH + 8;

      if (needPageBreak(doc, cardY, cardHeight + 16, marginBottom)) addDecoratedPage(doc, c);

      // shadow
      doc.save();
      doc.fillColor(c.primary).opacity(0.05);
      doc.roundedRect(margin + 2, cardY + 2, contentWidth, cardHeight, 8).fill();
      doc.restore();

      // card
      doc.roundedRect(margin, cardY, contentWidth, cardHeight, 8)
         .lineWidth(1).strokeColor(c.border).fillAndStroke(c.white);

      // header
      doc.rect(margin, cardY, contentWidth, cardHeaderH).fill(c.light);
      doc.save();
      doc.moveTo(margin, cardY + cardHeaderH).lineTo(margin + contentWidth, cardY + cardHeaderH)
         .strokeColor(c.borderLight).lineWidth(1).stroke();
      doc.restore();
      withFont(doc, 'Roboto-Bold', 12, () => {
        doc.fillColor(c.secondary).text('EMPLOYEE DETAILS', margin + 18, cardY + 8);
      });

      // grid
      let y = cardY + cardHeaderH + 8;
      const drawKV = (row, yy) => {
        const lh = measureHeight(doc, row[0][1], valWLeft, 'Roboto-Bold', 10, 1);
        const rh = measureHeight(doc, row[1][1], valWRight, 'Roboto-Bold', 10, 1);
        const h = Math.max(22, Math.ceil(Math.max(lh, rh)) + 8);

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
      y += 16;

      /* ===== EARNINGS (stacked) ===== */
      if (needPageBreak(doc, y, 30 + 24, marginBottom)) { addDecoratedPage(doc, c); y = 24; }
      y += drawSectionHeader(doc, margin, y, contentWidth, 'EARNINGS', c);

      const earnings = Array.isArray(data.earnings) ? data.earnings : [];
      const earningsLabelColW = contentWidth - 110;

      earnings.forEach((row) => {
        const label = String(row?.label || '');
        const amount = Number.isFinite(Number(row?.amount)) ? Number(row.amount) : null;

        const neededH = Math.max(measureHeight(doc, label, earningsLabelColW - 20, 'Roboto', 10.5, 1.5) + 14, 24);
        const rowH = Math.ceil(neededH);

        if (needPageBreak(doc, y, rowH + 16, marginBottom)) {
          addDecoratedPage(doc, c);
          y = 24 + drawSectionHeader(doc, margin, 24, contentWidth, 'EARNINGS (cont.)', c);
        }

        y += drawTableRow(doc, margin, y, contentWidth, earningsLabelColW, label, amount, c,
          { labelFont: 'Roboto', labelSize: 10.5, amountFont: 'Roboto-Medium', amountSize: 10.5, lineGap: 1.5 });
      });

      if (earnings.length === 0) y += drawTableRow(doc, margin, y, contentWidth, contentWidth - 110, '', null, c);
      y += 12;

      /* ===== DEDUCTIONS (stacked) ===== */
      if (needPageBreak(doc, y, 30 + 24, marginBottom)) { addDecoratedPage(doc, c); y = 24; }
      y += drawSectionHeader(doc, margin, y, contentWidth, 'DEDUCTIONS', c);

      const deductions = Array.isArray(data.deductions) ? data.deductions : [];
      const deductionsLabelColW = contentWidth - 110;

      deductions.forEach((row) => {
        const label = String(row?.label || '');
        const amount = Number.isFinite(Number(row?.amount)) ? Number(row.amount) : null;

        const neededH = Math.max(measureHeight(doc, label, deductionsLabelColW - 20, 'Roboto', 10.5, 1.5) + 14, 24);
        const rowH = Math.ceil(neededH);

        if (needPageBreak(doc, y, rowH + 16, marginBottom)) {
          addDecoratedPage(doc, c);
          y = 24 + drawSectionHeader(doc, margin, 24, contentWidth, 'DEDUCTIONS (cont.)', c);
        }

        y += drawTableRow(doc, margin, y, contentWidth, deductionsLabelColW, label, amount, c,
          { labelFont: 'Roboto', labelSize: 10.5, amountFont: 'Roboto-Medium', amountSize: 10.5, lineGap: 1.5 });
      });

      if (deductions.length === 0) y += drawTableRow(doc, margin, y, contentWidth, contentWidth - 110, '', null, c);
      y += 12;

      /* ===== Totals ===== */
      const totalsBarH = 40;
      if (needPageBreak(doc, y, totalsBarH + 100, marginBottom)) { addDecoratedPage(doc, c); y = 24; }

      let gross = 0, totalDed = 0;
      earnings.forEach(e => { if (Number.isFinite(Number(e.amount))) gross += Number(e.amount); });
      deductions.forEach(d => { if (Number.isFinite(Number(d.amount))) totalDed += Number(d.amount); });

      doc.rect(margin, y, contentWidth, totalsBarH).fill(c.primary);
      withFont(doc, 'Roboto-Bold', 11, () => {
        doc.fillColor(c.white).text('GROSS EARNINGS', margin + 14, y + 12);
        const gStr = gross.toFixed(2);
        const gW = doc.widthOfString(gStr);
        doc.text(gStr, margin + contentWidth/2 - 14 - gW, y + 12, { lineBreak: false });

        doc.text('TOTAL DEDUCTIONS', margin + contentWidth/2 + 14, y + 12);
        const dStr = totalDed.toFixed(2);
        const dW = doc.widthOfString(dStr);
        doc.text(dStr, margin + contentWidth - 14 - dW, y + 12, { lineBreak: false });
      });
      doc.save();
      doc.strokeColor('#ffffff').opacity(0.25).lineWidth(1);
      doc.moveTo(margin + contentWidth/2, y).lineTo(margin + contentWidth/2, y + totalsBarH).stroke();
      doc.restore();

      y += totalsBarH + 18;

      /* ===== NET PAY — Professional card (white, pill header) — DYNAMIC HEIGHT ===== */
      {
        const cardPadX = 18;     // inner horizontal padding
        const cardPadTop = 14;   // top padding
        const cardPadBottom = 16;

        const headerPillH = 26, headerPillR = 13, headerPillW = 126, headerPillPadX = 10;

        const labelSize = 11.5;  // ₹ + "NET PAY" in pill
        const amountSize = 22;   // amount
        const subSize = 9.5;     // subtext
        const lineGap = 1.2;

        const netPay = Math.max(0, gross - totalDed);
        const amountStr = `₹ ${netPay.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        const subtext = 'Net of all earnings and deductions';

        // measure dynamic content widths/heights (exact fonts)
        const contentW = contentWidth - cardPadX * 2;
        const amountH = measureHeight(doc, amountStr, contentW, 'Roboto-Bold', amountSize, lineGap);
        const subH    = measureHeight(doc, subtext, contentW, 'Roboto',      subSize,   1.1);

        const gapAfterPill = 8;
        const gapAfterAmount = 6;

        const netBlockH = cardPadTop + headerPillH + gapAfterPill
                        + Math.ceil(amountH) + gapAfterAmount
                        + Math.ceil(subH) + cardPadBottom;

        if (needPageBreak(doc, y, netBlockH + 24, marginBottom)) { addDecoratedPage(doc, c); y = 24; }

        // soft shadow
        doc.save();
        doc.fillColor(c.primary).opacity(0.05);
        doc.roundedRect(margin + 2, y + 2, contentWidth, netBlockH, 12).fill();
        doc.restore();

        // white card + border
        doc.save();
        doc.roundedRect(margin, y, contentWidth, netBlockH, 12).fill(c.white);
        doc.lineWidth(1).strokeColor(c.borderLight).stroke();
        doc.restore();

        // header pill
        const pillX = margin + cardPadX;
        const pillY = y + cardPadTop;
        doc.save();
        doc.fillColor('#e6fffb'); // teal-100
        doc.roundedRect(pillX, pillY, headerPillW, headerPillH, headerPillR).fill();
        doc.restore();

        // tiny ₹ token
        const tokenR = 9;
        const tokenCX = pillX + headerPillPadX + tokenR;
        const tokenCY = pillY + headerPillH / 2;
        doc.save();
        doc.fillColor('#a7f3d0'); // teal-200-ish
        doc.circle(tokenCX, tokenCY, tokenR).fill();
        doc.restore();

        // "₹" inside token + "NET PAY" (same size, baseline aligned)
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

        // amount
        const amtX = margin + cardPadX;
        const amtY = pillY + headerPillH + gapAfterPill;
        withFont(doc, 'Roboto-Bold', amountSize, () => {
          doc.fillColor(c.primary).text(amountStr, amtX, amtY, { width: contentW, lineGap, ellipsis: false });
        });

        // subtext (wrap safely within card)
        const subY = amtY + Math.ceil(amountH) + gapAfterAmount;
        withFont(doc, 'Roboto', subSize, () => {
          doc.fillColor(c.textMuted).text(subtext, amtX, subY, { width: contentW, lineGap: 1.1 });
        });

        y += netBlockH + 20;
      }

      /* ===== Amount in words (compact) ===== */
      const wordsBlockH = 48 + 20;
      if (needPageBreak(doc, y, wordsBlockH, marginBottom)) { addDecoratedPage(doc, c); y = 24; }

      const netPayRounded = Math.round(Math.max(0, gross - totalDed));
      const words = netPayRounded > 0 ? converter.toWords(netPayRounded) : 'zero';
      const inWords = `Rupees ${words.charAt(0).toUpperCase() + words.slice(1)} Only`;

      doc.save();
      doc.lineWidth(1.2).strokeColor(c.accent).fill('#ecfeff');
      doc.roundedRect(margin, y, contentWidth, 48, 8).fillAndStroke();
      doc.restore();

      withFont(doc, 'Roboto-Bold', 10.5, () => {
        doc.fillColor(c.accent).text('AMOUNT IN WORDS', margin + 16, y + 10);
      });
      withFont(doc, 'Roboto-Medium', 10.5, () => {
        doc.fillColor(c.text).text(inWords, margin + 16, y + 26, { width: contentWidth - 32, align: 'center' });
      });

      y += 68;

      /* ===== Footer ===== */
      if (needPageBreak(doc, y, 50, marginBottom)) { addDecoratedPage(doc, c); y = 24; }
      doc.save();
      doc.moveTo(margin, y).lineTo(pageWidth - margin, y)
         .strokeColor(c.borderLight).lineWidth(1).stroke();
      doc.restore();

      y += 12;
      const now = new Date().toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' });
      withFont(doc, 'Roboto', 9, () => {
        doc.fillColor(c.textMuted).text('This is a computer-generated payslip and does not require a signature.',
          0, y, { align: 'center', width: pageWidth });
      });
      withFont(doc, 'Roboto', 8, () => {
        doc.fillColor(c.textMuted).text(`Generated on ${now}`, 0, y + 14, { align: 'center', width: pageWidth });
      });

      // bottom accent
      doc.rect(0, pageHeight - 5, pageWidth, 5).fill(c.secondary);

      // Emit & end
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
