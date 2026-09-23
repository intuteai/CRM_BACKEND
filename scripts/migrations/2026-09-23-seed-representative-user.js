require('dotenv').config();
const pool = require('../../config/db');
const User = require('../../models/core/user');

async function seed() {
  const roleRes = await pool.query(`SELECT role_id FROM roles WHERE role_name = 'representative'`);
  if (roleRes.rows.length === 0) {
    throw new Error('representative role does not exist yet — run 2026-09-23-add-representative-role.js first');
  }
  const roleId = roleRes.rows[0].role_id;

  try {
    const { user } = await User.create({
      name: 'Representative (test)',
      email: 'representative@compageauto.com',
      password: 'password123',
      role_id: roleId,
    });
    console.log('Created representative test user:', user);
  } catch (err) {
    if (err.code === 'DUPLICATE_EMAIL') {
      console.log('representative@compageauto.com already exists, nothing to do.');
    } else {
      throw err;
    }
  }

  await pool.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
