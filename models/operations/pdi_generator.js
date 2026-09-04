'use strict';

const PDFDocument = require('pdfkit');
const fs          = require('fs');
const path        = require('path');
const zlib        = require('zlib');
const logger      = require('../../utils/logger');

/* ─── Font / asset paths ─────────────────────────────────────── */
const FONT_DIR  = path.join(__dirname, '../../assets/fonts');
const ASSET_DIR = path.join(__dirname, '../../assets');

let F  = 'Helvetica';       // regular
let FB = 'Helvetica-Bold';  // bold

// Disk presence only needs checking once per process — font files don't
// change between requests. registerFonts() still calls doc.registerFont()
// per document (PDFKit's font table is per-instance), but skips the
// repeated fs.existsSync() stats. Relies on generate() staying fully
// synchronous (no await between doc creation and doc.end()), since F/FB
// are shared module state.
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

function assetPath(name) {
  const p = path.join(ASSET_DIR, name);
  return fs.existsSync(p) ? p : null;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** PDFKit's PNG support (via the bundled png-js) decompresses pixel data
 *  with the *async* zlib.inflate callback API, and throws inside that
 *  callback on bad data — that throw happens outside any call stack we
 *  control (deferred until the page is flushed), so it cannot be caught by
 *  wrapping doc.image() in try/catch and would crash the whole process.
 *  JPEG embedding, by contrast, never decompresses pixels (it's passed
 *  through to the PDF via DCTDecode) and only throws synchronously.
 *  So: for PNGs, replay the same decompression here with the *synchronous*
 *  zlib API first — a real throw is now on our stack and catchable — and
 *  refuse to hand PDFKit anything that fails it. */
function isDecodablePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  const idatParts = [];
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const dataStart = pos + 8;
    const dataEnd = dataStart + len;
    if (len < 0 || dataEnd + 4 > buf.length) return false; // truncated chunk
    if (type === 'IDAT') idatParts.push(buf.subarray(dataStart, dataEnd));
    if (type === 'IEND') break;
    pos = dataEnd + 4; // skip the 4-byte CRC
  }
  if (idatParts.length === 0) return false;
  try {
    zlib.inflateSync(Buffer.concat(idatParts));
    return true;
  } catch {
    return false;
  }
}

/** Decode a `data:image/png;base64,...` / `data:image/jpeg;base64,...` URI
 *  into a Buffer PDFKit can embed. Returns null for anything else (missing
 *  field, non-image data URI, unsupported type, malformed base64, or a PNG
 *  that fails the isDecodablePng() pre-check) so callers can fall back to
 *  their placeholder without a try/catch of their own. */
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

/** Draw an image buffer centered/contained within a box, falling back to
 *  nothing (caller's existing placeholder stays visible) if the buffer is
 *  missing or PDFKit can't decode it (e.g. corrupt data). */
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

/* ─── Date helper (UTC to avoid off-by-one) ──────────────────── */
function fmtDate(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt)) return '';
  return `${String(dt.getUTCDate()).padStart(2,'0')}/${String(dt.getUTCMonth()+1).padStart(2,'0')}/${dt.getUTCFullYear()}`;
}

/* ═══════════════════════════════════════════════════════════════
   Primitive draw helpers — every text call has explicit x, y
   so PDFKit's internal cursor never drifts below the page.
   ═══════════════════════════════════════════════════════════════ */

/** Filled/stroked rectangle */
function box(doc, x, y, w, h, { fill, stroke = '#000', sw = 0.5 } = {}) {
  doc.save();
  if (fill)   doc.rect(x, y, w, h).fillColor(fill).fill();
  if (stroke) doc.rect(x, y, w, h).strokeColor(stroke).lineWidth(sw).stroke();
  doc.restore();
}

/** Text with always-explicit x, y — never relies on cursor.
 *  PDFKit's `lineBreak: false` is a no-op whenever `width` is passed (as
 *  every call here does) — text that doesn't fit still wraps onto extra
 *  lines and spills past the row it was drawn in (e.g. a narrow "S. No"
 *  cell with "Specification" in it). No caller in this file ever wants
 *  that, so single-line + `ellipsis: true` truncation is forced here,
 *  clipped to one line's height via currentLineHeight(). */
