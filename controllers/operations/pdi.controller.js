const templates = require('../../models/operations/pdi/templates');
const AuthoredTemplates = require('../../models/operations/pdi/authoredTemplates');
const logger = require('../../utils/logger');

exports.getTemplates = async (req, res) => {
  try {
    const codeList = Object.values(templates).map(({ id, name, version }) => ({ id, name, version }));
    const dbList = await AuthoredTemplates.listActive();
    res.json([...codeList, ...dbList]);
  } catch (error) {
    logger.error(`Error listing PDI templates: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.getTemplateDefinition = async (req, res) => {
  try {
    const { id } = req.params;
    // Code-registered templates (general, autonxt) already have their own
    // hand-coded forms and aren't meant to be fetched this way — treat as
    // not-found rather than leaking their internal structure through a route
    // that exists specifically to serve admin-authored templates.
    if (templates[id]) return res.status(404).json({ error: 'Template not found' });

    const row = await AuthoredTemplates.getActive(id);
    if (!row) return res.status(404).json({ error: 'Template not found' });
    res.json({ id: row.id, name: row.name, version: row.version, definition: row.definition });
  } catch (error) {
    logger.error(`Error fetching PDI template definition ${req.params.id}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};
