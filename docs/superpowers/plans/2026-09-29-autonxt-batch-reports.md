# AutoNXT Lot/Batch Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Parallel-safe grouping:** Tasks 1, 2, and 3 touch three completely independent files with no shared dependency between them — dispatch their implementer subagents in parallel. Task 4 depends on Task 3 (needs `numberBufferedPages` exported). Task 5 depends on Tasks 1, 2, and 4. Tasks 6, 7, 8 are strictly sequential after that (each builds on the previous file). Task 9 (live verification) is controller-personal, last.

**Goal:** Backend support for AutoNXT lot/batch PDI reports — one shared PDI number covering N motors, each an independently-editable report, finalized and combined into one server-rendered PDF together.

**Architecture:** A new `pdi_report_batches` table plus `batch_id`/`lot_index` columns on the existing report table. Every per-motor operation (create, edit, view) reuses the existing single-report model/routes completely unchanged. Only creation (atomic, transactional) and finalize (renders all N reports into one shared PDFKit document in a single pass, then caches/Drive-backs-up the combined PDF) are new, batch-specific code paths.

**Tech Stack:** Node.js/Express, `pg` (Pool + transactional client), PDFKit — no new dependencies.

---

### Task 1: Migration — `pdi_report_batches` table and `batch_id`/`lot_index` columns

**Files:**
- Create: `scripts/migrations/2026-09-29-add-pdi-report-batches.js`

- [ ] **Step 1: Write the migration**

```js
require('dotenv').config();
const pool = require('../../config/db');

async function migrate() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS pdi_report_batches (
      batch_id SERIAL PRIMARY KEY,
      template_id TEXT NOT NULL,
      pdi_no TEXT NOT NULL,
      lot_quantity INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'In Progress',
      drive_file_id TEXT,
      created_by INTEGER REFERENCES users(user_id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `ALTER TABLE pre_dispatch_inspection_reports ADD COLUMN IF NOT EXISTS batch_id INTEGER REFERENCES pdi_report_batches(batch_id)`,
    `ALTER TABLE pre_dispatch_inspection_reports ADD COLUMN IF NOT EXISTS lot_index INTEGER`,
  ];

  for (const sql of statements) {
    console.log('Running:', sql);
    await pool.query(sql);
  }

  console.log('Migration complete.');
  await pool.end();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
```

(Mirrors `scripts/migrations/2026-09-04-add-pdi-report-content.js` exactly — same shape, same `IF NOT EXISTS` idempotency, same invocation style, no migration-runner framework exists in this repo.)

- [ ] **Step 2: Run it**

Run: `node scripts/migrations/2026-09-29-add-pdi-report-batches.js`
Expected output:
```
Running: CREATE TABLE IF NOT EXISTS pdi_report_batches (...)
Running: ALTER TABLE pre_dispatch_inspection_reports ADD COLUMN IF NOT EXISTS batch_id ...
Running: ALTER TABLE pre_dispatch_inspection_reports ADD COLUMN IF NOT EXISTS lot_index ...
Migration complete.
```

- [ ] **Step 3: Verify the table and columns exist**

Run: `node -e "require('dotenv').config(); const pool = require('./config/db'); pool.query(\"SELECT column_name FROM information_schema.columns WHERE table_name = 'pdi_report_batches'\").then(r => { console.log(r.rows.map(x=>x.column_name)); pool.end(); })"`
Expected: an array containing `batch_id, template_id, pdi_no, lot_quantity, status, drive_file_id, created_by, created_at`.

- [ ] **Step 4: Commit**

```bash
git add scripts/migrations/2026-09-29-add-pdi-report-batches.js
git commit -m "$(cat <<'EOF'
feat: add pdi_report_batches table and batch_id/lot_index columns

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `pdfCache.js` — support a `batch-` prefix alongside the existing `report-` prefix

**Files:**
- Modify: `models/operations/pdi/pdfCache.js`
- Test: `tests/pdi_photo_optimizer.test.js` — **do not use this file**; create `tests/pdi_pdf_cache_prefix.test.js` instead (new, focused file — `pdfCache` doesn't have its own dedicated test file today; its existing coverage lives inside `tests/pdi_finalize_pdf.test.js`'s `describe('pdfCache', ...)` block, which this task extends in place rather than duplicating).

**Current full content of `models/operations/pdi/pdfCache.js`** (read it yourself to confirm — reproduced here for reference):

```js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const logger = require('../../../utils/logger');

const MAX_FILES = 100;

const cacheDir = () => process.env.PDI_PDF_CACHE_DIR || path.join(os.tmpdir(), 'pdi-pdf-cache');
const fileFor = (reportId) => path.join(cacheDir(), `report-${Number(reportId)}.pdf`);

async function read(reportId) {
  try {
    const buf = await fs.promises.readFile(fileFor(reportId));
    if (buf.length > 5 && buf.slice(0, 5).toString('ascii') === '%PDF-') return buf;
    await remove(reportId);
    return null;
  } catch (e) {
    if (e.code !== 'ENOENT') logger.warn(`PDI PDF cache read failed for report ${reportId}: ${e.message}`);
    return null;
  }
}

async function write(reportId, buffer) {
  try {
    await fs.promises.mkdir(cacheDir(), { recursive: true });
    const target = fileFor(reportId);
    const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await fs.promises.writeFile(temp, buffer);
    await fs.promises.rename(temp, target);
    await evictOldest();
    return true;
  } catch (e) {
    logger.warn(`PDI PDF cache write failed for report ${reportId}: ${e.message}`);
    return false;
  }
}

async function remove(reportId) {
  try {
    await fs.promises.unlink(fileFor(reportId));
  } catch (e) {
    if (e.code !== 'ENOENT') logger.warn(`PDI PDF cache remove failed for report ${reportId}: ${e.message}`);
  }
}

async function evictOldest() {
  const dir = cacheDir();
  const names = (await fs.promises.readdir(dir)).filter((n) => /^report-\d+\.pdf$/.test(n));
  if (names.length <= MAX_FILES) return;
  const withTimes = await Promise.all(names.map(async (n) => ({ n, t: (await fs.promises.stat(path.join(dir, n))).mtimeMs })));
  withTimes.sort((a, b) => a.t - b.t);
  await Promise.all(withTimes.slice(0, names.length - MAX_FILES).map((f) => fs.promises.unlink(path.join(dir, f.n)).catch(() => {})));
}

module.exports = { read, write, remove, MAX_FILES };
```

- [ ] **Step 1: Write the failing test**

Create `tests/pdi_pdf_cache_prefix.test.js`:

```js
const fs = require('fs');
const os = require('os');
const path = require('path');
const pdfCache = require('../models/operations/pdi/pdfCache');

let cacheDir;
beforeEach(() => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdi-cache-prefix-test-'));
  process.env.PDI_PDF_CACHE_DIR = cacheDir;
});
afterEach(() => { fs.rmSync(cacheDir, { recursive: true, force: true }); delete process.env.PDI_PDF_CACHE_DIR; });