function t(doc, text, x, y, w, { font, size = 8, align = 'left', color = '#000', lb = false } = {}) {
  doc.save().font(font || F).fontSize(size).fillColor(color);
  const opts = { width: w, align, lineBreak: lb };
  if (!lb) {
    opts.height = doc.currentLineHeight(true);
    opts.ellipsis = true;
  }
  doc.text(String(text ?? ''), x, y, opts).restore();
}

/* ═══════════════════════════════════════════════════════════════
   Page-level constants
   ═══════════════════════════════════════════════════════════════ */
const M      = 36;                    // left/right margin
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const CW     = PAGE_W - M * 2;       // 523.28 — content width
const BOT_M  = 36;                    // bottom margin

// Row heights
const HDR_H  = 60;   // header block height
const CN_H   = 14;   // company-name row
const INFO_H = 16;   // info rows (customer, product …)
const TH_H   = 28;   // electrical table header
const RH     = 14;   // data row height
const MTH_H  = 36;   // mechanical table header (2-level)
const GCH    = 14;   // general-check row height
const REM_H  = 40;   // remarks box
const SIG_H  = 36;   // signature box

/* ═══════════════════════════════════════════════════════════════
   Page 1 header — logo | title | format box
   ═══════════════════════════════════════════════════════════════ */
const LOGO_W = 110;
const FMT_W  = 140;
const TTL_W  = CW - LOGO_W - FMT_W;

function drawHeader(doc, data, y) {
  /* outer border */
  box(doc, M, y, CW, HDR_H, { stroke: '#000', sw: 0.8 });

  /* ── Logo section ── */
  const logo = assetPath('compage_header_left.png');
  if (logo) {
    try {
      doc.image(logo, M + 4, y + 4, { fit: [LOGO_W - 8, HDR_H - 8], align: 'center', valign: 'center' });
    } catch (e) { logger.warn('PDI logo draw failed: ' + e.message); }
  }
  // vertical divider after logo
  doc.save().strokeColor('#000').lineWidth(0.6)
     .moveTo(M + LOGO_W, y).lineTo(M + LOGO_W, y + HDR_H).stroke().restore();

  /* ── Title section ── */
  const tx = M + LOGO_W;
  t(doc, 'Pre Dispatch Inspection', tx, y + 10, TTL_W, { font: FB, size: 15, align: 'center' });
  t(doc, '(PDI)',                    tx, y + 32, TTL_W, { font: FB, size: 13, align: 'center' });

  // vertical divider before format box
  const fx = M + LOGO_W + TTL_W;
  doc.save().strokeColor('#000').lineWidth(0.6)
     .moveTo(fx, y).lineTo(fx, y + HDR_H).stroke().restore();

  /* ── Format info box ── */
  t(doc, 'Format No: CASPL/QA/F/14', fx + 4, y + 8,  FMT_W - 8, { font: FB, size: 7 });
  t(doc, 'Rev. No:00',               fx + 4, y + 22, FMT_W - 8, { font: FB, size: 7 });
  t(doc, 'Eff. Dt:01/01/2022',       fx + 4, y + 36, FMT_W - 8, { font: FB, size: 7 });

  /* ── Company name row below header ── */
  const cny = y + HDR_H;
  box(doc, M, cny, CW, CN_H, { stroke: '#000', sw: 0.5 });
  t(doc, 'Compage Automation Systems Pvt.Ltd.,', M + 4, cny + 3, CW - 8, { font: F, size: 8 });

  return cny + CN_H;
}

/* ── Info section (Customer Name, Date, Product ID …) ── */
function drawInfo(doc, data, y) {
  const half = CW / 2;
  const mx   = M + half;
  const rows = [
    ['Customer Name:', data.customer_name || '',             'Dt:',      data.date ? fmtDate(new Date(data.date)) : ''],
    ['Product ID:',   data.product_id    || '',             'Dwg. No:', data.drawing_no || ''],
    ['Product Specifications:', data.product_specifications || '', 'PDI No:', data.pdi_no || ''],
  ];
  rows.forEach(([lL, vL, lR, vR]) => {
    box(doc, M,   y, half, INFO_H, { stroke: '#000', sw: 0.4 });
    box(doc, mx,  y, half, INFO_H, { stroke: '#000', sw: 0.4 });
    t(doc, lL, M  + 3,   y + 4, 108,         { font: FB, size: 8 });
    t(doc, vL, M  + 114, y + 4, half - 118,  { font: F,  size: 8 });
    t(doc, lR, mx + 3,   y + 4, 55,          { font: FB, size: 8 });
    t(doc, vR, mx + 60,  y + 4, half - 64,   { font: F,  size: 8 });
    y += INFO_H;
  });
  return y;
}

