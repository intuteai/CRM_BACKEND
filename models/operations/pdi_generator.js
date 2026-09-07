// models/operations/pdi_generator.js
'use strict';

const PDFDocument = require('pdfkit');
const { registerFonts, M } = require('./pdi/primitives');
const { renderTemplate } = require('./pdi/renderer');
const templates = require('./pdi/templates');
const AuthoredTemplates = require('./pdi/authoredTemplates');
const { hydrateTemplate, buildSampleData } = require('./pdi/authoredTemplate');

// The actual synchronous draw — same PDFDocument construction and comment as
// before, just pulled out so both the DB-lookup path and the code-registry
// path (and the no-DB preview path) share one place that builds the doc.
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

class PDIGenerator {
  // templateVersion is only meaningful for DB-backed templates — pass null
  // for a code-registered template id (general, autonxt, ...).
  static async generate(templateId, templateVersion, data = {}) {
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
    if (codeTemplate) return renderPdfDoc(codeTemplate, data);

    const row = await AuthoredTemplates.getByVersion(templateId, templateVersion);
    if (!row) throw new Error(`Unknown PDI template: ${templateId}`);
    return renderPdfDoc(hydrateTemplate(row.definition), data);
  }

  // No DB lookup, no pdi_no requirement — used by the admin preview endpoint
  // to render an in-progress (possibly unsaved) draft definition directly.
  static previewFromDefinition(definition, data) {
    return renderPdfDoc(hydrateTemplate(definition), data ?? buildSampleData(definition));
  }
}

module.exports = PDIGenerator;
