'use strict';

const {
  box, t, decodeImageDataUri, drawImageInBox, assetPath,
  drawPageNum, drawPaginatedRows, resolveCols, getFonts,
  M, CW, PAGE_H, BOT_M,
} = require('./primitives');

/* ── header section ─────────────────────────────────────────── */
const HDR_H  = 60;
const CN_H   = 14;
const INFO_H = 16;
const LOGO_W = 110;
const FMT_W  = 140;
const TTL_W  = CW - LOGO_W - FMT_W;

function drawHeaderSection(doc, section, data, y) {
  const { F, FB } = getFonts();
  box(doc, M, y, CW, HDR_H, { stroke: '#000', sw: 0.8 });

  if (section.logoAsset) {
    const logo = assetPath(section.logoAsset);
    if (logo) {
      try {
        doc.image(logo, M + 4, y + 4, { fit: [LOGO_W - 8, HDR_H - 8], align: 'center', valign: 'center' });
      } catch { /* logo is optional decoration; a bad asset shouldn't fail the PDF */ }
    }
  }
  doc.save().strokeColor('#000').lineWidth(0.6)
     .moveTo(M + LOGO_W, y).lineTo(M + LOGO_W, y + HDR_H).stroke().restore();

  const tx = M + LOGO_W;
  t(doc, 'Pre Dispatch Inspection', tx, y + 10, TTL_W, { font: FB, size: 15, align: 'center' });
  t(doc, '(PDI)', tx, y + 32, TTL_W, { font: FB, size: 13, align: 'center' });

  const fx = M + LOGO_W + TTL_W;
  doc.save().strokeColor('#000').lineWidth(0.6)
     .moveTo(fx, y).lineTo(fx, y + HDR_H).stroke().restore();

  t(doc, `Format No: ${section.formatNo}`, fx + 4, y + 8,  FMT_W - 8, { font: FB, size: 7 });
  t(doc, `Rev. No:${section.revNo}`,       fx + 4, y + 22, FMT_W - 8, { font: FB, size: 7 });
  t(doc, `Eff. Dt:${section.effDate}`,     fx + 4, y + 36, FMT_W - 8, { font: FB, size: 7 });

  const cny = y + HDR_H;
  box(doc, M, cny, CW, CN_H, { stroke: '#000', sw: 0.5 });
  t(doc, section.companyName, M + 4, cny + 3, CW - 8, { font: F, size: 8 });
  y = cny + CN_H + 4;

  const half = CW / 2;
  const mx   = M + half;
  section.infoFields.forEach(([lL, vL, lR, vR]) => {
    box(doc, M,  y, half, INFO_H, { stroke: '#000', sw: 0.4 });
    box(doc, mx, y, half, INFO_H, { stroke: '#000', sw: 0.4 });
    t(doc, lL, M  + 3,   y + 4, 108,        { font: FB, size: 8 });
    t(doc, vL(data), M  + 114, y + 4, half - 118, { font: F,  size: 8 });
    t(doc, lR, mx + 3,   y + 4, 55,         { font: FB, size: 8 });
    t(doc, vR(data), mx + 60,  y + 4, half - 64,  { font: F,  size: 8 });
    y += INFO_H;
  });

  return y;
}

/* ── table section ──────────────────────────────────────────── */
function resolveCellValue(col, row, sectionData, data) {
  if (col.value) return col.value(row, sectionData, data);
  return row[col.key] ?? '';
}

function drawTableHeader(doc, cols, y, headerHeight) {
  const { FB } = getFonts();
  const grouped = cols.some(c => c.group);

  if (!grouped) {
    let x = M;
    cols.forEach(c => {
      box(doc, x, y, c.w, headerHeight, { fill: '#f0f0f0', stroke: '#000', sw: 0.5 });
      const lines = c.label.split('\n');
      const lh = 8;
      const sy = y + Math.max(3, (headerHeight - lines.length * lh) / 2);
      lines.forEach((ln, i) => t(doc, ln, x + 2, sy + i * lh, c.w - 4, { font: FB, size: 7, align: 'center' }));
      x += c.w;
    });
    return y + headerHeight;
  }

  // Grouped (2-level) header — columns sharing a `group` label span a
  // shared top row; ungrouped columns span the full header height.
  const h1 = headerHeight / 2, h2 = headerHeight / 2;
  let x = M;
  cols.forEach(c => {
    if (!c.group) {
      box(doc, x, y, c.w, h1 + h2, { fill: '#f0f0f0', stroke: '#000', sw: 0.5 });
      const lines = c.label.split('\n');
      const lh = 8;
      const sy = y + Math.max(3, (h1 + h2 - lines.length * lh) / 2);
      lines.forEach((ln, i) => t(doc, ln, x + 2, sy + i * lh, c.w - 4, { font: FB, size: 7, align: 'center' }));
    }
    x += c.w;
  });

  const groupLabels = [...new Set(cols.filter(c => c.group).map(c => c.group))];
  groupLabels.forEach(label => {
    const groupCols = cols.filter(c => c.group === label);
    const gx = M + cols.slice(0, cols.indexOf(groupCols[0])).reduce((s, c) => s + c.w, 0);
    const gw = groupCols.reduce((s, c) => s + c.w, 0);
    box(doc, gx, y, gw, h1, { fill: '#f0f0f0', stroke: '#000', sw: 0.5 });
    t(doc, label, gx + 2, y + 5, gw - 4, { font: FB, size: 7, align: 'center' });
    let sx = gx;
    groupCols.forEach(c => {
      box(doc, sx, y + h1, c.w, h2, { fill: '#f0f0f0', stroke: '#000', sw: 0.5 });
      const lines = c.label.split('\n');
      const lh = 7;
      const sy = y + h1 + Math.max(2, (h2 - lines.length * lh) / 2);
      lines.forEach((ln, i) => t(doc, ln, sx + 2, sy + i * lh, c.w - 4, { font: FB, size: 6.5, align: 'center' }));
      sx += c.w;
    });
  });

  return y + h1 + h2;
}