/* ═══════════════════════════════════════════════════════════════
   Electrical table columns
   ═══════════════════════════════════════════════════════════════ */
// A motor is tested running in one rotation direction at a time — Forward
// (F) or Reverse (R), never both at once — so each row carries a single
// "direction" selector rather than separate F/R columns per measurement.
// Measurement column widths are sized to the widest header line ("RPM\nSPECIFIED"
// ≈ 34px at 7pt Roboto-Bold) plus the t() helper's 4px padding, with a small
// safety margin — otherwise the header text ellipsis-truncates (verified via
// doc.widthOfString()).
const ECOLS_DEF = [
  { key: 'sno',               label: 'S. No',              w: 22,  align: 'center' },
  { key: 'motor_sr_no',       label: 'Motor Sr. No',       w: 56,  align: 'center' },
  { key: 'voltage',           label: 'Voltage',            w: 32,  align: 'center' },
  { key: 'direction',         label: 'F / R',              w: 26,  align: 'center' },
  { key: 'current_standard',  label: 'Current\nStandard',  w: 40,  align: 'center' },
  { key: 'current_measured',  label: 'Current\nMeasured',  w: 40,  align: 'center' },
  { key: 'rpm_specified',     label: 'RPM\nSPECIFIED',    w: 42,  align: 'center' },
  { key: 'rpm_measured',      label: 'RPM\nMEASURED',     w: 42,  align: 'center' },
  { key: 'electrical_remarks',label: 'Remarks',            w: 0,   align: 'left'  },
];

function resolveCols(defs) {
  const fixed   = defs.reduce((s, c) => s + (c.w || 0), 0);
  const flexN   = defs.filter(c => !c.w).length;
  const flexW   = Math.max(40, (CW - fixed) / (flexN || 1));
  return defs.map(c => ({ ...c, w: c.w || flexW }));
}

const ECOLS = resolveCols(ECOLS_DEF);

function drawElecHeader(doc, y) {
  let x = M;
  ECOLS.forEach(c => {
    box(doc, x, y, c.w, TH_H, { fill: '#f0f0f0', stroke: '#000', sw: 0.5 });
    const lines = c.label.split('\n');
    const lh    = 8;
    const sy    = y + Math.max(3, (TH_H - lines.length * lh) / 2);
    lines.forEach((ln, i) => t(doc, ln, x + 2, sy + i * lh, c.w - 4, { font: FB, size: 7, align: 'center' }));
    x += c.w;
  });
  return y + TH_H;
}

function drawElecRow(doc, row, y) {
  let x = M;
  ECOLS.forEach(c => {
    box(doc, x, y, c.w, RH, { stroke: '#000', sw: 0.3 });
    t(doc, row[c.key] ?? '', x + 2, y + 3, c.w - 4, { font: F, size: 7.5, align: c.align });
    x += c.w;
  });
  return y + RH;
}

/* ═══════════════════════════════════════════════════════════════
   Mechanical table columns — with Mounting Holes sub-header
   ═══════════════════════════════════════════════════════════════ */
const MCOLS_DEF = [
  { key: 'sno',                 label: 'S. No',          w: 26,  align: 'center', group: null },
  { key: 'motor_sr_no',         label: 'Motor\nSr. No',  w: 52,  align: 'center', group: null },
  { key: 'motor_length',        label: 'Motor\nLength',  w: 44,  align: 'center', group: null },
  { key: 'shaft_length',        label: 'Shaft O/P\nD/Length', w: 50, align: 'center', group: null },
  { key: 'mounting_pcd',        label: 'PCD',            w: 40,  align: 'center', group: 'Mounting\nHoles' },
  { key: 'mtg',                 label: 'MTG',            w: 50,  align: 'center', group: 'Mounting\nHoles' },
  { key: 'key_dim_result',      label: 'Key\nDim.',      w: 34,  align: 'center', group: null },
  { key: 'locating_dia_result', label: 'Locating\nDia.', w: 38,  align: 'center', group: null },
  { key: 'mechanical_remarks',  label: 'Remarks',        w: 0,   align: 'left',   group: null },
];

