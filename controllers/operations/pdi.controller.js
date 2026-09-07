exports.getTemplates = async (req, res) => {
  // Forward-compat stub — no template-authoring feature exists yet, so this is
  // always just the one hardcoded template. Real templates would live in a DB
  // table and this would query it instead.
  res.json([{ id: 'general', name: 'General', version: 1 }]);
};
