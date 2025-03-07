// models/activity.js
const pool = require('../config/db');

class Activity {
  static async log(user_id, action, details, client = null) {
    const queryClient = client || pool;
    try {
      await queryClient.query(
        'INSERT INTO activity_logs (user_id, action, details) VALUES ($1, $2, $3)',
        [user_id, action, details]
      );
    } catch (err) {
      console.error(`Error logging activity: ${err.message}`);
      throw err; // Ensure error propagates
    }
  }
}

module.exports = Activity;