const MCOLS = resolveCols(MCOLS_DEF);

// Defaults for the "Specification" row — overridden per-report by
// buildSpecVals() below from data.spec_* fields (all six are manual-entry
// values that vary by product, e.g. PCD/MTG differ between motor models).
const DEFAULT_SPEC_VALS = {
  motor_length:        '',
  shaft_length:        '',
  mounting_pcd:        '153',
  mtg:                 '1.M6 / 2.Ø8.0',
  key_dim_result:      'Go/NG',
  locating_dia_result: '50.0 mm',
};

function buildSpecVals(data) {
  return {
    motor_length:        data.spec_motor_length || DEFAULT_SPEC_VALS.motor_length,
    shaft_length:        data.spec_shaft_length || DEFAULT_SPEC_VALS.shaft_length,
    mounting_pcd:        data.spec_mounting_pcd || DEFAULT_SPEC_VALS.mounting_pcd,
    mtg:                 data.spec_mtg          || DEFAULT_SPEC_VALS.mtg,
    key_dim_result:      data.spec_key_dim      || DEFAULT_SPEC_VALS.key_dim_result,
    locating_dia_result: data.spec_locating_dia || DEFAULT_SPEC_VALS.locating_dia_result,
  };
}

function drawMechHeader(doc, y) {
  const h1 = 18, h2 = 18;  // top / bottom sub-header heights

  // Find the Mounting Holes group span
  const mhCols = MCOLS.filter(c => c.group === 'Mounting\nHoles');
  const mhX    = M + MCOLS.slice(0, MCOLS.indexOf(mhCols[0])).reduce((s, c) => s + c.w, 0);
  const mhW    = mhCols.reduce((s, c) => s + c.w, 0);

  let x = M;
  MCOLS.forEach(c => {
    const inGroup = c.group === 'Mounting\nHoles';
    if (!inGroup) {
      // spans full height
      box(doc, x, y, c.w, h1 + h2, { fill: '#f0f0f0', stroke: '#000', sw: 0.5 });
      const lines = c.label.split('\n');
      const lh    = 8;
      const sy    = y + Math.max(3, (h1 + h2 - lines.length * lh) / 2);
      lines.forEach((ln, i) => t(doc, ln, x + 2, sy + i * lh, c.w - 4, { font: FB, size: 7, align: 'center' }));
    }
    x += c.w;
  });

  // Mounting Holes — group header (top)
  box(doc, mhX, y, mhW, h1, { fill: '#f0f0f0', stroke: '#000', sw: 0.5 });
  t(doc, 'Mounting Holes', mhX + 2, y + 5, mhW - 4, { font: FB, size: 7, align: 'center' });

  // Sub-cells (bottom)
  let sx = mhX;
  mhCols.forEach(c => {
    box(doc, sx, y + h1, c.w, h2, { fill: '#f0f0f0', stroke: '#000', sw: 0.5 });
    const lines = c.label.split('\n');
    const lh    = 7;
    const sy    = y + h1 + Math.max(2, (h2 - lines.length * lh) / 2);
    lines.forEach((ln, i) => t(doc, ln, sx + 2, sy + i * lh, c.w - 4, { font: FB, size: 6.5, align: 'center' }));
    sx += c.w;
  });

  return y + h1 + h2;
}

function drawMechSpecRow(doc, specVals, y) {
  let x = M;
  MCOLS.forEach((c, i) => {
    const val = i === 0 ? 'Specification' : (specVals[c.key] || '');
    box(doc, x, y, c.w, RH, { fill: '#fffde7', stroke: '#000', sw: 0.3 });
    t(doc, val, x + 2, y + 3, c.w - 4, {
      font:  i === 0 ? FB : F,
      size:  i === 0 ? 6.5 : 7.5,
      align: i === 0 ? 'left' : 'center',
    });
    x += c.w;
  });
  return y + RH;
}

function drawMechRow(doc, row, y) {
  let x = M;
  MCOLS.forEach(c => {
    const val = row[c.key] ?? '';
    box(doc, x, y, c.w, RH, { stroke: '#000', sw: 0.3 });
    t(doc, val, x + 2, y + 3, c.w - 4, { font: F, size: 7.5, align: c.align });
    x += c.w;
  });
  return y + RH;
}

