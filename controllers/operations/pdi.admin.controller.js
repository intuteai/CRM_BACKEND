// controllers/operations/pdi.admin.controller.js
'use strict';

const AuthoredTemplates = require('../../models/operations/pdi/authoredTemplates');
const templates = require('../../models/operations/pdi/templates');
const PDIGenerator = require('../../models/operations/pdi_generator');
const logger = require('../../utils/logger');

function bufferPdf(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

// Postgres unique_violation on (id, version) — the narrow race window in
// AuthoredTemplates.saveNewVersion's read-then-insert (two concurrent saves
// for the same id both compute the same next version number). Low-probability
// for a single-admin authoring tool, but should surface as a clean, expected
// conflict, not a raw DB error — matches the existing convention in
// models/dispatch/iaOrders.js, models/sales/enquiry.js, models/core/user.js.
function isUniqueViolation(error) {
  return error && error.code === '23505';
}

exports.listTemplates = async (req, res) => {
  try {
    const rows = await AuthoredTemplates.listAll();
    res.json(rows);
  } catch (error) {
    logger.error(`Error listing authored PDI templates: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.getTemplate = async (req, res) => {
  try {
    const row = await AuthoredTemplates.getLatest(req.params.id);
    if (!row) return res.status(404).json({ error: 'Template not found' });
    res.json(row);
  } catch (error) {
    logger.error(`Error fetching authored PDI template ${req.params.id}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.createTemplate = async (req, res) => {
  try {
    const { id, name, definition } = req.body || {};
    if (!id || !name || !definition) {
      return res.status(400).json({ error: 'id, name, and definition are required' });
    }
    if (templates[id]) {
      return res.status(409).json({ error: `Template id "${id}" is reserved by a built-in template` });
    }
    if (await AuthoredTemplates.idExists(id)) {
      return res.status(409).json({ error: `Template id "${id}" already exists` });
    }
    const row = await AuthoredTemplates.create({ id, name, definition, createdBy: req.user.user_id });
    logger.info(`Authored PDI template created: ${id} by ${req.user.user_id}`);
    res.status(201).json(row);
  } catch (error) {
    if (isUniqueViolation(error)) {
      return res.status(409).json({ error: `Template id "${req.body?.id}" already exists` });
    }
    logger.error(`Error creating authored PDI template: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

async function saveWithStatus(req, res, statusOverride) {
  try {
    const { name, definition } = req.body || {};
    const row = await AuthoredTemplates.saveNewVersion(req.params.id, {
      name, definition, status: statusOverride,
    });
    res.json(row);
  } catch (error) {
    if (error.message === 'Template not found') return res.status(404).json({ error: error.message });
    if (isUniqueViolation(error)) {
      return res.status(409).json({ error: 'This template was just edited elsewhere — reload and try again.' });
    }
    logger.error(`Error saving authored PDI template ${req.params.id}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}

exports.saveTemplate = (req, res) => saveWithStatus(req, res, undefined);
exports.publishTemplate = (req, res) => saveWithStatus(req, res, 'active');
exports.archiveTemplate = (req, res) => saveWithStatus(req, res, 'archived');

exports.previewTemplate = async (req, res) => {
  try {
    const { definition } = req.body || {};
    if (!definition) return res.status(400).json({ error: 'definition is required' });
    const doc = PDIGenerator.previewFromDefinition(definition);
    const buf = await bufferPdf(doc);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="preview.pdf"');
    res.send(buf);
  } catch (error) {
    // A malformed draft definition is a client error (bad section config),
    // not a server fault — surface the actual message so the editor can show it.
    res.status(400).json({ error: error.message });
  }
};
