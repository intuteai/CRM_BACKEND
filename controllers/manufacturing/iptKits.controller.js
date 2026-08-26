const IPTKits = require('../../models/manufacturing/iptKits');
const logger = require('../../utils/logger');

exports.create = async (req, res) => {
  try {
    const kit = await IPTKits.create(req.body, req.io);
    logger.info(`ipt_kit created: ${kit.kit_id} by user ${req.user.user_id}`);
    return res.status(201).json(kit);
  } catch (err) {
    logger.error(`POST ipt-kits error: ${err.message}`);
    return res.status(400).json({ error: err.message, field: err.field ?? null });
  }
};
