const Inventory = require('../../models/core/inventory');
const redis = require('../../config/redis');
const pool = require('../../config/db');
const logger = require('../../utils/logger');
const sanitizeHtml = require('sanitize-html');

const sanitize = (input) => sanitizeHtml(input, { allowedTags: [], allowedAttributes: {} });

exports.create = async (req, res, next) => {
  try {
    const { product_name, stock_quantity, price, description, product_code, returnable_qty = 0, part_number_auto } = req.body;
    if (!product_name) return res.status(400).json({ error: 'Product name is required' });
    if (!product_code || product_code.length !== 11) return res.status(400).json({ error: 'Product code must be exactly 11 characters' });
    if (stock_quantity < 0) return res.status(400).json({ error: 'Stock quantity cannot be negative' });
    if (returnable_qty < 0) return res.status(400).json({ error: 'Returnable quantity cannot be negative' });

    if (!part_number_auto) {
      const partNumber = product_code.slice(0, 4);
      const { rows: conflictRows } = await pool.query(
        'SELECT product_id, product_name FROM inventory WHERE part_number = $1',
        [partNumber]
      );
      if (conflictRows.length > 0) {
        return res.status(400).json({
          error: `Part Number ${partNumber} is already used by ${conflictRows[0].product_name} (#${conflictRows[0].product_id})`,
        });
      }
    }

    const sanitizedData = {
      product_name: sanitize(product_name),
      stock_quantity: stock_quantity || 0,
      price: price || null,
      description: description ? sanitize(description) : null,
      product_code: sanitize(product_code),
      returnable_qty: returnable_qty || 0,
    };
    const product = await Inventory.create(sanitizedData, req.io);

    let partNumberWarning = null;
    if (part_number_auto) {
      const correctedPartNumber = String(product.product_id).padStart(4, '0');
      const currentPartNumber = product.product_code.slice(0, 4);
      if (product.product_id > 9999) {
        partNumberWarning = 'Product ID exceeds 9999 — Part Number could not be auto-assigned. Please set it manually.';
      } else if (correctedPartNumber !== currentPartNumber) {
        const correctedCode = correctedPartNumber + product.product_code.slice(4);
        try {
          const { rows: [updatedRow] } = await pool.query(
            'UPDATE inventory SET product_code = $1 WHERE product_id = $2 RETURNING *',
            [correctedCode, product.product_id]
          );
          Object.assign(product, updatedRow);
        } catch (correctionError) {
          logger.error(`Failed to auto-correct part number for inventory product ${product.product_id}: ${correctionError.message}`, correctionError.stack);
          partNumberWarning = correctionError.code === '23505'
            ? `Auto-assigned part number ${correctedPartNumber} conflicts with an existing entry — please set it manually.`
            : `Could not auto-assign part number ${correctedPartNumber} — please set it manually.`;
        }
      }
    }

    const keys = await redis.keys('inventory_*');
    if (keys.length > 0) await redis.del(keys);
    await redis.del('price_list_*');
    logger.info(`Product added: ${product.product_name} by ${req.user.user_id}`);
    res.status(201).json(partNumberWarning ? { ...product, partNumberWarning } : product);
  } catch (error) {
    if (error.code === '23505' && error.constraint === 'inventory_part_number_unique') {
      return res.status(400).json({ error: 'Part Number is already in use' });
    }
    if (error.code === '23505' && error.constraint === 'unique_product_code') {
      return res.status(400).json({ error: 'Product code must be unique' });
    }
    logger.error(`Error creating inventory: ${error.message}`, error.stack);
    next(error);
  }
};

exports.getAvailable = async (req, res, next) => {
  const { limit = 1000, offset = 0, force_refresh } = req.query;
  try {
    const cacheKey = `inventory_availability_${limit}_${offset}`;
    if (force_refresh !== 'true') {
      const cached = await redis.get(cacheKey);
      if (cached) { logger.info(`Cache hit for ${cacheKey}`); return res.json(JSON.parse(cached)); }
    }
    const items = await Inventory.getInventoryWithAvailability({ limit: parseInt(limit), offset: parseInt(offset) });
    const result = { data: items.map(item => ({ ...item, available: (item.available_quantity || 0) > 0 })), total: items.length };
    await redis.setEx(cacheKey, 3600, JSON.stringify(result));
    res.json(result);
  } catch (error) {
    logger.error(`Error in GET /api/inventory/available: ${error.message}`, error.stack);
    next(error);
  }
};

