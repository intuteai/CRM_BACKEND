const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const QueryService = require('../services/queryService');
const logger = require('../utils/logger');
const router = express.Router({ mergeParams: true });

router.get('/', authenticateToken, async (req, res, next) => {
  try {
    const { limit = 10, offset = 0 } = req.query;
    logger.info(`Fetching queries for user ${req.user.user_id} (role: ${req.user.role_id})`);
    const queries = await QueryService.getQueries(
      req.user.user_id,
      req.user.role_id,
      { limit: parseInt(limit), offset: parseInt(offset) }
    );
    res.json(queries);
  } catch (error) {
    next(error);
  }
});

router.post('/', authenticateToken, async (req, res, next) => {
  try {
    logger.info(`Creating query for user ${req.user.user_id}`);
    const query = await QueryService.createQuery(req.user.user_id, req.user.name, req.body.description);
    req.io.to(`user:${req.user.user_id}`).emit('newQuery', query);
    res.status(201).json(query);
  } catch (error) {
    next(error);
  }
});

router.put('/:id/respond', authenticateToken, async (req, res, next) => {
  try {
    logger.info(`Responding to query ${req.params.id} by user ${req.user.user_id}`);
    const query = await QueryService.respondToQuery(req.params.id, req.user.user_id, req.body.response);
    req.io.to(`user:${query.user_id}`).emit('queryUpdate', query);
    res.json(query);
  } catch (error) {
    next(error);
  }
});

router.put('/:id/in-progress', authenticateToken, async (req, res, next) => {
  try {
    logger.info(`Setting query ${req.params.id} to In Progress by user ${req.user.user_id}`);
    const query = await QueryService.setInProgress(req.params.id, req.user.user_id);
    req.io.to(`user:${query.user_id}`).emit('queryUpdate', query);
    res.json(query);
  } catch (error) {
    next(error);
  }
});

router.put('/:id/close', authenticateToken, async (req, res, next) => {
  try {
    logger.info(`Closing query ${req.params.id} by user ${req.user.user_id} (role: ${req.user.role_id})`);
    const query = await QueryService.closeQuery(req.params.id, req.user.user_id, req.user.role_id);
    req.io.to(`user:${query.user_id}`).emit('queryUpdate', query);
    res.json(query);
  } catch (error) {
    next(error);
  }
});

router.use((error, req, res, next) => {
  const status = error.statusCode || 500;
  const message = error.message || 'Internal Server Error';
  logger.error(`API Error: ${message}`, { stack: error.stack, userId: req.user?.user_id });
  res.status(status).json({ error: message });
});

module.exports = router;