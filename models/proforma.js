// models/proforma.js
// Proforma generator: full header on first page only, minimal on continuation pages
// Fixed: no more blank first page

const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const FONT_DIR = path.join(__dirname, '../assets/fonts');
const ASSETS = { signature: path.join(__dirname, '../assets/compage_signature.png') };

// === FIXED VALUES ===
const COMPANY_NAME = 'COMPAGE AUTOMATION SYSTEMS PVT. LTD.';
const COMPANY_ADDR = '20-21, New DLF Industrial Area, Faridabad';
const COMPANY_GST = '06AAACC3923F1Z4';

const RTGS_ACCOUNT = '923020007963713';
const RTGS_BANK = 'AXIS BANK';
const RTGS_BRANCH = 'SLF MALL FARIDABAD';
const RTGS_IFSC = 'UTIB0004676';
// ===================================

function safeExists(p) {
  try { return !!(p && fs.existsSync(p)); } catch (e) { return false; }
}

function registerFonts(doc) {
  try {
    const roboto = path.join(FONT_DIR, 'Roboto-Regular.ttf');
    const robotoBold = path.join(FONT_DIR, 'Roboto-Bold.ttf');
    if (safeExists(roboto)) doc.registerFont('Roboto', roboto);
    if (safeExists(robotoBold)) doc.registerFont('Roboto-Bold', robotoBold);
    doc.font(safeExists(roboto) ? 'Roboto' : 'Helvetica');
  } catch (e) {
    logger.warn('Font register failed: ' + e.message);
    doc.font('Helvetica');
  }
}

function withFont(doc, font, size, fn) {
  doc.save();
  if (font) doc.font(font);
  if (size) doc.fontSize(size);
  const r = fn();
  doc.restore();
  return r;
}

function measureHeight(doc, text, width, font = null, size = null, lineGap = 2) {
  const s = String(text ?? '');
  return withFont(doc, font, size, () => doc.heightOfString(s, { width, lineGap }));
}

function measureWidth(doc, text, font = null, size = null) {
  return withFont(doc, font, size, () => doc.widthOfString(String(text || '')));
}

