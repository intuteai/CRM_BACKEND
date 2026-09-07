const templates = require('../../models/operations/pdi/templates');

exports.getTemplates = async (req, res) => {
  const list = Object.values(templates).map(({ id, name, version }) => ({ id, name, version }));
  res.json(list);
};
