const express = require('express');
const router = express.Router();
const Problem = require('../models/Problem');
const { authenticateToken, checkPermission } = require('../middleware/auth');
const logger = require('../utils/logger');
const redis = require('../config/redis'); // Added import

// Get all problems with their solutions
router.get('/', authenticateToken, checkPermission('Problems', 'can_read'), async (req, res, next) => {
  try {
    const { limit = 100, offset = 0 } = req.query;
    const parsedLimit = Math.min(parseInt(limit, 10), 100);
    const parsedOffset = parseInt(offset, 10);

    const cacheKey = `problems_${parsedLimit}_${parsedOffset}_${req.user.user_id}`;
    const cached = await redis.get(cacheKey);
    if (cached && req.query.force_refresh !== 'true') {
      logger.info(`Cache hit for ${cacheKey}`);
      return res.json(JSON.parse(cached));
    }

    const { data } = await Problem.getAll({ limit: parsedLimit, offset: parsedOffset });
    const response = {
      problems: data,
      timezone: 'Asia/Kolkata',
    };

    await redis.setEx(cacheKey, 300, JSON.stringify(response));
    res.json(response);
  } catch (err) {
    logger.error(`Error fetching problems for user ${req.user.user_id}`, { message: err.message, stack: err.stack });
    next(err);
  }
});

// Add a new problem
router.post('/', authenticateToken, checkPermission('Problems', 'can_write'), async (req, res, next) => {
  try {
    const { product_id, problem_description } = req.body;
    if (!product_id || !problem_description) {
      return res.status(400).json({ error: 'Product ID and problem description are required' });
    }

    const newProblem = await Problem.create({ product_id, problem_description });
    req.io.emit('problem:created', newProblem);

    setImmediate(async () => {
      try {
        const problemKeys = await redis.keys(`problems_*_${req.user.user_id}`);
        if (problemKeys.length) await redis.del(problemKeys);
        logger.info(`Cleared problem caches for user ${req.user.user_id}`);
      } catch (err) {
        logger.error('Cache invalidation error', err);
      }
    });

    res.status(201).json({
      id: newProblem.id,
      product_id: newProblem.product_id,
      product_name: newProblem.product_name,
      problem_description: newProblem.problem_description,
      created_at: newProblem.created_at.toISOString(),
      timezone: 'Asia/Kolkata',
    });
  } catch (err) {
    logger.error(`Error creating problem for user ${req.user.user_id}`, { message: err.message, stack: err.stack });
    res.status(400).json({ error: err.message });
  }
});

// Add a solution attempt
router.post('/:id/solutions', authenticateToken, checkPermission('Problems', 'can_write'), async (req, res, next) => {
  try {
    const problemId = req.params.id;
    const { solution_description, is_successful } = req.body;
    if (!solution_description) {
      return res.status(400).json({ error: 'Solution description is required' });
    }

    const newSolution = await Problem.addSolution(problemId, { solution_description, is_successful });
    req.io.emit('solution:created', { problem_id: problemId, solution: newSolution });

    setImmediate(async () => {
      try {
        const problemKeys = await redis.keys(`problems_*_${req.user.user_id}`);
        if (problemKeys.length) await redis.del(problemKeys);
        logger.info(`Cleared problem caches for user ${req.user.user_id}`);
      } catch (err) {
        logger.error('Cache invalidation error', err);
      }
    });

    res.status(201).json({
      solution_id: newSolution.solution_id,
      problem_id: newSolution.problem_id,
      solution_description: newSolution.solution_description,
      is_successful: newSolution.is_successful,
      attempted_at: newSolution.attempted_at.toISOString(),
      timezone: 'Asia/Kolkata',
    });
  } catch (err) {
    logger.error(`Error creating solution for problem ${req.params.id}`, { message: err.message, stack: err.stack });
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;