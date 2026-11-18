// ERP-T11 restore check: fingerprints every motor-test table and re-verifies each stored run's evidence,
// so a restored copy can be compared with its source. READ ONLY (runs in a read-only transaction).
//
//   node scripts/migrations/motor-test/evidence_check.js --db erp_staging [--host <restored-instance-endpoint>] [--out file.json]
//   node scripts/migrations/motor-test/evidence_check.js --compare source.json restored.json
//
// Credentials: DB_USER / DB_PASSWORD (and DB_HOST unless --host) from the repo .env, or the environment
// (e.g. the read-only erp_backup login). TLS is verified (config/rds-global-bundle.pem).
//
// Per table: row count + an order-independent hash of every row (sha256 over the sorted md5 of each row's text).
// Per run: the D13 digest recomputed from the stored samples must equal samples_digest, and the stored sample
// count must equal stored_sample_count. A restore passes when both fingerprints are identical and every run verifies.
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const { Client } = require('pg');
const { connectionConfig } = require('./db');
const { runDigest } = require('../../../services/testing/digest');

const TABLES = ['mt_user_role', 'mt_operator', 'mt_motor_variant', 'mt_profile_version', 'mt_criteria_version', 'mt_test_run',
  'mt_test_sample', 'mt_test_event', 'mt_upload_receipt', 'mt_correction', 'mt_audit_event', 'schema_migrations'];
const PAGE = 5000;

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };

function compare(aPath, bPath) {
  const a = JSON.parse(fs.readFileSync(aPath, 'utf8'));
  const b = JSON.parse(fs.readFileSync(bPath, 'utf8'));
  const problems = [];
  for (const t of new Set([...Object.keys(a.tables), ...Object.keys(b.tables)])) {
    const x = a.tables[t]; const y = b.tables[t];
    if (!x || !y) problems.push(`${t}: missing in ${x ? 'restored' : 'source'}`);
    else if (x.rows !== y.rows || x.hash !== y.hash) problems.push(`${t}: source ${x.rows} rows ${x.hash.slice(0, 12)} / restored ${y.rows} rows ${y.hash.slice(0, 12)}`);
  }
  for (const [n, f] of [['source', a], ['restored', b]]) if (f.runs.failed.length) problems.push(`${n}: ${f.runs.failed.length} run(s) fail evidence verification`);
  console.log(`source   ${a.database}@${a.host} ${a.taken_at}`);
  console.log(`restored ${b.database}@${b.host} ${b.taken_at}`);
  console.log(problems.length ? `RESTORE CHECK FAILED\n- ${problems.join('\n- ')}` : `RESTORE CHECK PASSED: ${Object.keys(a.tables).length} tables identical, ${b.runs.verified} runs verified`);
  process.exit(problems.length ? 1 : 0);
}

async function fingerprint() {
  const db = arg('--db');
  if (!db) throw new Error('usage: --db <name> [--host <endpoint>] [--out file] | --compare a.json b.json');
  const cfg = connectionConfig(db);
  if (arg('--host')) cfg.host = arg('--host');
  const c = new Client(cfg);
  await c.connect();
  try {
    await c.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'); // one consistent snapshot, no writes possible
    const out = { database: db, host: cfg.host, taken_at: new Date().toISOString(), tables: {}, runs: { verified: 0, failed: [] } };
    for (const t of TABLES) {
      const { rows: [r] } = await c.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [t]);
      if (!r.present) continue;
      const { rows: [h] } = await c.query(`SELECT count(*)::bigint AS n, encode(sha256(convert_to(coalesce(string_agg(m, '' ORDER BY m), ''), 'UTF8')), 'hex') AS hash
        FROM (SELECT md5(x::text) AS m FROM ${t} x) s`);
      out.tables[t] = { rows: Number(h.n), hash: h.hash };
    }
    const { rows: runs } = await c.query('SELECT test_id, stored_sample_count, samples_digest FROM mt_test_run ORDER BY test_id');
    for (const run of runs) {
      const samples = [];
      for (let after = -1; ;) {
        const { rows } = await c.query(`SELECT sample_seq, t_ms, rpm_cmd, rpm_actual, current_a, voltage_v, bemf_v, status_flags FROM mt_test_sample
          WHERE test_id = $1 AND sample_seq > $2 ORDER BY sample_seq LIMIT ${PAGE}`, [run.test_id, after]);
        for (const s of rows) samples.push({ sample_seq: Number(s.sample_seq), t_ms: Number(s.t_ms), rpm_cmd: s.rpm_cmd, rpm_actual: s.rpm_actual,
          current_a: s.current_a, voltage_v: s.voltage_v, bemf_v: s.bemf_v, status_flags: s.status_flags });
        if (rows.length < PAGE) break;
        after = Number(rows[rows.length - 1].sample_seq);
      }
      let digest; try { digest = runDigest(samples); } catch (e) { digest = `error: ${e.message}`; }
      if (samples.length !== run.stored_sample_count || digest !== run.samples_digest) {
        out.runs.failed.push({ test_id: run.test_id, stored_sample_count: run.stored_sample_count, samples_found: samples.length, samples_digest: run.samples_digest, recomputed: digest });
      } else out.runs.verified++;
    }
    await c.query('COMMIT');
    out.fingerprint = crypto.createHash('sha256').update(JSON.stringify(out.tables)).digest('hex');
    const file = arg('--out') || `evidence-${db}-${out.taken_at.replace(/[:.]/g, '-')}.json`;
    fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
    for (const [t, v] of Object.entries(out.tables)) console.log(`${t.padEnd(20)} ${String(v.rows).padStart(8)}  ${v.hash.slice(0, 16)}`);
    console.log(`runs verified ${out.runs.verified}, failed ${out.runs.failed.length}; fingerprint ${out.fingerprint.slice(0, 16)}; written ${file}`);
    process.exit(out.runs.failed.length ? 1 : 0);
  } finally { await c.end().catch(() => {}); }
}

if (process.argv.includes('--compare')) compare(arg('--compare'), process.argv[process.argv.indexOf('--compare') + 2]);
else fingerprint().catch((e) => { console.error('FAILED:', e.message); process.exit(2); });
