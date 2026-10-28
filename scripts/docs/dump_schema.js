// Read-only snapshot of the live database catalogue for the technical
// documentation (Appendices B and C). Only SELECTs against information_schema,
// pg_stat_user_tables, pg_indexes, roles and permissions; writes nothing to the DB.
// Usage: node scripts/docs/dump_schema.js [outFile]
const fs = require('fs');
const path = require('path');
const pool = require('../../config/db');

const out = process.argv[2] || path.join(__dirname, '..', '..', 'docs', 'technical', 'generated', 'schema.json');

(async () => {
  const cols = await pool.query(
    `SELECT table_name, column_name, data_type, is_nullable, column_default
     FROM information_schema.columns WHERE table_schema = 'public'
     ORDER BY table_name, ordinal_position`
  );
  const cons = await pool.query(
    `SELECT tc.table_name, kcu.column_name, tc.constraint_type, ccu.table_name AS ref_table, ccu.column_name AS ref_col
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
     LEFT JOIN information_schema.constraint_column_usage ccu
       ON tc.constraint_name = ccu.constraint_name AND tc.constraint_type = 'FOREIGN KEY'
     WHERE tc.table_schema = 'public' AND tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY', 'UNIQUE')`
  );
  const roles = await pool.query('SELECT role_id, role_name FROM roles ORDER BY role_id');
  const perms = await pool.query(
    'SELECT role_id, module, can_read, can_write, can_delete FROM permissions ORDER BY role_id, module'
  );
  const counts = await pool.query(
    'SELECT relname AS table_name, n_live_tup AS approx_rows FROM pg_stat_user_tables ORDER BY relname'
  );
  const idx = await pool.query(
    "SELECT tablename, indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY tablename"
  );

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({
    cols: cols.rows, cons: cons.rows, roles: roles.rows, perms: perms.rows, counts: counts.rows, idx: idx.rows,
  }, null, 1));
  console.log(`schema: ${new Set(cols.rows.map((r) => r.table_name)).size} tables, ${cols.rows.length} columns, ${perms.rows.length} permission rows -> ${out}`);
  await pool.end();
})().catch((err) => {
  console.error('dump_schema failed:', err.message);
  process.exit(1);
});
