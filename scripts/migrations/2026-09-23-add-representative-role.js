require('dotenv').config();
const pool = require('../../config/db');

async function migrate() {
  const statements = [
    `ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS city TEXT`,
    `ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS photos TEXT[] NOT NULL DEFAULT '{}'`,
  ];

  for (const sql of statements) {
    console.log('Running:', sql);
    await pool.query(sql);
  }

  console.log('Ensuring representative role exists...');
  const roleRes = await pool.query(
    `SELECT role_id FROM roles WHERE role_name = 'representative'`
  );
  let roleId;
  if (roleRes.rows.length > 0) {
    roleId = roleRes.rows[0].role_id;
    console.log('representative role already exists, role_id =', roleId);
  } else {
    const inserted = await pool.query(
      `INSERT INTO roles (role_name) VALUES ('representative') RETURNING role_id`
    );
    roleId = inserted.rows[0].role_id;
    console.log('Created representative role, role_id =', roleId);
  }

  console.log('Ensuring representative has Enquiries permissions (read+write, no delete)...');
  const permRes = await pool.query(
    `SELECT 1 FROM permissions WHERE role_id = $1 AND module = 'Enquiries'`,
    [roleId]
  );
  if (permRes.rows.length > 0) {
    console.log('Enquiries permission row already exists for representative, skipping insert.');
  } else {
    await pool.query(
      `INSERT INTO permissions (role_id, module, can_read, can_write, can_delete)
       VALUES ($1, 'Enquiries', true, true, false)`,
      [roleId]
    );
    console.log('Inserted Enquiries permission row for representative.');
  }

  console.log('Migration complete.');
  await pool.end();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