function formatINR(n) {
  const v = Number(n || 0);
  if (!Number.isFinite(v)) return '0.00';
  return v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function numberToWordsTitleCase(num) {
  if (!Number.isFinite(num)) return 'Zero';
  num = Math.floor(Math.abs(num));
  if (num === 0) return 'Zero';
  const a = ['', 'one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'];
  const b = ['', '', 'twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'];
  function inWords(n) {
    if (n < 20) return a[n];
    if (n < 100) return b[Math.floor(n/10)] + (n%10 ? ' ' + a[n%10] : '');
    if (n < 1000) return a[Math.floor(n/100)] + ' hundred' + (n%100 ? ' and ' + inWords(n%100) : '');
    if (n < 100000) return inWords(Math.floor(n/1000)) + ' thousand' + (n%1000 ? ' ' + inWords(n%1000) : '');
    if (n < 10000000) return inWords(Math.floor(n/100000)) + ' lakh' + (n%100000 ? ' ' + inWords(n%100000) : '');
    return inWords(Math.floor(n/10000000)) + ' crore' + (n%10000000 ? ' ' + inWords(n%10000000) : '');
  }
  const raw = inWords(num).replace(/\s+/g, ' ').trim();
  return raw.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function findAsset(preferred, fallbackName) {
  if (safeExists(preferred)) return preferred;
  const fallback = path.join('/mnt/data', fallbackName || path.basename(preferred));
  if (safeExists(fallback)) return fallback;
  return null;
}

function drawFullHeader(doc) {
  registerFonts(doc);
  const pageW = doc.page.width;
  const margin = doc.page.margins.left;
  const innerPad = 8;
  const outerX = margin;
  const outerY = doc.page.margins.top;
  const outerW = pageW - margin - doc.page.margins.right;

  const magenta = '#e400c8';
  const green = '#00b200';
  const black = '#000000';

  doc.font('Roboto-Bold').fontSize(15).fillColor(magenta);
  doc.text(COMPANY_NAME, 0, outerY + 4, { width: pageW, align: 'center' });

  doc.font('Roboto').fontSize(9).fillColor(green);
  doc.text(COMPANY_ADDR, 0, outerY + 24, { width: pageW, align: 'center' });

  const topRuleY = outerY + 38;
  doc.save();
  doc.strokeColor(black).lineWidth(1).moveTo(outerX, topRuleY).lineTo(outerX + outerW, topRuleY).stroke();
  doc.restore();

  const gstY = topRuleY + 4;
  doc.font('Roboto').fontSize(10).fillColor(magenta);
  doc.text(`GST No.: ${COMPANY_GST}`, outerX, gstY, { width: outerW - 6, align: 'right' });

  const bottomRuleY = gstY + 12;
  doc.save();
  doc.strokeColor(black).lineWidth(1).moveTo(outerX, bottomRuleY).lineTo(outerX + outerW, bottomRuleY).stroke();
  doc.restore();

  const contentTop = bottomRuleY + 6;

  return {
    contentLeft: outerX + innerPad,
    contentTop,
    contentWidth: outerW - innerPad * 2,
    outerX, outerY, outerW, innerPad
  };
}

function drawContinuationHeader(doc) {
  const margin = doc.page.margins.left;
  const outerX = margin;
  const outerY = doc.page.margins.top;
  const outerW = doc.page.width - margin - doc.page.margins.right;

  doc.font('Roboto-Bold').fontSize(13).fillColor('#e400c8');
  doc.text(COMPANY_NAME, outerX, outerY + 12, { width: outerW, align: 'center' });

  doc.font('Roboto').fontSize(9).fillColor('#555555');
  doc.text('(Continued from previous page)', outerX, outerY + 30, { width: outerW, align: 'center' });

  doc.save();
  doc.strokeColor('#000').lineWidth(0.9)
     .moveTo(outerX, outerY + 48)
     .lineTo(outerX + outerW, outerY + 48)
     .stroke();
  doc.restore();

  return {
    contentLeft: outerX + 8,
    contentTop: outerY + 58,
    contentWidth: outerW - 16,
    outerX, outerY, outerW
  };
}

class Proforma {
  static generate(data = {}) {
    if (!data.proforma_no) throw new Error('proforma_no required');

    const doc = new PDFDocument({ size: 'A4', margin: 18, autoFirstPage: true });
    registerFonts(doc);

    let isFirstPage = true;
    let headerLayout;

    // Header logic for every page (including the automatic first page)
    doc.on('pageAdded', () => {
      registerFonts(doc);
      if (isFirstPage) {
        headerLayout = drawFullHeader(doc);
        isFirstPage = false;
      } else {
        headerLayout = drawContinuationHeader(doc);
      }
    });

    try {
      // The first page is already created automatically by PDFKit
      // We force layout initialization by calling drawFullHeader once more
      // (the event listener has already run once)
      headerLayout = drawFullHeader(doc);
      isFirstPage = false; // mark as processed

      let contentLeft = headerLayout.contentLeft;
      let contentTop = headerLayout.contentTop;
      let contentWidth = headerLayout.contentWidth;
      const innerPad = headerLayout.innerPad || 8;

      const greenBar = '#00d200';
      const black = '#000';

      // === Title bar - FIRST PAGE ONLY ===
      const barH = 20;
      const barY = contentTop;
      doc.save();
      doc.rect(contentLeft, barY, contentWidth, barH).fillColor(greenBar).fill();
      doc.restore();
      doc.font('Roboto-Bold').fontSize(12).fillColor(black)
         .text('PROFORMA INVOICE', contentLeft, barY + 3, { width: contentWidth, align: 'center' });

      contentTop += barH + 8;

      // === "To" & meta - FIRST PAGE ONLY ===
      const leftW = Math.round(contentWidth * 0.62);
      const metaW = contentWidth - leftW;
      const metaX = contentLeft + leftW;

      const metaTop = contentTop;
      doc.font('Roboto-Bold').fontSize(10).fillColor(black).text('To,', contentLeft, metaTop, { width: leftW });

      const toName = data.to_name || '';
      const toAddress = data.to_address || '';
      const toGST = data.to_gst_number ? ('\nGST No: ' + data.to_gst_number) : '';

      doc.font('Roboto').fontSize(9).fillColor(black);
      doc.text(`${toName}${toAddress ? '\n' + toAddress : ''}${toGST}`, contentLeft + 18, metaTop, { width: leftW - 18 });

      const rows = 4;
      const rowHeight = 18;
      const metaBoxH = rowHeight * rows;
      doc.strokeColor('#000').lineWidth(1);
      doc.rect(metaX, metaTop, metaW, metaBoxH).stroke();
      for (let i = 1; i < rows; i++) {
        const lineY = metaTop + rowHeight * i;
        doc.moveTo(metaX, lineY).lineTo(metaX + metaW, lineY).stroke();
      }

      const dateStr = data.date ? (new Date(data.date)).toLocaleDateString('en-GB') : '';
      const dateStr2 = data.meta_date2 ? (new Date(data.meta_date2)).toLocaleDateString('en-GB') : '';
      let metaRowY = metaTop + 4;
      doc.font('Roboto').fontSize(9).fillColor(black);
      doc.text(`Proforma Invoice No.: ${data.proforma_no}`, metaX + 6, metaRowY, { width: metaW - 12, align: 'left' });
      metaRowY += rowHeight;
      doc.text(`Date: ${dateStr}`, metaX + 6, metaRowY, { width: metaW - 12, align: 'left' });
      metaRowY += rowHeight;
      doc.text(`Order No.: ${data.order_no || ''}`, metaX + 6, metaRowY, { width: metaW - 12, align: 'left' });
      metaRowY += rowHeight;
      doc.text(`Date: ${dateStr2 || ''}`, metaX + 6, metaRowY, { width: metaW - 12, align: 'left' });

      let y = metaTop + metaBoxH + 10;

      // ── ITEMS TABLE ───────────────────────────────────────────────────────
      const items = Array.isArray(data.items) ? data.items : [];

      const pct = { sno: 8, desc: 56, qty: 8, rate: 14, total: 14 };
      const minRow = 28;
      const itemsHeaderH = 36;

      doc.font('Roboto').fontSize(9);
      const rowHeights = [];
      const itemsAreaW = contentWidth;
      const colPxCalc = {
        sno: Math.floor(itemsAreaW * pct.sno / 100),
        desc: Math.floor(itemsAreaW * pct.desc / 100),
        qty: Math.floor(itemsAreaW * pct.qty / 100),
        rate: Math.floor(itemsAreaW * pct.rate / 100),
        total: Math.floor(itemsAreaW * pct.total / 100),
      };
      const hp = 6;
      const descInnerW = colPxCalc.desc - hp * 2;

      if (items.length === 0) {
        rowHeights.push(minRow);
      } else {
        for (let it of items) {
          const descH = measureHeight(doc, it.description || '—', descInnerW, 'Roboto', 9, 2);
          const rh = Math.max(minRow, Math.ceil(descH) + 12);
          rowHeights.push(rh);
        }
      }

      function calcCols(baseX, iaW) {
        const colPx = {
          sno: Math.floor(iaW * pct.sno / 100),
          desc: Math.floor(iaW * pct.desc / 100),
          qty: Math.floor(iaW * pct.qty / 100),
          rate: Math.floor(iaW * pct.rate / 100),
          total: Math.floor(iaW * pct.total / 100),
        };
        const colX = {
          sno: baseX,
          desc: baseX + colPx.sno,
          qty: baseX + colPx.sno + colPx.desc,
          rate: baseX + colPx.sno + colPx.desc + colPx.qty,
          total: baseX + colPx.sno + colPx.desc + colPx.qty + colPx.rate
        };
        return { colPx, colX };
      }

      function drawItemsHeader(baseX, topY, iaW) {
        const headerTop = topY + 8;
        const { colPx, colX } = calcCols(baseX, iaW);
        doc.font('Roboto-Bold').fontSize(10).fillColor('#000');

        doc.moveTo(baseX, headerTop - 6).lineTo(baseX + iaW, headerTop - 6).strokeColor('#000').lineWidth(1).stroke();

        doc.save(); doc.strokeColor('#000').lineWidth(0.8);
        doc.moveTo(colX.desc, headerTop - 6).lineTo(colX.desc, headerTop - 6 + itemsHeaderH + 6).stroke();
        doc.moveTo(colX.qty, headerTop - 6).lineTo(colX.qty, headerTop - 6 + itemsHeaderH + 6).stroke();
        doc.moveTo(colX.rate, headerTop - 6).lineTo(colX.rate, headerTop - 6 + itemsHeaderH + 6).stroke();
        doc.moveTo(colX.total, headerTop - 6).lineTo(colX.total, headerTop - 6 + itemsHeaderH + 6).stroke();
        doc.restore();

        doc.text('S.No.', colX.sno + hp, headerTop, { width: colPx.sno - hp * 2, align: 'center' });
        doc.text('Description', colX.desc + hp, headerTop, { width: colPx.desc - hp * 2, align: 'left' });
        doc.text('Qty', colX.qty + hp, headerTop, { width: colPx.qty - hp * 2, align: 'center' });
        doc.text('Unit Rate', colX.rate + hp, headerTop, { width: colPx.rate - hp * 2, align: 'center' });
        doc.text('Total Price', colX.total + hp, headerTop, { width: colPx.total - hp * 2, align: 'center' });

        const headerBottom = headerTop + itemsHeaderH;
        doc.moveTo(baseX, headerBottom).lineTo(baseX + iaW, headerBottom).strokeColor('#000').lineWidth(0.8).stroke();

        return { headerBottom, colPx, colX };
      }

      let baseX = contentLeft;
      let iaW = contentWidth;
      let headerObj = drawItemsHeader(baseX, y - 6, iaW);
      let headerBottom = headerObj.headerBottom;
      let colPx = headerObj.colPx;
      let colX = headerObj.colX;
      let rowCursorY = headerBottom + 6;

      const pageBottomLimit = () => doc.page.height - doc.page.margins.bottom;

      function newPageAndHeader() {
        doc.addPage();  // triggers pageAdded → correct header

        contentLeft = headerLayout.contentLeft;
        contentTop = headerLayout.contentTop;
        contentWidth = headerLayout.contentWidth;

        baseX = contentLeft;
        iaW = contentWidth;

        y = contentTop + 4;
        headerObj = drawItemsHeader(baseX, y - 6, iaW);
        headerBottom = headerObj.headerBottom;
        colPx = headerObj.colPx;
        colX = headerObj.colX;
        rowCursorY = headerBottom + 6;
      }

      const rowsToProcess = items.length === 0 ? [{ description: '—', qty: 0, rate: 0, total_price: 0 }] : items;
      for (let ri = 0; ri < rowsToProcess.length; ri++) {
        const it = rowsToProcess[ri];
        const rh = rowHeights[ri] || minRow;

        const reservedBottom = 340;
        if (rowCursorY + rh + 10 > pageBottomLimit() - reservedBottom) {
          newPageAndHeader();
        }

        doc.moveTo(baseX, rowCursorY - 6).lineTo(baseX + iaW, rowCursorY - 6).strokeColor('#000').lineWidth(0.6).stroke();
        doc.save(); doc.strokeColor('#000').lineWidth(0.6);
        doc.moveTo(colX.desc, rowCursorY - 6).lineTo(colX.desc, rowCursorY + rh + 2).stroke();
        doc.moveTo(colX.qty, rowCursorY - 6).lineTo(colX.qty, rowCursorY + rh + 2).stroke();
        doc.moveTo(colX.rate, rowCursorY - 6).lineTo(colX.rate, rowCursorY + rh + 2).stroke();
        doc.moveTo(colX.total, rowCursorY - 6).lineTo(colX.total, rowCursorY + rh + 2).stroke();
        doc.restore();

        doc.font('Roboto').fontSize(9).fillColor('#000');
        doc.text(String(ri + 1), colX.sno + hp, rowCursorY, { width: colPxCalc.sno - hp * 2, align: 'center' });
        doc.text(it.description || '—', colX.desc + hp, rowCursorY, { width: colPxCalc.desc - hp * 2, align: 'left' });
        doc.text(String(it.qty || ''), colX.qty + hp, rowCursorY, { width: colPxCalc.qty - hp * 2, align: 'center' });
        doc.text(formatINR(it.rate || 0), colX.rate + hp, rowCursorY, { width: colPxCalc.rate - hp * 2, align: 'right' });

        const totalVal = (it.total_price != null) ? Number(it.total_price) : (Number(it.qty || 0) * Number(it.rate || 0));
        doc.text(formatINR(totalVal || 0), colX.total + hp, rowCursorY, { width: colPxCalc.total - hp * 2, align: 'right' });

        const bottomY = rowCursorY + rh + 2;
        doc.moveTo(baseX, bottomY).lineTo(baseX + iaW, bottomY).strokeColor('#000').lineWidth(0.6).stroke();

        rowCursorY = bottomY + 6;
      }

      // ── TRAILING BLOCKS - only on last page ───────────────────────────────
      let taxBoxY = rowCursorY + 12;

      const trailingNeeded = 380;
      if (taxBoxY + trailingNeeded > pageBottomLimit()) {
        newPageAndHeader();
        taxBoxY = rowCursorY + 12;
      }

      const subtotal = items.reduce((s, it) => {
        const qty = Number(it.qty || 0);
        const rate = Number(it.rate || 0);
        const t = (it.total_price != null) ? Number(it.total_price) : qty * rate;
        return s + (Number.isFinite(t) ? t : 0);
      }, 0);

      const gstPercent = Number(data.gst_percent ?? 18);
      const gstAmount = +(subtotal * gstPercent / 100);
      const grandTotal = subtotal + gstAmount;

      // Totals box
      const labels = ['Taxable Amount', `Tax @ ${gstPercent}%`, 'Total Payable'];
      let maxLabelW = 0;
      labels.forEach(lbl => {
        const w = measureWidth(doc, lbl, 'Roboto', 10);
        if (w > maxLabelW) maxLabelW = w;
      });

      const numericColumnDesired = 140;
      const totalsAreaWidth = Math.max(260, Math.ceil(maxLabelW + 20 + numericColumnDesired + 24));
      const totalsX = baseX + iaW - totalsAreaWidth - 6;
      const totalsNumberWidth = Math.min(160, numericColumnDesired);
      const totalsLabelWidth = totalsAreaWidth - totalsNumberWidth - 16;

      const taxBoxW = Math.floor(iaW * 0.48);
      const taxBoxH = 100;

      doc.rect(baseX + 6, taxBoxY, taxBoxW, taxBoxH).strokeColor('#000').lineWidth(0.8).stroke();
      doc.font('Roboto-Bold').fontSize(12).fillColor('#000')
         .text(`Tax-${gstPercent}%`, baseX + 18, taxBoxY + 32, { width: taxBoxW - 24, align: 'left' });

      doc.rect(totalsX, taxBoxY, totalsAreaWidth, taxBoxH).strokeColor('#000').lineWidth(0.8).stroke();

      let ty = taxBoxY + 12;
      function drawTotalsRow(label, value, opts = {}) {
        const bold = !!opts.bold;
        const gap = opts.gap || 18;
        doc.font(bold ? 'Roboto-Bold' : 'Roboto').fontSize(bold ? 11 : 10);
        doc.text(label, totalsX + 8, ty, { width: totalsLabelWidth, align: 'right' });

        const numX = totalsX + totalsAreaWidth - totalsNumberWidth - 6;
        doc.font(bold ? 'Roboto-Bold' : 'Roboto').fontSize(bold ? 12 : 10);
        doc.text(formatINR(value), numX, ty, { width: totalsNumberWidth, align: 'right' });

        const sepY = ty + (bold ? 16 : 14);
        doc.save();
        doc.moveTo(totalsX + 6, sepY).lineTo(totalsX + totalsAreaWidth - 6, sepY)
           .strokeColor('#dcdcdc').lineWidth(0.6).stroke();
        doc.restore();

        ty += gap;
      }

      drawTotalsRow('Taxable Amount', subtotal, { gap: 14 });
      drawTotalsRow(`Tax @ ${gstPercent}%`, gstAmount, { gap: 18 });
      drawTotalsRow('Total Payable', grandTotal, { bold: true, gap: 12 });

      // Amount in words
      let wordsY = taxBoxY + taxBoxH + 12;
      const wordsBoxH = 36;
      const rupees = Math.floor(Number.isFinite(grandTotal) ? grandTotal : 0);
      const paise = Math.round(((grandTotal || 0) - rupees) * 100);
      const wordsCore = numberToWordsTitleCase(rupees);
      const paisePart = paise ? ` and ${numberToWordsTitleCase(paise)} Paise` : '';
      const words = `Rs. ${wordsCore}${paisePart} Only`;

      doc.rect(baseX + 4, wordsY, iaW - 8, wordsBoxH).strokeColor('#000').lineWidth(0.8).stroke();
      doc.font('Roboto-Bold').fontSize(11).fillColor('#000')
         .text(words, baseX + 12, wordsY + 10, { width: iaW - 28, align: 'left' });

      // RTGS block
      let rtgsY = wordsY + wordsBoxH + 12;
      const rtgsH = 72;
      doc.rect(baseX, rtgsY, iaW, rtgsH).strokeColor('#000').lineWidth(0.8).stroke();

      doc.font('Roboto-Bold').fontSize(9).text('RTGS Detail:', baseX + 6, rtgsY + 6, { width: 200 });
      const rtgsRowY = rtgsY + 22;
      const cW = Math.floor((iaW - 12) / 4);
      const x0 = baseX + 6;
      doc.font('Roboto-Bold').fontSize(8).text('ACCOUNT NUMBER', x0, rtgsRowY, { width: cW });
      doc.text('BANK NAME', x0 + cW, rtgsRowY, { width: cW });
      doc.text('NAME OF THE BRANCH', x0 + cW * 2, rtgsRowY, { width: cW });
      doc.text('BRANCH RTGS CODE', x0 + cW * 3, rtgsRowY, { width: cW });

      const valY = rtgsRowY + 14;
      doc.font('Roboto').fontSize(9);
      doc.text(RTGS_ACCOUNT, x0, valY, { width: cW });
      doc.text(RTGS_BANK, x0 + cW, valY, { width: cW });
      doc.text(RTGS_BRANCH, x0 + cW * 2, valY, { width: cW });
      doc.text('IFSC Code:- ' + RTGS_IFSC, x0 + cW * 3, valY, { width: cW });

      // Signature area
      const sigY = rtgsY + rtgsH + 18;
      const containerW = Math.min(520, iaW * 0.9);
      const containerX = baseX + Math.round((iaW - containerW) / 2);
      const leftColW = Math.floor(containerW * 0.45);
      const gutter = 12;
      const rightColW = containerW - leftColW - gutter;
      const rightColX = containerX + leftColW + gutter;

      const sigImgMaxW = Math.min(180, rightColW);
      const sigImgX = rightColX + Math.round((rightColW - sigImgMaxW) / 2);
      const sigImgY = sigY;

      const sigPath = findAsset(ASSETS.signature, 'compage_signature.png');
      if (sigPath) {
        try {
          doc.image(sigPath, sigImgX, sigImgY, { width: sigImgMaxW });
        } catch (e) {
          logger.warn('Signature image failed: ' + e.message);
        }
      }

      const captionsY = sigImgY + 54;
      doc.font('Roboto-Bold').fontSize(11).fillColor('#12a54b');
      doc.text("Receiver's Signature", containerX, captionsY, { width: leftColW, align: 'left' });

      doc.font('Roboto').fontSize(10).fillColor('#12a54b');
      doc.text(`For ${COMPANY_NAME}`, rightColX, captionsY, { width: rightColW, align: 'right' });

      // Footer lines
      const footerLineY1 = captionsY + 24;
      doc.save();
      doc.moveTo(contentLeft, footerLineY1).lineTo(contentLeft + contentWidth, footerLineY1)
         .strokeColor('#000').lineWidth(1.4).stroke();
      doc.restore();

      const factoryY = footerLineY1 + 8;
      doc.font('Roboto-Bold').fontSize(11).fillColor('#12a54b');
      doc.text('Factory: 20-21, New DLF Industrial Area, Faridabad-121003, Phone: (0129) 4072336',
        contentLeft, factoryY, { width: contentWidth, align: 'center' });

      const footerLineY2 = factoryY + 18;
      doc.save();
      doc.moveTo(contentLeft, footerLineY2).lineTo(contentLeft + contentWidth, footerLineY2)
         .strokeColor('#000').lineWidth(1.4).stroke();
      doc.restore();

      const magentaY = footerLineY2 + 8;
      doc.font('Roboto-Bold').fontSize(10).fillColor('#e400c8');
      doc.text('NUMERIC CONTROL – DC DRIVE – AC DRIVE – SERVO MOTOR/ DRIVE – ENCODER – TACHO',
        contentLeft, magentaY, { width: contentWidth, align: 'center' });

      // Final outer box (only around first page content)
      if (headerLayout?.outerY) {
        try {
          const outerTop = headerLayout.outerY;
          const outerLeft = headerLayout.outerX;
          const outerWidth = headerLayout.outerW;
          const bottomPadding = 12;
          const computedH = (magentaY + 24 + bottomPadding) - outerTop;
          doc.save();
          doc.lineWidth(1).strokeColor('#000');
          doc.rect(outerLeft, outerTop, outerWidth, Math.max(computedH, 40)).stroke();
          doc.restore();
        } catch (e) {
          logger.warn('Outer box failed: ' + e.message);
        }
      }

      doc.end();
      return doc;
    } catch (err) {
      try { doc.end(); } catch (e) {}
      logger.error('Proforma generation error:', err);
      throw err;
    }
  }
}

module.exports = Proforma;