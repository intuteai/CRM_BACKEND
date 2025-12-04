const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

/* ===========================
   Helpers & Fonts
   =========================== */
const FONT_DIR = path.join(__dirname, '../assets/fonts');

function registerFonts(doc) {
  const reg = (name, file) => {
    const p = path.join(FONT_DIR, file);
    if (fs.existsSync(p)) {
      try { doc.registerFont(name, p); return true; } catch (e) { logger.warn(`Failed to register font ${file}: ${e.message}`); }
    }
    return false;
  };
  reg('Roboto', 'Roboto-Regular.ttf');
  reg('Roboto-Bold', 'Roboto-Bold.ttf');
  reg('Roboto-Medium', 'Roboto-Medium.ttf');
  try { doc.font('Roboto'); } catch (e) { doc.font('Helvetica'); }
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

/* page helpers */
function availableSpaceBelow(doc, y, footerReserve = 90) {
  const bottom = doc.page.height - doc.page.margins.bottom - footerReserve;
  return bottom - y;
}
function needPageBreak(doc, y, neededHeight, footerReserve = 90) {
  const bottom = doc.page.height - footerReserve;
  return (y + neededHeight) > bottom;
}

/* number to words (Indian system) */
function numberToWords(num) {
  if (!Number.isFinite(num)) return 'zero';
  num = Math.floor(Math.abs(num));
  if (num === 0) return 'zero';
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
  return inWords(num).replace(/ +/g, ' ').trim();
}

function formatDDMMYYYY(d) {
  if (!d) return '';
  const dt = (d instanceof Date) ? d : new Date(d);
  const dd = String(dt.getDate()).padStart(2,'0');
  const mm = String(dt.getMonth()+1).padStart(2,'0');
  const yyyy = dt.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}
function formatINR(n) {
  const v = Number(n || 0);
  if (!Number.isFinite(v)) return '0.00';
  return v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* ===========================
   Fixed content & assets
   =========================== */
const STANDARD_TERMS = [
  "Validity – 10 days from the date of offer",
  "Price Basis – Ex-Works Faridabad. Packing and forwarding extra.",
  "Payment Terms – 100% advance with P.O. for initial orders; for regular orders, the payment terms will be as settled at the time of finalization.",
  "Delivery – 4–6 weeks from the date of receipt of PO along with advance."
];

const SIGN_OFF_LINES = [
  "Thanking you.",
  "For Compage Automation Systems Pvt. Ltd."
];
const SIGN_OFF_NAME = "Anil Aggarwal (M:9999982595)";

const FIXED_FOOTER_LINE1 = "Factory:20-21,NewDLFIndustrialArea,Faridabad-121003,Phone: 9311856598  E-mail : sales@compageauto@gmail.com";
const FIXED_FOOTER_LINE2 = "Website: www.compageauto.com  |  GST No.: 06AAACC3923F1Z4";

const ASSETS = {
  headerLeft: path.join(__dirname, '../assets/compage_header_left.png'),
  headerRight: path.join(__dirname, '../assets/compage_header_right.png'),
  signature: path.join(__dirname, '../assets/compage_signature.png'),
};
function findAsset(preferredPath, fallbackName) {
  if (fs.existsSync(preferredPath)) return preferredPath;
  const fallback = path.join('/mnt/data', fallbackName || path.basename(preferredPath));
  if (fs.existsSync(fallback)) return fallback;
  return null;
}

/* ===========================
   Quotation generator
   =========================== */
class Quotation {
  static generate(data = {}) {
    if (!data.quotation_no) throw new Error('quotation_no required');

    const doc = new PDFDocument({ size: 'A4', margin: 36 });
    registerFonts(doc);

    const c = { primary: '#0b6b24', text: '#000000', muted: '#6b7280', border: '#c9c9c9', white: '#ffffff' };
    const pageW = doc.page.width, pageH = doc.page.height;
    const margin = doc.page.margins.left;
    const contentW = pageW - margin - doc.page.margins.right;

    // Draw footer two lines; explicit x,y,width to avoid NaN
    function drawFooter() {
      try {
        registerFonts(doc);
        const footerHeight = 44; // reserve
        const line1Y = doc.page.height - doc.page.margins.bottom - footerHeight + 10;
        const line2Y = line1Y + 12;
        doc.fillColor(c.muted).font('Roboto').fontSize(9);
        doc.text(FIXED_FOOTER_LINE1, margin, line1Y, { width: contentW, align: 'center' });
        doc.text(FIXED_FOOTER_LINE2, margin, line2Y, { width: contentW, align: 'center' });
        doc.save();
        doc.strokeColor('#e6e6e6').lineWidth(0.5);
        doc.moveTo(margin, doc.page.height - doc.page.margins.bottom - footerHeight - 4);
        doc.lineTo(pageW - margin, doc.page.height - doc.page.margins.bottom - footerHeight - 4);
        doc.stroke();
        doc.restore();
      } catch (e) { logger.warn('Footer draw failed: ' + e.message); }
    }
    doc.on('pageAdded', () => { drawFooter(); registerFonts(doc); });

    try {
      // Header logos + title
      doc.rect(0, 0, pageW, 6).fill(c.white);
      const headerY = 18;
      const logoMaxW = 60, logoMaxH = 40;
      const leftLogo = findAsset(ASSETS.headerLeft, 'compage_header_left.png');
      const rightLogo = findAsset(ASSETS.headerRight, 'compage_header_right.png');
      if (leftLogo) try { doc.image(leftLogo, margin, headerY, { fit: [logoMaxW, logoMaxH], valign: 'center' }); } catch (e) { logger.warn(e.message); }
      if (rightLogo) try { doc.image(rightLogo, pageW - doc.page.margins.right - logoMaxW, headerY, { fit: [logoMaxW, logoMaxH], valign: 'center' }); } catch (e) { logger.warn(e.message); }
      doc.font('Roboto-Bold').fontSize(18).fillColor(c.primary);
      doc.text('COMPAGE AUTOMATION SYSTEMS PVT.LTD.', 0, headerY + 6, { width: pageW, align: 'center' });

      // initial footer for first page
      drawFooter();

      // Meta row
      const metaY = headerY + 56;
      doc.font('Roboto').fontSize(11).fillColor(c.text);
      doc.text(`QuotationNo.${data.quotation_no}`, margin, metaY, { width: contentW * 0.6, align: 'left' });
      const dateStr = data.date ? (String(data.date).includes('/') ? String(data.date) : formatDDMMYYYY(new Date(data.date))) : formatDDMMYYYY(new Date());
      const dateBoxW = 160;
      const dateX = pageW - doc.page.margins.right - dateBoxW;
      doc.text(`Date: ${dateStr}`, dateX, metaY, { width: dateBoxW, align: 'right' });
      doc.y = metaY + 20;

      // To block and center Kind Attn / Sub
      doc.font('Roboto-Bold').fontSize(14).fillColor(c.text); doc.text('To,', margin, doc.y);
      const dots = (val, lines = 4) => { if (val && String(val).trim().length) return String(val); return Array.from({ length: lines }).map(()=> '………………….').join('\n'); };
      doc.font('Roboto').fontSize(11).fillColor(c.text);
      const toText = dots(data.to_address, 4);
      const toBlockWidth = Math.max(320, contentW * 0.55);
      doc.text(toText, margin + 8, doc.y + 6, { width: toBlockWidth, lineGap: 4 });
      const afterToY = doc.y;

      // Render recipient GST number (if provided) just below the To block
      if (data.to_gst_number && String(data.to_gst_number).trim()) {
        try {
          const gstText = `GST No: ${String(data.to_gst_number).trim()}`;
          doc.font('Roboto').fontSize(10).fillColor(c.muted);
          doc.text(gstText, margin + 8, doc.y + 6, { width: toBlockWidth, align: 'left' });
          doc.y = doc.y + measureHeight(doc, gstText, toBlockWidth, 'Roboto', 10, 2) + 6;
        } catch (e) {
          logger.warn('Failed to draw recipient GST: ' + e.message);
        }
      }

      const kindText = (data.kind_attn && String(data.kind_attn).trim().length) ? data.kind_attn : '……………';
      const subText = (data.subject_item && String(data.subject_item).trim().length) ? data.subject_item : '______________';
      const kindY = doc.y + 8;
      doc.font('Roboto-Bold').fontSize(13).fillColor(c.text).text(`Kind Attn: ${kindText}`, margin, kindY, { width: contentW, align: 'center' });
      const subY = kindY + 16;
      doc.font('Roboto-Bold').fontSize(13).fillColor(c.text).text(`Sub: Quotation for ${subText}`, margin, subY, { width: contentW, align: 'center' });
      doc.y = subY + 18;

      // Intro
      const intro = data.intro || 'We are pleased to quote you our best prices for the following items:';
      doc.font('Roboto').fontSize(11).fillColor(c.text); doc.text(intro, margin, doc.y); doc.moveDown(0.4);

      /* ============================
         ITEMS TABLE (auto-fit, vertical grid)
         ============================ */
      const tableX = margin;
      let tableY = doc.y;
      const pct = { sno: 0.06, hsn: 0.10, qty: 0.06, unit: 0.16, total: 0.12 };
      const usedPct = pct.sno + pct.hsn + pct.qty + pct.unit + pct.total;
      const descPct = Math.max(0.30, 1 - usedPct);
      let colSnoW = Math.round(contentW * pct.sno);
      let colHSNW = Math.round(contentW * pct.hsn);
      let colQtyW = Math.round(contentW * pct.qty);
      let colUnitW = Math.round(contentW * pct.unit);
      let colTotalW = Math.round(contentW * pct.total);
      let colDescW = Math.round(contentW * descPct);
      if (colSnoW < 40) colSnoW = 40; if (colHSNW < 60) colHSNW = 60; if (colQtyW < 40) colQtyW = 40;
      if (colUnitW < 80) colUnitW = 80; if (colTotalW < 80) colTotalW = 80; if (colDescW < 160) colDescW = 160;
      const sumCols = colSnoW + colDescW + colHSNW + colQtyW + colUnitW + colTotalW;
      if (sumCols > contentW) { const overflow = sumCols - contentW; colDescW = Math.max(120, colDescW - overflow); }
      const tableFontSize = contentW < 480 ? 9 : 11;

      function drawTableHeader(yPos) {
        doc.font('Roboto-Bold').fontSize(tableFontSize).fillColor(c.text);
        const h1 = measureHeight(doc, 'S. No.', colSnoW - 10, 'Roboto-Bold', tableFontSize, 2);
        const h2 = measureHeight(doc, 'Description', colDescW - 10, 'Roboto-Bold', tableFontSize, 2);
        const h3 = measureHeight(doc, 'HSN Code', colHSNW - 10, 'Roboto-Bold', tableFontSize, 2);
        const h4 = measureHeight(doc, 'Qty', colQtyW - 10, 'Roboto-Bold', tableFontSize, 2);
        const h5 = measureHeight(doc, 'Unit Price (₹)', colUnitW - 10, 'Roboto-Bold', tableFontSize, 2);
        const h6 = measureHeight(doc, 'Total Price (₹)', colTotalW - 10, 'Roboto-Bold', tableFontSize, 2);
        const headerH = Math.max(28, Math.ceil(Math.max(h1,h2,h3,h4,h5,h6)) + 12);
        doc.rect(tableX, yPos - 2, contentW, headerH).strokeColor(c.border).lineWidth(0.6).stroke();
        const x1 = tableX + colSnoW, x2 = x1 + colDescW, x3 = x2 + colHSNW, x4 = x3 + colQtyW, x5 = x4 + colUnitW;
        doc.moveTo(x1, yPos - 2).lineTo(x1, yPos + headerH - 2).stroke();
        doc.moveTo(x2, yPos - 2).lineTo(x2, yPos + headerH - 2).stroke();
        doc.moveTo(x3, yPos - 2).lineTo(x3, yPos + headerH - 2).stroke();
        doc.moveTo(x4, yPos - 2).lineTo(x4, yPos + headerH - 2).stroke();
        doc.moveTo(x5, yPos - 2).lineTo(x5, yPos + headerH - 2).stroke();
        doc.text('S. No.', tableX + 6, yPos + 6, { width: colSnoW - 10, align: 'center' });
        doc.text('Description', x1 + 6, yPos + 6, { width: colDescW - 10, align: 'left' });
        doc.text('HSN Code', x2 + 6, yPos + 6, { width: colHSNW - 10, align: 'center' });
        doc.text('Qty', x3 + 6, yPos + 6, { width: colQtyW - 10, align: 'center' });
        doc.text('Unit Price (₹)', x4 + 6, yPos + 6, { width: colUnitW - 10, align: 'center' });
        doc.text('Total Price (₹)', x5 + 6, yPos + 6, { width: colTotalW - 10, align: 'center' });
        return yPos + headerH + 6;
      }

      tableY = drawTableHeader(tableY);
      const items = Array.isArray(data.items) ? data.items : [];
      let runningY = tableY, subtotal = 0;

      function drawRow(item, idx) {
        const sno = item.sno ?? (idx + 1);
        const desc = item.description ?? '………………';
        const hsn = item.hsn_code ?? '';
        const qty = Number(item.qty != null ? item.qty : 1);
        const unit = Number(item.unit_price || 0);
        const total = Number(item.total_price != null ? item.total_price : (Number.isFinite(unit) ? unit * qty : 0));
        subtotal += (Number.isFinite(total) ? total : 0);
        const descH = measureHeight(doc, desc, colDescW - 12, 'Roboto', tableFontSize, 4);
        const amountH = measureHeight(doc, formatINR(total), colTotalW - 12, 'Roboto', tableFontSize, 2);
        const rowH = Math.max(26, Math.ceil(Math.max(descH, amountH)) + 12);
        if (rowH > availableSpaceBelow(doc, runningY, 90)) {
          doc.addPage();
          registerFonts(doc);
          runningY = drawTableHeader(doc.page.margins.top + 12);
        }
        doc.rect(tableX, runningY - 2, contentW, rowH).strokeColor(c.border).lineWidth(0.4).stroke();
        const xSno = tableX, x1 = xSno + colSnoW, x2 = x1 + colDescW, x3 = x2 + colHSNW, x4 = x3 + colQtyW, x5 = x4 + colUnitW;
        doc.moveTo(x1, runningY - 2).lineTo(x1, runningY + rowH - 2).stroke();
        doc.moveTo(x2, runningY - 2).lineTo(x2, runningY + rowH - 2).stroke();
        doc.moveTo(x3, runningY - 2).lineTo(x3, runningY + rowH - 2).stroke();
        doc.moveTo(x4, runningY - 2).lineTo(x4, runningY + rowH - 2).stroke();
        doc.moveTo(x5, runningY - 2).lineTo(x5, runningY + rowH - 2).stroke();
        doc.font('Roboto').fontSize(tableFontSize).fillColor(c.text);
        const snoText = `${sno}.`;
        const snoH = measureHeight(doc, snoText, colSnoW - 10, 'Roboto', tableFontSize, 2);
        const snoY = runningY + Math.max(6, Math.floor((rowH - snoH) / 2));
        doc.text(snoText, xSno + 6, snoY, { width: colSnoW - 10, align: 'center' });
        const descY = runningY + 6;
        doc.text(desc, x1 + 6, descY, { width: colDescW - 10, align: 'left' });
        const hsnText = String(hsn || '');
        const hsnH = measureHeight(doc, hsnText, colHSNW - 10, 'Roboto', tableFontSize, 2);
        const hsnY = runningY + Math.max(6, Math.floor((rowH - hsnH) / 2));
        doc.text(hsnText, x2 + 6, hsnY, { width: colHSNW - 10, align: 'center' });
        const qtyText = String(qty);
        const qtyH = measureHeight(doc, qtyText, colQtyW - 10, 'Roboto', tableFontSize, 2);
        const qtyY = runningY + Math.max(6, Math.floor((rowH - qtyH) / 2));
        doc.text(qtyText, x3 + 6, qtyY, { width: colQtyW - 10, align: 'center' });
        const unitText = formatINR(unit);
        const unitH = measureHeight(doc, unitText, colUnitW - 10, 'Roboto', tableFontSize, 2);
        const unitY = runningY + Math.max(6, Math.floor((rowH - unitH) / 2));
        doc.text(unitText, x4 + 6, unitY, { width: colUnitW - 10, align: 'center' });
        const totalText = formatINR(total);
        const totalH = measureHeight(doc, totalText, colTotalW - 10, 'Roboto', tableFontSize, 2);
        const totalX = x5 + 6;
        const totalY = runningY + Math.max(6, Math.floor((rowH - totalH) / 2));
        doc.text(totalText, totalX, totalY, { width: colTotalW - 10, align: 'center' });
        runningY += rowH + 2;
      }

      if (items.length === 0) {
        drawRow({ description: '……………………………………', qty: 0, unit_price: 0, total_price: 0 }, 0);
      } else {
        items.forEach((it, idx) => drawRow(it, idx));
      }

      /* GST calculations (no 'GST extra' box shown) */
      runningY = runningY + 6;

      const gstPercent = Number(data.gst_percent != null ? data.gst_percent : 18);
      const gstAmount = Number((subtotal * gstPercent) / 100);
      const grandTotal = subtotal + gstAmount;

      const totalsW = 260, totalsX = pageW - margin - totalsW, labelW = totalsW - 120, amtW = 120;
      const totalsFontSize = 11;
      doc.fontSize(totalsFontSize).fillColor(c.text);

      let yTotals = runningY;
      doc.font('Roboto').text('Subtotal', totalsX, yTotals, { width: labelW, align: 'right' });
      doc.text(formatINR(subtotal), totalsX + labelW, yTotals, { width: amtW, align: 'right' });
      const singleLineH = measureHeight(doc, 'Subtotal', labelW + amtW, 'Roboto', totalsFontSize, 6);
      yTotals += singleLineH + 4;
      doc.font('Roboto').text(`GST @ ${gstPercent}%`, totalsX, yTotals, { width: labelW, align: 'right' });
      doc.text(formatINR(gstAmount), totalsX + labelW, yTotals, { width: amtW, align: 'right' });
      yTotals += singleLineH + 4;
      doc.font('Roboto-Bold').fontSize(12).text('Grand Total', totalsX, yTotals, { width: labelW, align: 'right' });
      doc.text('₹ ' + formatINR(grandTotal), totalsX + labelW, yTotals, { width: amtW, align: 'right' });
      runningY = yTotals + 12;

      /* Amount-in-words box -- ensure space */
      const safeGrand = Number.isFinite(Number(grandTotal)) ? Number(grandTotal) : 0;
      const rupees = Math.floor(safeGrand), paise = Math.round((safeGrand - rupees) * 100);
      const rupeesWords = rupees ? numberToWords(rupees) : 'zero';
      const paiseWords = paise ? numberToWords(paise) : '';
      const amtWords = paise ? `Rupees ${rupeesWords} and ${paiseWords} paise only` : `Rupees ${rupeesWords} only`;
      const boxH = 54, boxNeeded = boxH + 20;
      if (needPageBreak(doc, runningY, boxNeeded, 90)) {
        doc.addPage(); registerFonts(doc);
        runningY = doc.page.margins.top + 12;
      }
      const boxY = runningY + 10;
      doc.save(); doc.rect(margin, boxY, contentW, boxH).fillColor('#f7faf7').fill(); doc.restore();
      doc.rect(margin, boxY, contentW, boxH).strokeColor('#e2e8f0').lineWidth(0.8).stroke();
      doc.font('Roboto-Bold').fontSize(11).fillColor(c.text).text('Amount in Words:', margin + 12, boxY + 8, { width: contentW - 24, align: 'left' });
      const amtDisplay = amtWords.charAt(0).toUpperCase() + amtWords.slice(1);
      doc.font('Roboto').fontSize(10).fillColor('#111827').text(amtDisplay, margin + 12, boxY + 26, { width: contentW - 24, align: 'left' });
      runningY = boxY + boxH + 20;

      /* TERMS: render line-by-line and force page-break when next line doesn't fit */
      // Prefer data.terms if given and non-empty; otherwise fall back to STANDARD_TERMS
      let termsToRender = Array.isArray(data.terms) && data.terms.length ? data.terms : STANDARD_TERMS;
      // Determine label (Default vs Custom) based on allowOverrideTerms flag if provided; fallback to presence of data.terms
      const isCustom = data.allowOverrideTerms === true || (Array.isArray(data.terms) && data.terms.length && String(data.allowOverrideTerms) === 'true');
      // Reserve a rough estimate for heading
      if (needPageBreak(doc, runningY, 30, 90)) { doc.addPage(); registerFonts(doc); runningY = doc.page.margins.top + 12; }
      const termsY = runningY + 6;
      const termsHeading = isCustom ? 'Terms & Conditions (Custom Terms)' : 'Terms & Conditions (Default Terms)';
      doc.font('Roboto-Bold').fontSize(11).fillColor(c.text).text(termsHeading, margin, termsY, { width: contentW, align: 'left' });
      doc.y = termsY + 12;
      const bulletX = margin + 6, contentX = margin + 18, availableWidth = contentW - (contentX - margin);
      doc.fontSize(10).fillColor(c.text);

      for (let i = 0; i < termsToRender.length; i++) {
        const t = termsToRender[i];
        // Prepare the text piece(s)
        let parts;
        if (t.includes('–')) parts = t.split('–');
        else if (t.includes('-')) parts = t.split('-');
        else parts = [t];
        let label = parts.shift().trim();
        const rest = parts.join('–').trim();
        // Measure height for this combined bullet block
        let estH;
        if (!rest) estH = measureHeight(doc, label, availableWidth, 'Roboto', 10, 2);
        else {
          // estimate label (bold) + rest
          estH = measureHeight(doc, label + ' – ' + rest, availableWidth, 'Roboto', 10, 2) + 2;
        }
        // If not enough space for this bullet, add page and draw header again
        if (needPageBreak(doc, doc.y, estH + 12, 90)) {
          doc.addPage(); registerFonts(doc);
          // Reprint heading for continuation
          doc.font('Roboto-Bold').fontSize(11).fillColor(c.text).text('Terms & Conditions (contd.)', margin, doc.page.margins.top + 6, { width: contentW, align: 'left' });
          doc.y = doc.page.margins.top + 6 + 16;
        }
        const lineY = doc.y;
        doc.text('•', bulletX, lineY, { width: 10, align: 'left' });
        if (!rest) {
          doc.font('Roboto').text(label, contentX, lineY, { width: availableWidth, align: 'left' });
          doc.y = lineY + measureHeight(doc, label, availableWidth, 'Roboto', 10, 2) + 6;
        } else {
          doc.font('Roboto-Bold').text(label + ' – ', contentX, lineY, { continued: true, width: availableWidth, align: 'left' });
          doc.font('Roboto').text(rest, { continued: false, width: availableWidth, align: 'left' });
          doc.y = doc.y + 6;
        }
      }

      // after terms, small gap
      doc.moveDown(0.6);

      /* SIGN-OFF + SIGNATURE: ensure enough space for signature image (if present) */
      // approximate signature height
      const sigPath = findAsset(ASSETS.signature, 'compage_signature.png');
      const sigW = 140;
      let sigH = 0;
      if (sigPath && fs.existsSync(sigPath)) {
        // approximate signature height by fit ratio (we will display width sigW)
        // Rather than load image metadata (complex), reserve conservative height 60
        sigH = 60;
      }

      // estimate sign-off block height: sign lines + signature + bank block minimal
      const signLinesHeight = Math.ceil(measureHeight(doc, SIGN_OFF_LINES.join('\n'), contentW - 8, 'Roboto', 11, 2)) + 8;
      const requiredForSign = signLinesHeight + sigH + 40;

      if (needPageBreak(doc, doc.y, requiredForSign + 140, 90)) {
        // if not enough space for signature + bank details etc, start a new page
        doc.addPage(); registerFonts(doc);
        doc.y = doc.page.margins.top + 12;
      }

      // print sign-off lines
      doc.font('Roboto').fontSize(11).fillColor(c.text);
      SIGN_OFF_LINES.forEach((line) => {
        doc.text(line, margin + 4, doc.y, { width: contentW - 8, align: 'left' });
      });

      // signature if present
      if (sigPath && fs.existsSync(sigPath)) {
        try {
          doc.moveDown(0.6);
          const sigY = doc.y;
          doc.image(sigPath, margin + 12, sigY, { width: sigW });
          doc.y = sigY + sigH + 6;
        } catch (e) {
          logger.warn('Signature draw failed: ' + e.message);
        }
      } else {
        doc.moveDown(0.6);
      }

      // name line
      doc.font('Roboto').fontSize(11).fillColor(c.text);
      doc.text(SIGN_OFF_NAME, margin + 4, doc.y, { width: contentW - 8, align: 'left' });
      doc.y = doc.y + 8;

      /* BANK DETAILS: measure and ensure page-break if needed (again) */
      const bankLines = [
        'Account Details:',
        'NAME: COMPAGE AUTOMATION SYSTEMS PVT LTD',
        'BANK: AXIS BANK LTD',
        'BRANCH: SHOP NO 63 SLF MALL, INDRAPRASTHA COLONY, SECTOR 3033, FARIDABAD 121003',
        'ACCOUNT NUMBER: 923020007963713',
        'ACCOUNT TYPE: CURRENT',
        'RTGS CODE: UTIB0004676'
      ];
      const bankFontRegular = 'Roboto', bankFontBold = 'Roboto-Bold', bankFontSize = 10, bankHeadingSize = 11;
      let estimatedBankH = 16;
      bankLines.forEach((line, i) => {
        const font = (i === 0) ? bankFontBold : bankFontRegular;
        const size = (i === 0) ? bankHeadingSize : bankFontSize;
        estimatedBankH += Math.ceil(measureHeight(doc, line, contentW - 24, font, size, 2)) + 6;
      });
      if (needPageBreak(doc, doc.y, estimatedBankH, 90)) {
        doc.addPage(); registerFonts(doc);
        doc.y = doc.page.margins.top + 12;
      }

      // draw bank lines with explicit x,y
      let bankY = doc.y + 12;
      const leftX = margin + 4, bankWidth = contentW - 24;
      doc.font(bankFontBold).fontSize(bankHeadingSize).text(bankLines[0], leftX, bankY, { width: bankWidth, align: 'left' });
      bankY += Math.ceil(measureHeight(doc, bankLines[0], bankWidth, bankFontBold, bankHeadingSize, 2)) + 6;
      doc.font(bankFontRegular).fontSize(bankFontSize).text(bankLines[1], leftX, bankY, { width: bankWidth, align: 'left' });
      bankY += Math.ceil(measureHeight(doc, bankLines[1], bankWidth, bankFontRegular, bankFontSize, 2)) + 4;
      doc.text(bankLines[2], leftX, bankY, { width: bankWidth, align: 'left' });
      bankY += Math.ceil(measureHeight(doc, bankLines[2], bankWidth, bankFontRegular, bankFontSize, 2)) + 4;
      doc.text(bankLines[3], leftX, bankY, { width: bankWidth, align: 'left' });
      bankY += Math.ceil(measureHeight(doc, bankLines[3], bankWidth, bankFontRegular, bankFontSize, 2)) + 6;
      doc.text(bankLines[4], leftX, bankY, { width: bankWidth, align: 'left' });
      bankY += Math.ceil(measureHeight(doc, bankLines[4], bankWidth, bankFontRegular, bankFontSize, 2)) + 4;
      doc.text(bankLines[5], leftX, bankY, { width: bankWidth, align: 'left' });
      bankY += Math.ceil(measureHeight(doc, bankLines[5], bankWidth, bankFontRegular, bankFontSize, 2)) + 4;
      doc.text(bankLines[6], leftX, bankY, { width: bankWidth, align: 'left' });
      bankY += Math.ceil(measureHeight(doc, bankLines[6], bankWidth, bankFontRegular, bankFontSize, 2)) + 4;
      doc.y = bankY + 12;

      // final footer draw
      drawFooter();

      doc.end();
      return doc;
    } catch (err) {
      try { doc.end(); } catch (e) {}
      logger.error('Quotation generator error:', err);
      throw err;
    }
  }
}

module.exports = Quotation;