/* ═══════════════════════════════════════════════════════════════
   General checks table
   ═══════════════════════════════════════════════════════════════ */
function drawGeneralChecks(doc, checks, data, y) {
  const lW = Math.round(CW * 0.50);
  const sW = 55, mW = 55;
  const rW = CW - lW - sW - mW;
  const xs = [M, M + lW, M + lW + sW, M + lW + sW + mW];
  const ws = [lW, sW, mW, rW];

  // header row
  ['General Check', 'Specified', 'Measured', 'Remarks'].forEach((h, i) => {
    box(doc, xs[i], y, ws[i], GCH, { fill: '#f0f0f0', stroke: '#000', sw: 0.5 });
    t(doc, h, xs[i] + 3, y + 3, ws[i] - 6, { font: FB, size: 7.5, align: 'center' });
  });
  y += GCH;

  checks.forEach(chk => {
    const entry = data[chk.key] || {};
    ws.forEach((w, i) => box(doc, xs[i], y, w, GCH, { stroke: '#000', sw: 0.3 }));
    t(doc, chk.label,             xs[0] + 3, y + 3, ws[0] - 6, { font: F, size: 7.5 });
    t(doc, 'Go/NG',               xs[1] + 3, y + 3, ws[1] - 6, { font: F, size: 7.5, align: 'center' });
    t(doc, entry.measured || 'GO',xs[2] + 3, y + 3, ws[2] - 6, { font: F, size: 7.5, align: 'center' });
    t(doc, entry.remarks  || 'OK',xs[3] + 3, y + 3, ws[3] - 6, { font: F, size: 7.5, align: 'center' });
    y += GCH;
  });
  return y;
}

/* ── Remarks ── */
function drawRemarks(doc, text, y) {
  box(doc, M, y, CW, REM_H, { stroke: '#000', sw: 0.4 });
  t(doc, 'Remarks:', M + 4, y + 8, 58,       { font: FB, size: 8 });
  t(doc, text || '', M + 64, y + 8, CW - 68, { font: F,  size: 8 });
  return y + REM_H;
}

/* ── Signatures ── */
function drawSig(doc, prepBy, appBy, y) {
  const half = CW / 2;
  box(doc, M,        y, half, SIG_H, { stroke: '#000', sw: 0.4 });
  box(doc, M + half, y, half, SIG_H, { stroke: '#000', sw: 0.4 });
  t(doc, 'Prepared By', M + 4,        y + 6,  half - 8, { font: FB, size: 8 });
  t(doc, prepBy || '',  M + 4,        y + 20, half - 8, { font: F,  size: 8 });
  t(doc, 'Approved By', M + half + 4, y + 6,  half - 8, { font: FB, size: 8 });
  t(doc, appBy  || '',  M + half + 4, y + 20, half - 8, { font: F,  size: 8 });
  return y + SIG_H;
}

/* ── Page number, drawn inside the bottom margin area. Safe only because
      margins.bottom is 0 (see the PDFDocument construction below) — PDFKit
      would otherwise auto-insert a blank page after text drawn this low. ── */
function drawPageNum(doc, n, total) {
  // Place it just above the physical bottom edge, inside BOT_M area
  const y = PAGE_H - BOT_M + 6;
  const pad = String(total).length;
  const label = `Pg ${String(n).padStart(pad, '0')} of ${String(total).padStart(pad, '0')}`;
  t(doc, label, M, y, CW, { font: F, size: 8, align: 'center', color: '#555' });
}

/* ── Draw a row list that overflows onto continuation pages ──
   Starts a new page (redrawing the table header via `redrawHeader`)
   whenever the next row wouldn't fit, and — on the row that would be
   last — also reserves `footerHeight` so the general-checks/remarks/
   signature block that follows never gets pushed off the page it
   was reserved on. */
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

/* ── Photos — 2-column grid, auto-paginating onto extra pages when a
      row of 2 wouldn't fit the current page. Mirrors drawPaginatedRows'
      overflow logic, adapted for a 2-up image grid instead of 1 row. ── */
