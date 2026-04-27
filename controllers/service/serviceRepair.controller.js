const ServiceRepair = require('../../models/service/serviceRepair');
const { uploadBufferToDrive, streamFileToDrive } = require('../../services/googleDrive');
const logger = require('../../utils/logger');

exports.getAll = async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const offset = Number(req.query.offset) || 0;
    const records = await ServiceRepair.getAll({ limit, offset });
    res.json(records);
  } catch (err) {
    logger.error('ServiceRepair getAll error:', err);
    res.status(500).json({ error: 'Failed to fetch records', code: 'SERVER_ERROR' });
  }
};

exports.getById = async (req, res) => {
  try {
    const record = await ServiceRepair.getById(req.params.id);
    if (!record) return res.status(404).json({ error: 'Record not found', code: 'NOT_FOUND' });
    res.json(record);
  } catch (err) {
    logger.error('ServiceRepair getById error:', err);
    res.status(500).json({ error: 'Failed to fetch record', code: 'SERVER_ERROR' });
  }
};

exports.create = async (req, res) => {
  try {
    if (!req.body.customer_name) {
      return res.status(400).json({ error: 'customer_name is required', code: 'VALIDATION_ERROR' });
    }
    const record = await ServiceRepair.create(req.body, req.user.user_id);
    logger.info(`ServiceRepair record created: ${record.record_id} by user ${req.user.user_id}`);
    res.status(201).json(record);
  } catch (err) {
    logger.error('ServiceRepair create error:', err);
    res.status(500).json({ error: 'Failed to create record', code: 'SERVER_ERROR' });
  }
};

exports.update = async (req, res) => {
  try {
    if (!req.body.customer_name) {
      return res.status(400).json({ error: 'customer_name is required', code: 'VALIDATION_ERROR' });
    }
    const record = await ServiceRepair.update(req.params.id, req.body);
    if (!record) return res.status(404).json({ error: 'Record not found', code: 'NOT_FOUND' });
    logger.info(`ServiceRepair record updated: ${req.params.id} by user ${req.user.user_id}`);
    res.json(record);
  } catch (err) {
    logger.error('ServiceRepair update error:', err);
    res.status(500).json({ error: 'Failed to update record', code: 'SERVER_ERROR' });
  }
};

// Proxy a Google Drive file — browser calls this, server fetches using service account
exports.proxyImage = async (req, res) => {
  try {
    const { fileId } = req.params;
    if (!/^[a-zA-Z0-9_-]+$/.test(fileId)) {
      return res.status(400).json({ error: 'Invalid file ID' });
    }
    await streamFileToDrive(fileId, res);
  } catch (err) {
    logger.error('ServiceRepair proxyImage error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to load image' });
  }
};

exports.remove = async (req, res) => {
  try {
    const deleted = await ServiceRepair.remove(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Record not found', code: 'NOT_FOUND' });
    logger.info(`ServiceRepair record deleted: ${req.params.id} by user ${req.user.user_id}`);
    res.json({ message: 'Record deleted successfully' });
  } catch (err) {
    logger.error('ServiceRepair remove error:', err);
    res.status(500).json({ error: 'Failed to delete record', code: 'SERVER_ERROR' });
  }
};

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png',
  'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf',
};

function resolveExt(mimetype) {
  return MIME_EXT[mimetype] || 'bin';
}

// Upload single photo: chalan_photo_url or delivery_challan_photo_url
exports.uploadPhoto = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided', code: 'VALIDATION_ERROR' });
    if (!ALLOWED_MIME.includes(req.file.mimetype)) {
      return res.status(400).json({ error: 'Invalid file type. Allowed: JPEG, PNG, WebP, GIF, PDF', code: 'VALIDATION_ERROR' });
    }

    const { id } = req.params;
    const { field } = req.query;
    const allowed = ['chalan_photo_url', 'delivery_challan_photo_url'];
    if (!allowed.includes(field)) {
      return res.status(400).json({ error: 'Invalid field. Use chalan_photo_url or delivery_challan_photo_url', code: 'VALIDATION_ERROR' });
    }

    const filename = `service_repair_${id}_${field}_${Date.now()}.${resolveExt(req.file.mimetype)}`;
    const { directUrl } = await uploadBufferToDrive(req.file.buffer, req.file.mimetype, filename);

    const record = await ServiceRepair.updatePhotoField(id, field, directUrl);
    if (!record) return res.status(404).json({ error: 'Record not found', code: 'NOT_FOUND' });

    logger.info(`ServiceRepair photo uploaded for record ${id}, field: ${field}`);
    res.json({ url: directUrl, record });
  } catch (err) {
    logger.error('ServiceRepair uploadPhoto error:', err);
    res.status(500).json({ error: 'Failed to upload photo', code: 'SERVER_ERROR' });
  }
};

// Upload one of the repaired photos (appended to array)
exports.uploadRepairedPhoto = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided', code: 'VALIDATION_ERROR' });
    if (!ALLOWED_MIME.includes(req.file.mimetype)) {
      return res.status(400).json({ error: 'Invalid file type. Allowed: JPEG, PNG, WebP, GIF', code: 'VALIDATION_ERROR' });
    }

    const { id } = req.params;
    const filename = `service_repair_${id}_repaired_${Date.now()}.${resolveExt(req.file.mimetype)}`;
    const { directUrl } = await uploadBufferToDrive(req.file.buffer, req.file.mimetype, filename);

    const record = await ServiceRepair.appendRepairedPhoto(id, directUrl);
    if (!record) return res.status(404).json({ error: 'Record not found', code: 'NOT_FOUND' });

    logger.info(`ServiceRepair repaired photo appended for record ${id}`);
    res.json({ url: directUrl, record });
  } catch (err) {
    logger.error('ServiceRepair uploadRepairedPhoto error:', err);
    res.status(500).json({ error: 'Failed to upload repaired photo', code: 'SERVER_ERROR' });
  }
};
