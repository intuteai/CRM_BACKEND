// Adds the Innopack organization's first role: innopack_design, role_id 16.
// The id is fixed because middleware/roles.js and auth.controller.js refer to
// it by number. No permissions rows: Innopack gets no Compage or Intute AI
// module; its own screens will add their own guards.
// Safe to run twice. Usage: node scripts/migrations/2026-11-20-add-innopack-design-role.js
require('dotenv').config();
const pool = require('../../config/db');

const ROLE_ID = 16;
const ROLE_NAME = 'innopack_design';

async function migrate() {
  const { rows } = await pool.query('SELECT role_id, role_name FROM roles WHERE role_id = $1 OR role_name = $2', [ROLE_ID, ROLE_NAME]);
  const exact = rows.find((r) => r.role_id === ROLE_ID && r.role_name === ROLE_NAME);
  if (exact) {
    console.log(`${ROLE_NAME} already exists as role_id ${ROLE_ID}, nothing to do.`);
  } else if (rows.length) {
    throw new Error(`Conflict, not changing anything: ${JSON.stringify(rows)}`);
  } else {
    await pool.query('INSERT INTO roles (role_id, role_name) VALUES ($1, $2)', [ROLE_ID, ROLE_NAME]);
    // Keep the sequence ahead of the explicit id so a later bare INSERT cannot collide.
    await pool.query(`SELECT setval('roles_role_id_seq', GREATEST((SELECT MAX(role_id) FROM roles), (SELECT last_value FROM roles_role_id_seq)))`);
    console.log(`Created ${ROLE_NAME} as role_id ${ROLE_ID}.`);
  }
  await pool.end();
}

migrate().catch(async (err) => {
  console.error('Migration failed:', err.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
