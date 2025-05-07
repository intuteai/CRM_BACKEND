const express = require('express');
const Enquiry = require('../models/enquiry');
const redis = require('../config/redis');
const { authenticateToken, checkPermission } = require('../middleware/auth');
const logger = require('../utils/logger');
const router = express.Router({ mergeParams: true });

router.post('/', authenticateToken, checkPermission('Enquiries', 'can_write'), async (req, res) => {
  try {
    const {
      enquiry_id,
      company_name,
      contact_person,
      mail_id,
      phone_no,
      items_required,
      status,
      last_discussion,
      next_interaction,
    } = req.body;

    if (!company_name) {
      return res.status(400).json({ error: 'Company name is required', code: 'INVALID_INPUT' });
    }

    const enquiry = await Enquiry.create(
      {
        enquiry_id,
        company_name,
        contact_person,
        mail_id,
        phone_no,
        items_required,
        status,
        last_discussion,
        next_interaction,
      },
      req.io
    );

    // Invalidate all enquiry list caches
    const keys = await redis.keys('enquiry_list_*');
    if (keys.length > 0) await redis.del(keys);

    logger.info(`Enquiry created: ${enquiry.enquiry_id} by ${req.user.user_id}`);
    res.status(201).json(enquiry);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Enquiry ID already exists', code: 'DUPLICATE_ENQUIRY_ID' });
    }
    logger.error(`Error creating enquiry: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
  }
});

router.get('/', authenticateToken, checkPermission('Enquiries', 'can_read'), async (req, res) => {
  const { limit = 10, cursor, force_refresh = 'false' } = req.query;
  const cacheKey = cursor ? `enquiry_list_${limit}_${cursor}` : `enquiry_list_${limit}`;

  try {
    if (force_refresh === 'true') await redis.del(cacheKey);

    const cached = await redis.get(cacheKey);
    if (cached && force_refresh !== 'true') {
      logger.info(`Cache hit for ${cacheKey}`);
      return res.json(JSON.parse(cached));
    }

    const enquiries = await Enquiry.getAll({ limit: parseInt(limit), cursor });
    await redis.setEx(cacheKey, 300, JSON.stringify(enquiries));
    logger.info(`Fetched ${enquiries.data.length} enquiries`);
    res.json(enquiries);
  } catch (error) {
    logger.error(`Error fetching enquiries: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
  }
});

router.get('/:id', authenticateToken, checkPermission('Enquiries', 'can_read'), async (req, res) => {
  const cacheKey = `enquiry_${req.params.id}`;

  try {
    if (req.query.force_refresh === 'true') await redis.del(cacheKey);

    const cached = await redis.get(cacheKey);
    if (cached && req.query.force_refresh !== 'true') {
      logger.info(`Cache hit for ${cacheKey}`);
      return res.json(JSON.parse(cached));
    }

    const enquiry = await Enquiry.getById(req.params.id);
    await redis.setEx(cacheKey, 300, JSON.stringify(enquiry));
    logger.info(`Fetched enquiry: ${enquiry.enquiry_id}`);
    res.json(enquiry);
  } catch (error) {
    logger.error(`Error fetching enquiry ${req.params.id}: ${error.message}`, error.stack);
    res.status(error.message === 'Enquiry not found' ? 404 : 500).json({ error: error.message, code: error.message === 'Enquiry not found' ? 'NOT_FOUND' : 'SERVER_ERROR' });
  }
});

router.put('/:id', authenticateToken, checkPermission('Enquiries', 'can_write'), async (req, res) => {
  try {
    const {
      company_name,
      contact_person,
      mail_id,
      phone_no,
      items_required,
      status,
      last_discussion,
      next_interaction,
    } = req.body;

    const enquiry = await Enquiry.update(
      req.params.id,
      {
        company_name,
        contact_person,
        mail_id,
        phone_no,
        items_required,
        status,
        last_discussion,
        next_interaction,
      },
      req.io
    );

    // Invalidate specific enquiry and all list caches
    const keys = await redis.keys(`enquiry_${req.params.id}`);
    const listKeys = await redis.keys('enquiry_list_*');
    if (keys.length > 0 || listKeys.length > 0) await redis.del([...keys, ...listKeys]);

    logger.info(`Enquiry updated: ${enquiry.enquiry_id} by ${req.user.user_id}`);
    res.json(enquiry);
  } catch (error) {
    logger.error(`Error updating enquiry ${req.params.id}: ${error.message}`, error.stack);
    res.status(error.message === 'Enquiry not found' ? 404 : 500).json({ error: error.message, code: error.message === 'Enquiry not found' ? 'NOT_FOUND' : 'SERVER_ERROR' });
  }
});

router.delete('/:id', authenticateToken, checkPermission('Enquiries', 'can_delete'), async (req, res) => {
  try {
    const enquiry = await Enquiry.delete(req.params.id, req.io);

    // Invalidate specific enquiry and all list caches
    const keys = await redis.keys(`enquiry_${req.params.id}`);
    const listKeys = await redis.keys('enquiry_list_*');
    if (keys.length > 0 || listKeys.length > 0) await redis.del([...keys, ...listKeys]);

    logger.info(`Enquiry deleted: ${enquiry.enquiry_id} by ${req.user.user_id}`);
    res.json({ message: 'Enquiry deleted successfully', enquiry });
  } catch (error) {
    logger.error(`Error deleting enquiry ${req.params.id}: ${error.message}`, error.stack);
    res.status(error.message === 'Enquiry not found' ? 404 : 500).json({ error: error.message, code: error.message === 'Enquiry not found' ? 'NOT_FOUND' : 'SERVER_ERROR' });
  }
});

router.post('/refresh', authenticateToken, checkPermission('Enquiries', 'can_read'), async (req, res) => {
  try {
    // Invalidate all enquiry-related caches
    const keys = await redis.keys('enquiry_*');
    const listKeys = await redis.keys('enquiry_list_*');
    if (keys.length > 0 || listKeys.length > 0) await redis.del([...keys, ...listKeys]);

    logger.info(`Enquiry caches invalidated by ${req.user.user_id}`);
    res.json({ message: 'Enquiry caches invalidated successfully' });
  } catch (error) {
    logger.error(`Error invalidating enquiry caches: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
  }
});

module.exports = router;