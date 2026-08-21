// models/hr/invoice.js
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const converter = require('number-to-words');
const logger = require('../../utils/logger');

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

// Reads width/height straight from a PNG's IHDR chunk. Used so image aspect
// ratios are always derived from the actual file on disk — a hardcoded guess
// here is exactly what caused the stamp to overlap the "For {company}" text
// when the real stamp.png turned out taller/narrower than assumed.
function getPngDimensions(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(24);
    fs.readSync(fd, buf, 0, 24, 0);
    fs.closeSync(fd);
    if (buf.toString('ascii', 1, 4) !== 'PNG') return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } catch (e) {
    logger.warn(`Could not read PNG dimensions for ${filePath}: ${e.message}`);
    return null;
  }
}

/* ===========================
   Fonts
   =========================== */
const FONT_DIR = path.join(__dirname, '../../assets/fonts');
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
   Fixed company / bank details
   (Intute-AI Technologies is always the seller on this document)
   =========================== */
const COMPANY = {
  name: 'INTUTE-AI TECHNOLOGIES (OPC) PVT. LTD.',
  address: 'A-5, SECTOR-68, NOIDA, UP-201303',
  gst: '09AAHCI7346B1ZK',
  registeredAddress: 'REGISTERED ADDRESS- E2120, GSW, SECTOR-79, NOIDA, UP-201305',
  officeAddress: 'OFFICE ADDRESS- 811, A-5, SECTOR68, NOIDA, UP-201303',
  tagline: 'AI | EV | CLEANTECH',
};
const RTGS = {
  accountNumber: '50200096319530',
  bankName: 'HDFC BANK',
  branch: 'SECTOR-18 NOIDA',
  accountType: 'CURRENT',
  ifsc: 'HDFC0000088',
};

/* ===========================
   Grid-cell drawing helpers
   =========================== */
// Draws a bordered cell with a label (small, muted) stacked above a value,
// or just a value if no label is given.
function gridCell(doc, x, y, w, h, opts = {}) {
  const {
    label, value, valueFont = 'Roboto', valueSize = 9.5, align = 'left',
    bg = null, border = '#333333', padX = 6, padY = 4, labelSize = 7.5, color = '#111111',
  } = opts;

  doc.save();
  if (bg) doc.rect(x, y, w, h).fill(bg);
  doc.restore();

  doc.save();
  doc.lineWidth(0.75).strokeColor(border).rect(x, y, w, h).stroke();
  doc.restore();

  let textY = y + padY;
  if (label) {
    withFont(doc, 'Roboto', labelSize, () => {
      doc.fillColor('#555555').text(String(label), x + padX, textY, { width: w - padX * 2 });
    });
    textY += labelSize + 3;
  }
  withFont(doc, valueFont, valueSize, () => {
    doc.fillColor(color).text(String(value ?? ''), x + padX, textY, {
      width: w - padX * 2, align,
    });
  });
}

// Mirrors gridCell's internal layout math to compute the height a cell's
// content actually needs, given a fixed width — without this, a value too
// long to fit on one line wraps and silently overflows the cell's drawn
// border into whatever is below it (seen in practice: a long invoice number
// overlapping the Date row beneath it).
function measureGridCellHeight(doc, width, opts = {}) {
  const { label, value, valueFont = 'Roboto', valueSize = 9.5, padX = 6, padY = 4, labelSize = 7.5 } = opts;
  let h = padY;
  if (label) h += labelSize + 3;
  // lineGap 0 matches gridCell's actual doc.text() call below, which passes
  // none — any mismatch here would make this estimate drift from what's
  // really drawn (either under-measuring, risking the very overflow this
  // function exists to prevent, or over-measuring and wasting space).
  h += Math.ceil(measureHeight(doc, value, width - padX * 2, valueFont, valueSize, 0));
  return h + padY;
}

/* ===========================
   Invoice
   =========================== */
class Invoice {
  static #toNumber(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
  static #safeEmit(io, event, payload) { if (!io?.emit) return; try { io.emit(event, payload); } catch (e) { logger.warn('Socket emit failed:', e.message); } }

