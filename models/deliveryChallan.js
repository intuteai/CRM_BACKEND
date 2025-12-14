const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const FONT_DIR = path.join(__dirname, '../assets/fonts');

const COMPANY_NAME = 'COMPAGE AUTOMATION SYSTEMS PVT. LTD.';
const COMPANY_ADDR =
  '20-21, New DLF Industrial Area, Faridabad-121003, Haryana (INDIA)';
const COMPANY_GST = '06AAACC3923F1Z4';

function safeExists(p) {
  try {
    return !!(p && fs.existsSync(p));
  } catch (e) {
    return false;
  }
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

// Shared function to build the entire PDF content
function buildPDF(doc, data) {
  if (!data.challan_no) throw new Error('challan_no required');

  registerFonts(doc);

  const pageW = doc.page.width;
  const margin = doc.page.margins.left;
  const innerW = pageW - margin * 2;
  const black = '#000000';

  // ========= HEADER =========
  doc
    .font('Roboto-Bold')
    .fontSize(16)
    .fillColor(black)
    .text(COMPANY_NAME, margin, 24, { width: innerW, align: 'center' });

  doc
    .font('Roboto')
    .fontSize(9)
    .fillColor(black)
    .text(COMPANY_ADDR, margin, 44, { width: innerW, align: 'center' });

  const topLineY = 64;
  doc
    .moveTo(margin, topLineY)
    .lineTo(margin + innerW, topLineY)
    .lineWidth(1)
    .strokeColor(black)
    .stroke();

  doc
    .font('Roboto-Bold')
    .fontSize(14)
    .fillColor(black)
    .text('DELIVERY CHALLAN', margin, topLineY + 8, {
      width: innerW,
      align: 'center',
    });

  doc
    .font('Roboto-Bold')
    .fontSize(10)
    .fillColor(black)
    .text(`GST No.: ${COMPANY_GST}`, margin, topLineY + 28, {
      width: innerW,
      align: 'center',
    });

  const bottomLineY = topLineY + 46;
  doc
    .moveTo(margin, bottomLineY)
    .lineTo(margin + innerW, bottomLineY)
    .lineWidth(1)
    .strokeColor(black)
    .stroke();

  let y = bottomLineY + 8;

  // ========= TO SECTION + META BOX =========
  const leftW = Math.round(innerW * 0.55);
  const rightW = innerW - leftW;

  const toName = data.to_name || '';
  const toAddress = data.to_address || '';
  const gstParty = data.to_gst_number ? `GST No.: ${data.to_gst_number}` : '';

  doc.font('Roboto-Bold').fontSize(10).fillColor(black);
  doc.text('To,', margin, y, { width: leftW });
  y += 14;
  doc.text('M/s.', margin, y, { width: leftW });
  y += 16;

  doc.font('Roboto').fontSize(9).fillColor(black);

  if (toName) {
    doc.text(toName, margin, y, { width: leftW, align: 'left' });
    y += 12;
  }
  if (toAddress) {
    doc.text(toAddress, margin, y, { width: leftW, align: 'left' });
    y += doc.heightOfString(toAddress, { width: leftW, align: 'left' }) + 2;
  }
  if (gstParty) {
    doc.text(gstParty, margin, y, { width: leftW, align: 'left' });
  }

  const metaX = margin + leftW + 8;
  const metaY = bottomLineY + 8;
  const rowH = 18;
  const rows = 3;
  const metaH = rowH * rows;

  doc.rect(metaX, metaY, rightW - 8, metaH).lineWidth(1).strokeColor(black).stroke();

  for (let i = 1; i < rows; i++) {
    const ly = metaY + i * rowH;
    doc.moveTo(metaX, ly).lineTo(metaX + rightW - 8, ly).strokeColor(black).lineWidth(0.8).stroke();
  }

  const colMid = metaX + (rightW - 8) / 2;

  function metaRow(labelLeft, valueLeft, labelRight, valueRight, idx) {
    const baseY = metaY + idx * rowH + 4;
    doc.font('Roboto').fontSize(9).fillColor(black);

    doc.text(labelLeft, metaX + 4, baseY, { width: (rightW - 8) / 2 - 8, align: 'left' });
    doc.text(valueLeft || '', metaX + 4 + 70, baseY, { width: (rightW - 8) / 2 - 70, align: 'left' });

    if (labelRight) doc.text(labelRight, colMid + 4, baseY, { width: (rightW - 8) / 2 - 8, align: 'left' });
    if (valueRight) doc.text(valueRight || '', colMid + 4 + 60, baseY, { width: (rightW - 8) / 2 - 60, align: 'left' });
  }

  const challanDate = data.date ? new Date(data.date) : null;
  const challanDateStr = challanDate ? challanDate.toLocaleDateString('en-GB') : '';
  const orderDate = data.order_date ? new Date(data.order_date) : null;
  const orderDateStr = orderDate ? orderDate.toLocaleDateString('en-GB') : '';

  metaRow('Challan No.:', data.challan_no || '', 'Date:', challanDateStr, 0);
  metaRow('Order No.:', data.order_no || '', 'Order Date:', orderDateStr, 1);
  metaRow('Vehicle No.:', data.vehicle_no || '', '', '', 2);

  y = metaY + metaH + 16;
  const aboveTableText = 'Received the under mentioned goods in good & ordered condition.';
  doc.font('Roboto').fontSize(9).fillColor(black).text(aboveTableText, margin, y, { width: innerW, align: 'left' });
  y += 18;

  // ========= ITEMS TABLE =========
  const tableX = margin;
  const tableW = innerW;
  const colNoW = 40;
  const colDescW = Math.round(tableW * 0.55);
  const colQtyW = 70;
  const colRemarksW = tableW - colNoW - colDescW - colQtyW;

  const headerY = y;
  doc.rect(tableX, headerY, tableW, 20).lineWidth(1).strokeColor(black).stroke();

  doc.font('Roboto-Bold').fontSize(10).fillColor(black);
  doc.text('No.', tableX + 4, headerY + 4, { width: colNoW - 8, align: 'center' });
  doc.text('Description', tableX + colNoW + 4, headerY + 4, { width: colDescW - 8, align: 'left' });
  doc.text('Qty', tableX + colNoW + colDescW + 4, headerY + 4, { width: colQtyW - 8, align: 'center' });
  doc.text('Remarks', tableX + colNoW + colDescW + colQtyW + 4, headerY + 4, { width: colRemarksW - 8, align: 'left' });

  let rowY = headerY + 20;
  const rowMinH = 22;

  const items = Array.isArray(data.items) && data.items.length
    ? data.items
    : [{ productName: '', qty: '', remarks: '' }];

  doc.font('Roboto').fontSize(9).fillColor(black);

  items.forEach((it, idx) => {
    const desc = it.productName || '';   // ✅ ONLY product name – strict requirement

    const qty = it.qty != null ? String(it.qty) : '';
    const remarks = it.remarks || '';

    const descH = doc.heightOfString(desc || ' ', {
      width: colDescW - 8,
      align: 'left',
    });
    const cellH = Math.max(rowMinH, descH + 6);

    doc.rect(tableX, rowY, tableW, cellH).stroke();

    doc.text(String(idx + 1), tableX + 4, rowY + 4, {
      width: colNoW - 8,
      align: 'center',
    });
    doc.text(desc, tableX + colNoW + 4, rowY + 4, {
      width: colDescW - 8,
      align: 'left',
    });
    doc.text(qty, tableX + colNoW + colDescW + 4, rowY + 4, {
      width: colQtyW - 8,
      align: 'center',
    });
    doc.text(remarks, tableX + colNoW + colDescW + colQtyW + 4, rowY + 4, {
      width: colRemarksW - 8,
      align: 'left',
    });

    rowY += cellH;
  });

  // ========= TEXT BELOW TABLE =========
  rowY += 10;
  const belowTableText =
    'Any descrepancy or rejection should be intimated to us within 2 days of receipt of good, failing which no complaints will be entertained. Guarantee of goods will be void if two copies of delivery challan are not duly signed and returned immediately on reciept of goods.';
  doc.font('Roboto').fontSize(9).fillColor(black).text(belowTableText, margin, rowY, { width: innerW, align: 'left' });

  rowY += doc.heightOfString(belowTableText, { width: innerW, align: 'left' }) + 30;

  // ========= SIGNATURE AREA =========
  const signY = rowY;
  doc.font('Roboto').fontSize(10).fillColor(black).text("Receiver's Signature", margin, signY, { width: innerW / 2 - 20, align: 'left' });
  doc.font('Roboto-Bold').fontSize(10).fillColor(black).text(`For ${COMPANY_NAME}`, margin + innerW / 2, signY, { width: innerW / 2, align: 'right' });

  rowY = signY + 40;

  // ========= FOOTER =========
  const factoryText =
    'Registered Office & Factory: 20-21, New DLF Industrial Area, Faridabad-121003 Phone: (0129) 4072336 E-mail : infocompageautomtion@gmail.com';
  doc.font('Roboto-Bold').fontSize(9).fillColor(black).text(factoryText, margin, rowY, { width: innerW, align: 'center' });

  rowY += 26;
  const lastLineText = 'NUMERIC CONTROL – DC DRIVE – AC DRIVE – SERVO MOTOR/ DRIVE – ENCODER – TACHO';
  doc.font('Roboto-Bold').fontSize(9).fillColor(black).text(lastLineText, margin, rowY, { width: innerW, align: 'center' });
}

class DeliveryChallan {
  static generate(data = {}) {
    const doc = new PDFDocument({ size: 'A4', margin: 24 });

    try {
      buildPDF(doc, data);
      doc.end();
      return doc;
    } catch (err) {
      try { doc.end(); } catch (e) {}
      logger.error('Delivery challan generator error:', err);
      throw err;
    }
  }

  static generateBuffer(data = {}) {
    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({ size: 'A4', margin: 24 });

        const chunks = [];
        doc.on('data', (c) => chunks.push(c));
        doc.on('end', () => {
          try {
            const buffer = Buffer.concat(chunks);
            resolve(buffer);
          } catch (e) {
            reject(e);
          }
        });
        doc.on('error', (err) => {
          logger.error('PDF generation streaming error:', err);
          reject(err);
        });

        try {
          buildPDF(doc, data);
          doc.end();
        } catch (err) {
          try { doc.end(); } catch (e) {}
          logger.error('PDF generation inner error:', err);
          reject(err);
        }
      } catch (err) {
        logger.error('generateBuffer outer error:', err);
        reject(err);
      }
    });
  }
}

module.exports = DeliveryChallan;