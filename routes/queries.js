// routes/queries.js
const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const QueryService = require('../services/queryService');
const logger = require('../utils/logger');
const router = express.Router({ mergeParams: true});

/**
 * @route GET /api/queries
 * @desc Fetch queries for the authenticated user (admin sees all, customer sees own)
 * @access Private
 * @query {number} [limit=10] - Number of queries to return
 * @query {number} [offset=0] - Offset for pagination
 * @returns {Array} - List of query objects
 */
router.get('/', authenticateToken, async (req, res, next) => {
  try {
    const { limit = 10, offset = 0 } = req.query;
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

/**
 * @route POST /api/queries
 * @desc Create a new query
 * @access Private (Customer)
 * @body {string} description - Query text
 * @returns {Object} - Created query object
 */
router.post('/', authenticateToken, async (req, res, next) => {
  try {
    const query = await QueryService.createQuery(req.user.user_id, req.user.name, req.body.description);
    req.io.to(`user:${req.user.user_id}`).emit('newQuery', query);
    res.status(201).json(query);
  } catch (error) {
    next(error);
  }
});

/**
 * @route PUT /api/queries/:id/respond
 * @desc Respond to a query (admin only)
 * @access Private (Admin)
 * @param {string} id - Query ID
 * @body {string} response - Response text
 * @returns {Object} - Updated query object
 */
router.put('/:id/respond', authenticateToken, async (req, res, next) => {
  try {
    const query = await QueryService.respondToQuery(req.params.id, req.user.user_id, req.body.response);
    req.io.to(`user:${query.user_id}`).emit('queryUpdate', query);
    res.json(query);
  } catch (error) {
    next(error);
  }
});

/**
 * @route PUT /api/queries/:id/in-progress
 * @desc Set query to "In Progress" (admin only)
 * @access Private (Admin)
 * @param {string} id - Query ID
 * @returns {Object} - Updated query object
 */
router.put('/:id/in-progress', authenticateToken, async (req, res, next) => {
  try {
    const query = await QueryService.setInProgress(req.params.id, req.user.user_id);
    req.io.to(`user:${query.user_id}`).emit('queryUpdate', query);
    res.json(query);
  } catch (error) {
    next(error);
  }
});

/**
 * @route PUT /api/queries/:id/close
 * @desc Close a query (admin or owning customer)
 * @access Private
 * @param {string} id - Query ID
 * @returns {Object} - Updated query object
 */
router.put('/:id/close', authenticateToken, async (req, res, next) => {
  try {
    const query = await QueryService.closeQuery(req.params.id, req.user.user_id, req.user.role_id);
    req.io.to(`user:${query.user_id}`).emit('queryUpdate', query);
    res.json(query);
  } catch (error) {
    next(error);
  }
});

// Centralized error handler
router.use((error, req, res, next) => {
  const status = error.statusCode || 500;
  const message = error.message || 'Internal Server Error';
  logger.error(`API Error: ${message}`, error.stack);
  res.status(status).json({ error: message });
});

module.exports = router;