describe('pdfCache — batch prefix', () => {
  it('defaults to the "report" prefix, unchanged from today', async () => {
    await pdfCache.write(7, Buffer.from('%PDF-1.4 report'));
    expect(fs.existsSync(path.join(cacheDir, 'report-7.pdf'))).toBe(true);
    expect((await pdfCache.read(7)).toString()).toBe('%PDF-1.4 report');
  });

  it('a "batch" prefix writes/reads a separate file from the same id under "report"', async () => {
    await pdfCache.write(7, Buffer.from('%PDF-1.4 report'));
    await pdfCache.write(7, Buffer.from('%PDF-1.4 batch'), 'batch');
    expect(fs.existsSync(path.join(cacheDir, 'batch-7.pdf'))).toBe(true);
    expect((await pdfCache.read(7)).toString()).toBe('%PDF-1.4 report'); // unaffected
    expect((await pdfCache.read(7, 'batch')).toString()).toBe('%PDF-1.4 batch');
  });

  it('remove(id, "batch") only removes the batch file, not the report file with the same id', async () => {
    await pdfCache.write(7, Buffer.from('%PDF-1.4 report'));
    await pdfCache.write(7, Buffer.from('%PDF-1.4 batch'), 'batch');
    await pdfCache.remove(7, 'batch');
    expect(await pdfCache.read(7, 'batch')).toBeNull();
    expect((await pdfCache.read(7)).toString()).toBe('%PDF-1.4 report');
  });

  it('eviction counts report and batch files together against one shared MAX_FILES budget', async () => {
    for (let i = 1; i <= pdfCache.MAX_FILES; i++) {
      await pdfCache.write(i, Buffer.from(`%PDF-1.4 ${i}`));
      const f = path.join(cacheDir, `report-${i}.pdf`);
      fs.utimesSync(f, new Date(Date.now() - (10000 - i) * 1000), new Date(Date.now() - (10000 - i) * 1000));
    }
    // One more file, as a batch -- pushes total past MAX_FILES, should evict the oldest report file.
    await pdfCache.write(999, Buffer.from('%PDF-1.4 newest'), 'batch');
    const left = fs.readdirSync(cacheDir).filter((n) => /^(?:report|batch)-\d+\.pdf$/.test(n));
    expect(left.length).toBeLessThanOrEqual(pdfCache.MAX_FILES);
    expect(await pdfCache.read(999, 'batch')).not.toBeNull(); // newest survives
    expect(await pdfCache.read(1)).toBeNull(); // oldest report evicted
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/pdi_pdf_cache_prefix.test.js`
Expected: FAIL — `pdfCache.write(id, buffer, 'batch')`/`read(id, 'batch')`/`remove(id, 'batch')` currently ignore the third argument (everything defaults to the `report-` prefix), so the "batch" tests fail; the "defaults to report" test already passes.

- [ ] **Step 3: Add the prefix parameter**

Replace `models/operations/pdi/pdfCache.js` in full:

```js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const logger = require('../../../utils/logger');

// A finished (Completed) PDI report is locked against edits, so the PDF built
// when it was finalized is the PDF it will always have -- there is nothing to
// gain by rendering it again on every "View PDF" / recovery request. This keeps
// the last MAX_FILES of them on the server's disk and serves them straight back.
//
// It is only a cache: the disk is the container's own, so a redeploy empties it,
// and a miss just falls back to rendering from the stored report, exactly as
// before. Every operation here is best-effort and never throws -- a full or
// read-only disk must not break finalizing or downloading.
//
// `prefix` distinguishes a single report's cache entry ('report', the default,
// used by every pre-existing call site unchanged) from a batch's combined PDF
// ('batch', new) -- both share this one directory and one MAX_FILES budget.
const MAX_FILES = 100;

// Resolved on each call (not at load) so a test can point it at a temp folder.
const cacheDir = () => process.env.PDI_PDF_CACHE_DIR || path.join(os.tmpdir(), 'pdi-pdf-cache');
const fileFor = (id, prefix = 'report') => path.join(cacheDir(), `${prefix}-${Number(id)}.pdf`);

async function read(id, prefix = 'report') {
  try {
    const buf = await fs.promises.readFile(fileFor(id, prefix));
    if (buf.length > 5 && buf.slice(0, 5).toString('ascii') === '%PDF-') return buf;
    await remove(id, prefix); // a truncated/garbled file is worse than a miss
    return null;
  } catch (e) {
    if (e.code !== 'ENOENT') logger.warn(`PDI PDF cache read failed for ${prefix} ${id}: ${e.message}`);
    return null;
  }
}

// Written to a temp name then renamed, so a reader never sees a half-written file.
async function write(id, buffer, prefix = 'report') {
  try {
    await fs.promises.mkdir(cacheDir(), { recursive: true });
    const target = fileFor(id, prefix);
    const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await fs.promises.writeFile(temp, buffer);
    await fs.promises.rename(temp, target);
    await evictOldest();
    return true;
  } catch (e) {
    logger.warn(`PDI PDF cache write failed for ${prefix} ${id}: ${e.message}`);
    return false;
  }
}

async function remove(id, prefix = 'report') {
  try {
    await fs.promises.unlink(fileFor(id, prefix));
  } catch (e) {
    if (e.code !== 'ENOENT') logger.warn(`PDI PDF cache remove failed for ${prefix} ${id}: ${e.message}`);
  }
}

async function evictOldest() {
  const dir = cacheDir();
  const names = (await fs.promises.readdir(dir)).filter((n) => /^(?:report|batch)-\d+\.pdf$/.test(n));
  if (names.length <= MAX_FILES) return;
  const withTimes = await Promise.all(names.map(async (n) => ({ n, t: (await fs.promises.stat(path.join(dir, n))).mtimeMs })));
  withTimes.sort((a, b) => a.t - b.t);
  await Promise.all(withTimes.slice(0, names.length - MAX_FILES).map((f) => fs.promises.unlink(path.join(dir, f.n)).catch(() => {})));
}

module.exports = { read, write, remove, MAX_FILES };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/pdi_pdf_cache_prefix.test.js`
Expected: PASS — all 4 tests.

- [ ] **Step 5: Run the existing pdfCache tests to confirm zero regression**

Run: `npx jest tests/pdi_finalize_pdf.test.js -t "pdfCache"`
Expected: PASS — every pre-existing `pdfCache` test (all omit the third argument, so they exercise the default `'report'` prefix exactly as before).

- [ ] **Step 6: Commit**

```bash
git add models/operations/pdi/pdfCache.js tests/pdi_pdf_cache_prefix.test.js
git commit -m "$(cat <<'EOF'
feat: pdfCache supports a batch-prefixed cache entry alongside report-prefixed ones

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `renderer.js` — make `renderTemplate` safe to call more than once against one shared document

**Files:**
- Modify: `models/operations/pdi/renderer.js`
- Test: `tests/pdi_template_renderer.test.js`

**Why:** `renderTemplate`'s last step renumbers *every currently-buffered page* in the document (`doc.bufferedPageRange()`, which returns ALL pages ever added to `doc`, not just the ones from this call). Calling `renderTemplate` a second time against the same `doc` (which batch-combining needs to do, once per linked report) would re-draw "Pg X of TOTAL" text over every earlier report's already-numbered footers — `t()`'s text draws have no background rectangle, so the old and new numbers would visually overlap into garbled text. This task makes the page-numbering pass optional and separately callable, with the default behavior (used by every existing single-report call site) completely unchanged.

**Current relevant content of `models/operations/pdi/renderer.js`** (the end of the file):

```js
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

(`drawPageNum` is already imported from `./primitives` at the top of this file — confirm the exact import line yourself before editing, it's `const { ..., drawPageNum, ... } = require('./primitives');`.)

- [ ] **Step 1: Write the failing test**

Add to `tests/pdi_template_renderer.test.js`, as a new `describe` block just before the final closing `});` of the file's outer `describe('PDI template renderer', ...)`:

```js
  describe('renderTemplate called more than once against the same document (batch combining)', () => {
    const onePageTemplate = (label) => ({
      pages: [{ sections: [{ type: 'text', label, dataKey: 'remarks', default: label }] }],
    });

    it('numberPages: false skips the page-numbering pass entirely', async () => {
      const doc = new PDFDocument({ size: 'A4', margins: { top: 10, bottom: 0, left: 36, right: 36 }, autoFirstPage: false, bufferPages: true });
      registerFonts(doc);
      const drawnTexts = [];
      const originalText = doc.text.bind(doc);
      doc.text = (str, ...rest) => { drawnTexts.push(String(str)); return originalText(str, ...rest); };

      renderTemplate(doc, onePageTemplate('A'), {}, { numberPages: false });
      doc.end();
      await bufferPdf(doc);

      expect(drawnTexts.some((t) => /^Pg \d+ of \d+$/.test(t))).toBe(false);
    });

    it('default behavior (no options) still numbers pages, unchanged', async () => {
      const doc = new PDFDocument({ size: 'A4', margins: { top: 10, bottom: 0, left: 36, right: 36 }, autoFirstPage: false, bufferPages: true });
      registerFonts(doc);
      const drawnTexts = [];
      const originalText = doc.text.bind(doc);
      doc.text = (str, ...rest) => { drawnTexts.push(String(str)); return originalText(str, ...rest); };

      renderTemplate(doc, onePageTemplate('A'), {});
      doc.end();
      await bufferPdf(doc);

      expect(drawnTexts).toContain('Pg 1 of 1');
    });

    it('numberBufferedPages, called once after two numberPages:false renders, numbers across the WHOLE combined document', async () => {
      const doc = new PDFDocument({ size: 'A4', margins: { top: 10, bottom: 0, left: 36, right: 36 }, autoFirstPage: false, bufferPages: true });
      registerFonts(doc);
      const drawnTexts = [];
      const originalText = doc.text.bind(doc);
      doc.text = (str, ...rest) => { drawnTexts.push(String(str)); return originalText(str, ...rest); };

      renderTemplate(doc, onePageTemplate('A'), {}, { numberPages: false });
      renderTemplate(doc, onePageTemplate('B'), {}, { numberPages: false });
      numberBufferedPages(doc);
      doc.end();
      await bufferPdf(doc);

      // Two 1-page reports combined -> continuous "Pg 1 of 2" / "Pg 2 of 2",
      // not each restarting at "Pg 1 of 1".
      expect(drawnTexts).toContain('Pg 1 of 2');
      expect(drawnTexts).toContain('Pg 2 of 2');
      expect(drawnTexts.filter((t) => /^Pg \d+ of \d+$/.test(t))).toHaveLength(2);
    });
  });
```

Add `numberBufferedPages` to the destructured import at the top of the test file (find the existing line importing `renderTemplate` from `../models/operations/pdi/renderer` and add it alongside):

```js
const { renderTemplate, numberBufferedPages } = require('../models/operations/pdi/renderer');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/pdi_template_renderer.test.js -t "called more than once"`
Expected: FAIL — `renderTemplate` doesn't accept a 4th options argument yet, and `numberBufferedPages` isn't exported (the destructure will be `undefined`, causing a `TypeError` when called).

- [ ] **Step 3: Implement**

Replace the end of `models/operations/pdi/renderer.js` (the `renderTemplate` function and its `module.exports`) with:

```js
// Draws page-number footers ("Pg X of TOTAL") on every currently-buffered
// page. Split out of renderTemplate so batch-combining code can call it
// exactly ONCE after rendering all N reports into one shared document,
// instead of once per report -- see renderTemplate's numberPages option.
function numberBufferedPages(doc) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    drawPageNum(doc, i + 1, range.count);
  }
}

