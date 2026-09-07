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
