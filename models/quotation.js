// models/quotation.js
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
      try {
        doc.registerFont(name, p);
        return true;
      } catch (e) {
        logger.warn(`Failed to register font ${file}: ${e.message}`);
      }
    }
    return false;
  };
  const hasRegular = reg('Roboto', 'Roboto-Regular.ttf');
  const hasBold = reg('Roboto-Bold', 'Roboto-Bold.ttf');
  const hasMedium = reg('Roboto-Medium', 'Roboto-Medium.ttf');

  try {
    doc.font(hasRegular ? 'Roboto' : 'Helvetica');
  } catch (e) {
    doc.font('Helvetica');
  }
}

/* small helpers */
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
/**
 * needPageBreak checks if (y + neededHeight) would go past the usable page bottom.
 * Default marginBottom increased so footer won't be overlapped (footer+padding reserve).
 */
function needPageBreak(doc, y, neededHeight, marginBottom = 80) {
  const bottom = doc.page.height - marginBottom;
  return (y + neededHeight) > bottom;
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

/**
 * Keep the footer as a single string; PDFKit will wrap it if needed.
 * We will draw it flush to the bottom on every page.
 */
const FIXED_FOOTER = "Factory:20-21,NewDLFIndustrialArea,Faridabad-121003,Phone: 9311856598  E-mail : sales@compageauto@gmail.com, Website: www.compageauto.com";

/* Standardized asset paths */
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

    // color palette
    const c = {
      primary: '#0b6b24',
      text: '#000000',
      muted: '#6b7280',
      border: '#c9c9c9',
      white: '#ffffff'
    };

    const pageW = doc.page.width;
    const pageH = doc.page.height;
    const margin = doc.page.margins.left;
    const contentW = pageW - margin - doc.page.margins.right;

    // draw footer function — will be called for every page (including first).
    function drawFooter() {
      try {
        registerFonts(doc);
        const footerHeight = 36; // approximate height reserved for footer
        doc.fillColor(c.muted).fontSize(9).font('Roboto');
        doc.text(FIXED_FOOTER, margin, doc.page.height - doc.page.margins.bottom - footerHeight + 6, {
          width: contentW,
          align: 'center',
        });
        // draw a subtle line above footer to separate content (optional)
        doc.save();
        doc.strokeColor('#e6e6e6').lineWidth(0.5);
        doc.moveTo(margin, doc.page.height - doc.page.margins.bottom - footerHeight - 4);
        doc.lineTo(pageW - margin, doc.page.height - doc.page.margins.bottom - footerHeight - 4);
        doc.stroke();
        doc.restore();
      } catch (e) {
        logger.warn('Footer draw failed: ' + e.message);
      }
    }

    // ensure footer is drawn on each newly added page
    doc.on('pageAdded', () => {
      drawFooter();
      registerFonts(doc);
    });

    try {
      // --- Header logos + title ---
      doc.rect(0, 0, pageW, 6).fill(c.white);

      const headerY = 18;
      const logoMaxW = 60;
      const logoMaxH = 40;
      const leftLogo = findAsset(ASSETS.headerLeft, 'compage_header_left.png');
      const rightLogo = findAsset(ASSETS.headerRight, 'compage_header_right.png');

      if (leftLogo) {
        try {
          doc.image(leftLogo, margin, headerY, { fit: [logoMaxW, logoMaxH], valign: 'center' });
        } catch (e) { logger.warn('left logo draw failed:' + e.message); }
      }
      if (rightLogo) {
        try {
          const rightX = pageW - doc.page.margins.right - logoMaxW;
          doc.image(rightLogo, rightX, headerY, { fit: [logoMaxW, logoMaxH], valign: 'center' });
        } catch (e) { logger.warn('right logo draw failed:' + e.message); }
      }

      doc.font('Roboto-Bold').fontSize(18).fillColor(c.primary);
      doc.text('COMPAGE AUTOMATION SYSTEMS PVT.LTD.', 0, headerY + 6, { width: pageW, align: 'center' });

      // draw footer for the first page right away so every page has footer
      drawFooter();

      // Meta row: QuotationNo (left) and Date (right)
      const metaY = headerY + 56;
      doc.font('Roboto').fontSize(11).fillColor(c.text);
      doc.text(`QuotationNo.${data.quotation_no}`, margin, metaY, { align: 'left' });

      const dateStr = data.date ? (String(data.date).includes('/') ? String(data.date) : formatDDMMYYYY(new Date(data.date))) : formatDDMMYYYY(new Date());
      const dateBoxW = 160;
      const dateX = pageW - doc.page.margins.right - dateBoxW;
      doc.text(`Date: ${dateStr}`, dateX, metaY, { width: dateBoxW, align: 'right' });

      // reduce extra vertical gap here but keep a consistent gap from header and footer reserves
      doc.y = metaY + 20;

      // --- To block (left) and Kind Attn / Sub center ---
      // Start position for To block
      doc.font('Roboto-Bold').fontSize(14).fillColor(c.text);
      doc.text('To,', margin, doc.y);

      // dotted placeholder helper (preserves newlines)
      const dots = (val, lines = 4) => {
        if (val && String(val).trim().length) return String(val);
        return Array.from({length: lines}).map(()=>'………………….').join('\n');
      };
      doc.font('Roboto').fontSize(11).fillColor(c.text);

      const toText = dots(data.to_address, 4);
      // Choose width for address block, and a smaller lineGap to keep good spacing
      const toBlockWidth = Math.max(320, contentW * 0.55);
      // Render the to-address block starting at margin + 8 (indent)
      // Use explicit lineGap to prevent overly tight or loose lines
      doc.text(toText, margin + 8, doc.y + 6, { width: toBlockWidth, lineGap: 4 });

      // After rendering the address block, use current doc.y to place Kind Attn / Sub
      const afterToY = doc.y;
      const kindText = (data.kind_attn && String(data.kind_attn).trim().length) ? data.kind_attn : '……………';
      const subText = (data.subject_item && String(data.subject_item).trim().length) ? data.subject_item : '______________';

      // place Kind Attn just below the To block with a small gap
      const kindY = afterToY + 8;
      doc.font('Roboto-Bold').fontSize(13).fillColor(c.text).text(`Kind Attn: ${kindText}`, 0, kindY, { width: pageW, align: 'center' });

      const subY = kindY + 16;
      doc.font('Roboto-Bold').fontSize(13).fillColor(c.text).text(`Sub: Quotation for ${subText}`, 0, subY, { width: pageW, align: 'center' });

      // move the cursor below sub
      doc.y = subY + 18;

      // Intro
      const intro = data.intro || 'We are pleased to quote you our best prices for the following items:';
      doc.font('Roboto').fontSize(11).fillColor(c.text);
      doc.text(intro, margin, doc.y);

      doc.moveDown(0.4);

      // --- Items table header & rows ---
      const tableX = margin;
      let tableY = doc.y;
      const colSnoW = 60;
      const colDescW = contentW - colSnoW - 140 - 100;
      const colUnitW = 140;
      const colTotalW = 100;

      function drawTableHeader(yPos) {
        doc.font('Roboto-Bold').fontSize(11).fillColor(c.text);
        doc.rect(tableX, yPos - 2, contentW, 24).strokeColor(c.border).lineWidth(0.6).stroke();
        doc.text('S. No.', tableX + 6, yPos, { width: colSnoW - 10, align: 'left' });
        doc.text('Description', tableX + colSnoW + 6, yPos, { width: colDescW - 10, align: 'left' });
        doc.text('Unit Price (INR)', tableX + colSnoW + colDescW + 6, yPos, { width: colUnitW - 10, align: 'right' });
        doc.text('Total Price (INR)', tableX + colSnoW + colDescW + colUnitW + 6, yPos, { width: colTotalW - 10, align: 'right' });
        return yPos + 28;
      }

      tableY = drawTableHeader(tableY);

      const items = Array.isArray(data.items) ? data.items : [];
      let runningY = tableY;
      let subtotal = 0;

      function drawRow(item, idx) {
        const sno = item.sno ?? (idx + 1);
        const desc = item.description ?? '………………';
        const unit = Number(item.unit_price || 0);
        const total = Number(item.total_price != null ? item.total_price : unit);
        subtotal += total;

        const descH = measureHeight(doc, desc, colDescW - 12, 'Roboto', 11, 4);
        const amountH = measureHeight(doc, formatINR(total), colTotalW - 12, 'Roboto', 11, 2);
        const rowH = Math.max(26, Math.ceil(Math.max(descH, amountH)) + 12);

        if (needPageBreak(doc, runningY, rowH + 60)) {
          doc.addPage();
          registerFonts(doc);
          runningY = drawTableHeader(doc.y + 6);
        }

        doc.rect(tableX, runningY - 2, contentW, rowH).strokeColor(c.border).lineWidth(0.4).stroke();

        doc.font('Roboto').fontSize(11).fillColor(c.text).text(`${sno}.`, tableX + 6, runningY + 6, { width: colSnoW - 10, align: 'left' });
        doc.text(desc, tableX + colSnoW + 6, runningY + 6, { width: colDescW - 10, align: 'left' });
        doc.text(formatINR(unit), tableX + colSnoW + colDescW + 6, runningY + 6, { width: colUnitW - 10, align: 'right' });
        doc.text(formatINR(total), tableX + colSnoW + colDescW + colUnitW + 6, runningY + 6, { width: colTotalW - 10, align: 'right' });

        runningY += rowH + 2;
      }

      if (items.length === 0) {
        drawRow({ description: '……………………………………', unit_price: 0, total_price: 0 }, 0);
      } else {
        items.forEach((it, idx) => drawRow(it, idx));
      }

      // GST extra row centered below rows
      if (needPageBreak(doc, runningY, 80)) {
        doc.addPage();
        registerFonts(doc);
        runningY = doc.y + 6;
      }

      const gstY = runningY + 6;
      doc.rect(tableX, gstY - 4, contentW, 34).strokeColor(c.border).lineWidth(0.4).stroke();
      doc.font('Roboto').fontSize(11).fillColor(c.text);
      doc.text(`GST extra @IGST-${data.gst_percent ?? 18}%`, tableX + 18, gstY + 8, { width: contentW - 36, align: 'left' });

      runningY = gstY + 34 + 6;

      // Totals (right aligned)
      const gstPercent = Number(data.gst_percent != null ? data.gst_percent : 18);
      const gstAmount = Number((subtotal * gstPercent) / 100);
      const grandTotal = subtotal + gstAmount;

      const totalsW = 260;
      const totalsX = pageW - margin - totalsW;
      const labelW = totalsW - 120;
      const amtW = 120;

      // choose consistent line height for totals
      const totalsFontSize = 11;
      const lineGap = 6;
      doc.fontSize(totalsFontSize).fillColor(c.text);

      let yTotals = runningY;
      // Subtotal
      doc.font('Roboto').text('Subtotal', totalsX, yTotals, { width: labelW, align: 'right' });
      doc.text(formatINR(subtotal), totalsX + labelW, yTotals, { width: amtW, align: 'right' });

      // advance exact measured height to ensure rows align
      const singleLineH = measureHeight(doc, 'Subtotal', labelW + amtW, 'Roboto', totalsFontSize, lineGap);
      yTotals += singleLineH + 4;

      // GST %
      doc.font('Roboto').text(`GST @ ${gstPercent}%`, totalsX, yTotals, { width: labelW, align: 'right' });
      doc.text(formatINR(gstAmount), totalsX + labelW, yTotals, { width: amtW, align: 'right' });

      yTotals += singleLineH + 4;

      // Grand Total (bold)
      doc.font('Roboto-Bold').fontSize(12).text('Grand Total', totalsX, yTotals, { width: labelW, align: 'right' });
      doc.text(formatINR(grandTotal), totalsX + labelW, yTotals, { width: amtW, align: 'right' });

      runningY = yTotals + 12;

      // Terms & Conditions (server enforced)
      const termsToRender = (Array.isArray(data.terms) && data.allowOverrideTerms === true) ? data.terms : STANDARD_TERMS;

      if (needPageBreak(doc, runningY, 220)) {
        doc.addPage();
        registerFonts(doc);
        runningY = doc.y + 6;
      }

      // Place heading explicitly at left
      const termsY = runningY + 6;
      doc.font('Roboto-Bold').fontSize(11).fillColor(c.text).text('Terms & Conditions', margin, termsY, { align: 'left' });

      // start bullet list just below the heading
      doc.y = termsY + 12;

      // Bullet layout - ensure bullets align with wrapped text
      const bulletX = margin + 6;
      const contentX = margin + 18;
      const availableWidth = contentW - (contentX - margin);

      doc.fontSize(10).fillColor(c.text);

      termsToRender.forEach((t) => {
        // split at en-dash or hyphen (prefer en-dash)
        let parts;
        if (t.includes('–')) parts = t.split('–');
        else if (t.includes('-')) parts = t.split('-');
        else parts = [t];

        let label = parts.shift().trim();
        const rest = parts.join('–').trim();

        // capture baseline Y
        const lineY = doc.y;

        // draw bullet glyph (small area)
        doc.text('•', bulletX, lineY, { width: 10, align: 'left' });

        if (!rest) {
          doc.font('Roboto').text(label, contentX, lineY, { width: availableWidth, align: 'left' });
          doc.y = lineY + measureHeight(doc, label, availableWidth, 'Roboto', 10, 2) + 4;
          return;
        }

        // draw label (bold) and remainder (normal) on same paragraph with wrapping
        doc.font('Roboto-Bold').text(label + ' – ', contentX, lineY, { continued: true, width: availableWidth, align: 'left' });
        doc.font('Roboto').text(rest, { continued: false, width: availableWidth, align: 'left' });

        // small gap after each bullet line
        doc.moveDown(0.18);
      });

      // Immediately after terms show sign-off lines in requested order:
      // "Thanking you."
      // "For Compage Automation Systems Pvt. Ltd."
      // signature image (if present)
      // "Anil Aggarwal (M:9999982595)"

      // small gap before sign-off
      doc.moveDown(0.6);

      // Sign-off text lines
      doc.font('Roboto').fontSize(11).fillColor(c.text);
      SIGN_OFF_LINES.forEach(line => doc.text(line, margin + 4));

      // signature image (if present) directly after "For Compage..." and before name
      const sigPath = findAsset(ASSETS.signature, 'compage_signature.png');
      if (sigPath && fs.existsSync(sigPath)) {
        try {
          const sigW = 140;
          const sigX = margin + 12;
          // small gap to position signature under "For Compage..."
          doc.moveDown(0.6);
          const sigY = doc.y;
          doc.image(sigPath, sigX, sigY, { width: sigW });
          // move the cursor below the signature
          doc.y = sigY + 60;
        } catch (e) { logger.warn('Signature draw failed: ' + e.message); }
      } else {
        doc.moveDown(0.6);
      }

      // finally the name/phone line
      doc.font('Roboto').fontSize(11).fillColor(c.text);
      doc.text(SIGN_OFF_NAME, margin + 4);

      // Make sure footer exists for the last page (in case of no 'pageAdded' triggers after last page)
      drawFooter();

      doc.end();
      return doc;

    } catch (err) {
      try { doc.end(); } catch(e) {}
      logger.error('Quotation generator error:', err);
      throw err;
    }
  }
}

module.exports = Quotation;
