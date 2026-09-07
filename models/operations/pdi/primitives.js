'use strict';

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');
const logger = require('../../../utils/logger');

/* ─── Font / asset paths ─────────────────────────────────────── */
const FONT_DIR  = path.join(__dirname, '../../../assets/fonts');
const ASSET_DIR = path.join(__dirname, '../../../assets');

let F  = 'Helvetica';       // regular
let FB = 'Helvetica-Bold';  // bold

const ROBOTO_REGULAR_PATH = path.join(FONT_DIR, 'Roboto-Regular.ttf');
const ROBOTO_BOLD_PATH    = path.join(FONT_DIR, 'Roboto-Bold.ttf');
const HAS_ROBOTO_REGULAR  = fs.existsSync(ROBOTO_REGULAR_PATH);
const HAS_ROBOTO_BOLD     = fs.existsSync(ROBOTO_BOLD_PATH);

function registerFonts(doc) {
  F  = 'Helvetica';
  FB = 'Helvetica-Bold';
  if (HAS_ROBOTO_REGULAR) {
    try { doc.registerFont('Roboto', ROBOTO_REGULAR_PATH); F = 'Roboto'; } catch { /* keep Helvetica */ }
  }
  if (HAS_ROBOTO_BOLD) {
    try { doc.registerFont('Roboto-Bold', ROBOTO_BOLD_PATH); FB = 'Roboto-Bold'; } catch { /* keep Helvetica-Bold */ }
  }
  doc.font(F);
}

// F/FB are mutated by registerFonts() per-document — callers that need the
// *current* bold/regular font name (anything drawing text) must call this
// fresh rather than caching the result, since it can change between renders.
function getFonts() {
  return { F, FB };
}

function assetPath(name) {
  const p = path.join(ASSET_DIR, name);
  return fs.existsSync(p) ? p : null;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** PDFKit's PNG support decompresses pixel data with the *async* zlib.inflate
 *  callback API and throws inside that callback on bad data — a throw that
 *  happens outside any call stack we control and cannot be caught by wrapping
 *  doc.image() in try/catch. So: replay the same decompression here with the
 *  *synchronous* zlib API first (catchable) and refuse to hand PDFKit
 *  anything that fails it. JPEGs never decompress pixels (DCTDecode passthrough)
 *  and only throw synchronously, so they don't need this pre-check. */
function isDecodablePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  const idatParts = [];
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const dataStart = pos + 8;
    const dataEnd = dataStart + len;
    if (len < 0 || dataEnd + 4 > buf.length) return false;
    if (type === 'IDAT') idatParts.push(buf.subarray(dataStart, dataEnd));
    if (type === 'IEND') break;
    pos = dataEnd + 4;
  }
  if (idatParts.length === 0) return false;
  try {
    zlib.inflateSync(Buffer.concat(idatParts));
    return true;
  } catch {
    return false;
  }
}

function decodeImageDataUri(dataUri) {
  if (!dataUri || typeof dataUri !== 'string') return null;
  const match = dataUri.match(/^data:image\/(png|jpe?g);base64,([a-z0-9+/=]+)$/i);
  if (!match) return null;
  let buf;
  try {
    buf = Buffer.from(match[2], 'base64');
  } catch {
    return null;
  }
  if (/^png$/i.test(match[1]) && !isDecodablePng(buf)) return null;
  return buf;
}

function drawImageInBox(doc, buf, x, y, w, h, pad = 2) {
  if (!buf) return false;
  try {
    doc.image(buf, x + pad, y + pad, { fit: [w - pad * 2, h - pad * 2], align: 'center', valign: 'center' });
    return true;
  } catch (e) {
    logger.warn('PDI image draw failed: ' + e.message);
    return false;
  }
}

function fmtDate(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt)) return '';
  return `${String(dt.getUTCDate()).padStart(2,'0')}/${String(dt.getUTCMonth()+1).padStart(2,'0')}/${dt.getUTCFullYear()}`;
}

/* ═══════════════════════════════════════════════════════════════
   Page-level constants
   ═══════════════════════════════════════════════════════════════ */
const M      = 36;
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const CW     = PAGE_W - M * 2;
const BOT_M  = 36;

/** Filled/stroked rectangle */
function box(doc, x, y, w, h, { fill, stroke = '#000', sw = 0.5 } = {}) {
  doc.save();
  if (fill)   doc.rect(x, y, w, h).fillColor(fill).fill();
  if (stroke) doc.rect(x, y, w, h).strokeColor(stroke).lineWidth(sw).stroke();
  doc.restore();
}

/** Text with always-explicit x, y — never relies on cursor. Forces
 *  single-line + ellipsis truncation since every caller passes `width` and
 *  none want PDFKit's default wrap-and-spill behavior. */
function t(doc, text, x, y, w, { font, size = 8, align = 'left', color = '#000', lb = false } = {}) {
  doc.save().font(font || F).fontSize(size).fillColor(color);
  const opts = { width: w, align, lineBreak: lb };
  if (!lb) {
    opts.height = doc.currentLineHeight(true);
    opts.ellipsis = true;
  }
  doc.text(String(text ?? ''), x, y, opts).restore();
}

/** Page number, drawn inside the bottom margin area. Safe only because the
 *  PDFDocument is constructed with margins.bottom: 0 — see renderer.js. */
function drawPageNum(doc, n, total) {
  const y = PAGE_H - BOT_M + 6;
  const pad = String(total).length;
  const label = `Pg ${String(n).padStart(pad, '0')} of ${String(total).padStart(pad, '0')}`;
  t(doc, label, M, y, CW, { font: F, size: 8, align: 'center', color: '#555' });
}

/** Draw a row list that overflows onto continuation pages. Starts a new page
 *  (redrawing the table header via `redrawHeader`) whenever the next row
 *  wouldn't fit, and — on the row that would be last — also reserves
 *  `footerHeight` so whatever follows on the page never gets orphaned. */
function drawPaginatedRows(doc, { rows, drawRow, rowHeight, y, footerHeight, redrawHeader }) {
  rows.forEach((row, idx) => {
    const reserve = idx === rows.length - 1 ? footerHeight : 0;
    if (y + rowHeight + reserve > PAGE_H - BOT_M) {
      doc.addPage();
      y = redrawHeader(10);
    }
    y = drawRow(doc, row, y);
  });
  if (rows.length === 0 && y + footerHeight > PAGE_H - BOT_M) {
    doc.addPage();
    y = redrawHeader(10);
  }
  return y;
}

/** Resolve a column-def array's widths: columns with an explicit `w` keep
 *  it, columns without one split the remaining `contentWidth` evenly. */
function resolveCols(defs, contentWidth) {
  const fixed = defs.reduce((s, c) => s + (c.w || 0), 0);
  const flexN = defs.filter(c => !c.w).length;
  const flexW = Math.max(40, (contentWidth - fixed) / (flexN || 1));
  return defs.map(c => ({ ...c, w: c.w || flexW }));
}

module.exports = {
  registerFonts, getFonts, assetPath,
  decodeImageDataUri, drawImageInBox,
  fmtDate, box, t, drawPageNum, drawPaginatedRows, resolveCols,
  M, PAGE_W, PAGE_H, CW, BOT_M,
};
