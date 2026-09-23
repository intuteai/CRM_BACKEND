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

  t(doc, `Format No: ${section.formatNo ?? ''}`, fx + 4, y + 8,  FMT_W - 8, { font: FB, size: 7 });
  t(doc, `Rev. No:${section.revNo ?? ''}`,       fx + 4, y + 22, FMT_W - 8, { font: FB, size: 7 });
  t(doc, `Eff. Dt:${section.effDate ?? ''}`,     fx + 4, y + 36, FMT_W - 8, { font: FB, size: 7 });

  // Optional extra lines below the fixed 3 (e.g. a "Rev Dt:" line some
  // formats have) — smaller font/spacing so a 4th line still fits inside
  // the fixed HDR_H box. Templates that don't set this are unaffected.
  (section.extraFormatLines || []).forEach((line, i) => {
    t(doc, line, fx + 4, y + 36 + (i + 1) * 12, FMT_W - 8, { font: FB, size: 6.5 });
  });

  const cny = y + HDR_H;
  box(doc, M, cny, CW, CN_H, { stroke: '#000', sw: 0.5 });
  t(doc, section.companyName, M + 4, cny + 3, CW - 8, { font: F, size: 8 });
  y = cny + CN_H + 4;

  const half = CW / 2;
  const mx   = M + half;
  const rLabelW = section.rLabelW || 55;
  section.infoFields.forEach(([lL, vL, lR, vR]) => {
    box(doc, M,  y, half, INFO_H, { stroke: '#000', sw: 0.4 });
    box(doc, mx, y, half, INFO_H, { stroke: '#000', sw: 0.4 });
    t(doc, lL, M  + 3,   y + 4, 108,        { font: FB, size: 8 });
    t(doc, vL(data), M  + 114, y + 4, half - 118, { font: F,  size: 8 });
    t(doc, lR, mx + 3,   y + 4, rLabelW,              { font: FB, size: 8 });
    t(doc, vR(data), mx + rLabelW + 5, y + 4, half - rLabelW - 9, { font: F,  size: 8 });
    y += INFO_H;
  });

  return y;
}

/* ── table section ──────────────────────────────────────────── */
function resolveCellValue(col, row, sectionData, data) {
  if (col.value) return col.value(row, sectionData, data);
  return row[col.key] ?? '';
}

// Columns sharing the same `group` label must be contiguous in the
// `columns` array passed to a table section — the grouped-header box
// positions are computed from the running x-offset up to the first column
// of each group, so interleaving grouped/ungrouped or two different
// groups' columns will silently misalign the header boxes rather than error.
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
  // labelSpan lets the first cell's box/text claim more than one column's
  // width -- e.g. merging in a column that a spec row never fills (like
  // Motor Sr. No) so "Specification" has room to fit instead of being
  // forced into just the S.No column's width and ellipsis-truncated to
  // "Spe…" regardless of how the label itself is worded.
  const labelSpan = Math.max(1, specRow.labelSpan || 1);
  // A value cell here can hold a full "nominal ±tol (min – max)" string
  // (backend-changes-v1.0.8.md item 2) — up to ~35 characters into a column
  // as narrow as 38-56pt, far more than fits on one line even at a small
  // font. specRow.rowHeight (falls back to the data rows' own height, same
  // as before) gives this row the extra vertical room; `t(..., { lb: true })`
  // switches it from forced single-line ellipsis to PDFKit's normal wrap.
  const h = specRow.rowHeight || rowHeight;
  let x = M;
  cols.forEach((c, i) => {
    if (i > 0 && i < labelSpan) {
      // Merged into the label cell drawn at i === 0 -- no box/text of its
      // own, but x must still advance past it so later columns line up.
      x += c.w;
      return;
    }
    const w = i === 0 ? cols.slice(0, labelSpan).reduce((sum, col) => sum + col.w, 0) : c.w;
    const val = i === 0 ? specRow.firstColLabel : (vals[c.key] || '');
    box(doc, x, y, w, h, { fill: specRow.fill, stroke: '#000', sw: 0.3 });
    t(doc, val, x + 2, y + 3, w - 4, {
      font:  i === 0 ? FB : F,
      size:  6.5,
      align: i === 0 ? 'left' : 'center',
      lb:    i !== 0,
    });
    x += c.w;
  });
  return y + h;
}

