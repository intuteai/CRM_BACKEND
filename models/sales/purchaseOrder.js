const PDFDocument = require('pdfkit');
const fs          = require('fs');
const path        = require('path');
const logger      = require('../../utils/logger');

/* ─── Fonts ─────────────────────────────────────────────────────── */
const FONT_DIR = path.join(__dirname, '../../assets/fonts');

function registerFonts(doc) {
  const tryReg = (name, file) => {
    const p = path.join(FONT_DIR, file);
    if (fs.existsSync(p)) try { doc.registerFont(name, p); } catch (_) {}
  };
  tryReg('Roboto',      'Roboto-Regular.ttf');
  tryReg('Roboto-Bold', 'Roboto-Bold.ttf');
  try { doc.font('Roboto'); } catch (_) { doc.font('Helvetica'); }
}

/* ─── Helpers ────────────────────────────────────────────────────── */
function measureH(doc, text, width, font, size, lineGap = 2) {
  doc.save();
  try {
    if (font) doc.font(font);
    if (size) doc.fontSize(size);
    const h = doc.heightOfString(String(text ?? ''), { width, lineGap });
    doc.restore();
    return h;
  } catch (_) { doc.restore(); return 14; }
}
function fmtDate(val) {
  if (!val) return '';
  const d = val instanceof Date ? val : new Date(val);
  if (isNaN(d.getTime())) return String(val);
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
}
function fmtNum(n) {
  const v = Number(n || 0);
  return Number.isFinite(v)
    ? v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '0.00';
}

/* ─── Assets ─────────────────────────────────────────────────────── */
const ASSET_DIR = path.join(__dirname, '../../assets');
function getAsset(f) {
  const p = path.join(ASSET_DIR, f);
  if (fs.existsSync(p)) return p;
  const p2 = path.join(__dirname, '../assets', f);
  return fs.existsSync(p2) ? p2 : null;
}

/* ─── Static content ─────────────────────────────────────────────── */
const CO_LEFT = [
  'ST/CST NO. FBD/CST/HGST/1209965',
  'Dt. 5/1/94',
  'Tin No. 06031209965',
  'ECC No. AAACC3923FXM001',
  'GST No. 06AAACC3923F1Z4',
];
const CO_RIGHT = [
  'RC NO. 79/R/V/DIV/FBD/94',
  'Collectorate: New Delhi',
  'Range: XXII FBD',
  'DIV: V FBD',
];
const DEFAULT_NOTES = [
  '1. To ensure prompt action, please quote our order number & date on all future correspondence, challan, bills etc.',
  '2. Please send acceptance of this order immediately if nothing to the contrary is heard within 10 days from date of order, the order shall be deemed to have been accepted by you.',
];
const DEFAULT_TERMS = [
  'The rates prevailing at the time',
  'a) Price Basis : Ex-Faridabad',
  'b) Taxes : GST Extra',
  'c) Payment Terms : After Delivery',
  'd) Delivery : Immediate',
];
const FOOTER1 = 'Registered Office & Factory: 20-21, New DLF Industrial Area, Faridabad-121003, Phone: (0129) 4072336,';
const FOOTER2 = 'E-mail : infocompageautomation@gmail.com,   Website: www.compageauto.com';

const FOOTER_ROW_H = 18;

/* ════════════════════════════════════════════════════════════════════
   PurchaseOrder
   ════════════════════════════════════════════════════════════════════ */
