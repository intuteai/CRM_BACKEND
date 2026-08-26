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

exports.getAll = async (req, res) => {
  try {
    const { limit, cursor, search } = req.query;
    const result = await IPTKits.getAll({ limit, cursor, search });
    return res.json(result);
  } catch (err) {
    logger.error(`GET ipt-kits error: ${err.message}`);
    return res.status(500).json({ error: 'Server error' });
  }
};

exports.nextSerial = async (req, res) => {
  try {
    const kit_serial = await IPTKits.previewNextSerial();
    return res.json({ kit_serial });
  } catch (err) {
    logger.error(`GET ipt-kits/next-serial error: ${err.message}`);
    return res.status(500).json({ error: 'Server error' });
  }
};

exports.getOne = async (req, res) => {
  try {
    const kit = await IPTKits.getById(req.params.id);
    return res.json(kit);
  } catch (err) {
    return res.status(err.message === 'Kit not found' ? 404 : 500).json({ error: err.message });
  }
};

exports.update = async (req, res) => {
  try {
    const kit = await IPTKits.update(req.params.id, req.body, req.io);
    logger.info(`ipt_kit updated: ${kit.kit_id} by user ${req.user.user_id}`);
    return res.json(kit);
  } catch (err) {
    logger.error(`PUT ipt-kits/${req.params.id} error: ${err.message}`);
    return res.status(err.message === 'Kit not found' ? 404 : 400).json({ error: err.message, field: err.field ?? null });
  }
};

exports.delete = async (req, res) => {
  try {
    const result = await IPTKits.delete(req.params.id, req.io);
    logger.info(`ipt_kit deleted: ${result.kit_id} by user ${req.user.user_id}`);
    return res.json({ message: 'Kit deleted', kit_id: result.kit_id });
  } catch (err) {
    return res.status(err.message === 'Kit not found' ? 404 : 500).json({ error: err.message });
  }
};
