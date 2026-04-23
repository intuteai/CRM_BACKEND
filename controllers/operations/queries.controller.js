const QueryService = require('../../services/queryService');
const logger = require('../../utils/logger');

exports.getAll = async (req, res, next) => {
  try {
    const { limit = 10, offset = 0 } = req.query;
    logger.info(`Fetching queries for user ${req.user.user_id} (role: ${req.user.role_id})`);
    const queries = await QueryService.getQueries(req.user.user_id, req.user.role_id, { limit: parseInt(limit), offset: parseInt(offset) });
    res.json(queries);
  } catch (error) {
    next(error);
  }
};

exports.create = async (req, res, next) => {
  try {
    logger.info(`Creating query for user ${req.user.user_id}`);
    const query = await QueryService.createQuery(req.user.user_id, req.user.name, req.body.description);
    req.io.to(`user:${req.user.user_id}`).emit('newQuery', query);
    res.status(201).json(query);
  } catch (error) {
    next(error);
  }
};

exports.respond = async (req, res, next) => {
  try {
    logger.info(`Responding to query ${req.params.id} by user ${req.user.user_id}`);
    const query = await QueryService.respondToQuery(req.params.id, req.user.user_id, req.body.response);
    req.io.to(`user:${query.user_id}`).emit('queryUpdate', query);
    res.json(query);
  } catch (error) {
    next(error);
  }
};

exports.setInProgress = async (req, res, next) => {
  try {
    logger.info(`Setting query ${req.params.id} to In Progress by user ${req.user.user_id}`);
    const query = await QueryService.setInProgress(req.params.id, req.user.user_id);
    req.io.to(`user:${query.user_id}`).emit('queryUpdate', query);
    res.json(query);
  } catch (error) {
    next(error);
  }
};

exports.close = async (req, res, next) => {
  try {
    logger.info(`Closing query ${req.params.id} by user ${req.user.user_id} (role: ${req.user.role_id})`);
    const query = await QueryService.closeQuery(req.params.id, req.user.user_id, req.user.role_id);
    req.io.to(`user:${query.user_id}`).emit('queryUpdate', query);
    res.json(query);
  } catch (error) {
    next(error);
  }
};