const PHOTO_GAP  = 8;
const PHOTO_LBL_H = 16;
const PHOTO_IMG_H = 150;
const PHOTO_ROW_H = PHOTO_LBL_H + PHOTO_IMG_H + 8;
const PHOTO_CELL_W = (CW - PHOTO_GAP) / 2;

function drawPhotosHeader(doc, y) {
  box(doc, M, y, CW, 18, { stroke: '#000', sw: 0.5 });
  t(doc, 'PHOTOS:', M + 4, y + 5, CW - 8, { font: FB, size: 9 });
  return y + 18 + 6;
}

function drawPhotoCell(doc, photo, index, x, y) {
  const label = (photo.label || '').trim() || `Photo ${index + 1}`;
  box(doc, x, y, PHOTO_CELL_W, PHOTO_LBL_H, { stroke: '#000', sw: 0.5 });
  t(doc, `${index + 1}. ${label}`, x + 4, y + 4, PHOTO_CELL_W - 8, { font: FB, size: 8.5 });
  const imgY = y + PHOTO_LBL_H;
  box(doc, x, imgY, PHOTO_CELL_W, PHOTO_IMG_H, { stroke: '#000', sw: 0.5 });
  drawImageInBox(doc, decodeImageDataUri(photo.image), x, imgY, PHOTO_CELL_W, PHOTO_IMG_H);
}

function drawPhotoGrid(doc, photos, y) {
  y = drawPhotosHeader(doc, y);
  for (let i = 0; i < photos.length; i += 2) {
    if (y + PHOTO_ROW_H > PAGE_H - BOT_M) {
      doc.addPage();
      y = drawPhotosHeader(doc, 10);
    }
    drawPhotoCell(doc, photos[i], i, M, y);
    if (photos[i + 1]) {
      drawPhotoCell(doc, photos[i + 1], i + 1, M + PHOTO_CELL_W + PHOTO_GAP, y);
    }
    y += PHOTO_ROW_H;
  }
  return y;
}

/* ═══════════════════════════════════════════════════════════════
   Main generator
   ═══════════════════════════════════════════════════════════════ */
