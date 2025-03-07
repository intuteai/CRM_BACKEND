// services/queryService.js
const pool = require('../config/db');
const redisClient = require('../config/redis');
const logger = require('../utils/logger');
const Activity = require('../models/activity');

class QueryError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
    this.name = 'QueryError';
  }
}

class QueryService {
  static async getQueries(userId, roleId, { limit = 10, offset = 0 }) {
    const cacheKey = `queries:${userId}:${limit}:${offset}`;
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      logger.info(`Cache hit for ${cacheKey}`);
      return JSON.parse(cached);
    }

    const query = roleId === 1
      ? `
        SELECT q.query_id AS "queryId", u.name AS "customerName", 
               q.query_text AS "description", q.query_status AS "status"
        FROM queries q
        JOIN users u ON q.user_id = u.user_id
        ORDER BY q.date_of_query_raised DESC
        LIMIT $1 OFFSET $2
      `
      : `
        SELECT q.query_id AS "queryId", u.name AS "customerName", 
               q.query_text AS "description", q.query_status AS "status"
        FROM queries q
        JOIN users u ON q.user_id = u.user_id
        WHERE q.user_id = $1
        ORDER BY q.date_of_query_raised DESC
        LIMIT $2 OFFSET $3
      `;
    const params = roleId === 1 ? [limit, offset] : [userId, limit, offset];
    const { rows: queries } = await pool.query(query, params);

    for (let query of queries) {
      query.adminResponses = await this.getResponses(query.queryId);
    }

    await redisClient.setEx(cacheKey, 3600, JSON.stringify(queries));
    logger.info(`Fetched ${queries.length} queries for user ${userId}`);
    return queries;
  }

  static async createQuery(userId, customerName, description) {
    if (!description || typeof description !== 'string' || !description.trim()) {
      throw new QueryError('Query description is required and must be a non-empty string', 400);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [query] } = await client.query(
        'INSERT INTO queries (user_id, query_text, query_status) VALUES ($1, $2, $3) RETURNING *',
        [userId, description, 'Open']
      );
      await Activity.log(userId, 'CREATE_QUERY', `Query ${query.query_id} created`, client);
      await client.query('COMMIT');

      const response = {
        queryId: query.query_id,
        customerName,
        description: query.query_text,
        status: query.query_status,
        adminResponses: []
      };
      // Invalidate all query caches to ensure admins and customers see the new query
      await redisClient.delPattern('queries:*');
      logger.info(`Query ${query.query_id} created by user ${userId}`);
      return response;
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error(`Error creating query: ${err.message}`, err.stack);
      throw err;
    } finally {
      client.release();
    }
  }

  static async respondToQuery(queryId, respondedBy, responseText) {
    if (!responseText || typeof responseText !== 'string' || !responseText.trim()) {
      throw new QueryError('Response text is required and must be a non-empty string', 400);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      logger.info(`Fetching query ${queryId} for response`);
      const { rows: [query] } = await client.query(
        'SELECT * FROM queries WHERE query_id = $1 FOR UPDATE',
        [queryId]
      );
      if (!query) {
        logger.error(`Query ${queryId} not found`);
        throw new QueryError('Query not found', 404);
      }
      if (query.query_status === 'Closed') {
        throw new QueryError('Cannot respond to a closed query', 400);
      }

      await client.query(
        'INSERT INTO query_responses (query_id, responded_by, response, response_date) VALUES ($1, $2, $3, NOW())',
        [queryId, respondedBy, responseText]
      );
      const { rows: [updatedQuery] } = await client.query(
        'UPDATE queries SET query_status = $1, last_updated = NOW() WHERE query_id = $2 RETURNING *',
        ['In Progress', queryId]
      );
      updatedQuery.adminResponses = await this.getResponses(queryId);
      const customerName = (await client.query('SELECT name FROM users WHERE user_id = $1', [updatedQuery.user_id])).rows[0].name;
      await Activity.log(respondedBy, 'RESPOND_QUERY', `Response added to Query ${queryId}`, client);
      await client.query('COMMIT');

      const response = {
        queryId: updatedQuery.query_id,
        customerName,
        description: updatedQuery.query_text,
        status: updatedQuery.query_status,
        adminResponses: updatedQuery.adminResponses
      };
      await redisClient.delPattern(`queries:*`);
      return response;
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error(`Error in respondToQuery for query ${queryId}: ${err.message}`, err.stack);
      throw err;
    } finally {
      client.release();
    }
  }

  static async setInProgress(queryId, userId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      logger.info(`Fetching query ${queryId} for in-progress update`);
      const { rows: [query] } = await client.query(
        'SELECT * FROM queries WHERE query_id = $1 FOR UPDATE',
        [queryId]
      );
      if (!query) {
        logger.error(`Query ${queryId} not found`);
        throw new QueryError('Query not found', 404);
      }
      if (query.query_status === 'Closed') {
        throw new QueryError('Cannot set closed query to In Progress', 400);
      }
      if (query.query_status === 'In Progress') {
        throw new QueryError('Query is already In Progress', 400);
      }

      const { rows: [updatedQuery] } = await client.query(
        'UPDATE queries SET query_status = $1, last_updated = NOW() WHERE query_id = $2 RETURNING *',
        ['In Progress', queryId]
      );
      updatedQuery.adminResponses = await this.getResponses(queryId);
      await Activity.log(userId, 'SET_QUERY_IN_PROGRESS', `Query ${queryId} set to In Progress`, client);
      await client.query('COMMIT');

      logger.info(`Query ${queryId} set to In Progress by ${userId}`);
      await redisClient.delPattern(`queries:*`);
      return updatedQuery;
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error(`Error in setInProgress for query ${queryId}: ${err.message}`, err.stack);
      throw err;
    } finally {
      client.release();
    }
  }

  static async closeQuery(queryId, userId, roleId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      logger.info(`Fetching query ${queryId} for close`);
      const { rows: [query] } = await client.query(
        'SELECT * FROM queries WHERE query_id = $1 FOR UPDATE',
        [queryId]
      );
      if (!query) {
        logger.error(`Query ${queryId} not found`);
        throw new QueryError('Query not found', 404);
      }
      if (roleId === 2 && query.user_id !== userId) {
        throw new QueryError('Permission denied', 403);
      }
      if (query.query_status === 'Closed') {
        throw new QueryError('Query already closed', 400);
      }

      const { rows: [updatedQuery] } = await client.query(
        'UPDATE queries SET query_status = $1, last_updated = NOW() WHERE query_id = $2 RETURNING *',
        ['Closed', queryId]
      );
      updatedQuery.adminResponses = await this.getResponses(queryId);
      await Activity.log(userId, 'CLOSE_QUERY', `Query ${queryId} closed`, client);
      await client.query('COMMIT');

      logger.info(`Query ${queryId} closed by ${userId}`);
      await redisClient.delPattern(`queries:*`);
      return updatedQuery;
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error(`Error in closeQuery for query ${queryId}: ${err.message}`, err.stack);
      throw err;
    } finally {
      client.release();
    }
  }

  static async getResponses(queryId) {
    const { rows } = await pool.query(
      'SELECT response AS "response", response_date AS "response_date" ' +
      'FROM query_responses WHERE query_id = $1 ORDER BY response_date ASC',
      [queryId]
    );
    return rows;
  }
}

module.exports = QueryService;