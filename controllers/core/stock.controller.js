// Raw-material stock API (/api/stock). Validation lives in stock.validation.js,
// database work (transactions, row locks, audit rows) in models/core/stock.js.
const Stock = require('../../models/core/stock');
const pool = require('../../config/db');
const logger = require('../../utils/logger');
const { uploadBufferToDrive } = require('../../services/googleDrive');
const {
  validateStockBody,
  validateAdjustBody,
  validateAcceptReturnBody,
  parseProductId,
  parsePaging,
} = require('./stock.validation');

const { StockError } = Stock;

const STOCK_ERROR_STATUS = {
  NOT_FOUND: 404,
  PART_NUMBER_TAKEN: 400,
  INSUFFICIENT_STOCK: 400,
  RETURN_EXCEEDS_RETURNABLE: 400,
};

function invalid(res, errors) {
  return res.status(400).json({ error: errors[0].message, code: 'INVALID_INPUT', details: errors });
}

/** Turn a model or pg error into the API's error answer. */
function sendError(res, err, context) {
  if (err instanceof StockError) {
    return res.status(STOCK_ERROR_STATUS[err.code] || 400).json({ error: err.message, code: err.code });
  }
  if (err && err.code === '23505') {
    if (err.constraint === 'raw_materials_part_number_unique') {
      return res.status(400).json({ error: 'Part Number is already in use', code: 'PART_NUMBER_TAKEN' });
    }
    if (err.constraint === 'raw_materials_product_code_key') {
      return res.status(400).json({ error: 'Product code must be unique', code: 'DUPLICATE_CODE' });
    }
    return res.status(400).json({ error: 'This value is already in use', code: 'DUPLICATE_CODE' });
  }
  if (err && err.code === '22003') {
    return res.status(400).json({ error: 'A number is too large (value too large)', code: 'INVALID_INPUT' });
  }
  if (err && err.code === '23514') {
    return res.status(400).json({ error: 'A value breaks a stock rule (for example a negative quantity)', code: 'INVALID_INPUT' });
  }
  if (err && err.code === '23503') {
    return res.status(409).json({
      error: 'Cannot delete: this material is used in a BOM, work order or process record',
      code: 'IN_USE',
    });
  }
  logger.error(`${context}: ${err && err.message}`, err && err.stack);
  return res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
}

function emitItem(req, item) {
  req.io?.emit('stockUpdate', {
    source: 'raw_materials',
    product_id: item.productId,
    stock_quantity: item.stockQuantity,
    returnable_qty: item.returnableQty,
    qty_required: item.qtyRequired,
    location: item.location ?? null,
    image_url: item.imageUrl ?? null,
  });
}

function productIdOr400(req, res) {
  const id = parseProductId(req.params.productId);
  if (id === null) {
    res.status(400).json({ error: 'Product ID must be a positive whole number', code: 'INVALID_INPUT' });
  }
  return id;
}

exports.getAll = async (req, res) => {
  const { limit, offset } = parsePaging(req.query);
  try {
    res.json(await Stock.getAll({ limit, offset }));
  } catch (err) {
    sendError(res, err, 'Error fetching stock');
  }
};

exports.checkPartNumber = async (req, res) => {
  try {
    const { part_number, exclude_id } = req.query;
    if (!part_number || !/^\d{4}$/.test(part_number)) {
      return res.status(400).json({ error: 'part_number must be a 4-digit string', code: 'INVALID_INPUT' });
    }
    let query = 'SELECT product_id, product_name FROM raw_materials WHERE part_number = $1';
    const params = [part_number];
    if (exclude_id !== undefined) {
      const excludeIdNum = parseInt(exclude_id, 10);
      if (isNaN(excludeIdNum)) {
        return res.status(400).json({ error: 'exclude_id must be numeric', code: 'INVALID_INPUT' });
      }
      query += ' AND product_id != $2';
      params.push(excludeIdNum);
    }
    const { rows } = await pool.query(query, params);
    if (rows.length === 0) {
      return res.json({ available: true, conflictProductId: null, conflictProductName: null });
    }
    res.json({ available: false, conflictProductId: rows[0].product_id, conflictProductName: rows[0].product_name });
  } catch (err) {
    sendError(res, err, 'Error checking stock part number');
  }
};