class PDIGenerator {
  static generate(data = {}) {
    if (!data.pdi_no) throw new Error('pdi_no required');

    // Only render rows that have a motor serial number filled in
    const allRows    = Array.isArray(data.rows) ? data.rows : [];
    const activeRows = allRows
      .filter(r => r && String(r.motor_sr_no || '').trim())
      .map((r, i) => ({ ...r, sno: r.sno ?? i + 1 }));

    const gElec = data.general_electrical || {};
    const gMech = data.general_mechanical || {};

    const doc = new PDFDocument({
      size: 'A4',
      // bottom:0 — every draw call in this file uses explicit x/y and our
      // own PAGE_H/BOT_M-based overflow checks (drawPaginatedRows), never
      // PDFKit's flowing layout. Any non-zero bottom margin makes PDFKit's
      // own maxY() = height - margins.bottom trigger *its* auto page-break
      // on any text() call (they all pass `width`, see t()) positioned
      // past that line — which drawPageNum's footer text always is by
      // design — silently inserting a blank page after every page.
      margins: { top: 10, bottom: 0, left: M, right: M },
      autoFirstPage: false,
      // Total page count isn't known until every row/section is laid out
      // (row overflow can add continuation pages), so page numbers are
      // filled in afterward via switchToPage() rather than inline.
      bufferPages: true,
    });
    registerFonts(doc);

    const ELEC_CHECKS = [
      { key: 'sound',            label: 'All Motors Sound' },
      { key: 'high_voltage',     label: 'All Motors High Voltage Breakdown Check' },
      { key: 'insulation',       label: 'All Motors Insulation Check' },
      { key: 'phase_resistance', label: 'All Motors Phase Resistance Check' },
      { key: 'hall_sensor',      label: 'All Motors Hall Sensor Connector Check' },
    ];
    const powerCableLength  = data.power_cable_length  || '1250±50mm';
    const sensorCableLength = data.sensor_cable_length || '1250±50mm';
    const MECH_CHECKS = [
      { key: 'power_cable',      label: `All Motor Power Cable Length ${powerCableLength}` },
      { key: 'sensor_cable',     label: `All Motor Sensor Cable Length ${sensorCableLength}` },
      { key: 'bolt_tightening',  label: 'All Motor Bolt Tightening Check' },
      { key: 'paint_check',      label: 'All Motor Paint Check (If Applicable)' },
    ];

    /* ═══════════════════════════════
       PAGE 1 — Electrical Check
       ═══════════════════════════════ */
    doc.addPage();

    let y = 10;
    y = drawHeader(doc, data, y);   // returns y after company-name row
    y += 4;
    y = drawInfo(doc, data, y);
    y += 6;
    y = drawElecHeader(doc, y);

    const elecFooterH = GCH * (1 + ELEC_CHECKS.length) + 6 + REM_H + 6 + SIG_H + 8;
    y = drawPaginatedRows(doc, {
      rows: activeRows,
      drawRow: drawElecRow,
      rowHeight: RH,
      y,
      footerHeight: elecFooterH,
      redrawHeader: (py) => drawElecHeader(doc, py),
    });
    y += 6;
    y = drawGeneralChecks(doc, ELEC_CHECKS, gElec, y);
    y += 6;
    y = drawRemarks(doc, data.electrical_remarks || 'ALL MOTORS OK, PASSED.', y);
    y += 8;
    drawSig(doc, data.prepared_by, data.approved_by, y);

    /* ═══════════════════════════════
       PAGE 2 — Mechanical Check
       ═══════════════════════════════ */
    doc.addPage();
    y = 10;

    // Title
    t(doc, 'Mechanical Dimensional Check sheet', M, y, CW, { font: FB, size: 13, align: 'center' });
    y += 20;

    // Technical drawing — real image when supplied, else placeholder + spec annotations
    const diagH = 100;
    box(doc, M, y, CW, diagH, { stroke: '#000', sw: 0.6 });
    const drawingBuf = decodeImageDataUri(data.drawing_image);
    if (drawingBuf && drawImageInBox(doc, drawingBuf, M, y, CW, diagH)) {
      // Image fills the box; skip the placeholder text/spec overlay so it isn't drawn on top.
    } else {
      t(doc, `[Motor Technical Drawing — Dwg No: ${data.drawing_no || '____'}]`,
        M + 8, y + diagH / 2 - 5, CW - 16, { font: F, size: 8, color: '#aaa', align: 'center' });
      // Spec annotations inside diagram box
      t(doc, 'PCD ø152.74 ±0.10',                                  M + 6,             y + 6,  120,      { font: F, size: 6.5, color: '#555' });
      t(doc, 'Temp. & Hall Sensor Cable 1250±50 mm · 8Pin Connector', M + CW * 0.35,  y + 6,  CW * 0.4, { font: F, size: 6.5, color: '#555', align: 'center' });
      t(doc, 'Motor Power Cable 1250±50 mm',                        M + CW * 0.35,    y + 16, CW * 0.4, { font: F, size: 6.5, color: '#555', align: 'center' });
    }
    y += diagH + 8;

    // Mechanical table: header → spec row → data rows
    y = drawMechHeader(doc, y);
    y = drawMechSpecRow(doc, buildSpecVals(data), y);

    const mechFooterH = GCH * (1 + MECH_CHECKS.length) + 6 + REM_H + 6 + SIG_H + 8;
    y = drawPaginatedRows(doc, {
      rows: activeRows,
      drawRow: drawMechRow,
      rowHeight: RH,
      y,
      footerHeight: mechFooterH,
      // Continuation pages repeat only the column header, not the spec row
      redrawHeader: (py) => drawMechHeader(doc, py),
    });
    y += 6;
    y = drawGeneralChecks(doc, MECH_CHECKS, gMech, y);
    y += 6;
    y = drawRemarks(doc, data.mechanical_remarks || 'ALL MOTORS OK, PASSED.', y);
    y += 8;
    drawSig(doc, data.prepared_by, data.approved_by, y);

    /* ═══════════════════════════════
       PAGE 3 — Photos
       ═══════════════════════════════ */
    doc.addPage();
    y = 10;

    const photosList = Array.isArray(data.photos)
      ? data.photos.filter((p) => p && ((p.label && p.label.trim()) || p.image))
      : [];
    drawPhotoGrid(doc, photosList, y);

    // Number every physical page (including any continuation pages
    // created by drawPaginatedRows) now that the true total is known.
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      drawPageNum(doc, i + 1, range.count);
    }

    doc.end();
    return doc;
  }
}

module.exports = PDIGenerator;