function drawTableRow(doc, cols, row, sectionData, data, rowHeight, y) {
  const { F, FB } = getFonts();
  let x = M;
  cols.forEach(c => {
    const val = resolveCellValue(c, row, sectionData, data);
    const flagged = c.isOutOfTolerance ? c.isOutOfTolerance(row, data) : false;
    // Bold text is the flag's print-safe cue — the light-red fill and dark-red
    // text are the primary on-screen/color-print signal, but a light fill can
    // wash out on a black-and-white printer or a photocopy of one; bold still
    // reads as "different" once color is gone.
    box(doc, x, y, c.w, rowHeight, { stroke: '#000', sw: 0.3, fill: flagged ? '#fee2e2' : undefined });
    t(doc, val, x + 2, y + 3, c.w - 4, { font: flagged ? FB : F, size: 7.5, align: c.align, color: flagged ? '#b91c1c' : '#000' });
    x += c.w;
  });
  return y + rowHeight;
}

function drawTableSection(doc, section, data, y) {
  if (section.mode !== 'fixed' && section.mode !== 'repeatable') {
    throw new Error(`PDI table section has invalid mode: ${section.mode} (expected 'fixed' or 'repeatable')`);
  }
  if (section.title) {
    const { FB } = getFonts();
    t(doc, section.title, M, y, CW, { font: FB, size: 10, align: 'left' });
    y += 16;
  }
  const cols = resolveCols(section.columns, CW);
  const rowHeight = section.rowHeight || 14;
  // Same fallback as rowHeight above — the admin editor always sets 20 when a
  // table section is created, but nothing enforces that at this layer. An
  // authored template missing headerHeight (e.g. hand-built via the API, or a
  // future editor bug) used to reach here as `undefined`, which drawTableHeader
  // silently turns into NaN for grouped columns (`headerHeight / 2`) and
  // PDFKit then throws "unsupported number: NaN" — a 500 with no useful
  // client-facing message. Defend it here, same as rowHeight.
  const headerHeight = section.headerHeight || 20;
  const sectionData = section.dataKey ? (data[section.dataKey] || {}) : {};

  y = drawTableHeader(doc, cols, y, headerHeight);

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
    redrawHeader: (py) => drawTableHeader(doc, cols, py, headerHeight),
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
  if (section.mode !== 'freeform' && section.mode !== 'fixed-slots') {
    throw new Error(`PDI photo section has invalid mode: ${section.mode} (expected 'freeform' or 'fixed-slots')`);
  }
  let groups; // [{ label, images: [...] }]
  if (section.mode === 'fixed-slots') {
    const slotData = data[section.dataKey] || {};
    // A slot's stored value is an array for admin-authored templates (Task 8's
    // multi-photo format) but a single data-URI string (or null) for AutoNXT,
    // which predates that format and was never migrated — normalize both
    // shapes here rather than assuming every fixed-slots template is new.
    groups = section.slots.map((slot) => {
      const raw = slotData[slot.key];
      const images = Array.isArray(raw) ? raw : (raw ? [raw] : []);
      return { label: slot.label, images };
    });
  } else {
    const list = Array.isArray(data[section.dataKey]) ? data[section.dataKey] : [];
    groups = list
      .filter(p => p && ((p.label && p.label.trim()) || (p.images && p.images.length)))
      .map(p => ({ label: (p.label || '').trim(), images: p.images || [] }));
  }

  // Flatten each group's photos into individual PDF cells — a group with N
  // photos produces N labeled cells ("Damage Photos (1)", "(2)", ...) instead
  // of being limited to one. A group with zero images still gets one empty
  // cell (preserves today's "empty slot still shows in the PDF" behavior for
  // fixed-slots mode, so an unfilled slot isn't just silently missing).
  const items = [];
  groups.forEach((g) => {
    if (g.images.length === 0) {
      items.push({ label: g.label, image: null });
    } else if (g.images.length === 1) {
      items.push({ label: g.label, image: g.images[0] });
    } else {
      // Apply the same "Photo N" fallback the draw loop below applies to a
      // falsy label — done here, not left to the loop, because appending
      // " (1)"/" (2)" to an empty label produces a non-empty (so non-falsy)
      // string that would otherwise silently bypass that fallback, for
      // exactly the entries most likely to need it (images added, no label
      // typed yet).
      const baseLabel = g.label || `Photo ${items.length + 1}`;
      g.images.forEach((img, i) => items.push({ label: `${baseLabel} (${i + 1})`, image: img }));
    }
  });

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
    // Same value/key convention as a table column (resolveCellValue): a role
    // with its own `value(data)` (e.g. the Mechanical page's roles, which
    // fall back to the Electrical signature on a report saved before that
    // page had its own) is resolved through it instead of a plain lookup.
    const value = role.value ? role.value(data) : (data[role.key] || '');
    box(doc, x, y, w, SIG_H, { stroke: '#000', sw: 0.4 });
    t(doc, role.label, x + 4, y + 6,  w - 8, { font: FB, size: 8 });
    t(doc, value, x + 4, y + 20, w - 8, { font: F,  size: 8 });
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