exports.getAll = async (req, res, next) => {
  const { limit = 10, offset = 0, force_refresh } = req.query;
  try {
    const cacheKey = `inventory_${limit}_${offset}`;
    if (force_refresh !== 'true') {
      const cached = await redis.get(cacheKey);
      if (cached) { logger.info(`Cache hit for ${cacheKey}`); return res.json(JSON.parse(cached)); }
    }
    const inventory = await Inventory.getAll({ limit: parseInt(limit), offset: parseInt(offset) });
    await redis.setEx(cacheKey, 3600, JSON.stringify(inventory));
    logger.info(`Fetched ${inventory.data.length} inventory items`);
    res.json(inventory);
  } catch (error) {
    logger.error(`Error in GET /api/inventory: ${error.message}`, error.stack);
    next(error);
  }
};

exports.checkPartNumber = async (req, res, next) => {
  try {
    const { part_number, exclude_id } = req.query;
    if (!part_number || !/^\d{4}$/.test(part_number)) {
      return res.status(400).json({ error: 'part_number must be a 4-digit string' });
    }
    let query = 'SELECT product_id, product_name FROM inventory WHERE part_number = $1';
    const params = [part_number];
    if (exclude_id) {
      query += ' AND product_id != $2';
      params.push(exclude_id);
    }
    const { rows } = await pool.query(query, params);
    if (rows.length === 0) {
      return res.json({ available: true, conflictProductId: null, conflictProductName: null });
    }
    res.json({ available: false, conflictProductId: rows[0].product_id, conflictProductName: rows[0].product_name });
  } catch (error) {
    logger.error(`Error checking inventory part number: ${error.message}`, error.stack);
    next(error);
  }
};

exports.update = async (req, res, next) => {
  try {
    const productId = req.params.id;
    const { product_name, price, description, product_code, stock_quantity, returnable_qty } = req.body;
    if (!product_name) return res.status(400).json({ error: 'Product name is required' });
    if (price !== undefined && price < 0) return res.status(400).json({ error: 'Price must be >= 0' });
    if (!product_code || product_code.length !== 11) return res.status(400).json({ error: 'Product code must be exactly 11 characters' });

    const partNumber = product_code.slice(0, 4);
    const { rows: conflictRows } = await pool.query(
      'SELECT product_id, product_name FROM inventory WHERE part_number = $1 AND product_id != $2',
      [partNumber, productId]
    );
    if (conflictRows.length > 0) {
      return res.status(400).json({
        error: `Part Number ${partNumber} is already used by ${conflictRows[0].product_name} (#${conflictRows[0].product_id})`,
      });
    }

    const updateData = {
      product_name: sanitize(product_name),
      price: price !== undefined ? parseFloat(price) : null,
      description: description ? sanitize(description) : null,
      product_code: sanitize(product_code),
    };
    if (stock_quantity !== undefined) {
      const parsedQty = parseInt(stock_quantity);
      if (isNaN(parsedQty)) return res.status(400).json({ error: 'Stock quantity must be a number' });
      updateData.stock_quantity = parsedQty;
    }
    if (returnable_qty !== undefined) {
      const parsedReturnable = parseInt(returnable_qty);
      if (isNaN(parsedReturnable) || parsedReturnable < 0) return res.status(400).json({ error: 'Returnable quantity must be a non-negative integer' });
      updateData.returnable_qty = parsedReturnable;
    }

    const updatedProduct = await Inventory.update(productId, updateData, true);
    if (price !== undefined) await Inventory.syncPriceWithPriceList(productId, price);
    if ((stock_quantity !== undefined || returnable_qty !== undefined) && req.io) {
      req.io.emit('stockUpdate', { product_id: updatedProduct.product_id, stock_quantity: updatedProduct.stock_quantity, returnable_qty: updatedProduct.returnable_qty });
    }
    const keys = await redis.keys('inventory_*');
    if (keys.length > 0) await redis.del(keys);
    await redis.del('price_list_*');
    res.json(updatedProduct);
  } catch (error) {
    if (error.code === '23505' && error.constraint === 'inventory_part_number_unique') {
      return res.status(400).json({ error: 'Part Number is already in use' });
    }
    if (error.code === '23505' && error.constraint === 'unique_product_code') {
      return res.status(400).json({ error: 'Product code must be unique' });
    }
    logger.error(`Error updating inventory ${req.params.id}: ${error.message}`, error.stack);
    next(error);
  }
};

