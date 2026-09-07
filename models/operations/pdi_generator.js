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
