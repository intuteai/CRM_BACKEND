'use strict';

const PDFDocument = require('pdfkit');
const fs          = require('fs');
const path        = require('path');
const logger      = require('../../utils/logger');

/* ─── Font / asset paths ─────────────────────────────────────── */
const FONT_DIR  = path.join(__dirname, '../../assets/fonts');
const ASSET_DIR = path.join(__dirname, '../../assets');

let F  = 'Helvetica';       // regular
let FB = 'Helvetica-Bold';  // bold

function registerFonts(doc) {
  const reg = (name, file) => {
    const p = path.join(FONT_DIR, file);
    if (!fs.existsSync(p)) return false;
    try { doc.registerFont(name, p); return true; } catch { return false; }
  };
  if (reg('Roboto',      'Roboto-Regular.ttf')) F  = 'Roboto';
  if (reg('Roboto-Bold', 'Roboto-Bold.ttf'))    FB = 'Roboto-Bold';
  doc.font(F);
}

function assetPath(name) {
  const p = path.join(ASSET_DIR, name);
  return fs.existsSync(p) ? p : null;
}

/* ─── Date helper (UTC to avoid off-by-one) ──────────────────── */
function fmtDate(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt)) return String(d);
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

/** Text with always-explicit x, y — never relies on cursor */
function t(doc, text, x, y, w, { font, size = 8, align = 'left', color = '#000', lb = false } = {}) {
  doc.save()
     .font(font || F).fontSize(size).fillColor(color)
     .text(String(text ?? ''), x, y, { width: w, align, lineBreak: lb })
     .restore();
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
const ECOLS_DEF = [
  { key: 'sno',               label: 'S. No',              w: 28,  align: 'center' },
  { key: 'motor_sr_no',       label: 'Motor Sr. No',       w: 60,  align: 'center' },
  { key: 'voltage',           label: 'Voltage',            w: 38,  align: 'center' },
  { key: 'current_standard',  label: 'Current\nStandard F',w: 44,  align: 'center' },
  { key: 'current_measured',  label: 'Current\nMeasured F',w: 44,  align: 'center' },
  { key: 'rpm_specified',     label: 'RPM\nSPECIFIED F',  w: 44,  align: 'center' },
  { key: 'rpm_measured',      label: 'RPM\nMEASURED F',   w: 44,  align: 'center' },
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
  { key: '_mtg',                label: 'MTG\n1.M6/2.Ø8.0', w: 50, align: 'center', group: 'Mounting\nHoles' },
  { key: 'key_dim_result',      label: 'Key\nDim.',      w: 34,  align: 'center', group: null },
  { key: 'locating_dia_result', label: 'Locating\nDia.', w: 38,  align: 'center', group: null },
  { key: 'mechanical_remarks',  label: 'Remarks',        w: 0,   align: 'left',   group: null },
];

const MCOLS = resolveCols(MCOLS_DEF);

// Spec values shown in the "Specification" row
const SPEC_VALS = {
  mounting_pcd:        '153',
  _mtg:                '1.M6 / 2.Ø8.0',
  key_dim_result:      'Go/NG',
  locating_dia_result: '50.0 mm',
};

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

function drawMechSpecRow(doc, y) {
  let x = M;
  MCOLS.forEach((c, i) => {
    const val = i === 0 ? 'Specification' : (SPEC_VALS[c.key] || '');
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
    const val = c.key === '_mtg' ? '' : (row[c.key] ?? '');
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

/* ── Page number — drawn WITHIN the bottom margin so PDFKit
      never auto-adds a blank page ── */
function drawPageNum(doc, n, total) {
  // Place it just above the physical bottom edge, inside BOT_M area
  const y = PAGE_H - BOT_M + 6;
  t(doc, `Pg 0${n} of 0${total}`, M, y, CW, { font: F, size: 8, align: 'center', color: '#555' });
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
      // top:10 gives us full control of the header region;
      // PDFKit's auto-break threshold = PAGE_H - BOT_M = 805.89
      margins: { top: 10, bottom: BOT_M, left: M, right: M },
      autoFirstPage: false,
    });
    registerFonts(doc);

    const ELEC_CHECKS = [
      { key: 'sound',            label: 'All Motors Sound' },
      { key: 'high_voltage',     label: 'All Motors High Voltage Breakdown Check' },
      { key: 'insulation',       label: 'All Motors Insulation Check' },
      { key: 'phase_resistance', label: 'All Motors Phase Resistance Check' },
      { key: 'hall_sensor',      label: 'All Motors Hall Sensor Connector Check' },
    ];
    const MECH_CHECKS = [
      { key: 'power_cable',      label: 'All Motor Power Cable Length 1250±50mm' },
      { key: 'sensor_cable',     label: 'All Motor Sensor Cable Length 1250±50mm' },
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
    activeRows.forEach(row => { y = drawElecRow(doc, row, y); });
    y += 6;
    y = drawGeneralChecks(doc, ELEC_CHECKS, gElec, y);
    y += 6;
    y = drawRemarks(doc, data.electrical_remarks || 'ALL MOTORS OK, PASSED.', y);
    y += 8;
    drawSig(doc, data.prepared_by, data.approved_by, y);
    drawPageNum(doc, 1, 3);

    /* ═══════════════════════════════
       PAGE 2 — Mechanical Check
       ═══════════════════════════════ */
    doc.addPage();
    y = 10;

    // Title
    t(doc, 'Mechanical Dimensional Check sheet', M, y, CW, { font: FB, size: 13, align: 'center' });
    y += 20;

    // Technical drawing placeholder
    const diagH = 100;
    box(doc, M, y, CW, diagH, { stroke: '#000', sw: 0.6 });
    t(doc, `[Motor Technical Drawing — Dwg No: ${data.drawing_no || '____'}]`,
      M + 8, y + diagH / 2 - 5, CW - 16, { font: F, size: 8, color: '#aaa', align: 'center' });
    // Spec annotations inside diagram box
    t(doc, 'PCD ø152.74 ±0.10',                                  M + 6,             y + 6,  120,      { font: F, size: 6.5, color: '#555' });
    t(doc, 'Temp. & Hall Sensor Cable 1250±50 mm · 8Pin Connector', M + CW * 0.35,  y + 6,  CW * 0.4, { font: F, size: 6.5, color: '#555', align: 'center' });
    t(doc, 'Motor Power Cable 1250±50 mm',                        M + CW * 0.35,    y + 16, CW * 0.4, { font: F, size: 6.5, color: '#555', align: 'center' });
    y += diagH + 8;

    // Mechanical table: header → spec row → data rows
    y = drawMechHeader(doc, y);
    y = drawMechSpecRow(doc, y);
    activeRows.forEach(row => { y = drawMechRow(doc, row, y); });
    y += 6;
    y = drawGeneralChecks(doc, MECH_CHECKS, gMech, y);
    y += 6;
    y = drawRemarks(doc, data.mechanical_remarks || 'ALL MOTORS OK, PASSED.', y);
    y += 8;
    drawSig(doc, data.prepared_by, data.approved_by, y);
    drawPageNum(doc, 2, 3);

    /* ═══════════════════════════════
       PAGE 3 — Photos
       ═══════════════════════════════ */
    doc.addPage();
    y = 10;

    box(doc, M, y, CW, 18, { stroke: '#000', sw: 0.5 });
    t(doc, 'PHOTOS:', M + 4, y + 5, CW - 8, { font: FB, size: 9 });
    y += 18;

    const photoLblH = 16;
    // Split remaining printable space (above bottom margin) evenly between two photo boxes
    const available = PAGE_H - BOT_M - y - photoLblH * 2 - 10;
    const photoH    = Math.max(100, Math.floor(available / 2));

    box(doc, M, y, CW, photoLblH, { stroke: '#000', sw: 0.5 });
    t(doc, '1. Overall Motor:', M + 4, y + 4, CW - 8, { font: FB, size: 9 });
    y += photoLblH;
    box(doc, M, y, CW, photoH, { stroke: '#000', sw: 0.5 });
    y += photoH;

    box(doc, M, y, CW, photoLblH, { stroke: '#000', sw: 0.5 });
    t(doc, '2. Name Plate', M + 4, y + 4, CW - 8, { font: FB, size: 9 });
    y += photoLblH;
    box(doc, M, y, CW, photoH, { stroke: '#000', sw: 0.5 });

    drawPageNum(doc, 3, 3);

    doc.end();
    return doc;
  }
}

module.exports = PDIGenerator;