exports.delete = async (req, res, next) => {
  try {
    const productId = req.params.id;
    const deletedProduct = await Inventory.delete(productId, req.io);
    const keys = await redis.keys('inventory_*');
    if (keys.length > 0) await redis.del(keys);
    await redis.del('price_list_*');
    logger.info(`Product deleted: ${deletedProduct.product_name} by ${req.user.user_id}`);
    res.json({ message: 'Product deleted successfully', product: deletedProduct });
  } catch (error) {
    if (error.message.includes('active inventory holds')) return res.status(400).json({ error: 'Cannot delete product with active holds', details: error.message });
    if (error.message.includes('non-zero stock')) return res.status(400).json({ error: 'Cannot delete product with remaining stock', details: error.message });
    logger.error(`Error deleting inventory ${req.params.id}: ${error.message}`, error.stack);
    next(error);
  }
};

exports.createHold = async (req, res, next) => {
  try {
    const productId = req.params.id;
    const { quantity, reason, reference_type, reference_value } = req.body;
    if (!quantity || quantity <= 0) return res.status(400).json({ error: 'Quantity must be greater than 0' });
    if (!reason) return res.status(400).json({ error: 'Reason is required' });
    const hold = await Inventory.createHold({ product_id: productId, quantity: parseInt(quantity), reason: sanitize(reason), reference_type: reference_type || null, reference_value: reference_value || null, created_by: req.user.user_id });
    const keys = await redis.keys('inventory_availability_*');
    if (keys.length > 0) await redis.del(keys);
    res.status(201).json(hold);
  } catch (error) {
    logger.error(`Error creating hold for product ${req.params.id}: ${error.message}`, error.stack);
    next(error);
  }
};

exports.releaseHold = async (req, res, next) => {
  try {
    const holdId = req.params.hold_id;
    const releasedHold = await Inventory.releaseHold(holdId);
    const keys = await redis.keys('inventory_availability_*');
    if (keys.length > 0) await redis.del(keys);
    res.json(releasedHold);
  } catch (error) {
    if (error.message.includes('not found or already released')) return res.status(404).json({ error: 'Hold not found or already released', details: error.message });
    logger.error(`Error releasing hold ${req.params.hold_id}: ${error.message}`, error.stack);
    next(error);
  }
};

exports.getHolds = async (req, res, next) => {
  try {
    const holds = await Inventory.getActiveHoldsByProduct(req.params.id);
    res.json({ data: holds, total: holds.length });
  } catch (error) {
    logger.error(`Error fetching holds for product ${req.params.id}: ${error.message}`, error.stack);
    next(error);
  }
};

exports.acceptReturn = async (req, res, next) => {
  try {
    const productId = req.params.id;
    const { qty } = req.body;
    if (!qty || qty <= 0) return res.status(400).json({ error: 'Quantity must be greater than 0' });
    const { rows: productRows } = await pool.query('SELECT stock_quantity, returnable_qty, product_name FROM inventory WHERE product_id = $1', [productId]);
    if (!productRows.length) return res.status(404).json({ error: 'Product not found' });
    const product = productRows[0];
    const qtyToAccept = parseInt(qty);
    if (qtyToAccept > product.returnable_qty) return res.status(400).json({ error: `Cannot accept more than available returnable quantity (${product.returnable_qty})` });
    const { rows: updatedRows } = await pool.query(
      'UPDATE inventory SET stock_quantity = stock_quantity + $1, returnable_qty = returnable_qty - $1 WHERE product_id = $2 RETURNING *',
      [qtyToAccept, productId]
    );
    const updatedProduct = updatedRows[0];
    if (req.io) req.io.emit('stockUpdate', { product_id: updatedProduct.product_id, stock_quantity: updatedProduct.stock_quantity, returnable_qty: updatedProduct.returnable_qty });
    const keys = await redis.keys('inventory_*');
    if (keys.length > 0) await redis.del(keys);
    res.json({ message: 'Return accepted successfully', product: updatedProduct });
  } catch (error) {
    logger.error(`Error accepting return for product ${req.params.id}: ${error.message}`, error.stack);
    next(error);
  }
};