function drawSpecRow(doc, specRow, cols, rowHeight, data, y) {
  const { F, FB } = getFonts();
  const vals = specRow.build(data);
  let x = M;
  cols.forEach((c, i) => {
    const val = i === 0 ? specRow.firstColLabel : (vals[c.key] || '');
    box(doc, x, y, c.w, rowHeight, { fill: specRow.fill, stroke: '#000', sw: 0.3 });
    t(doc, val, x + 2, y + 3, c.w - 4, {
      font:  i === 0 ? FB : F,
      size:  i === 0 ? 6.5 : 7.5,
      align: i === 0 ? 'left' : 'center',
    });
    x += c.w;
  });
  return y + rowHeight;
}

function drawTableRow(doc, cols, row, sectionData, data, rowHeight, y) {
  const { F } = getFonts();
  let x = M;
  cols.forEach(c => {
    box(doc, x, y, c.w, rowHeight, { stroke: '#000', sw: 0.3 });
    const val = resolveCellValue(c, row, sectionData, data);
    t(doc, val, x + 2, y + 3, c.w - 4, { font: F, size: 7.5, align: c.align });
    x += c.w;
  });
  return y + rowHeight;
}

function drawTableSection(doc, section, data, y) {
  const cols = resolveCols(section.columns, CW);
  const rowHeight = section.rowHeight || 14;
  const sectionData = section.dataKey ? (data[section.dataKey] || {}) : {};

  y = drawTableHeader(doc, cols, y, section.headerHeight);

  if (section.specRow) {
    y = drawSpecRow(doc, section.specRow, cols, rowHeight, data, y);
  }

  if (section.mode === 'fixed') {
    section.fixedRows(data).forEach(row => {
      y = drawTableRow(doc, cols, row, sectionData, data, rowHeight, y);
    });
    return y;
  }

  // repeatable — one row per item in data[dataKey], auto-paginating with a
  // reserved footer so whatever follows on the page never gets orphaned.
  const source = Array.isArray(data[section.dataKey]) ? data[section.dataKey] : [];
  const rows = source
    .filter(section.filterRow || (() => true))
    .map((r, i) => ({ ...r, sno: r.sno ?? i + 1 }));

  return drawPaginatedRows(doc, {
    rows,
    drawRow: (d, row, ry) => drawTableRow(d, cols, row, sectionData, data, rowHeight, ry),
    rowHeight,
    y,
    footerHeight: section.footerHeight ? section.footerHeight(data) : 0,
    redrawHeader: (py) => drawTableHeader(doc, cols, py, section.headerHeight),
  });
}

/* ── photo section ──────────────────────────────────────────── */
const PHOTO_GAP    = 8;
const PHOTO_LBL_H  = 16;
const PHOTO_IMG_H  = 150;
const PHOTO_ROW_H  = PHOTO_LBL_H + PHOTO_IMG_H + 8;
const PHOTO_CELL_W = (CW - PHOTO_GAP) / 2;

function drawPhotosHeader(doc, y) {
  const { FB } = getFonts();
  box(doc, M, y, CW, 18, { stroke: '#000', sw: 0.5 });
  t(doc, 'PHOTOS:', M + 4, y + 5, CW - 8, { font: FB, size: 9 });
  return y + 18 + 6;
}