class PurchaseOrder {
  static generate(data = {}) {
    if (!data.po_no) throw new Error('po_no required');

    const doc   = new PDFDocument({ size: 'A4', margin: 36 });
    registerFonts(doc);

    const mg    = 36;
    const pageW = doc.page.width;
    const pageH = doc.page.height;
    const cW    = pageW - mg * 2;

    doc.on('pageAdded', () => { registerFonts(doc); });

    try {
      /* ── constants ───────────────────────────────────────────── */
      const LW      = 0.75;
      const FS_INFO = 8.5;
      const FS_ORD  = 9;
      const FS_TBL  = 9;
      const INFO_LH = 13;
      const halfX   = mg + cW / 2;
      const halfW   = cW / 2 - 10;

      /* ── prepare data ────────────────────────────────────────── */
      const toName  = data.to_name    ? String(data.to_name).trim()    : '';
      const toAddr  = data.to_address ? String(data.to_address).trim() : '';
      const dateStr = data.date
        ? (String(data.date).includes('/') ? data.date : fmtDate(new Date(data.date)))
        : fmtDate(new Date());
      const refDate = data.ref_date
        ? (String(data.ref_date).includes('/') ? data.ref_date : fmtDate(new Date(data.ref_date)))
        : '';
      const notes     = Array.isArray(data.notes) && data.notes.length ? data.notes : DEFAULT_NOTES;
      const notesText = notes.join('\n\n');
      const terms     = Array.isArray(data.terms) && data.terms.length ? data.terms : DEFAULT_TERMS;
      const items     = Array.isArray(data.items) ? data.items : [];

      /* ── table column widths ─────────────────────────────────── */
      const cSno  = Math.round(cW * 0.055);
      const cDesc = Math.round(cW * 0.330);
      const cQty  = Math.round(cW * 0.095);
      const cUnit = Math.round(cW * 0.125);
      const cTot  = Math.round(cW * 0.130);
      const cDisc = Math.round(cW * 0.095);
      const cNet  = cW - cSno - cDesc - cQty - cUnit - cTot - cDisc;
      const xSno  = mg;
      const xDesc = xSno  + cSno;
      const xQty  = xDesc + cDesc;
      const xUnit = xQty  + cQty;
      const xTot  = xUnit + cUnit;
      const xDisc = xTot  + cTot;
      const xNet  = xDisc + cDisc;
      const colXs = [xDesc, xQty, xUnit, xTot, xDisc, xNet];

      /* ── section height estimates ────────────────────────────── */
      const LOGO_W  = 55;
      const LOGO_H  = 45;
      const HDR_H   = LOGO_H + 10;
      const INFO_H  = Math.max(CO_LEFT.length, CO_RIGHT.length) * INFO_LH + 10;

      const notesH  = measureH(doc, notesText, halfW - 6, 'Roboto', FS_ORD, 3);
      const rightH  = 2 * 13 + 6 + notesH;

      // ── Constrained widths for To name rendering ──────────────
      // "To, " prefix takes ~18px at 9pt; name gets the remainder
      const toPrefixW   = 18;
      const nameRenderW = halfW - 10 - toPrefixW; // width available for name text

      const toNameText  = toName ? toName : '';

      // Measure name height within its actual render width
      const nameLineH = toNameText
        ? measureH(doc, toNameText, nameRenderW, 'Roboto', FS_ORD, 2)
        : 0;

      // Address block height within left column
      const addrH = toAddr
        ? measureH(doc, toAddr, halfW - 10, 'Roboto', FS_ORD, 2)
        : 0;

      // Left column: ORDER No + DATE rows (2×13) + To/name row + address + padding
      const LEFT_FIXED_ROWS = 2;
      const toRowH          = Math.max(13, nameLineH + 4);
      const leftH           = LEFT_FIXED_ROWS * 13 + toRowH + addrH + 16;
      const ORD_H           = Math.max(leftH, rightH) + 12;

      const TBL_HDR_H = 20;
      const TOT_ROW_H = 20;
      const itemRowHs = items.length === 0
        ? [22, 22, 22]
        : items.map(it => {
            const d = String(it.description || '');
            return Math.max(22, Math.ceil(measureH(doc, d, cDesc - 10, 'Roboto', FS_TBL, 2)) + 10);
          });

      const TERMS_HEADING_H = 16;
      const termsRowHs = terms.map(t => measureH(doc, t, cW - 12, 'Roboto-Bold', 9.5, 2) + 5);
      const TERMS_H = TERMS_HEADING_H + termsRowHs.reduce((s, h) => s + h, 0) + 14;

      const SIG_IMG_H = 60;
      const BOX_TOP   = mg;

      /* ── helpers ─────────────────────────────────────────────── */
      function hRule(y) {
        doc.save().strokeColor('#000000').lineWidth(LW * 0.8)
           .moveTo(mg, y).lineTo(mg + cW, y).stroke().restore();
      }
      function vLines(rowY, rowH, xs) {
        doc.save().strokeColor('#000000').lineWidth(LW * 0.6);
        xs.forEach(x => doc.moveTo(x, rowY).lineTo(x, rowY + rowH).stroke());
        doc.restore();
      }

      /* ══════════════════════════════════════════════════════════
         SECTION 1 — HEADER
         ══════════════════════════════════════════════════════════ */
      let curY = BOX_TOP;

      const leftLogo  = getAsset('compage_header_left.png');
      const rightLogo = getAsset('compage_header_right.png');
      const logoY     = curY + (HDR_H - LOGO_H) / 2;

      if (leftLogo)
        try { doc.image(leftLogo,  mg + 4, logoY, { fit: [LOGO_W, LOGO_H], valign: 'center' }); }
        catch (e) { logger.warn('Left logo: ' + e.message); }
      if (rightLogo)
        try { doc.image(rightLogo, pageW - mg - LOGO_W - 4, logoY, { fit: [LOGO_W, LOGO_H], valign: 'center' }); }
        catch (e) { logger.warn('Right logo: ' + e.message); }

      const titleX = mg + LOGO_W + 8;
      const titleW = cW - (LOGO_W + 8) * 2;
      doc.font('Roboto-Bold').fontSize(14).fillColor('#000000')
         .text('COMPAGE AUTOMATION SYSTEMS PVT. LTD.', titleX, curY + 10, { width: titleW, align: 'center' });
      doc.font('Roboto-Bold').fontSize(11).fillColor('#000000')
         .text('PURCHASE ORDER', titleX, curY + 28, { width: titleW, align: 'center' });

      curY += HDR_H;
      hRule(curY);

      /* ══════════════════════════════════════════════════════════
         SECTION 2 — COMPANY INFO
         ══════════════════════════════════════════════════════════ */
      vLines(curY, INFO_H, [halfX]);

      doc.font('Roboto').fontSize(FS_INFO).fillColor('#000000');
      CO_LEFT.forEach((line, i) => {
        doc.text(line, mg + 6, curY + 5 + i * INFO_LH, { width: halfW, lineBreak: false });
      });
      CO_RIGHT.forEach((line, i) => {
        doc.text(line, halfX + 6, curY + 5 + i * INFO_LH, { width: halfW, lineBreak: false });
      });

      curY += INFO_H;
      hRule(curY);

      /* ══════════════════════════════════════════════════════════
         SECTION 3 — ORDER DETAILS
         ══════════════════════════════════════════════════════════ */
      vLines(curY, ORD_H, [halfX]);

      // Divider below ORDER No. + DATE rows
      hRule(curY + 32);

      // ── Left column ──────────────────────────────────────────
      let lY = curY + 6;

      doc.font('Roboto').fontSize(FS_ORD).fillColor('#000000');
      doc.text(`ORDER No. ${data.po_no}`, mg + 6, lY, { width: halfW - 4, lineBreak: false });
      lY += 13;
      doc.text(`DATE – ${dateStr}`, mg + 6, lY, { width: halfW - 4, lineBreak: false });
      lY += 13;

      // ── Render "To, " bold + name wrapped within left column ──
      // Both "To, " and the name are constrained to halfW - 10 total width.
      // lineBreak: true ensures long names wrap instead of overflowing.
      doc.font('Roboto-Bold').fontSize(FS_ORD).fillColor('#000000')
         .text('To, ', mg + 6, lY, { continued: true, width: halfW - 10 });
      doc.font('Roboto').fontSize(FS_ORD).fillColor('#000000')
         .text(toNameText, { continued: false, width: nameRenderW, lineBreak: true });

      // Advance lY by the measured height of the name (min 13px)
      lY += Math.max(13, nameLineH + 2);

      // Address — constrained to left column, wraps naturally
      if (toAddr) {
        doc.font('Roboto').fontSize(FS_ORD).fillColor('#000000')
           .text(toAddr, mg + 6, lY, { width: halfW - 10, lineGap: 2 });
      }

      // ── Right column ─────────────────────────────────────────
      let rY = curY + 6;
      doc.font('Roboto').fontSize(FS_ORD).fillColor('#000000');
      doc.text(`Ref No. – ${data.ref_no || ''}`, halfX + 6, rY, { width: halfW }); rY += 13;
      doc.text(`Date – ${refDate}`,               halfX + 6, rY, { width: halfW }); rY += 18;
      doc.text(notesText, halfX + 6, rY, { width: halfW - 4, lineGap: 3 });

      curY += ORD_H;
      hRule(curY);

      /* ══════════════════════════════════════════════════════════
         SECTION 4 — ITEMS TABLE
         ══════════════════════════════════════════════════════════ */
      vLines(curY, TBL_HDR_H, colXs);
      doc.font('Roboto-Bold').fontSize(FS_TBL).fillColor('#000000');
      const thY = curY + 6;
      doc.text('S.No.',       xSno  + 2, thY, { width: cSno  - 4, align: 'center' });
      doc.text('Description', xDesc + 4, thY, { width: cDesc - 6, align: 'center' });
      doc.text('Qty. (KG)',   xQty  + 2, thY, { width: cQty  - 4, align: 'center' });
      doc.text('Unit price',  xUnit + 2, thY, { width: cUnit - 4, align: 'center' });
      doc.text('Total Price', xTot  + 2, thY, { width: cTot  - 4, align: 'center' });
      doc.text('Discount',    xDisc + 2, thY, { width: cDisc - 4, align: 'center' });
      doc.text('Net Price',   xNet  + 2, thY, { width: cNet  - 4, align: 'center' });

      curY += TBL_HDR_H;
      hRule(curY);

      let grandNet = 0;

      function drawItemRow(item, idx, rowH) {
        const desc    = String(item.description || '');
        const qty     = Number(item.qty        || 0);
        const unit    = Number(item.unit_price || 0);
        const total   = Number(item.total_price != null ? item.total_price : qty * unit);
        const discPct = Number(item.discount   != null ? item.discount    : 0);
        const net     = Number(item.net_price  != null ? item.net_price   : total * (1 - discPct / 100));
        grandNet += Number.isFinite(net) ? net : 0;

        vLines(curY, rowH, colXs);
        doc.font('Roboto').fontSize(FS_TBL).fillColor('#000000');
        const midY = curY + Math.max(5, Math.floor((rowH - FS_TBL) / 2));
        doc.text(String(idx + 1), xSno  + 2, midY,     { width: cSno  - 4, align: 'center' });
        doc.text(desc,            xDesc + 4, curY + 5, { width: cDesc - 6, align: 'left'   });
        doc.text(String(qty),     xQty  + 2, midY,     { width: cQty  - 4, align: 'center' });
        doc.text(fmtNum(unit),    xUnit + 2, midY,     { width: cUnit - 4, align: 'right'  });
        doc.text(fmtNum(total),   xTot  + 2, midY,     { width: cTot  - 4, align: 'right'  });
        doc.text(discPct > 0 ? `${discPct}%` : '0%', xDisc + 2, midY, { width: cDisc - 4, align: 'center' });
        doc.text(fmtNum(net),     xNet  + 2, midY,     { width: cNet  - 4, align: 'right'  });
        curY += rowH;
        hRule(curY);
      }

      if (items.length === 0) {
        itemRowHs.forEach(rowH => {
          vLines(curY, rowH, colXs);
          curY += rowH;
          hRule(curY);
        });
      } else {
        items.forEach((it, i) => drawItemRow(it, i, itemRowHs[i]));
      }

      // Grand total row
      vLines(curY, TOT_ROW_H, colXs);
      doc.font('Roboto-Bold').fontSize(FS_TBL).fillColor('#000000')
         .text(fmtNum(grandNet), xNet + 2, curY + 5, { width: cNet - 4, align: 'right' });
      curY += TOT_ROW_H;
      hRule(curY);

      /* ══════════════════════════════════════════════════════════
         SECTION 5 — TERMS & CONDITIONS
         ══════════════════════════════════════════════════════════ */
      let tY = curY + 6;
      doc.font('Roboto-Bold').fontSize(10).fillColor('#000000')
         .text('Terms & Conditions:', mg + 6, tY);
      tY += TERMS_HEADING_H;

      terms.forEach((t, i) => {
        doc.font('Roboto-Bold').fontSize(9.5).fillColor('#000000')
           .text(t, mg + 6, tY, { width: cW - 12 });
        tY += termsRowHs[i];
      });

      curY += TERMS_H;

      /* ══════════════════════════════════════════════════════════
         SECTION 6 — SIGN-OFF
         ══════════════════════════════════════════════════════════ */
      let sY = curY + 10;
      doc.font('Roboto').fontSize(10).fillColor('#000000')
         .text('For Compage Automation Systems Pvt. Ltd.', mg + 6, sY, { width: cW - 12 });
      sY += 14 + 10;

      const sigFile = getAsset('compage_signature.png');
      if (sigFile) {
        try { doc.image(sigFile, mg + 10, sY, { width: 130 }); }
        catch (e) { logger.warn('Signature: ' + e.message); }
      }
      sY += SIG_IMG_H + 10;

      doc.font('Roboto').fontSize(10).fillColor('#000000')
         .text('Authorized Signatory', mg + 6, sY, { width: cW - 12 });

      sY += 20;

      /* ══════════════════════════════════════════════════════════
         SECTION 7 — FOOTER
         ══════════════════════════════════════════════════════════ */
      hRule(sY);
      sY += 4;
      doc.font('Roboto').fontSize(8).fillColor('#000000')
         .text(FOOTER1, mg, sY, { width: cW, align: 'center' });
      sY += FOOTER_ROW_H;

      hRule(sY);
      sY += 4;
      doc.font('Roboto').fontSize(8).fillColor('#000000')
         .text(FOOTER2, mg, sY, { width: cW, align: 'center' });
      sY += FOOTER_ROW_H;

      /* ── Draw outer box ──────────────────────────────────────── */
      doc.rect(mg, BOX_TOP, cW, sY - BOX_TOP)
         .strokeColor('#000000').lineWidth(LW).stroke();

      doc.end();
      return doc;
    } catch (err) {
      try { doc.end(); } catch (_) {}
      logger.error('PO generator error:', err);
      throw err;
    }
  }
}

module.exports = PurchaseOrder;