exports.create = async (req, res) => {
  const { errors, value } = validateStockBody(req.body);
  if (errors.length) return invalid(res, errors);
  try {
    const { item, partNumberWarning } = await Stock.create(value, { userId: req.user?.user_id });
    logger.info(`Created stock item ${item.productId} by ${req.user?.user_id}`);
    emitItem(req, item);
    res.status(201).json(partNumberWarning ? { ...item, partNumberWarning } : item);
  } catch (err) {
    sendError(res, err, 'Error creating stock');
  }
};

exports.update = async (req, res) => {
  const productId = productIdOr400(req, res);
  if (productId === null) return;
  const { errors, value } = validateStockBody(req.body);
  if (errors.length) return invalid(res, errors);
  try {
    const item = await Stock.update(productId, value, { userId: req.user?.user_id });
    logger.info(`Updated stock item ${productId} by ${req.user?.user_id}`);
    emitItem(req, item);
    res.json(item);
  } catch (err) {
    sendError(res, err, `Error updating stock ${productId}`);
  }
};

exports.uploadPhoto = async (req, res) => {
  const productId = productIdOr400(req, res);
  if (productId === null) return;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded', code: 'INVALID_INPUT' });
  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (!allowedTypes.includes(req.file.mimetype)) {
    return res.status(400).json({ error: 'Invalid file type. Allowed: JPEG, PNG, WebP, GIF', code: 'INVALID_INPUT' });
  }
  try {
    // Check first so a photo for a missing product never lands in Drive.
    const existing = await Stock.getById(productId);
    if (!existing) return res.status(404).json({ error: 'Stock item not found', code: 'NOT_FOUND' });

    const ext = req.file.mimetype.includes('png') ? 'png'
      : req.file.mimetype.includes('webp') ? 'webp'
        : req.file.mimetype.includes('gif') ? 'gif' : 'jpg';
    const filename = `raw_${productId}_${Date.now()}.${ext}`;
    const { directUrl, id: fileId } = await uploadBufferToDrive(req.file.buffer, req.file.mimetype, filename);
    const item = await Stock.setImageUrl(productId, directUrl);
    if (!item) return res.status(404).json({ error: 'Stock item not found', code: 'NOT_FOUND' });
    emitItem(req, item);
    return res.json({ success: true, message: 'Photo uploaded successfully', ...item, fileId });
  } catch (err) {
    return sendError(res, err, `Photo upload failed for product ${productId}`);
  }
};

exports.delete = async (req, res) => {
  const productId = productIdOr400(req, res);
  if (productId === null) return;
  try {
    await Stock.delete(productId);
    logger.info(`Deleted stock item ${productId} by ${req.user?.user_id}`);
    req.io?.emit('stockUpdate', { source: 'raw_materials', product_id: productId, status: 'deleted' });
    res.status(204).send();
  } catch (err) {
    sendError(res, err, `Error deleting stock ${productId}`);
  }
};

exports.adjust = async (req, res) => {
  const productId = productIdOr400(req, res);
  if (productId === null) return;
  const { errors, value } = validateAdjustBody(req.body);
  if (errors.length) return invalid(res, errors);
  try {
    const item = await Stock.adjustStock({ productId, quantity: value.quantity, reason: value.reason, userId: req.user?.user_id });
    logger.info(`Adjusted stock for product ${productId} by ${value.quantity} (by ${req.user?.user_id})`);
    emitItem(req, item);
    res.json(item);
  } catch (err) {
    sendError(res, err, `Error adjusting stock ${productId}`);
  }
};

exports.acceptReturn = async (req, res) => {
  const productId = productIdOr400(req, res);
  if (productId === null) return;
  const { errors, value } = validateAcceptReturnBody(req.body);
  if (errors.length) return invalid(res, errors);
  try {
    const item = await Stock.acceptReturn({ productId, quantity: value.quantity, userId: req.user?.user_id });
    logger.info(`Accepted return of ${value.quantity} for raw material ${productId} (by ${req.user?.user_id})`);
    emitItem(req, item);
    res.json(item);
  } catch (err) {
    sendError(res, err, `Error accepting return for stock ${productId}`);
  }
};

exports.getAdjustments = async (req, res) => {
  const productId = productIdOr400(req, res);
  if (productId === null) return;
  const lim = parseInt(req.query.limit, 10);
  const limit = Number.isFinite(lim) && lim > 0 ? Math.min(lim, 100) : 20;
  try {
    res.json(await Stock.getAdjustments(productId, limit));
  } catch (err) {
    sendError(res, err, `Error fetching stock history for ${productId}`);
  }
};

exports.sendError = sendError;
