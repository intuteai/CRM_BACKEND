const pool = require('../config/db');

class Query {
  static async create(user_id, { query_text }) {
    const result = await pool.query(
      'INSERT INTO queries (user_id, query_text, query_status) VALUES ($1, $2, $3) RETURNING *',
      [user_id, query_text, 'Open']
    );
    return result.rows[0];
  }

  static async getByUserId(user_id, { limit, offset }) {
    const result = await pool.query(
      'SELECT * FROM queries WHERE user_id = $1 ORDER BY date_of_query_raised DESC LIMIT $2 OFFSET $3',
      [user_id, limit, offset]
    );
    return { data: result.rows };
  }

  static async getAll({ limit, offset }) {
    const result = await pool.query(
      'SELECT * FROM queries ORDER BY date_of_query_raised DESC LIMIT $1 OFFSET $2',
      [limit, offset]
    );
    return { data: result.rows };
  }

  static async getResponses(query_id) {
    const result = await pool.query(
      'SELECT response_id, query_id, responded_by, response, response_date FROM query_responses WHERE query_id = $1 ORDER BY response_date ASC',
      [query_id]
    );
    console.log('Fetched responses for query_id', query_id, ':', result.rows); // Debug
    return result.rows;
  }

  static async getById(query_id) {
    const result = await pool.query('SELECT * FROM queries WHERE query_id = $1', [query_id]);
    const query = result.rows[0];
    if (query) {
      query.adminResponses = await this.getResponses(query_id);
    }
    return query;
  }

  static async updateStatus(query_id, status) {
    const result = await pool.query(
      'UPDATE queries SET query_status = $1, last_updated = NOW() WHERE query_id = $2 RETURNING *',
      [status, query_id]
    );
    return result.rows[0];
  }

  static async addResponse(query_id, responded_by, response) {
    const result = await pool.query(
      'INSERT INTO query_responses (query_id, responded_by, response, response_date) VALUES ($1, $2, $3, NOW()) RETURNING *',
      [query_id, responded_by, response]
    );
    console.log('Added response:', result.rows[0]); // Debug
    return result.rows[0];
  }
}

module.exports = Query;