// `numberPages` (default true, unchanged for every existing single-report
// call site): when false, skips the page-numbering pass. Needed because
// doc.bufferedPageRange() returns EVERY page ever added to `doc`, not just
// the ones from this call -- calling the numbering pass a second time (e.g.
// once per report while combining several into one shared document) would
// redraw "Pg X of TOTAL" text directly over every earlier report's
// already-numbered footer, with no background rectangle to hide the old
// text underneath (t() draws transparent text, nothing else). A caller doing
// that instead passes numberPages:false for every report and calls
// numberBufferedPages(doc) itself exactly once at the end, producing one
// continuous page count across the whole combined document.
function renderTemplate(doc, template, data, { numberPages = true } = {}) {
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

  if (numberPages) numberBufferedPages(doc);
}

module.exports = { renderTemplate, numberBufferedPages };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/pdi_template_renderer.test.js`
Expected: PASS — every test in the file, including the 3 new ones and every pre-existing test (backward compatibility: no existing call site passes a 4th argument, so `numberPages` defaults to `true` and behavior is byte-for-byte identical to before).

- [ ] **Step 5: Run the full renderer-dependent test suite for regressions**

Run: `npx jest tests/pdi_template_renderer.test.js tests/pdi_autonxt_tolerance.test.js tests/pdi_general_v1_0_8.test.js`
Expected: PASS, all suites.

- [ ] **Step 6: Commit**

```bash
git add models/operations/pdi/renderer.js tests/pdi_template_renderer.test.js
git commit -m "$(cat <<'EOF'
feat: renderTemplate can skip page-numbering so batch combining can number once, at the end

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `pdi_generator.js` — `generateCombined()`, rendering N reports into one shared PDF

**Files:**
- Modify: `models/operations/pdi_generator.js`
- Test: `tests/pdi_generator_combined.test.js` (new)

Depends on Task 3 (`numberBufferedPages` must already be exported from `renderer.js`).

**Current full content of `models/operations/pdi_generator.js`:**

```js
// models/operations/pdi_generator.js
'use strict';

const PDFDocument = require('pdfkit');
const { registerFonts, M } = require('./pdi/primitives');
const { renderTemplate } = require('./pdi/renderer');
const templates = require('./pdi/templates');
const AuthoredTemplates = require('./pdi/authoredTemplates');
const { hydrateTemplate, buildSampleData } = require('./pdi/authoredTemplate');
const { optimizePhotoData } = require('./pdi/photoOptimizer');

function renderPdfDoc(template, data) {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 10, bottom: 0, left: M, right: M },
    autoFirstPage: false,
    bufferPages: true,
  });
  registerFonts(doc);
  renderTemplate(doc, template, data);
  doc.end();
  return doc;
}

async function renderOptimizedPdfDoc(template, data, options = {}) {
  const stats = {};
  const optimized = await optimizePhotoData(template, data, stats);
  if (options.timings) options.timings.optimize = stats;
  return renderPdfDoc(template, optimized);
}

class PDIGenerator {
  static async generate(templateId, templateVersion, data = {}, options = {}) {
    if (!data.pdi_no) throw new Error('pdi_no required');

    const codeTemplate = templates[templateId];
    if (codeTemplate) return renderOptimizedPdfDoc(codeTemplate, data, options);

    const row = await AuthoredTemplates.getByVersion(templateId, templateVersion);
    if (!row) throw new Error(`Unknown PDI template: ${templateId}`);
    return renderOptimizedPdfDoc(hydrateTemplate(row.definition), data, options);
  }

  static previewFromDefinition(definition, data) {
    return renderPdfDoc(hydrateTemplate(definition), data ?? buildSampleData(definition));
  }
}

module.exports = PDIGenerator;
```

- [ ] **Step 1: Write the failing test**

Create `tests/pdi_generator_combined.test.js`:

```js
const PDIGenerator = require('../models/operations/pdi_generator');

function bufferPdf(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

const motorData = (n) => ({
  customer_name: 'Unit Test Co.', pdi_no: 'BATCH-TEST-1', motor_sr_no: `SR${n}`,
});

describe('PDIGenerator.generateCombined', () => {
  it('renders N reports into one PDF, more pages than any single report alone', async () => {
    const single = await bufferPdf(await PDIGenerator.generate('autonxt', null, motorData(1)));
    const combined = await bufferPdf(await PDIGenerator.generateCombined([
      { templateId: 'autonxt', templateVersion: null, data: motorData(1) },
      { templateId: 'autonxt', templateVersion: null, data: motorData(2) },
      { templateId: 'autonxt', templateVersion: null, data: motorData(3) },
    ]));
    expect(combined.slice(0, 5).toString('ascii')).toBe('%PDF-');
    // A combined 3-motor PDF must be substantially larger than one motor's own PDF.
    expect(combined.length).toBeGreaterThan(single.length * 2);
  });

  it('numbers pages continuously across the whole combined document, not restarting per report', async () => {
    const PDFDocument = require('pdfkit');
    const originalPDFDocument = PDFDocument;
    // Spy on doc.text via a lightweight monkey-patch of PDFDocument.prototype.text,
    // restored after the assertion -- generateCombined constructs its own
    // PDFDocument internally, so there's no other hook to capture drawn text.
    const drawn = [];
    const originalText = originalPDFDocument.prototype.text;
    originalPDFDocument.prototype.text = function patchedText(str, ...rest) {
      drawn.push(String(str));
      return originalText.call(this, str, ...rest);
    };
    try {
      await bufferPdf(await PDIGenerator.generateCombined([
        { templateId: 'autonxt', templateVersion: null, data: motorData(1) },
        { templateId: 'autonxt', templateVersion: null, data: motorData(2) },
      ]));
    } finally {
      originalPDFDocument.prototype.text = originalText;
    }
    const pageLabels = drawn.filter((t) => /^Pg \d+ of \d+$/.test(t));
    // AutoNXT is a 3-page template -- 2 motors combined = 6 pages, numbered
    // "Pg 1 of 6".."Pg 6 of 6", never restarting at "Pg 1 of 3" for motor 2.
    expect(pageLabels).toHaveLength(6);
    expect(pageLabels).toContain('Pg 1 of 6');
    expect(pageLabels).toContain('Pg 6 of 6');
    expect(pageLabels.some((t) => t === 'Pg 1 of 3')).toBe(false);
  });

  it('rejects a report missing pdi_no, the same requirement generate() already has', async () => {
    await expect(PDIGenerator.generateCombined([
      { templateId: 'autonxt', templateVersion: null, data: { customer_name: 'No number' } },
    ])).rejects.toThrow('pdi_no required');
  });

  it('rejects an unknown template id, the same as generate()', async () => {
    await expect(PDIGenerator.generateCombined([
      { templateId: 'not-a-real-template', templateVersion: null, data: motorData(1) },
    ])).rejects.toThrow(/Unknown PDI template/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/pdi_generator_combined.test.js`
Expected: FAIL — `PDIGenerator.generateCombined` is not a function yet.

- [ ] **Step 3: Implement `generateCombined`**

Replace `models/operations/pdi_generator.js` in full:

```js
// models/operations/pdi_generator.js
'use strict';

const PDFDocument = require('pdfkit');
const { registerFonts, M } = require('./pdi/primitives');
const { renderTemplate, numberBufferedPages } = require('./pdi/renderer');
const templates = require('./pdi/templates');
const AuthoredTemplates = require('./pdi/authoredTemplates');
const { hydrateTemplate, buildSampleData } = require('./pdi/authoredTemplate');
const { optimizePhotoData } = require('./pdi/photoOptimizer');

function renderPdfDoc(template, data) {
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

async function renderOptimizedPdfDoc(template, data, options = {}) {
  const stats = {};
  const optimized = await optimizePhotoData(template, data, stats);
  if (options.timings) options.timings.optimize = stats;
  return renderPdfDoc(template, optimized);
}

// Resolves a (templateId, templateVersion) pair to a renderable template
// object -- the same code-registry-then-DB lookup generate() already does,
// pulled out so generateCombined can call it once per report without
// duplicating the logic.
async function resolveTemplate(templateId, templateVersion) {
  const codeTemplate = templates[templateId];
  if (codeTemplate) return codeTemplate;
  const row = await AuthoredTemplates.getByVersion(templateId, templateVersion);
  if (!row) throw new Error(`Unknown PDI template: ${templateId}`);
  return hydrateTemplate(row.definition);
}

class PDIGenerator {
  // templateVersion is only meaningful for DB-backed templates — pass null
  // for a code-registered template id (general, autonxt, ...).
  static async generate(templateId, templateVersion, data = {}, options = {}) {
    if (!data.pdi_no) throw new Error('pdi_no required');

    // Code-registered templates always win here if a DB-authored template's id
    // ever collided with one (general, autonxt, ...). That collision isn't
    // prevented yet anywhere in the code today — AuthoredTemplates.create does
    // a bare INSERT with no check against the code registry. It's *planned* to
    // be closed by the admin API's createTemplate rejecting the collision with
    // a 409 (see docs/superpowers/specs/2026-09-08-pdi-template-authoring-design.md),
    // a task not yet built. Until that ships, don't treat this check as a
    // resolved tiebreaker — it's just the fast path for the common case today
    // (a code template, no DB round-trip needed).
    const codeTemplate = templates[templateId];
    if (codeTemplate) return renderOptimizedPdfDoc(codeTemplate, data, options);

    const row = await AuthoredTemplates.getByVersion(templateId, templateVersion);
    if (!row) throw new Error(`Unknown PDI template: ${templateId}`);
    return renderOptimizedPdfDoc(hydrateTemplate(row.definition), data, options);
  }

  // Renders N reports into ONE shared PDF document, in the given order --
  // used by AutoNXT batch finalize to produce one combined PDF instead of N
  // separate ones (no PDF-merge library in this codebase, and PDFKit can't
  // import pre-rendered PDF bytes anyway). `reportsData` is
  // [{ templateId, templateVersion, data }, ...], already in the order the
  // combined PDF should read in (lot_index order for a batch). Each report's
  // photos are downscaled the same way a single-report PDF already is.
  // Page numbering runs ONCE across the whole combined document at the end
  // (continuous "Pg X of TOTAL"), not restarted per report -- see
  // renderer.js's renderTemplate `numberPages` option for why a second
  // in-place numbering pass would corrupt earlier reports' footers.
  static async generateCombined(reportsData, options = {}) {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 10, bottom: 0, left: M, right: M },
      autoFirstPage: false,
      bufferPages: true,
    });
    registerFonts(doc);

    for (const { templateId, templateVersion, data } of reportsData) {
      if (!data.pdi_no) throw new Error('pdi_no required');
      const template = await resolveTemplate(templateId, templateVersion);
      const stats = {};
      const optimized = await optimizePhotoData(template, data, stats);
      if (options.timings) options.timings.push(stats);
      renderTemplate(doc, template, optimized, { numberPages: false });
    }

    numberBufferedPages(doc);
    doc.end();
    return doc;
  }

  // No DB lookup, no pdi_no requirement — used by the admin preview endpoint
  // to render an in-progress (possibly unsaved) draft definition directly.
  static previewFromDefinition(definition, data) {
    return renderPdfDoc(hydrateTemplate(definition), data ?? buildSampleData(definition));
  }
}

module.exports = PDIGenerator;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/pdi_generator_combined.test.js`
Expected: PASS — all 4 tests.

- [ ] **Step 5: Run the full generator/renderer suite for regressions**