function drawPhotoCell(doc, label, image, index, x, y) {
  const { FB } = getFonts();
  box(doc, x, y, PHOTO_CELL_W, PHOTO_LBL_H, { stroke: '#000', sw: 0.5 });
  t(doc, `${index + 1}. ${label}`, x + 4, y + 4, PHOTO_CELL_W - 8, { font: FB, size: 8.5 });
  const imgY = y + PHOTO_LBL_H;
  box(doc, x, imgY, PHOTO_CELL_W, PHOTO_IMG_H, { stroke: '#000', sw: 0.5 });
  drawImageInBox(doc, decodeImageDataUri(image), x, imgY, PHOTO_CELL_W, PHOTO_IMG_H);
}

function drawPhotoSection(doc, section, data, y) {
  let items;
  if (section.mode === 'fixed-slots') {
    const slotData = data[section.dataKey] || {};
    items = section.slots.map(slot => ({ label: slot.label, image: slotData[slot.key] }));
  } else {
    const list = Array.isArray(data[section.dataKey]) ? data[section.dataKey] : [];
    items = list
      .filter(p => p && ((p.label && p.label.trim()) || p.image))
      .map(p => ({ label: (p.label || '').trim(), image: p.image }));
  }

  y = drawPhotosHeader(doc, y);
  for (let i = 0; i < items.length; i += 2) {
    if (y + PHOTO_ROW_H > PAGE_H - BOT_M) {
      doc.addPage();
      y = drawPhotosHeader(doc, 10);
    }
    drawPhotoCell(doc, items[i].label || `Photo ${i + 1}`, items[i].image, i, M, y);
    if (items[i + 1]) {
      drawPhotoCell(doc, items[i + 1].label || `Photo ${i + 2}`, items[i + 1].image, i + 1, M + PHOTO_CELL_W + PHOTO_GAP, y);
    }
    y += PHOTO_ROW_H;
  }
  return y;
}

/* ── image section ──────────────────────────────────────────── */
function drawImageSection(doc, section, data, y) {
  const { F, FB } = getFonts();
  if (section.title) {
    t(doc, section.title, M, y, CW, { font: FB, size: 13, align: 'center' });
    y += 20;
  }

  const w = section.width || CW;
  const h = section.height;
  box(doc, M, y, w, h, { stroke: '#000', sw: 0.6 });
  const buf = decodeImageDataUri(data[section.dataKey]);
  if (!(buf && drawImageInBox(doc, buf, M, y, w, h))) {
    const ph = section.placeholder;
    if (ph) {
      t(doc, ph.text(data), M + 8, y + h / 2 - 5, w - 16, { font: F, size: 8, color: '#aaa', align: 'center' });
      (ph.annotations || []).forEach(a => {
        const ax = a.xFrac != null ? M + CW * a.xFrac : M + (a.x || 0);
        const aw = a.wFrac != null ? CW * a.wFrac : (a.w || 100);
        t(doc, a.text, ax, y + a.y, aw, { font: F, size: a.size || 6.5, color: '#555', align: a.align || 'left' });
      });
    }
  }
  return y + h + 8;
}

/* ── signature section ──────────────────────────────────────── */
const SIG_H = 36;

function drawSignatureSection(doc, section, data, y) {
  const { F, FB } = getFonts();
  const n = section.roles.length;
  const w = CW / n;
  section.roles.forEach((role, i) => {
    const x = M + w * i;
    box(doc, x, y, w, SIG_H, { stroke: '#000', sw: 0.4 });
    t(doc, role.label, x + 4, y + 6,  w - 8, { font: FB, size: 8 });
    t(doc, data[role.key] || '', x + 4, y + 20, w - 8, { font: F,  size: 8 });
  });
  return y + SIG_H;
}

/* ── text section (e.g. Remarks) ────────────────────────────── */
const TEXT_H = 40;

function drawTextSection(doc, section, data, y) {
  const { F, FB } = getFonts();
  box(doc, M, y, CW, TEXT_H, { stroke: '#000', sw: 0.4 });
  t(doc, section.label, M + 4, y + 8, 58, { font: FB, size: 8 });
  t(doc, data[section.dataKey] || section.default || '', M + 64, y + 8, CW - 68, { font: F, size: 8 });
  return y + TEXT_H;
}

/* ── top-level walk ─────────────────────────────────────────── */
const DRAWERS = {
  header: drawHeaderSection,
  table: drawTableSection,
  photo: drawPhotoSection,
  image: drawImageSection,
  signature: drawSignatureSection,
  text: drawTextSection,
};

function renderTemplate(doc, template, data) {
  template.pages.forEach(page => {
    doc.addPage();
    let y = 10;
    page.sections.forEach(section => {
      const draw = DRAWERS[section.type];
      if (!draw) throw new Error(`Unknown PDI template section type: ${section.type}`);
      y = draw(doc, section, data, y);
      if (section.gap) y += section.gap;
    });
  });

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    drawPageNum(doc, i + 1, range.count);
  }
}

module.exports = { renderTemplate };
