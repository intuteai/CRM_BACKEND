const templates = require('../../models/operations/pdi/templates');
const AuthoredTemplates = require('../../models/operations/pdi/authoredTemplates');

exports.getTemplates = async (req, res) => {
  const codeList = Object.values(templates).map(({ id, name, version }) => ({ id, name, version }));
  const dbList = await AuthoredTemplates.listActive();
  res.json([...codeList, ...dbList]);
};
