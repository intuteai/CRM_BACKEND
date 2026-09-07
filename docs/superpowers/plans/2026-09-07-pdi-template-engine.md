# PDI Template Engine (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded, General-only PDI PDF generator with a data-driven template engine (5 reusable section types + a generic renderer), re-express General through it with zero visible output change, then wire the frontend to support picking a template when a second one exists.

**Architecture:** `models/operations/pdi/primitives.js` holds the already-generic drawing helpers (box/text/image/pagination) extracted verbatim from today's `pdi_generator.js`. `models/operations/pdi/renderer.js` adds one drawer function per section type (header, table, photo, image, signature, text) and a `renderTemplate(doc, template, data)` that walks a template's pages/sections. `models/operations/pdi/templates/general.js` re-expresses today's exact 3-page General layout as data. `pdi_generator.js` shrinks to a 3-line dispatcher: look up the template by id, hand it to the renderer. Frontend gets a template picker that auto-skips itself while only one template exists.

**Tech Stack:** Node/Express, PDFKit, PostgreSQL (unchanged schema), React Router v6, Jest + Supertest.

**Reference:** `docs/superpowers/specs/2026-09-07-pdi-template-engine-design.md`

---

## Before you start

Read the current `models/operations/pdi_generator.js` in full — every task below extracts or re-expresses pieces of it, and the line numbers/behavior described assume you're looking at the version as of commit `a64f6f9`. If it's changed since, treat this plan's code as the *target* behavior, not a literal diff.

---

### Task 1: Extract shared drawing primitives

**Files:**
- Create: `models/operations/pdi/primitives.js`
- Test: `tests/pdi_primitives.test.js`

These are the parts of today's `pdi_generator.js` that have nothing to do with General specifically — font loading, image decoding, the `box`/`t` drawing primitives, date formatting, column-width resolution, and the page-numbering/pagination helpers. They move verbatim (same logic, same constants) into their own module so both the renderer (Task 2) and every template can use them without depending on General's file.

- [ ] **Step 1: Create the primitives module**

```js
// models/operations/pdi/primitives.js
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
 *  single-line + ellipsis truncation (see isolated comment history in the
 *  original pdi_generator.js) since every caller passes `width` and none
 *  want PDFKit's default wrap-and-spill behavior. */
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
```

- [ ] **Step 2: Write a test covering the non-trivial primitives**

```js
// tests/pdi_primitives.test.js
const PDFDocument = require('pdfkit');
const {
  decodeImageDataUri, resolveCols, fmtDate, registerFonts, getFonts,
} = require('../models/operations/pdi/primitives');

// A real (tiny, valid) 1x1 transparent PNG, base64-encoded.
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

describe('pdi primitives', () => {
  it('decodeImageDataUri accepts a valid PNG data URI', () => {
    const buf = decodeImageDataUri(TINY_PNG);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(0);
  });

  it('decodeImageDataUri rejects non-image / malformed input', () => {
    expect(decodeImageDataUri(null)).toBeNull();
    expect(decodeImageDataUri('not a data uri')).toBeNull();
    expect(decodeImageDataUri('data:image/png;base64,not-base64!!!')).toBeNull();
  });

  it('resolveCols splits remaining width evenly across flex columns', () => {
    const cols = resolveCols(
      [{ key: 'a', w: 100 }, { key: 'b' }, { key: 'c' }],
      300
    );
    expect(cols[0].w).toBe(100);
    expect(cols[1].w).toBe(100); // (300-100)/2
    expect(cols[2].w).toBe(100);
  });

  it('resolveCols enforces a 40pt floor on flex columns', () => {
    const cols = resolveCols([{ key: 'a', w: 290 }, { key: 'b' }], 300);
    expect(cols[1].w).toBe(40);
  });

  it('fmtDate formats as DD/MM/YYYY in UTC', () => {
    expect(fmtDate('2026-01-05T00:00:00.000Z')).toBe('05/01/2026');
    expect(fmtDate(null)).toBe('');
    expect(fmtDate('not a date')).toBe('');
  });

  it('registerFonts falls back to Helvetica when Roboto assets are missing, without throwing', () => {
    const doc = new PDFDocument({ autoFirstPage: false });
    expect(() => registerFonts(doc)).not.toThrow();
    const { F, FB } = getFonts();
    expect(typeof F).toBe('string');
    expect(typeof FB).toBe('string');
  });
});
```

- [ ] **Step 3: Run the new test**

Run: `npx jest tests/pdi_primitives.test.js`
Expected: PASS (6/6)

