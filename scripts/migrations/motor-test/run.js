#!/usr/bin/env node
// Applies motor-test SQL migrations (NNN_*.sql in this folder) to ONE named database.
// Each file runs in its own transaction and is recorded in schema_migrations (name + sha256).
// Production needs an explicit flag; take a manual RDS snapshot first (agreed 2026-11-07).
//
//   node scripts/migrations/motor-test/run.js --db erp_staging
//   node scripts/migrations/motor-test/run.js --db erp_migrated --production   (after snapshot + review)
//   add --dry-run to list what would run.

'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Client } = require('pg');
const { connectionConfig } = require('./db');

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const db = arg('--db');
const dryRun = args.includes('--dry-run');
const PRODUCTION_DB = 'erp_migrated';

if (!db) { console.error('Usage: run.js --db <database> [--production] [--dry-run]'); process.exit(2); }
if (db === PRODUCTION_DB && !args.includes('--production')) {
  console.error(`Refusing to touch production (${PRODUCTION_DB}) without --production. Take an RDS snapshot first.`);
  process.exit(2);
}

const files = fs.readdirSync(__dirname).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();

(async () => {
  const client = new Client(connectionConfig(db));
  await client.connect();
  if (dryRun) await client.query('SET default_transaction_read_only = on'); // a dry run never writes
  const { rows: [{ exists }] } = await client.query(`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists`);
  if (!exists && !dryRun) {
    await client.query(`CREATE TABLE schema_migrations (
      name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), applied_by text NOT NULL DEFAULT current_user)`);
  }
  const done = new Map(exists || !dryRun ? (await client.query('SELECT name, sha256 FROM schema_migrations')).rows.map((r) => [r.name, r.sha256]) : []);

  for (const file of files) {
    const sql = fs.readFileSync(path.join(__dirname, file), 'utf8');
    const hash = crypto.createHash('sha256').update(sql).digest('hex');
    const name = `motor-test/${file}`;
    if (done.has(name)) {
      if (done.get(name) !== hash) throw new Error(`${name} was changed after it was applied; add a new migration instead`);
      console.log(`skip    ${name} (already applied)`);
      continue;
    }
    if (dryRun) { console.log(`pending ${name}`); continue; }
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)', [name, hash]);
      await client.query('COMMIT');
      console.log(`applied ${name} to ${db}`);
    } catch (e) {
      await client.query('ROLLBACK');
      throw new Error(`${name} failed and was rolled back: ${e.message}`);
    }
  }
  await client.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
