// models/operations/pdi_generator.js
'use strict';

const PDFDocument = require('pdfkit');
const { registerFonts, M } = require('./pdi/primitives');
const { renderTemplate, numberPageRange } = require('./pdi/renderer');
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
  // Each report's own pages are numbered independently, restarting at
  // "Pg 1 of N" for that report's own page count -- matching both a normal
  // single-report PDF and the real customer-facing PDI format (confirmed
  // against an actual multi-motor lot document from Compage QA, which
  // restarts per motor rather than numbering the whole lot continuously).
  // See renderer.js's numberPageRange for why this is done per report
  // immediately after rendering it, not once at the end.
  // An entry may carry `loadPhotos: async () => photos` instead of
  // data.photos, so a big lot holds one unit's photos in memory at a time
  // rather than every unit's at once.
  static async generateCombined(reportsData, options = {}) {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 10, bottom: 0, left: M, right: M },
      autoFirstPage: false,
      bufferPages: true,
    });
    registerFonts(doc);

    for (const { templateId, templateVersion, data: baseData, loadPhotos } of reportsData) {
      if (!baseData.pdi_no) throw new Error('pdi_no required');
      const template = await resolveTemplate(templateId, templateVersion);
      const data = loadPhotos ? { ...baseData, photos: await loadPhotos() } : baseData;
      const stats = {};
      const optimized = await optimizePhotoData(template, data, stats);
      if (options.timings) options.timings.push(stats);
      const startPage = doc.bufferedPageRange().count;
      renderTemplate(doc, template, optimized, { numberPages: false });
      const pageCount = doc.bufferedPageRange().count - startPage;
      numberPageRange(doc, startPage, pageCount);
    }

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