Run: `npx jest tests/pdi_generator.test.js tests/pdi_template_renderer.test.js tests/pdi_autonxt_tolerance.test.js tests/pdi_general_v1_0_8.test.js`
Expected: PASS, all suites (if `tests/pdi_generator.test.js` can't reach its DB dependency in your sandbox, note that clearly and move on — this has happened intermittently for other subagents this session and is an environment limitation, not a code regression from this change, which touches no DB code).

- [ ] **Step 6: Commit**

```bash
git add models/operations/pdi_generator.js tests/pdi_generator_combined.test.js
git commit -m "$(cat <<'EOF'
feat: PDIGenerator.generateCombined renders N reports into one shared PDF

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `pdiReportBatches.js` model — create, read, finalize, download

**Files:**
- Create: `models/operations/pdiReportBatches.js`
- Test: `tests/pdi_report_batches.test.js` (new)

Depends on Tasks 1 (table exists), 2 (`pdfCache` prefix), and 4 (`generateCombined`).

**Reference — exact patterns this task reuses, read the source files yourself to confirm current line numbers before writing:**
- Transaction pattern (`models/manufacturing/bom.js:91-227`): `const client = await pool.connect(); try { await client.query('BEGIN'); ...; await client.query('COMMIT'); return ...; } catch (e) { await client.query('ROLLBACK'); throw ...; } finally { client.release(); }`.
- `pool` is a plain `pg.Pool` from `require('../config/db')`, exporting `.query()` and `.connect()` directly (`config/db.js`).
- The guarded finalize UPDATE (`models/operations/pdiReports.js:485-490`): `UPDATE pre_dispatch_inspection_reports SET status = 'Completed' WHERE report_id = $1 AND status <> 'Completed' RETURNING report_id, status`.
- `bufferPdf(doc)` helper (`models/operations/pdiReports.js:63-70`) — duplicate it here (small, self-contained, same duplication this codebase already accepts elsewhere rather than a shared micro-util for one four-line function).
- `#backupPdfToDrive` pattern (`models/operations/pdiReports.js:518-538`) — mirrored here at the batch level, using `uploadBufferToDrivePrivate`/`deleteDriveFile` from `services/googleDrive` and writing `pdi_report_batches.drive_file_id` instead of the report table's column.
- The test-mocking style (`tests/pdi_finalize_pdf.test.js:1-48`): `jest.mock('../config/db', () => ({ query: ..., connect: ... }))` and `jest.mock('../services/googleDrive', ...)` — no real Postgres connection in any Jest test in this repo; extend this pattern with a mocked transactional `client` (an object with its own `query`/`release` jest mocks) for the new `pool.connect()`-based creation flow.

- [ ] **Step 1: Write the failing test**

Create `tests/pdi_report_batches.test.js`:

```js
// AutoNXT lot/batch reports (docs/superpowers/specs/2026-09-29-autonxt-batch-reports-design.md).
// The database and Google Drive are mocked, matching every other PDI model test in this repo --
// see tests/pdi_finalize_pdf.test.js for the established pattern this extends.
const fs = require('fs');
const os = require('os');
const path = require('path');

const mockClient = {
  query: jest.fn(),
  release: jest.fn(),
};
const mockState = {
  poolQueryImpl: null, // set per-test for pool.query calls outside a transaction
  clientQueryImpl: null, // set per-test for client.query calls inside a transaction
};
const mockQuery = jest.fn(async (...args) => {
  if (mockState.poolQueryImpl) return mockState.poolQueryImpl(...args);
  return { rows: [], rowCount: 0 };
});
const mockConnect = jest.fn(async () => mockClient);
const mockUpload = jest.fn();
const mockDeleteDrive = jest.fn(async () => undefined);

jest.mock('../config/db', () => ({
  query: (...a) => mockQuery(...a),
  connect: (...a) => mockConnect(...a),
}));
jest.mock('../services/googleDrive', () => ({
  uploadBufferToDrivePrivate: (...a) => mockUpload(...a),
  deleteDriveFile: (...a) => mockDeleteDrive(...a),
}));

const PdiReportBatches = require('../models/operations/pdiReportBatches');
const pdfCache = require('../models/operations/pdi/pdfCache');

let cacheDir;
beforeEach(() => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdi-batch-cache-test-'));
  process.env.PDI_PDF_CACHE_DIR = cacheDir;
  mockQuery.mockClear();
  mockConnect.mockClear();
  mockClient.query.mockReset();
  mockClient.release.mockClear();
  mockUpload.mockReset();
  mockDeleteDrive.mockClear();
  mockState.poolQueryImpl = null;
  mockState.clientQueryImpl = null;
});
afterEach(() => { fs.rmSync(cacheDir, { recursive: true, force: true }); delete process.env.PDI_PDF_CACHE_DIR; });

describe('createBatch', () => {
  it('validates lot quantity is an integer in [1, 50]', async () => {
    await expect(PdiReportBatches.createBatch({ template_id: 'autonxt', pdi_no: 'P-1', quantity: 0 }))
      .rejects.toMatchObject({ code: 'INVALID_LOT_QUANTITY' });
    await expect(PdiReportBatches.createBatch({ template_id: 'autonxt', pdi_no: 'P-1', quantity: 51 }))
      .rejects.toMatchObject({ code: 'INVALID_LOT_QUANTITY' });
    await expect(PdiReportBatches.createBatch({ template_id: 'autonxt', pdi_no: 'P-1', quantity: 2.5 }))
      .rejects.toMatchObject({ code: 'INVALID_LOT_QUANTITY' });
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('creates one batch row and N linked report rows inside one transaction, in lot_index order', async () => {
    let call = 0;
    mockClient.query.mockImplementation(async (sql, params) => {
      call++;
      if (sql === 'BEGIN' || sql === 'COMMIT') return {};
      if (/INSERT INTO pdi_report_batches/.test(sql)) {
        return { rows: [{ batch_id: 101, template_id: 'autonxt', pdi_no: 'PDI-2026-001', lot_quantity: 3, status: 'In Progress' }] };
      }
      if (/INSERT INTO pre_dispatch_inspection_reports/.test(sql)) {
        // params include batch_id and lot_index -- confirm exact values per call
        const lotIndex = params[params.length - 1];
        return { rows: [{ report_id: 1000 + lotIndex, lot_index: lotIndex }] };
      }
      throw new Error(`Unexpected query in test: ${sql}`);
    });

    const result = await PdiReportBatches.createBatch({ template_id: 'autonxt', pdi_no: 'PDI-2026-001', quantity: 3, created_by: 5 });

    expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
    expect(result.batch_id).toBe(101);
    expect(result.lot_quantity).toBe(3);
    expect(result.status).toBe('In Progress');
    expect(result.reports).toEqual([
      { report_id: 1001, lot_index: 1, lot_quantity: 3 },
      { report_id: 1002, lot_index: 2, lot_quantity: 3 },
      { report_id: 1003, lot_index: 3, lot_quantity: 3 },
    ]);
  });

  it('rolls back the whole transaction if any report insert fails -- no partial batch', async () => {
    mockClient.query.mockImplementation(async (sql, params) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
      if (/INSERT INTO pdi_report_batches/.test(sql)) return { rows: [{ batch_id: 101, template_id: 'autonxt', pdi_no: 'P', lot_quantity: 3, status: 'In Progress' }] };
      if (/INSERT INTO pre_dispatch_inspection_reports/.test(sql)) {
        const lotIndex = params[params.length - 1];
        if (lotIndex === 2) throw new Error('simulated DB failure on report 2');
        return { rows: [{ report_id: 1000 + lotIndex, lot_index: lotIndex }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    await expect(PdiReportBatches.createBatch({ template_id: 'autonxt', pdi_no: 'P', quantity: 3 })).rejects.toThrow(/simulated DB failure/);
    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClient.query).not.toHaveBeenCalledWith('COMMIT');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });
});

describe('finalizeBatch', () => {
  const reportRow = (lotIndex, over = {}) => ({
    report_id: 1000 + lotIndex, lot_index: lotIndex, status: 'Pending', template_id: 'autonxt', template_version: null,
    data: { pdi_no: 'PDI-2026-001', customer_name: 'Unit', motor_sr_no: `SR${lotIndex}` }, photos: {},
    ...over,
  });

  it('marks every linked report Completed, renders one combined PDF, and marks the batch Completed', async () => {
    mockState.poolQueryImpl = async (sql, params) => {
      if (/SELECT [\s\S]*FROM pdi_report_batches WHERE batch_id/.test(sql)) {
        return { rows: [{ batch_id: 101, template_id: 'autonxt', pdi_no: 'PDI-2026-001', lot_quantity: 2, status: 'In Progress' }] };
      }
      if (/SELECT [\s\S]*FROM pre_dispatch_inspection_reports WHERE batch_id/.test(sql)) {
        return { rows: [reportRow(1), reportRow(2)] };
      }
      if (/UPDATE pre_dispatch_inspection_reports[\s\S]*SET status = 'Completed'[\s\S]*WHERE report_id/.test(sql)) {
        return { rows: [{ report_id: params[0], status: 'Completed' }], rowCount: 1 };
      }
      if (/UPDATE pdi_report_batches SET status = 'Completed'/.test(sql)) {
        return { rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };
    mockUpload.mockResolvedValue({ id: 'drive-batch-1' });

    const result = await PdiReportBatches.finalizeBatch(101);
    expect(result.pdfBuffer.slice(0, 5).toString('ascii')).toBe('%PDF-');
    expect(result.payload.status).toBe('Completed');
    await result.background;
    expect(await pdfCache.read(101, 'batch')).not.toBeNull();
  });

  it('refuses an already-Completed batch without touching any report or rendering anything', async () => {
    mockState.poolQueryImpl = async (sql) => {
      if (/SELECT [\s\S]*FROM pdi_report_batches WHERE batch_id/.test(sql)) {
        return { rows: [{ batch_id: 101, template_id: 'autonxt', pdi_no: 'P', lot_quantity: 2, status: 'Completed' }] };
      }
      return { rows: [], rowCount: 0 };
    };
    await expect(PdiReportBatches.finalizeBatch(101)).rejects.toMatchObject({ code: 'BATCH_ALREADY_FINALIZED' });
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('fails the whole batch before marking anything Completed if one report is missing pdi_no', async () => {
    mockState.poolQueryImpl = async (sql) => {
      if (/SELECT [\s\S]*FROM pdi_report_batches WHERE batch_id/.test(sql)) {
        return { rows: [{ batch_id: 101, template_id: 'autonxt', pdi_no: 'PDI-2026-001', lot_quantity: 2, status: 'In Progress' }] };
      }
      if (/SELECT [\s\S]*FROM pre_dispatch_inspection_reports WHERE batch_id/.test(sql)) {
        return { rows: [reportRow(1), reportRow(2, { data: { motor_sr_no: 'SR2' /* no pdi_no */ } })] };
      }
      return { rows: [], rowCount: 0 };
    };
    await expect(PdiReportBatches.finalizeBatch(101)).rejects.toMatchObject({ code: 'PDI_NO_REQUIRED' });
    expect(mockUpload).not.toHaveBeenCalled();
  });
});

describe('getBatchPdfForDownload', () => {
  it('returns 409 BATCH_NOT_READY when the batch has not been finalized', async () => {
    mockState.poolQueryImpl = async (sql) => {
      if (/SELECT status FROM pdi_report_batches WHERE batch_id/.test(sql)) return { rows: [{ status: 'In Progress' }] };
      return { rows: [], rowCount: 0 };
    };
    await expect(PdiReportBatches.getBatchPdfForDownload(101)).rejects.toMatchObject({ code: 'BATCH_NOT_READY' });
  });

  it('serves the cached combined PDF for a Completed batch', async () => {
    await pdfCache.write(101, Buffer.from('%PDF-1.4 combined'), 'batch');
    mockState.poolQueryImpl = async (sql) => {
      if (/SELECT status FROM pdi_report_batches WHERE batch_id/.test(sql)) return { rows: [{ status: 'Completed' }] };
      return { rows: [], rowCount: 0 };
    };
    const { buffer, source } = await PdiReportBatches.getBatchPdfForDownload(101);
    expect(buffer.toString()).toBe('%PDF-1.4 combined');
    expect(source).toBe('cache');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/pdi_report_batches.test.js`
Expected: FAIL — `models/operations/pdiReportBatches.js` doesn't exist yet.

- [ ] **Step 3: Implement the model**

Create `models/operations/pdiReportBatches.js`:

```js
'use strict';

const pool = require('../config/db');
const logger = require('../utils/logger');
const PDIGenerator = require('./pdi_generator');
const { uploadBufferToDrivePrivate, deleteDriveFile } = require('../services/googleDrive');
const pdfCache = require('./pdi/pdfCache');

const MIN_LOT_QUANTITY = 1;
const MAX_LOT_QUANTITY = 50; // a technical safety cap, not a real business limit

function bufferPdf(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

function invalidQuantityError() {
  const err = new Error('quantity must be a whole number between 1 and 50');
  err.code = 'INVALID_LOT_QUANTITY';
  return err;
}

class PdiReportBatches {
  // Atomic: one pdi_report_batches row + `quantity` linked report rows, in
  // one transaction -- either all of it lands or none of it does. Every
  // linked report is stamped with this batch's shared pdi_no up front (so
  // finalize's per-report pdi_no check is trivially satisfied later) and
  // starts 'Pending', same shape createReport already produces for a
  // standalone report.
  static async createBatch({ template_id, pdi_no, quantity, created_by }) {
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty < MIN_LOT_QUANTITY || qty > MAX_LOT_QUANTITY) {
      throw invalidQuantityError();
    }
    if (!pdi_no) {
      const err = new Error('pdi_no is required');
      err.code = 'PDI_NO_REQUIRED';
      throw err;
    }
    const templateId = template_id || 'autonxt';

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const batchResult = await client.query(`
        INSERT INTO pdi_report_batches (template_id, pdi_no, lot_quantity, status, created_by)
        VALUES ($1, $2, $3, 'In Progress', $4)
        RETURNING batch_id, template_id, pdi_no, lot_quantity, status
      `, [templateId, pdi_no, qty, created_by || null]);
      const batch = batchResult.rows[0];

      const reports = [];
      for (let lotIndex = 1; lotIndex <= qty; lotIndex++) {
        const reportResult = await client.query(`
          INSERT INTO pre_dispatch_inspection_reports
            (status, template_id, data, photos, batch_id, lot_index)
          VALUES ('Pending', $1, $2, '{}'::jsonb, $3, $4)
          RETURNING report_id, lot_index
        `, [templateId, JSON.stringify({ pdi_no }), batch.batch_id, lotIndex]);
        reports.push({ report_id: reportResult.rows[0].report_id, lot_index: reportResult.rows[0].lot_index, lot_quantity: qty });
      }

      await client.query('COMMIT');
      return { ...batch, reports };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async getBatch(batchId) {
    const _id = Number(batchId);
    if (!Number.isFinite(_id)) throw new Error('Batch not found');

    const batchResult = await pool.query(
      `SELECT batch_id, template_id, pdi_no, lot_quantity, status FROM pdi_report_batches WHERE batch_id = $1`,
      [_id]
    );
    if (batchResult.rows.length === 0) throw new Error('Batch not found');

    const reportsResult = await pool.query(`
      SELECT report_id, lot_index, status, data->>'motor_sr_no' AS motor_sr_no, data->>'pdi_no' AS pdi_no
      FROM pre_dispatch_inspection_reports
      WHERE batch_id = $1
      ORDER BY lot_index ASC
    `, [_id]);

    return { ...batchResult.rows[0], reports: reportsResult.rows };
  }

  // See docs/superpowers/specs/2026-09-29-autonxt-batch-reports-design.md's
  // "Finalize flow" section for why this does NOT call the single-report
  // PdiReports.finalizeReport per linked report (that would render every
  // report twice -- once inside finalizeReport, once again to build the
  // combined PDF). Instead: mark each report Completed with the same
  // guarded UPDATE finalizeReport itself uses, render the combined PDF
  // ONCE, cache/Drive-back-up only the combined PDF.
  static async finalizeBatch(batchId) {
    const _id = Number(batchId);
    if (!Number.isFinite(_id)) throw new Error('Batch not found');

    const batchResult = await pool.query(
      `SELECT batch_id, template_id, pdi_no, lot_quantity, status FROM pdi_report_batches WHERE batch_id = $1`,
      [_id]
    );
    if (batchResult.rows.length === 0) throw new Error('Batch not found');
    const batch = batchResult.rows[0];

    if (batch.status === 'Completed') {
      const err = new Error('This batch is already finalized.');
      err.code = 'BATCH_ALREADY_FINALIZED';
      throw err;
    }

    const reportsResult = await pool.query(`
      SELECT report_id, lot_index, status, template_id, template_version, data, photos
      FROM pre_dispatch_inspection_reports
      WHERE batch_id = $1
      ORDER BY lot_index ASC
    `, [_id]);
    const reports = reportsResult.rows;

    for (const report of reports) {
      if (!report.data?.pdi_no) {
        const err = new Error(`Report ${report.report_id} (lot ${report.lot_index}) is missing pdi_no.`);
        err.code = 'PDI_NO_REQUIRED';
        throw err;
      }
    }

    for (const report of reports) {
      const result = await pool.query(`
        UPDATE pre_dispatch_inspection_reports
        SET status = 'Completed'
        WHERE report_id = $1 AND status <> 'Completed'
        RETURNING report_id, status
      `, [report.report_id]);
      if (result.rows.length === 0) {
        const err = new Error(`Report ${report.report_id} (lot ${report.lot_index}) was already finalized by a concurrent request.`);
        err.code = 'BATCH_ALREADY_FINALIZED';
        throw err;
      }
    }

    const pdfBuffer = await bufferPdf(await PDIGenerator.generateCombined(
      reports.map((r) => ({
        templateId: r.template_id,
        templateVersion: r.template_version,
        data: { ...(r.data || {}), photos: r.photos || {} },
      }))
    ));

    await pool.query(`UPDATE pdi_report_batches SET status = 'Completed' WHERE batch_id = $1`, [_id]);

    const payload = { ...batch, status: 'Completed', reports: reports.map((r) => ({ report_id: r.report_id, lot_index: r.lot_index })) };

    const background = Promise.all([
      this.#backupPdfToDrive(_id, batch.pdi_no, pdfBuffer),
      pdfCache.write(_id, pdfBuffer, 'batch'),
    ]);

    return { payload, pdfBuffer, background };
  }

  static async #backupPdfToDrive(batchId, pdiNo, pdfBuffer) {
    const startedAt = Date.now();
    try {
      const safeNo = String(pdiNo || batchId).replace(/[^a-zA-Z0-9_-]/g, '_');
      const uploaded = await uploadBufferToDrivePrivate(pdfBuffer, 'application/pdf', `PDI_BATCH_${safeNo}.pdf`);
      const res = await pool.query('UPDATE pdi_report_batches SET drive_file_id = $1 WHERE batch_id = $2', [uploaded.id, batchId]);
      if (res.rowCount === 0) {
        await deleteDriveFile(uploaded.id).catch((e) => logger.warn(`Drive cleanup failed for deleted PDI batch ${batchId}: ${e.message}`));
        return;
      }
      logger.info(`PDI batch Drive backup: batch ${batchId}, ${Date.now() - startedAt}ms, ${pdfBuffer.length} bytes`);
    } catch (e) {
      logger.warn(`Drive backup failed for PDI batch ${batchId}: ${e.message}`);
    }
  }

  static async getBatchPdfForDownload(batchId) {
    const _id = Number(batchId);
    if (!Number.isFinite(_id)) throw new Error('Batch not found');

    const meta = await pool.query(`SELECT status FROM pdi_report_batches WHERE batch_id = $1`, [_id]);
    if (meta.rows.length === 0) throw new Error('Batch not found');

    if (meta.rows[0].status !== 'Completed') {
      const err = new Error('This batch has not been finalized yet.');
      err.code = 'BATCH_NOT_READY';
      throw err;
    }

    const cached = await pdfCache.read(_id, 'batch');
    if (cached) return { buffer: cached, source: 'cache' };

    // Cache miss on a Completed batch (e.g. after a redeploy emptied the disk
    // cache) -- re-render the combined PDF from each report's stored data,
    // same fallback shape PdiReports.getPdfForDownload already has for a
    // single report.
    const reportsResult = await pool.query(`
      SELECT report_id, lot_index, template_id, template_version, data, photos
      FROM pre_dispatch_inspection_reports
      WHERE batch_id = $1
      ORDER BY lot_index ASC
    `, [_id]);
    const buffer = await bufferPdf(await PDIGenerator.generateCombined(
      reportsResult.rows.map((r) => ({
        templateId: r.template_id,
        templateVersion: r.template_version,
        data: { ...(r.data || {}), photos: r.photos || {} },
      }))
    ));
    await pdfCache.write(_id, buffer, 'batch');
    return { buffer, source: 'rendered' };
  }
}

module.exports = PdiReportBatches;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/pdi_report_batches.test.js`
Expected: PASS — all tests across `createBatch`, `finalizeBatch`, `getBatchPdfForDownload`.

- [ ] **Step 5: Run the full backend PDI suite for regressions**

Run: `npx jest tests/pdi_ --runInBand --forceExit`
Expected: PASS, every suite (the `--forceExit` flag avoids the known Jest "did not exit" hang from lingering handles this session has hit before — it does not affect pass/fail results).

- [ ] **Step 6: Commit**

```bash
git add models/operations/pdiReportBatches.js tests/pdi_report_batches.test.js
git commit -m "$(cat <<'EOF'
feat: pdiReportBatches model -- atomic create, finalize, and combined-PDF download

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Controller

**Files:**
- Create: `controllers/operations/pdiReportBatches.controller.js`

Depends on Task 5.

**Reference — exact error-mapping and response-header conventions this task mirrors, from `controllers/operations/pdiReports.controller.js`:**
- `error.code === 'X'` → a specific `res.status(Y).json({ error: error.message, code: error.code })`, falling through to a generic `res.status(500).json({ error: 'Internal Server Error' })` with a `logger.error(...)` call, for anything unrecognized.
- Finalize sends the PDF directly: `res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', \`attachment; filename="..."\`); res.send(pdfBuffer);` — no JSON success body.
- `req.user.user_id` is already available on every authenticated request (set by `middleware/auth.js`'s `authenticateToken`).

- [ ] **Step 1: Implement**

Create `controllers/operations/pdiReportBatches.controller.js`:

```js
const PdiReportBatches = require('../../models/operations/pdiReportBatches');
const logger = require('../../utils/logger');

exports.createBatch = async (req, res) => {
  try {
    const { template_id, pdi_no, quantity } = req.body || {};
    const batch = await PdiReportBatches.createBatch({ template_id, pdi_no, quantity, created_by: req.user.user_id });
    logger.info(`PDI report batch created: ${batch.batch_id} (${batch.lot_quantity} reports) by ${req.user.user_id}`);
    res.status(201).json(batch);
  } catch (error) {
    if (error.code === 'INVALID_LOT_QUANTITY') return res.status(400).json({ error: error.message, code: error.code });
    if (error.code === 'PDI_NO_REQUIRED') return res.status(400).json({ error: error.message, code: error.code });
    logger.error(`Error creating PDI report batch: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.getBatch = async (req, res) => {
  try {
    const batch = await PdiReportBatches.getBatch(req.params.batchId);
    res.json(batch);
  } catch (error) {
    if (error.message === 'Batch not found') return res.status(404).json({ error: error.message });
    logger.error(`Error fetching PDI report batch ${req.params.batchId}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.finalizeBatch = async (req, res) => {
  try {
    const { payload, pdfBuffer } = await PdiReportBatches.finalizeBatch(req.params.batchId);
    const safeName = String(payload.pdi_no || payload.batch_id).replace(/[^a-zA-Z0-9_-]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="PDI_BATCH_${safeName}.pdf"`);
    logger.info(`PDI report batch finalized: ${payload.batch_id} by ${req.user.user_id}`);
    res.send(pdfBuffer);
  } catch (error) {
    if (error.message === 'Batch not found') return res.status(404).json({ error: error.message });
    if (error.code === 'PDI_NO_REQUIRED') return res.status(400).json({ error: error.message, code: error.code });
    if (error.code === 'BATCH_ALREADY_FINALIZED') return res.status(409).json({ error: error.message, code: error.code });
    logger.error(`Error finalizing PDI report batch ${req.params.batchId}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.downloadBatchPdf = async (req, res) => {
  try {
    const { buffer } = await PdiReportBatches.getBatchPdfForDownload(req.params.batchId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="PDI_BATCH_${req.params.batchId}.pdf"`);
    res.send(buffer);
  } catch (error) {
    if (error.message === 'Batch not found') return res.status(404).json({ error: error.message });
    if (error.code === 'BATCH_NOT_READY') return res.status(409).json({ error: error.message, code: error.code });
    logger.error(`Error generating PDI batch PDF ${req.params.batchId}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};
```

- [ ] **Step 2: Verify it loads without a syntax error**

Run: `node -e "require('./controllers/operations/pdiReportBatches.controller.js'); console.log('loads OK')"`
Expected: `loads OK`

- [ ] **Step 3: Commit**

```bash
git add controllers/operations/pdiReportBatches.controller.js
git commit -m "$(cat <<'EOF'
feat: PDI report batches controller

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Routes and mounting

**Files:**
- Create: `routes/operations/pdiReportBatches.js`
- Modify: `server.js`

Depends on Task 6.

- [ ] **Step 1: Create the routes file**

```js
const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth');
const controller = require('../../controllers/operations/pdiReportBatches.controller');

router.post('/', authenticateToken, controller.createBatch);
router.get('/:batchId', authenticateToken, controller.getBatch);
router.post('/:batchId/finalize', authenticateToken, controller.finalizeBatch);
router.get('/:batchId/pdf', authenticateToken, controller.downloadBatchPdf);

module.exports = router;
```

(Mirrors `routes/operations/pdiReports.js` exactly — `authenticateToken` only, no `checkPermission` gate, matching every PDI route today.)

- [ ] **Step 2: Mount it in `server.js`**

Find this block (search for `pdiReportsRoutes` in `server.js`):

```js
const pdiReportsRoutes       = require('./routes/operations/pdiReports');
```

Add directly after it:

```js
const pdiReportBatchesRoutes = require('./routes/operations/pdiReportBatches');
```

Find:

```js
// Order matters: /api/pdi/reports must be mounted before /api/pdi, or Express
// would hand "reports" off to the legacy router's GET /:id handler instead.
app.use('/api/pdi/reports', pdiReportsRoutes);
app.use('/api/pdi/admin/templates', pdiAdminRoutes);
app.use('/api/pdi',         pdiRoutes);
```

Replace with:

```js
// Order matters: /api/pdi/reports and /api/pdi/report-batches must both be
// mounted before /api/pdi, or Express would hand them off to the legacy
// router's GET /:id handler instead.
app.use('/api/pdi/reports', pdiReportsRoutes);
app.use('/api/pdi/report-batches', pdiReportBatchesRoutes);
app.use('/api/pdi/admin/templates', pdiAdminRoutes);
app.use('/api/pdi',         pdiRoutes);
```

- [ ] **Step 3: Verify the server still starts**

Run: `node -e "require('./server.js')" &`, wait 3 seconds, then check it logged `Server running on port 8000` (or whatever `PORT` resolves to) with no startup error, then stop it. (If you can't easily background/kill it in your environment, at minimum run `node -c server.js` to confirm it parses, and separately confirm both new route/controller files `require()` cleanly as in Task 6 Step 2.)

- [ ] **Step 4: Commit**

```bash
git add routes/operations/pdiReportBatches.js server.js
git commit -m "$(cat <<'EOF'
feat: mount PDI report batch routes at /api/pdi/report-batches

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Full regression pass

**Files:** none — verification only.

- [ ] **Step 1: Run the complete backend PDI test suite**

Run: `npx jest tests/pdi_ --runInBand --forceExit`
Expected: PASS, every suite — this is the first time all of Tasks 1-7's changes run together (each prior task only ran its own directly-affected suites). Fix anything that fails before proceeding; do not proceed to live verification with a failing suite.

- [ ] **Step 2: Run the broader backend test suite once, to catch any unexpected cross-feature regression**

Run: `npx jest --runInBand --forceExit`
Expected: PASS (or the same pre-existing unrelated failures this session has already established as baseline noise — do not attempt to fix anything outside the `pdi_*` suites; just confirm nothing NEW broke).

---

### Task 9: Live verification (controller-personal, not a subagent)

**Files:** none — verification only, using the gstack skill's browse tool is not needed here (no UI exists for this feature yet — it's an API-only delivery for the app developer). Verification is via direct API calls against a local dev server pointed at production RDS, same pattern as every prior PDI live-verification round this session.

- [ ] **Step 1: Start CRM_BACKEND locally against production RDS**

Same `.env`/override pattern as every prior round this session.

- [ ] **Step 2: Create a real throwaway batch**

```bash
TOKEN="<a valid JWT, e.g. from logging in as the test admin account>"
curl -s -X POST "http://localhost:8000/api/pdi/report-batches" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"template_id":"autonxt","pdi_no":"BATCH-PLAN-VERIFY-001","quantity":3}'
```
Confirm: `201`, `batch_id` present, `reports` has exactly 3 entries with `lot_index` 1, 2, 3 and distinct `report_id`s, `lot_quantity: 3` on each.

- [ ] **Step 2: Fill in each linked report**

For each of the 3 `report_id`s from Step 1, `PATCH /api/pdi/reports/:id` with enough AutoNXT data to pass finalize (at minimum `motor_sr_no` and enough of the fixed checklist to be a realistic report — reuse the same throwaway-data shape used in every prior AutoNXT live-verification round this session). Confirm each PATCH returns `200`.

- [ ] **Step 3: Finalize the batch**

```bash
curl -s -X POST "http://localhost:8000/api/pdi/report-batches/<batchId>/finalize" \
  -H "Authorization: Bearer $TOKEN" -o batch-verify.pdf -D -
```
Confirm: `200`, `Content-Type: application/pdf`, and the saved file starts with `%PDF-`.

- [ ] **Step 4: Inspect the combined PDF**

Render it to PNG (same `pdf-to-png.ps1` approach used earlier this session) and confirm: 9 pages total (3 motors × AutoNXT's 3 pages each), each motor's own header fields (`motor_sr_no`) visible on the right pages in `lot_index` order, and continuous page numbering across the whole document (`Pg 1 of 9` … `Pg 9 of 9`, never restarting at `Pg 1 of 3`).

- [ ] **Step 5: Confirm each individual report shows `Completed`**

`GET /api/pdi/reports/:id` for each of the 3 report ids — confirm `status: "Completed"`.

- [ ] **Step 6: Confirm the combined PDF is downloadable afterward**

```bash
curl -s "http://localhost:8000/api/pdi/report-batches/<batchId>/pdf" -H "Authorization: Bearer $TOKEN" -o batch-verify-2.pdf
```
Confirm byte-identical to Step 3's PDF (served from cache, not re-rendered — check response headers/log line for `source: cache` if logged, or just compare file hashes).

- [ ] **Step 7: Confirm the error codes**

- Repeat `POST .../finalize` on the same batch → `409 BATCH_ALREADY_FINALIZED`.
- `POST /api/pdi/report-batches` with `quantity: 0` and `quantity: 51` → both `400 INVALID_LOT_QUANTITY`.
- `GET /api/pdi/report-batches/:batchId/pdf` for a brand-new, never-finalized batch → `409 BATCH_NOT_READY`.

- [ ] **Step 8: Clean up**

Delete all 3 throwaway reports (`DELETE /api/pdi/reports/:id`) and confirm the `pdi_report_batches` row can be removed too (delete it directly via a one-off `DELETE FROM pdi_report_batches WHERE batch_id = $1` — no delete-batch endpoint exists in this spec, matching the app dev's request which never asked for one; deleting the row directly for cleanup purposes only is fine since nothing references it once its reports are gone).

- [ ] **Step 9: Confirm nothing pushed**

`git log origin/main..HEAD --oneline` in `CRM_BACKEND` — confirm every commit from Tasks 1-7 is listed as local-only. Report the final commit list to the user and wait for them to ask before pushing anything.