  static generate(data, io) {
    if (!data?.invoiceNumber?.trim()) throw new Error('Invoice number is required');
    if (!data?.billing?.name?.trim()) throw new Error('Billing company/customer name is required');
    if (!Array.isArray(data.items) || data.items.length === 0) throw new Error('At least one invoice item is required');

    const items = data.items
      .map(i => ({
        description: String(i?.description || ''),
        qty: this.#toNumber(i?.qty),
        rate: this.#toNumber(i?.rate),
      }))
      .filter(i => i.description.trim());
    if (items.length === 0) throw new Error('At least one invoice item with a description is required');

    const doc = new PDFDocument({ margin: 30, size: 'A4' });
    const stream = doc;
    registerFonts(doc);

    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;
    const margin = 30;
    const contentWidth = pageWidth - 2 * margin;

    const drawPageChrome = () => {
      doc.rect(0, 0, pageWidth, pageHeight).fill('#ffffff');
    };

    try {
      const gstPercent = Number.isFinite(Number(data.gstPercent)) ? Number(data.gstPercent) : 18;
      const totalAmount = items.reduce((sum, i) => sum + i.qty * i.rate, 0);
      const gstAmount = totalAmount * (gstPercent / 100);
      const grandTotal = Math.round((totalAmount + gstAmount) * 100) / 100;
      const grandTotalRounded = Math.round(grandTotal);
      const words = grandTotalRounded > 0 ? converter.toWords(grandTotalRounded) : 'zero';
      const inWords = `INR ${words.charAt(0).toUpperCase() + words.slice(1)}`;

      let y = margin;

      /* ===== Header: logo + company block ===== */
      const headerH = 62;
      const logoW = 90;
      const logoPng = path.join(__dirname, '../../assets/image.png');
      gridCell(doc, margin, y, logoW, headerH, { value: '' });
      if (fs.existsSync(logoPng)) {
        doc.image(logoPng, margin + 6, y + 6, { fit: [logoW - 12, headerH - 12], align: 'center', valign: 'center' });
      } else {
        logger.warn('Logo file missing: assets/image.png');
      }

      const companyX = margin + logoW;
      const companyW = contentWidth - logoW;
      doc.save();
      doc.lineWidth(0.75).strokeColor('#333333').rect(companyX, y, companyW, headerH).stroke();
      doc.restore();
      withFont(doc, 'Roboto-Bold', 15, () => {
        doc.fillColor('#111111').text(COMPANY.name, companyX + 10, y + 8, { width: companyW - 20 });
      });
      withFont(doc, 'Roboto-Bold', 9, () => {
        doc.fillColor('#333333').text(COMPANY.address, companyX + 10, y + 30, { width: companyW - 20 });
      });
      withFont(doc, 'Roboto-Bold', 9, () => {
        doc.fillColor('#0891b2').text(`GST No.: ${COMPANY.gst}`, companyX + 10, y + 45, { width: companyW - 20 });
      });
      y += headerH;

      /* ===== INVOICE title bar ===== */
      const titleH = 22;
      gridCell(doc, margin, y, contentWidth, titleH, {
        value: 'INVOICE', valueFont: 'Roboto-Bold', valueSize: 13, align: 'center', bg: '#0f172a', color: '#ffffff', padY: 5,
      });
      y += titleH;

      /* ===== Billing block (left) + Invoice meta (right) ===== */
      const leftW = contentWidth * 0.58;
      const rightW = contentWidth - leftW;
      const rightX = margin + leftW;
      const metaRowMinH = 18;
      const metaValueW = rightW * 0.58;

      const billingLines = [data.billing.address, data.billing.phone ? `Phone: ${data.billing.phone}` : null,
        data.billing.email ? `Email: ${data.billing.email}` : null, data.billing.gst ? `GST: ${data.billing.gst}` : null]
        .filter(Boolean).join('\n');

      const metaRows = [
        ['Invoice No.', data.invoiceNumber],
        ['Date', data.date || '-'],
        ['Order No.', data.orderNo || '-'],
        ['Order Date', data.orderDate || '-'],
      ];
      // Each row's height is driven by whichever value actually needs more
      // room — a long invoice number no longer overflows into the row below.
      const metaRowHeights = metaRows.map(([, value]) =>
        Math.max(metaRowMinH, measureGridCellHeight(doc, metaValueW, { value, valueSize: 8.5 }))
      );

      const billingCellH = Math.max(
        metaRowMinH * 4,
        measureGridCellHeight(doc, leftW, { label: `To, ${data.billing.name}`, value: billingLines, valueSize: 8.5, labelSize: 7.5 })
      );
      const metaTotalH = metaRowHeights.reduce((a, b) => a + b, 0);
      const billingH = Math.max(billingCellH, metaTotalH);
      // If the billing side ends up taller, give the extra room to the last
      // meta row so the two columns still end at exactly the same y.
      if (billingH > metaTotalH) metaRowHeights[metaRowHeights.length - 1] += billingH - metaTotalH;

      gridCell(doc, margin, y, leftW, billingH, {
        label: `To, ${data.billing.name}`, value: billingLines, valueSize: 8.5,
      });

      let metaRowY = y;
      metaRows.forEach(([label, value], idx) => {
        const rowH = metaRowHeights[idx];
        gridCell(doc, rightX, metaRowY, rightW * 0.42, rowH, {
          value: label, valueFont: 'Roboto-Medium', valueSize: 8.5, bg: '#f8fafc',
        });
        gridCell(doc, rightX + rightW * 0.42, metaRowY, rightW * 0.58, rowH, {
          value, valueSize: 8.5,
        });
        metaRowY += rowH;
      });
      y += billingH;

      /* ===== HSN + Vendor code ===== */
      const hsnRowH = 18;
      gridCell(doc, margin, y, contentWidth / 2, hsnRowH, { value: `HSN: ${data.hsn || '-'}`, valueFont: 'Roboto-Medium', valueSize: 8.5 });
      gridCell(doc, margin + contentWidth / 2, y, contentWidth / 2, hsnRowH, { value: `Vendor code: ${data.vendorCode || '-'}`, valueFont: 'Roboto-Medium', valueSize: 8.5 });
      y += hsnRowH;

      /* ===== Line items table ===== */
      const colW = { sr: contentWidth * 0.07, desc: contentWidth * 0.48, qty: contentWidth * 0.1, rate: contentWidth * 0.17, total: contentWidth * 0.18 };
      const tableHeaderH = 20;
      const drawTableHead = () => {
        gridCell(doc, margin, y, colW.sr, tableHeaderH, { value: 'Sr No.', valueFont: 'Roboto-Bold', valueSize: 8.5, align: 'center', bg: '#eff6ff' });
        gridCell(doc, margin + colW.sr, y, colW.desc, tableHeaderH, { value: 'Description', valueFont: 'Roboto-Bold', valueSize: 8.5, align: 'center', bg: '#eff6ff' });
        gridCell(doc, margin + colW.sr + colW.desc, y, colW.qty, tableHeaderH, { value: 'Qty', valueFont: 'Roboto-Bold', valueSize: 8.5, align: 'center', bg: '#eff6ff' });
        gridCell(doc, margin + colW.sr + colW.desc + colW.qty, y, colW.rate, tableHeaderH, { value: 'Unit Rate (INR)', valueFont: 'Roboto-Bold', valueSize: 8.5, align: 'center', bg: '#eff6ff' });
        gridCell(doc, margin + colW.sr + colW.desc + colW.qty + colW.rate, y, colW.total, tableHeaderH, { value: 'Total Price (INR)', valueFont: 'Roboto-Bold', valueSize: 8.5, align: 'center', bg: '#eff6ff' });
        y += tableHeaderH;
      };
      drawTableHead();

      // Reserve room for everything drawn after the item rows (totals, grand total,
      // amount-in-words, RTGS block, signature/footer) so a long item list triggers a
      // clean page break instead of overflowing past the bottom margin. Computed once,
      // up front, from the exact fixed row heights used below — not a guessed constant.
      const totalsRowH = 18;
      const grandRowH = 20;
      const wordsRowH = 20;
      const rtgsHeaderH = 16;
      const rtgsRowH = 18;
      const footerRowH = 14;
      const taglineH = 18;

      // Stamp size/aspect derived from the actual file (not guessed) so the
      // signature block is sized to genuinely fit it — a hardcoded aspect ratio
      // here is exactly what caused the stamp to overlap the "For {company}" text.
      const stampPath = path.join(__dirname, '../../assets/stamp.png');
      const stampExists = fs.existsSync(stampPath);
      const stampDims = stampExists ? getPngDimensions(stampPath) : null;
      const stampW = 80;
      const stampH = stampDims ? stampW * (stampDims.height / stampDims.width) : stampW * 0.68;
      const sigTopPad = 6;
      const gapAfterStamp = 6;
      const forCompanyTextH = 12;
      const sigH = Math.max(60, sigTopPad + stampH + gapAfterStamp + forCompanyTextH + 6);

      const trailingContentH =
        (totalsRowH * 2) + grandRowH +
        wordsRowH +
        rtgsHeaderH + (rtgsRowH * 3) +
        sigH +
        (footerRowH * 2) + taglineH + 10;

      items.forEach((item, idx) => {
        const lineTotal = item.qty * item.rate;
        const rowH = Math.max(20, Math.ceil(measureHeight(doc, item.description, colW.desc - 12, 'Roboto', 8.5, 1.2)) + 8);

        const isLast = idx === items.length - 1;
        const reserve = isLast ? trailingContentH : rowH;
        if (y + rowH + reserve > pageHeight - margin) {
          doc.addPage();
          drawPageChrome();
          y = margin;
          drawTableHead();
        }

        gridCell(doc, margin, y, colW.sr, rowH, { value: String(idx + 1), valueSize: 8.5, align: 'center' });
        gridCell(doc, margin + colW.sr, y, colW.desc, rowH, { value: item.description, valueSize: 8.5 });
        gridCell(doc, margin + colW.sr + colW.desc, y, colW.qty, rowH, { value: item.qty, valueSize: 8.5, align: 'center' });
        gridCell(doc, margin + colW.sr + colW.desc + colW.qty, y, colW.rate, rowH, { value: item.rate.toFixed(2), valueSize: 8.5, align: 'right' });
        gridCell(doc, margin + colW.sr + colW.desc + colW.qty + colW.rate, y, colW.total, rowH, { value: lineTotal.toFixed(2), valueSize: 8.5, align: 'right' });
        y += rowH;
      });

      const totalsColX = margin + colW.sr + colW.desc + colW.qty;
      [
        ['Total Amount', totalAmount.toFixed(2)],
        [`GST ${gstPercent}%`, gstAmount.toFixed(2)],
      ].forEach(([label, value]) => {
        gridCell(doc, margin, y, colW.sr + colW.desc, totalsRowH, { value: '' });
        gridCell(doc, totalsColX, y, colW.rate, totalsRowH, { value: label, valueFont: 'Roboto-Medium', valueSize: 8.5, align: 'right' });
        gridCell(doc, totalsColX + colW.rate, y, colW.total, totalsRowH, { value, valueSize: 8.5, align: 'right' });
        y += totalsRowH;
      });

      gridCell(doc, margin, y, colW.sr + colW.desc, grandRowH, { value: '' });
      gridCell(doc, totalsColX, y, colW.rate, grandRowH, {
        value: 'TOTAL', valueFont: 'Roboto-Bold', valueSize: 9.5, align: 'right', bg: '#0f172a', color: '#ffffff',
      });
      gridCell(doc, totalsColX + colW.rate, y, colW.total, grandRowH, {
        value: grandTotal.toFixed(2), valueFont: 'Roboto-Bold', valueSize: 9.5, align: 'right', bg: '#0f172a', color: '#ffffff',
      });
      y += grandRowH;

      /* ===== Amount in words ===== */
      gridCell(doc, margin, y, contentWidth, wordsRowH, { value: inWords, valueFont: 'Roboto-Medium', valueSize: 9, bg: '#f8fafc' });
      y += wordsRowH;

      /* ===== RTGS detail ===== */
      gridCell(doc, margin, y, contentWidth, rtgsHeaderH, { value: 'RTGS Detail:', valueFont: 'Roboto-Bold', valueSize: 8.5 });
      y += rtgsHeaderH;

      const half = contentWidth / 2;
      gridCell(doc, margin, y, half * 0.45, rtgsRowH, { value: 'ACCOUNT NUMBER', valueFont: 'Roboto-Medium', valueSize: 8, bg: '#f8fafc' });
      gridCell(doc, margin + half * 0.45, y, half * 0.55, rtgsRowH, { value: RTGS.accountNumber, valueSize: 8.5 });
      gridCell(doc, margin + half, y, half * 0.3, rtgsRowH, { value: 'BANK NAME', valueFont: 'Roboto-Medium', valueSize: 8, bg: '#f8fafc' });
      gridCell(doc, margin + half + half * 0.3, y, half * 0.7, rtgsRowH, { value: RTGS.bankName, valueSize: 8.5 });
      y += rtgsRowH;

      gridCell(doc, margin, y, half, rtgsRowH, { value: `BRANCH - ${RTGS.branch}`, valueFont: 'Roboto-Medium', valueSize: 8 });
      gridCell(doc, margin + half, y, half * 0.3, rtgsRowH, { value: 'ACCOUNT TYPE', valueFont: 'Roboto-Medium', valueSize: 8, bg: '#f8fafc' });
      gridCell(doc, margin + half + half * 0.3, y, half * 0.7, rtgsRowH, { value: RTGS.accountType, valueSize: 8.5 });
      y += rtgsRowH;

      gridCell(doc, margin, y, contentWidth, rtgsRowH, { value: `BRANCH RTGS CODE -IFSC Code: ${RTGS.ifsc}`, valueFont: 'Roboto-Medium', valueSize: 8 });
      y += rtgsRowH;

      /* ===== Signature block ===== */
      gridCell(doc, margin, y, contentWidth / 2, sigH, { value: '' });
      gridCell(doc, margin + contentWidth / 2, y, contentWidth / 2, sigH, { value: '' });

      if (stampExists) {
        doc.image(stampPath, margin + contentWidth / 2 + (contentWidth / 2 - stampW) / 2, y + sigTopPad, { width: stampW, height: stampH });
      } else {
        logger.warn('Stamp file missing: assets/stamp.png');
      }

      withFont(doc, 'Roboto-Bold', 8.5, () => {
        doc.fillColor('#333333').text("Receiver's Signature", margin + 8, y + sigH - 14);
      });
      withFont(doc, 'Roboto-Bold', 8.5, () => {
        doc.fillColor('#333333').text(`For ${COMPANY.name}`, margin + contentWidth / 2 + 8, y + sigTopPad + stampH + gapAfterStamp, { width: contentWidth / 2 - 16, align: 'center' });
      });
      y += sigH;

      /* ===== Footer ===== */
      gridCell(doc, margin, y, contentWidth, footerRowH, { value: `${COMPANY.registeredAddress},`, valueSize: 7.5, valueFont: 'Roboto', bg: '#f8fafc' });
      y += footerRowH;
      gridCell(doc, margin, y, contentWidth, footerRowH, { value: COMPANY.officeAddress, valueSize: 7.5, valueFont: 'Roboto', bg: '#f8fafc' });
      y += footerRowH;

      gridCell(doc, margin, y, contentWidth, taglineH, {
        value: COMPANY.tagline, valueFont: 'Roboto-Bold', valueSize: 9.5, align: 'center', bg: '#0891b2', color: '#ffffff', padY: 4,
      });
      y += taglineH;

      const payload = {
        filename: `INVOICE_${String(data.invoiceNumber).replace(/[^a-zA-Z0-9]/g, '_')}.pdf`,
        generated_at: new Date().toISOString(),
        generated_by: io?.user?.user_id || null,
      };
      this.#safeEmit(io, 'invoice:generated', payload);

      doc.end();
      return stream;

    } catch (err) {
      logger.error('Invoice PDF generation failed:', err);
      throw new Error('Failed to generate PDF');
    }
  }
}

module.exports = Invoice;
