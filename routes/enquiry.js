const express = require('express');
const Enquiry = require('../models/enquiry');
const redis = require('../config/redis');
const { authenticateToken } = require('../middleware/auth');
const logger = require('../utils/logger');
const router = express.Router({ mergeParams: true });

const ensureAdmin = (req, res, next) => {
  if (req.user.role_id !== 1) {
    return res.status(403).json({ error: 'Access restricted to admin only' });
  }
  next();
};

// POST /api/enquiries - Create a new enquiry
router.post('/', authenticateToken, ensureAdmin, async (req, res) => {
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

    if (!enquiry_id || !company_name) {
      return res.status(400).json({ error: 'Enquiry ID and company name are required' });
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

    // Clear cache for enquiry listings
    const keys = await redis.keys('enquiry_*');
    if (keys.length > 0) await redis.del(keys);

    logger.info(`Enquiry created: ${enquiry.enquiry_id} by ${req.user.user_id}`);
    res.status(201).json(enquiry);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Enquiry ID already exists' });
    }
    logger.error(`Error creating enquiry: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// GET /api/enquiries - Get all enquiries
router.get('/', authenticateToken, ensureAdmin, async (req, res) => {
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
    await redis.setEx(cacheKey, 300, JSON.stringify(enquiries)); // Cache for 5 minutes
    logger.info(`Fetched ${enquiries.data.length} enquiries`);
    res.json(enquiries);
  } catch (error) {
    logger.error(`Error fetching enquiries: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// GET /api/enquiries/:id - Get a single enquiry
router.get('/:id', authenticateToken, ensureAdmin, async (req, res) => {
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
    res.status(error.message === 'Enquiry not found' ? 404 : 500).json({ error: error.message });
  }
});

// PUT /api/enquiries/:id - Update an enquiry
router.put('/:id', authenticateToken, ensureAdmin, async (req, res) => {
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

    // Clear cache for enquiry listings and single enquiry
    const keys = await redis.keys('enquiry_*');
    if (keys.length > 0) await redis.del(keys);

    logger.info(`Enquiry updated: ${enquiry.enquiry_id} by ${req.user.user_id}`);
    res.json(enquiry);
  } catch (error) {
    logger.error(`Error updating enquiry ${req.params.id}: ${error.message}`, error.stack);
    res.status(error.message === 'Enquiry not found' ? 404 : 500).json({ error: error.message });
  }
});

// DELETE /api/enquiries/:id - Delete an enquiry
router.delete('/:id', authenticateToken, ensureAdmin, async (req, res) => {
  try {
    const enquiry = await Enquiry.delete(req.params.id, req.io);

    // Clear cache for enquiry listings and single enquiry
    const keys = await redis.keys('enquiry_*');
    if (keys.length > 0) await redis.del(keys);

    logger.info(`Enquiry deleted: ${enquiry.enquiry_id} by ${req.user.user_id}`);
    res.json({ message: 'Enquiry deleted successfully', enquiry });
  } catch (error) {
    logger.error(`Error deleting enquiry ${req.params.id}: ${error.message}`, error.stack);
    res.status(error.message === 'Enquiry not found' ? 404 : 500).json({ error: error.message });
  }
});

module.exports = router;