- [ ] **Step 4: Run the full existing suite to confirm nothing else broke**

Run: `npx jest tests/pdiReports.test.js --forceExit`
Expected: PASS (12/12) — this file doesn't touch `pdi_generator.js` yet, so this is just a baseline checkpoint before the riskier tasks.

- [ ] **Step 5: Commit**

```bash
git add models/operations/pdi/primitives.js tests/pdi_primitives.test.js
git commit -m "feat: extract PDI PDF drawing primitives into a shared module"
```

---

### Task 2: Build the generic section renderer

**Files:**
- Create: `models/operations/pdi/renderer.js`
- Test: `tests/pdi_template_renderer.test.js`

This is the actual template engine: one drawer per section type, dispatched by `renderTemplate`. Every drawer takes `(doc, section, data, y)` and returns the new `y`. None of this file knows anything about General or AutoNXT — it's exercised here with a synthetic template, and General's re-expression (Task 3) proves it against a real one.

**Section type reference** (config shape each drawer expects):

- `header` — `{ type: 'header', companyName, formatNo, revNo, effDate, logoAsset, infoFields: [[label, valueFn, label, valueFn], ...] }`
- `table` — `{ type: 'table', mode: 'fixed'|'repeatable', dataKey, columns, headerHeight, rowHeight, specRow?, footerHeight?, fixedRows?, filterRow? }`
  - `mode: 'repeatable'`: rows come from `data[dataKey]` (filtered by `filterRow`, if given), auto-paginates reserving `footerHeight(data)` on the page holding the last row.
  - `mode: 'fixed'`: rows come from `fixedRows(data)` (a function, even for static lists), drawn without pagination — matches how the original General-checks tables behaved (no overflow guard of their own; the *preceding* repeatable table's footerHeight reservation is what keeps them on-page).
  - Each column is `{ key, label, w?, align, group?, value? }`. `value(row, sectionData, data)` overrides the default `row[key]` lookup — used for computed/constant cells (see General's checks tables in Task 3). `group` puts 2+ columns under a shared top-row label (2-level header).
  - `specRow?: { fill, firstColLabel, build(data) => { [colKey]: value } }` — an optional single row drawn right after the header, before any data rows.
- `photo` — `{ type: 'photo', mode: 'freeform'|'fixed-slots', dataKey, slots? }`
  - `freeform`: `data[dataKey]` is an array of `{ label, image }`, only entries with a label or image are drawn.
  - `fixed-slots`: `slots` is `[{ key, label }]`; `data[dataKey]` is an object keyed by slot `key` holding each slot's image data URI.
- `image` — `{ type: 'image', dataKey, width?, height, title?, placeholder?: { text(data), annotations: [{ text, x?/xFrac?, y, w?/wFrac?, size?, align? }] } }`
- `signature` — `{ type: 'signature', roles: [{ key, label }, ...] }` — N roles split evenly across the content width.
- `text` — `{ type: 'text', label, dataKey, default? }` — a single labeled text box (e.g. Remarks).

Any section may also set `gap: <number>` — extra vertical space added after that section before the next one starts.

- [ ] **Step 1: Write the renderer**

```js
// models/operations/pdi/renderer.js
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
```

- [ ] **Step 2: Write a test exercising every section type via a synthetic template**

```js
// tests/pdi_template_renderer.test.js
const PDFDocument = require('pdfkit');
const { registerFonts } = require('../models/operations/pdi/primitives');
const { renderTemplate } = require('../models/operations/pdi/renderer');

function bufferPdf(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const SYNTHETIC_TEMPLATE = {
  id: 'synthetic-test',
  name: 'Synthetic Test Template',
  version: 1,
  pages: [
    {
      sections: [
        {
          type: 'header', gap: 4,
          companyName: 'Test Co.', formatNo: 'F/1', revNo: '00', effDate: '01/01/2026',
          logoAsset: 'does-not-exist.png', // exercises the "missing asset" path
          infoFields: [['Customer:', (d) => d.customer || '', 'Date:', () => '']],
        },
        {
          // repeatable + grouped 2-level header + pagination (30 rows forces a continuation page)
          type: 'table', gap: 4,
          mode: 'repeatable', dataKey: 'rows', filterRow: (r) => !!r.id,
          columns: [
            { key: 'id', label: 'ID', w: 30, align: 'center' },
            { key: 'a', label: 'A', w: 60, align: 'center', group: 'Group' },
            { key: 'b', label: 'B', w: 60, align: 'center', group: 'Group' },
            { key: 'notes', label: 'Notes', align: 'left' },
          ],
          headerHeight: 36, rowHeight: 14,
          footerHeight: () => 100,
        },
        {
          // fixed + computed columns + spec row
          type: 'table', gap: 4,
          mode: 'fixed', dataKey: 'checks',
          fixedRows: () => [{ key: 'x', label: 'Check X' }],
          columns: [
            { label: 'Check', w: 200, align: 'left', value: (row) => row.label },
            { label: 'Result', align: 'center', value: (row, sectionData) => (sectionData[row.key] || {}).measured || 'GO' },
          ],
          headerHeight: 14, rowHeight: 14,
          specRow: { fill: '#fffde7', firstColLabel: 'Spec', build: () => ({}) },
        },
        { type: 'text', gap: 4, label: 'Remarks:', dataKey: 'remarks', default: 'OK' },
        { type: 'signature', roles: [{ key: 'a_sig', label: 'A' }, { key: 'b_sig', label: 'B' }, { key: 'c_sig', label: 'C' }] },
      ],
    },
    {
      sections: [
        {
          type: 'image', title: 'Page 2', dataKey: 'missing_image', height: 80,
          placeholder: {
            text: () => 'no image',
            annotations: [{ text: 'note', xFrac: 0.1, y: 4, wFrac: 0.5 }],
          },
        },
        { type: 'image', dataKey: 'real_image', height: 80 }, // real embedded image, no placeholder needed
      ],
    },
    {
      sections: [
        { type: 'photo', mode: 'freeform', dataKey: 'photos' },
      ],
    },
    {
      sections: [
        {
          type: 'photo', mode: 'fixed-slots', dataKey: 'slot_photos',
          slots: [{ key: 'front', label: 'Front' }, { key: 'back', label: 'Back' }],
        },
      ],
    },
  ],
};

describe('PDI template renderer', () => {
  it('renders every section type, including pagination overflow, without throwing', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, a: 'x', b: 'y', notes: 'n' }));
    const data = {
      customer: 'Acme',
      rows,
      checks: { x: { measured: 'GO' } },
      remarks: 'All good',
      a_sig: 'Alice', b_sig: 'Bob', c_sig: 'Carol',
      real_image: TINY_PNG,
      photos: [{ label: 'Shot 1', image: TINY_PNG }, { label: '', image: '' }],
      slot_photos: { front: TINY_PNG },
    };

    const doc = new PDFDocument({
      size: 'A4', margins: { top: 10, bottom: 0, left: 36, right: 36 },
      autoFirstPage: false, bufferPages: true,
    });
    registerFonts(doc);
    renderTemplate(doc, SYNTHETIC_TEMPLATE, data);
    doc.end();

    const buf = await bufferPdf(doc);
    expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-');
    // 30 rows at headerHeight 36 + 14/row easily overflows page 1 onto a
    // continuation page, so the real page count must exceed the 4 declared pages.
    expect(doc.bufferedPageRange().count).toBeGreaterThan(4);
  });

  it('throws a clear error for an unknown section type', () => {
    const doc = new PDFDocument({ autoFirstPage: false, bufferPages: true });
    registerFonts(doc);
    const badTemplate = { pages: [{ sections: [{ type: 'nope' }] }] };
    expect(() => renderTemplate(doc, badTemplate, {})).toThrow(/Unknown PDI template section type/);
  });
});
```

- [ ] **Step 3: Run the tests, expect them to fail first (renderer.js doesn't exist yet if you're doing this test-first)**

If you wrote `renderer.js` in Step 1 before the test, skip straight to Step 4 — both were specified together above because the renderer has no meaningful behavior to test in isolation. If following strict TDD, comment out the `require('../models/operations/pdi/renderer')` line, confirm the test file fails to load, then restore it once `renderer.js` exists.

- [ ] **Step 4: Run tests**

Run: `npx jest tests/pdi_template_renderer.test.js`
Expected: PASS (2/2)

- [ ] **Step 5: Commit**

```bash
git add models/operations/pdi/renderer.js tests/pdi_template_renderer.test.js
git commit -m "feat: add generic PDI template renderer (header/table/photo/image/signature/text sections)"
```

---

### Task 3: Re-express General as a template, make `pdi_generator.js` a thin dispatcher

**Files:**
- Create: `models/operations/pdi/templates/general.js`
- Create: `models/operations/pdi/templates/index.js`
- Modify: `models/operations/pdi_generator.js` (full rewrite, shown below)
- Modify: `models/operations/pdiReports.js:181, 209` (pass `report.template_id`)
- Modify: `controllers/operations/pdi.controller.js` (`getTemplates` sources the registry)
- Test: `tests/pdi_generator.test.js` (new)
- Test: `tests/pdiReports.test.js` (must keep passing, unmodified)

This is the highest-risk task: General is in production, and this must not change its visible output. `models/operations/pdi_generator.js` keeps its path (nothing else has to change its `require`), but its content shrinks to a lookup + dispatch.

- [ ] **Step 1: Generate a "before" reference PDF from a rich fixture, using the current code**

Before touching any files, capture what General produces today for a fixture that exercises every part of the page (multiple rows forcing a continuation page, both general-checks tables, a real drawing image, real photos, both signatures):

```bash
mkdir -p /tmp/pdi-visual-check
node -e "
const PDIGenerator = require('./models/operations/pdi_generator');
const fs = require('fs');
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const data = {
  pdi_no: 'PDI-VISUAL-CHECK', customer_name: 'Visual Check Co.', product_id: 'MOTOR-X',
  product_specifications: 'Spec text', date: '2026-01-05', drawing_no: 'DWG-1',
  rows: Array.from({ length: 25 }, (_, i) => ({
    motor_sr_no: 'SR' + (i + 1), voltage: '24V', direction: 'F',
    current_standard: '1.0A', current_measured: '1.1A', rpm_specified: '3000', rpm_measured: '2990',
    electrical_remarks: 'OK', motor_length: '100mm', shaft_length: '50mm',
    key_dim_result: 'Go', locating_dia_result: '50.0mm', mechanical_remarks: 'OK',
  })),
  general_electrical: { sound: { measured: 'GO', remarks: 'OK' } },
  general_mechanical: { power_cable: { measured: 'GO', remarks: 'OK' } },
  electrical_remarks: 'ALL MOTORS OK, PASSED.', mechanical_remarks: 'ALL MOTORS OK, PASSED.',
  drawing_image: TINY_PNG, prepared_by: 'Prep Person', approved_by: 'Approve Person',
  photos: [{ label: 'Overall Motor', image: TINY_PNG }, { label: 'Name Plate', image: TINY_PNG }],
};
const doc = PDIGenerator.generate(data);
const chunks = [];
doc.on('data', (c) => chunks.push(c));
doc.on('end', () => fs.writeFileSync('/tmp/pdi-visual-check/before.pdf', Buffer.concat(chunks)));
"
```

Save that fixture object somewhere you can paste it back in Step 5 (it's reused verbatim, just with `PDIGenerator.generate('general', data)` instead).

- [ ] **Step 2: Write the General template definition**

```js
// models/operations/pdi/templates/general.js
'use strict';

const { CW, fmtDate } = require('../primitives');

const GCH   = 14;
const REM_H = 40;
const SIG_H = 36;

const ECOLS = [
  { key: 'sno',                label: 'S. No',              w: 22, align: 'center' },
  { key: 'motor_sr_no',        label: 'Motor Sr. No',       w: 56, align: 'center' },
  { key: 'voltage',            label: 'Voltage',            w: 32, align: 'center' },
  { key: 'direction',          label: 'F / R',              w: 26, align: 'center' },
  { key: 'current_standard',   label: 'Current\nStandard',  w: 40, align: 'center' },
  { key: 'current_measured',   label: 'Current\nMeasured',  w: 40, align: 'center' },
  { key: 'rpm_specified',      label: 'RPM\nSPECIFIED',     w: 42, align: 'center' },
  { key: 'rpm_measured',       label: 'RPM\nMEASURED',      w: 42, align: 'center' },
  { key: 'electrical_remarks', label: 'Remarks',            align: 'left' },
];

const MCOLS = [
  { key: 'sno',                 label: 'S. No',               w: 26, align: 'center' },
  { key: 'motor_sr_no',         label: 'Motor\nSr. No',       w: 52, align: 'center' },
  { key: 'motor_length',        label: 'Motor\nLength',       w: 44, align: 'center' },
  { key: 'shaft_length',        label: 'Shaft O/P\nD/Length', w: 50, align: 'center' },
  { key: 'mounting_pcd',        label: 'PCD',                 w: 40, align: 'center', group: 'Mounting\nHoles' },
  { key: 'mtg',                 label: 'MTG',                 w: 50, align: 'center', group: 'Mounting\nHoles' },
  { key: 'key_dim_result',      label: 'Key\nDim.',           w: 34, align: 'center' },
  { key: 'locating_dia_result', label: 'Locating\nDia.',      w: 38, align: 'center' },
  { key: 'mechanical_remarks',  label: 'Remarks',             align: 'left' },
];

function checksColumns() {
  return [
    { label: 'General Check', w: Math.round(CW * 0.5), align: 'left',   value: (row) => row.label },
    { label: 'Specified',     w: 55,                    align: 'center', value: () => 'Go/NG' },
    { label: 'Measured',      w: 55,                    align: 'center', value: (row, sectionData) => (sectionData[row.key] || {}).measured || 'GO' },
    { label: 'Remarks',                                 align: 'center', value: (row, sectionData) => (sectionData[row.key] || {}).remarks || 'OK' },
  ];
}

const ELEC_CHECKS = [
  { key: 'sound',            label: 'All Motors Sound' },
  { key: 'high_voltage',     label: 'All Motors High Voltage Breakdown Check' },
  { key: 'insulation',       label: 'All Motors Insulation Check' },
  { key: 'phase_resistance', label: 'All Motors Phase Resistance Check' },
  { key: 'hall_sensor',      label: 'All Motors Hall Sensor Connector Check' },
];

function mechChecks(data) {
  const powerCableLength  = data.power_cable_length  || '1250±50mm';
  const sensorCableLength = data.sensor_cable_length || '1250±50mm';
  return [
    { key: 'power_cable',     label: `All Motor Power Cable Length ${powerCableLength}` },
    { key: 'sensor_cable',    label: `All Motor Sensor Cable Length ${sensorCableLength}` },
    { key: 'bolt_tightening', label: 'All Motor Bolt Tightening Check' },
    { key: 'paint_check',     label: 'All Motor Paint Check (If Applicable)' },
  ];
}

const DEFAULT_SPEC_VALS = {
  motor_length: '', shaft_length: '', mounting_pcd: '153',
  mtg: '1.M6 / 2.Ø8.0', key_dim_result: 'Go/NG', locating_dia_result: '50.0 mm',
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

const activeRowsFilter = (r) => r && String(r.motor_sr_no || '').trim();

const SIG_ROLES = [
  { key: 'prepared_by', label: 'Prepared By' },
  { key: 'approved_by', label: 'Approved By' },
];

const generalTemplate = {
  id: 'general',
  name: 'General',
  version: 1,
  pages: [
    {
      // Page 1 — Electrical Check
      sections: [
        {
          type: 'header', gap: 6,
          companyName: 'Compage Automation Systems Pvt.Ltd.,',
          formatNo: 'CASPL/QA/F/14', revNo: '00', effDate: '01/01/2022',
          logoAsset: 'compage_header_left.png',
          infoFields: [
            ['Customer Name:', (d) => d.customer_name || '', 'Dt:', (d) => d.date ? fmtDate(new Date(d.date)) : ''],
            ['Product ID:', (d) => d.product_id || '', 'Dwg. No:', (d) => d.drawing_no || ''],
            ['Product Specifications:', (d) => d.product_specifications || '', 'PDI No:', (d) => d.pdi_no || ''],
          ],
        },
        {
          type: 'table', gap: 6,
          mode: 'repeatable', dataKey: 'rows', filterRow: activeRowsFilter,
          columns: ECOLS, headerHeight: 28, rowHeight: 14,
          footerHeight: () => GCH * (1 + ELEC_CHECKS.length) + 6 + REM_H + 6 + SIG_H + 8,
        },
        {
          type: 'table', gap: 6,
          mode: 'fixed', dataKey: 'general_electrical',
          fixedRows: () => ELEC_CHECKS, columns: checksColumns(), headerHeight: 14, rowHeight: 14,
        },
        { type: 'text', gap: 8, label: 'Remarks:', dataKey: 'electrical_remarks', default: 'ALL MOTORS OK, PASSED.' },
        { type: 'signature', roles: SIG_ROLES },
      ],
    },
    {
      // Page 2 — Mechanical Check
      sections: [
        {
          type: 'image',
          title: 'Mechanical Dimensional Check sheet',
          dataKey: 'drawing_image', height: 100,
          placeholder: {
            text: (d) => `[Motor Technical Drawing — Dwg No: ${d.drawing_no || '____'}]`,
            annotations: [
              { text: 'PCD ø152.74 ±0.10', x: 6, y: 6, w: 120, size: 6.5 },
              { text: 'Temp. & Hall Sensor Cable 1250±50 mm · 8Pin Connector', xFrac: 0.35, y: 6, wFrac: 0.4, size: 6.5, align: 'center' },
              { text: 'Motor Power Cable 1250±50 mm', xFrac: 0.35, y: 16, wFrac: 0.4, size: 6.5, align: 'center' },
            ],
          },
        },
        {
          type: 'table', gap: 6,
          mode: 'repeatable', dataKey: 'rows', filterRow: activeRowsFilter,
          columns: MCOLS, headerHeight: 36, rowHeight: 14,
          specRow: { fill: '#fffde7', firstColLabel: 'Specification', build: buildSpecVals },
          footerHeight: (data) => GCH * (1 + mechChecks(data).length) + 6 + REM_H + 6 + SIG_H + 8,
        },
        {
          type: 'table', gap: 6,
          mode: 'fixed', dataKey: 'general_mechanical',
          fixedRows: mechChecks, columns: checksColumns(), headerHeight: 14, rowHeight: 14,
        },
        { type: 'text', gap: 8, label: 'Remarks:', dataKey: 'mechanical_remarks', default: 'ALL MOTORS OK, PASSED.' },
        { type: 'signature', roles: SIG_ROLES },
      ],
    },
    {
      // Page 3 — Photos
      sections: [
        { type: 'photo', mode: 'freeform', dataKey: 'photos' },
      ],
    },
  ],
};

module.exports = generalTemplate;
```

- [ ] **Step 3: Create the template registry**

```js
// models/operations/pdi/templates/index.js
'use strict';

const general = require('./general');

module.exports = { general };
```

- [ ] **Step 4: Rewrite `pdi_generator.js` as a thin dispatcher**

```js
// models/operations/pdi_generator.js
'use strict';

const PDFDocument = require('pdfkit');
const { registerFonts, M } = require('./pdi/primitives');
const { renderTemplate } = require('./pdi/renderer');
const templates = require('./pdi/templates');

class PDIGenerator {
  static generate(templateId, data = {}) {
    if (!data.pdi_no) throw new Error('pdi_no required');

    const template = templates[templateId];
    if (!template) throw new Error(`Unknown PDI template: ${templateId}`);

    const doc = new PDFDocument({
      size: 'A4',
      // bottom:0 — every draw call uses explicit x/y and its own
      // PAGE_H/BOT_M-based overflow checks, never PDFKit's flowing layout.
      // A non-zero bottom margin would make PDFKit silently insert a blank
      // page after every page (see primitives.js drawPageNum's comment).
      margins: { top: 10, bottom: 0, left: M, right: M },
      autoFirstPage: false,
      bufferPages: true,
    });
    registerFonts(doc);

    renderTemplate(doc, template, data);

    doc.end();
    return doc;
  }
}

module.exports = PDIGenerator;
```

- [ ] **Step 5: Update the two callers to pass `template_id`**

In `models/operations/pdiReports.js`:

```js
// finalizeReport — was:
// const pdfBuffer = await bufferPdf(PDIGenerator.generate({ ...(report.data || {}), photos: report.photos || [] }));
const pdfBuffer = await bufferPdf(PDIGenerator.generate(report.template_id, { ...(report.data || {}), photos: report.photos || [] }));
```

```js
// getPdfBuffer — was:
// return bufferPdf(PDIGenerator.generate({ ...(report.data || {}), photos: report.photos || [] }));
return bufferPdf(PDIGenerator.generate(report.template_id, { ...(report.data || {}), photos: report.photos || [] }));
```

- [ ] **Step 6: Source `getTemplates` from the registry**

In `controllers/operations/pdi.controller.js`, replace the whole file's content with:

```js
const templates = require('../../models/operations/pdi/templates');

exports.getTemplates = async (req, res) => {
  const list = Object.values(templates).map(({ id, name, version }) => ({ id, name, version }));
  res.json(list);
};
```

- [ ] **Step 7: Write a direct unit test for the generator + registry wiring**

```js
// tests/pdi_generator.test.js
const PDIGenerator = require('../models/operations/pdi_generator');

function bufferPdf(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

describe('PDIGenerator (template dispatch)', () => {
  it('generates a valid PDF for the general template', async () => {
    const buf = await bufferPdf(PDIGenerator.generate('general', {
      pdi_no: 'PDI-UNIT-1', customer_name: 'Unit Test Co.',
      rows: [{ motor_sr_no: 'SR1', voltage: '24V' }],
    }));
    expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('throws for an unknown template id', () => {
    expect(() => PDIGenerator.generate('does-not-exist', { pdi_no: 'X' })).toThrow(/Unknown PDI template/);
  });

  it('still requires pdi_no', () => {
    expect(() => PDIGenerator.generate('general', {})).toThrow(/pdi_no required/);
  });
});
```

- [ ] **Step 8: Run the full backend test suite**

Run: `npx jest tests/pdi_generator.test.js tests/pdi_template_renderer.test.js tests/pdi_primitives.test.js --forceExit`
Expected: PASS (all)

Run: `npx jest tests/pdiReports.test.js --forceExit`
Expected: PASS (12/12) — unmodified, this is the regression proof that the API layer's behavior didn't change.

- [ ] **Step 9: Visual verification against the "before" PDF from Step 1 — controller does this step personally, not a fresh subagent**

**If you're an implementer subagent executing this task: stop after Step 8 and report DONE_WITH_CONCERNS, noting that Step 9 (visual sign-off) is a controller step.** A fresh subagent has no memory of this project's established PDF-rendering workaround and shouldn't guess at it.

**If you're the controller (or continuing this session):** generate the "after" PDF using the same fixture data as Step 1 (same object, just `PDIGenerator.generate('general', data)`), save to `/tmp/pdi-visual-check/after.pdf`, then render both to PNG page-by-page using this project's established technique — `powershell.exe` (not `pwsh`) via the `Windows.Data.Pdf` WinRT API (Chrome headless doesn't work in this environment; see project memory `project_pdf_visual_verify.md` if available). Adapt the exact PowerShell invocation as needed — WinRT async interop via reflection is finicky and worth verifying against a throwaway single-page PDF first if it doesn't work on the first try. Then use the Read tool on each `before-pageN.png` / `after-pageN.png` pair and confirm they're visually identical (layout, text, table structure, image placement). If anything differs, it's a fidelity bug in the template/renderer — fix it before moving on. This step has no automated pass/fail; use your own judgment reading the rendered pages.

- [ ] **Step 10: Commit**

```bash
git add models/operations/pdi/templates/general.js models/operations/pdi/templates/index.js \
        models/operations/pdi_generator.js models/operations/pdiReports.js \
        controllers/operations/pdi.controller.js tests/pdi_generator.test.js
git commit -m "feat: re-express General PDI report as a template, dispatch PDF generation by template_id"
```

---

### Task 4: Frontend — template picker + template-aware routing

**Files:**
- Create: `CRM/src/components/shared/PdiTemplatePicker.jsx`
- Modify: `CRM/src/routeConfig.jsx`
- Modify: `CRM/src/components/shared/PdiReportsTable.jsx`

Today, the "PDI Generator" dashboard card links straight to `/pdi-generator`, which renders `PDIGeneratorForm` (General's form, opened as a modal on mount). This task inserts a template picker at `/pdi-generator` that auto-skips itself while only General exists, and moves General's actual form to `/pdi-generator/general`. Resume becomes template-aware. AutoNXT's own form component and route are added in Task 5 — this task only has to prove the mechanism works with one real template.

- [ ] **Step 1: Create the picker component**

```jsx
// CRM/src/components/shared/PdiTemplatePicker.jsx
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useNotify } from '../../hooks/useNotify';

const BASE_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:5000';

export default function PdiTemplatePicker() {
  const navigate = useNavigate();
  const { notifyError } = useNotify();
  const [templates, setTemplates] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = localStorage.getItem('token');
        const response = await fetch(`${BASE_URL}/api/pdi/templates`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) throw new Error(`Server responded with status: ${response.status}`);
        const list = await response.json();
        if (cancelled) return;

        if (list.length === 1) {
          navigate(`/pdi-generator/${list[0].id}`, { replace: true });
          return;
        }
        setTemplates(list);
      } catch (err) {
        if (!cancelled) notifyError(err.message || 'Could not load PDI templates.', { autoClose: 3000 });
      }
    })();
    return () => { cancelled = true; };
  }, [navigate, notifyError]);

  if (!templates) {
    return <div className="p-8 text-center text-gray-500">Loading PDI templates…</div>;
  }

  return (
    <div className="max-w-lg mx-auto mt-16 p-6">
      <h1 className="text-xl font-semibold mb-4">Choose a PDI Template</h1>
      <div className="flex flex-col gap-3">
        {templates.map((tpl) => (
          <button
            key={tpl.id}
            onClick={() => navigate(`/pdi-generator/${tpl.id}`)}
            className="text-left p-4 border rounded-lg hover:bg-amber-50 hover:border-amber-400 transition-colors"
          >
            <div className="font-medium">{tpl.name}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Register the new route and repoint General's route**

In `CRM/src/routeConfig.jsx`, add the import near the other `admin`/`shared` imports:

```js
import PdiTemplatePicker from "./components/shared/PdiTemplatePicker";
```

Find the existing entry:

```js
{
  path: "/pdi-generator",
  allowedRoles: ["admin", "production"],
  component: PDIGeneratorForm,
},
```

Replace it with two entries — the picker at the old path, General's form moved one level deeper:

```js
{
  path: "/pdi-generator",
  allowedRoles: ["admin", "production"],
  component: PdiTemplatePicker,
},
{
  path: "/pdi-generator/general",
  allowedRoles: ["admin", "production"],
  component: PDIGeneratorForm,
},
```

- [ ] **Step 3: Make Resume template-aware**

In `CRM/src/components/shared/PdiReportsTable.jsx`, find `handleResume` (around line 194-197):

```js
// was:
const handleResume = useCallback(
  (report) => {
    navigate(`/pdi-generator?report=${report.report_id}`);
```

Change the navigate call to route through the report's own template:

```js
const handleResume = useCallback(
  (report) => {
    navigate(`/pdi-generator/${report.template_id || 'general'}?report=${report.report_id}`);
```

(`|| 'general'` covers any report row whose `template_id` came back null/undefined — matches the DB column's existing default.)

- [ ] **Step 4: Manual verification**

This is routing/UX glue, not unit-testable in isolation without a browser. Start both dev servers and, using the `gstack` skill (already used earlier this session for the equivalent web-form-migration walkthrough):

1. Log in, click the "PDI Generator" dashboard card. Confirm it lands on the General form exactly as before (the picker should flash briefly or not be visible at all, since only one template exists).
2. Open the PDI Reports dashboard, click Resume on an existing report. Confirm it opens the form pre-filled, same as before.
3. Navigate directly to `/pdi-generator/general` — confirm it works the same as `/pdi-generator` did before this task.

- [ ] **Step 5: Commit**

```bash
git add src/components/shared/PdiTemplatePicker.jsx src/routeConfig.jsx src/components/shared/PdiReportsTable.jsx
git commit -m "feat: add PDI template picker, route General's form to /pdi-generator/general"
```

---

### Task 5: AutoNXT template (blocked — needs the reference document)

**Files:**
- Create: `models/operations/pdi/templates/autonxt.js` (backend)
- Modify: `models/operations/pdi/templates/index.js` (register it)
- Create: `CRM/src/components/admin/AutoNXTGeneratorForm.jsx` (frontend)
- Modify: `CRM/src/routeConfig.jsx` (add `/pdi-generator/autonxt` route)
- Test: `tests/pdi_generator.test.js` (extend with an AutoNXT case)

**This task cannot start without the AutoNXT reference PDF re-supplied by the user.** It was pasted into an earlier session and its content (exact fields, table columns, photo slot labels, sign-off structure) didn't survive into this plan. Everything in Tasks 1-4 is independent of it and should already be shipped by the time this task is picked up.

If you are an agentic worker executing this plan and reach this task without that document available in context: **stop and ask the user to re-paste the AutoNXT PDI PDF** before writing any code. Do not guess at field names, table structure, or photo slots — General's re-expression in Task 3 already proved the engine works; inventing AutoNXT's content instead of reading it from the real document would produce a template nobody asked for.

Once the document is available, the shape of the work is already established by Task 3's pattern:
1. Read the document, identify which of the 6 section types (header/table/photo/image/signature/text) each part of the page maps to — per the design spec, expect a `mode: 'repeatable'` table for the per-motor rows and a `mode: 'fixed-slots'` photo section for the labeled photo grid, but confirm against the actual document rather than assuming.
2. Write `models/operations/pdi/templates/autonxt.js` following `general.js`'s structure.
3. Register it in `models/operations/pdi/templates/index.js`.
4. Build `AutoNXTGeneratorForm.jsx` following `PDIGeneratorForm.jsx`'s save/finalize/resume patterns (same `handleOpen`/`handleSave`/`handleClose`/`handleFinalize` shape, same `POST /api/pdi/reports` with `template_id: 'autonxt'`).
5. Add the `/pdi-generator/autonxt` route.
6. Extend `tests/pdi_generator.test.js` with a case generating a valid PDF from the AutoNXT template.
7. Do the same before/after-style visual check as Task 3 Step 9 (there's no "before" here since this is new, but still render to PNG and eyeball it against the reference document).
