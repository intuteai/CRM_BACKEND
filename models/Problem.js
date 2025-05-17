const pool = require('../config/db');

class Problem {
  static async create({ product_id, problem_description }) {
    const result = await pool.query(
      'INSERT INTO problems (product_id, problem_description) VALUES ($1, $2) RETURNING *',
      [product_id, problem_description]
    );
    const newProblem = await pool.query(
      `SELECT p.id, p.product_id, i.product_name, p.problem_description, p.created_at
       FROM problems p
       JOIN inventory i ON p.product_id = i.product_id
       WHERE p.id = $1`,
      [result.rows[0].id]
    );
    return newProblem.rows[0];
  }

  static async getAll({ limit, offset }) {
    const result = await pool.query(`
      SELECT p.id, p.product_id, i.product_name, p.problem_description, p.created_at,
             json_agg(
               json_build_object(
                 'solution_id', ps.solution_id,
                 'solution_description', ps.solution_description,
                 'is_successful', ps.is_successful,
                 'attempted_at', ps.attempted_at
               ) ORDER BY ps.attempted_at
             ) FILTER (WHERE ps.solution_id IS NOT NULL) AS solutions
      FROM problems p
      LEFT JOIN inventory i ON p.product_id = i.product_id
      LEFT JOIN problem_solutions ps ON p.id = ps.problem_id
      GROUP BY p.id, i.product_name, p.product_id, p.problem_description, p.created_at
      ORDER BY p.created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);
    return { data: result.rows };
  }

  static async getById(problem_id) {
    const result = await pool.query(
      `SELECT p.id, p.product_id, i.product_name, p.problem_description, p.created_at
       FROM problems p
       JOIN inventory i ON p.product_id = i.product_id
       WHERE p.id = $1`,
      [problem_id]
    );
    const problem = result.rows[0];
    if (problem) {
      problem.solutions = await this.getSolutions(problem_id);
    }
    return problem;
  }

  static async getSolutions(problem_id) {
    const result = await pool.query(
      'SELECT solution_id, problem_id, solution_description, is_successful, attempted_at FROM problem_solutions WHERE problem_id = $1 ORDER BY attempted_at ASC',
      [problem_id]
    );
    console.log('Fetched solutions for problem_id', problem_id, ':', result.rows);
    return result.rows;
  }

  static async addSolution(problem_id, { solution_description, is_successful }) {
    const result = await pool.query(
      'INSERT INTO problem_solutions (problem_id, solution_description, is_successful) VALUES ($1, $2, $3) RETURNING *',
      [problem_id, solution_description, is_successful || false]
    );
    console.log('Added solution:', result.rows[0]);
    return result.rows[0];
  }
}

module.exports = Problem;