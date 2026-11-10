#!/usr/bin/env node
// Proves the database-level safety rules of 001_mt_schema.sql on a NON-production database.
// Everything runs in one transaction that is rolled back: nothing is left behind.
//   node scripts/migrations/motor-test/check_rules.js --db erp_staging

'use strict';
const { Client } = require('pg');
const { connectionConfig } = require('./db');

const db = process.argv[process.argv.indexOf('--db') + 1];
if (!db || db.startsWith('--') || db === 'erp_migrated') { console.error('Use --db <non-production database>'); process.exit(2); }
const D = (c) => 'sha256:' + c.repeat(64);

(async () => {
  const c = new Client(connectionConfig(db));
  await c.connect();
  let pass = 0, fail = 0;
  const q = (sql, p) => c.query(sql, p);
  async function expect(name, shouldFail, sql, params, pattern) {
    await q('SAVEPOINT t');
    try {
      await q(sql, params);
      await q('RELEASE SAVEPOINT t');
      if (shouldFail) { fail++; console.log(`FAIL ${name}: was allowed`); } else { pass++; console.log(`PASS ${name}`); }
    } catch (e) {
      await q('ROLLBACK TO SAVEPOINT t');
      const ok = shouldFail && (!pattern || pattern.test(e.message));
      if (ok) { pass++; console.log(`PASS ${name} (blocked: ${e.message.split('\n')[0].slice(0, 90)})`); }
      else { fail++; console.log(`FAIL ${name}: ${e.message}`); }
    }
  }

  await q('BEGIN');
  try {
    const head = 1, other = 843; // admin creates, a different user approves
    const op = (await q(`INSERT INTO mt_operator (name, created_by) VALUES ('Check Operator', $1) RETURNING operator_ref`, [head])).rows[0].operator_ref;
    const v = (await q(`INSERT INTO mt_motor_variant (product_id, code, created_by) VALUES (2, 'CHECK-VARIANT', $1) RETURNING variant_id`, [head])).rows[0].variant_id;
    const prof = (await q(`INSERT INTO mt_profile_version (variant_id, version, max_rpm, step_rpm, duration_s, sample_hz, created_by)
                           VALUES ($1, 1, 3000, 10, 120, 10, $2) RETURNING profile_id`, [v, head])).rows[0].profile_id;
    const crit = (await q(`INSERT INTO mt_criteria_version (variant_id, version, definition, created_by) VALUES ($1, 1, '{"rules":[]}', $2) RETURNING criteria_version_id`, [v, head])).rows[0].criteria_version_id;
    for (const [t, id, col] of [['mt_profile_version', prof, 'profile_id'], ['mt_criteria_version', crit, 'criteria_version_id']]) {
      await q(`UPDATE ${t} SET status='IN_REVIEW', submitted_at=now() WHERE ${col}=$1`, [id]);
      await q(`UPDATE ${t} SET status='PUBLISHED', sha256=$2, approved_by=$3, published_at=now() WHERE ${col}=$1`, [id, D('a'), other]);
    }

    const run = (id, o) => q(`INSERT INTO mt_test_run (test_id, motor_serial, variant_id, profile_id, criteria_version_id, operator_id, operator_ref, operator_name,
        uploaded_by, vcu_id, vcu_fw_version, vcu_boot_id, hmi_version, final_state, stop_reason, fault_code, outcome, sample_count, stored_sample_count,
        run_digest, samples_digest, run_digest_match)
      VALUES ($1,'CHECK-SN',$2,$3,$4,843,$5,'Check Operator',843,'VCU-01','1.0.3','b1','1.0.0',$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [id, v, prof, crit, op, o.state, o.stop, o.fault ?? null, o.outcome, o.count, o.stored ?? o.count, o.rd ?? D('b'), o.sd ?? D('b'), o.match ?? true]);
    const T1 = '11111111-1111-4111-8111-111111111111';
    console.log('PASS valid COMPLETED PASS run is stored (setup)'); pass++;
    await run(T1, { state: 'COMPLETED', stop: 'RAMP_COMPLETE', outcome: 'PASS', count: 2 });
    await q(`INSERT INTO mt_test_sample VALUES ($1,0,0,0,0,0.12,48.1,NULL,7), ($1,1,100,10,8,1.25,47.5,NULL,7)`, [T1]);
    await q(`INSERT INTO mt_upload_receipt (test_id, payload_hash) VALUES ($1, $2)`, [T1, D('c')]);

    const tryRun = async (name, id, o, pattern) => {
      await q('SAVEPOINT t');
      try { await run(id, o); await q('ROLLBACK TO SAVEPOINT t'); fail++; console.log(`FAIL ${name}: was allowed`); }
      catch (e) { await q('ROLLBACK TO SAVEPOINT t'); if (!pattern || pattern.test(e.message)) { pass++; console.log(`PASS ${name} (blocked: ${e.message.slice(0, 80)})`); } else { fail++; console.log(`FAIL ${name}: ${e.message}`); } }
    };
    await tryRun('PASS with final_state ABORTED is refused', '22222222-2222-4222-8222-222222222222', { state: 'ABORTED', stop: 'OPERATOR_STOP', outcome: 'PASS', count: 2 }, /check constraint/);
    await tryRun('COMPLETED with 0 samples is refused', '33333333-3333-4333-8333-333333333333', { state: 'COMPLETED', stop: 'RAMP_COMPLETE', outcome: 'INCOMPLETE', count: 0 }, /check constraint/);
    await tryRun('PASS without matching digest is refused', '44444444-4444-4444-8444-444444444444', { state: 'COMPLETED', stop: 'RAMP_COMPLETE', outcome: 'PASS', count: 2, match: false }, /check constraint/);
    await tryRun('FAULT without fault_code is refused', '55555555-5555-4555-8555-555555555555', { state: 'FAULT', stop: 'FAULT', outcome: 'INCOMPLETE', count: 0 }, /check constraint/);
    await tryRun('duplicate test_id is refused', T1, { state: 'COMPLETED', stop: 'RAMP_COMPLETE', outcome: 'PASS', count: 2 }, /duplicate key/);
    console.log('PASS zero-sample FAULT INCOMPLETE run is stored (setup)'); pass++;
    await run('66666666-6666-4666-8666-666666666666', { state: 'FAULT', stop: 'FAULT', fault: 'F_OVERCURRENT', outcome: 'INCOMPLETE', count: 0, rd: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', sd: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' });

    await expect('UPDATE of a stored run is refused', true, `UPDATE mt_test_run SET outcome='FAIL' WHERE test_id=$1`, [T1], /MT_IMMUTABLE/);
    await expect('DELETE of a stored run is refused', true, `DELETE FROM mt_test_run WHERE test_id=$1`, [T1], /MT_IMMUTABLE/);
    await expect('DELETE of a reading is refused', true, `DELETE FROM mt_test_sample WHERE test_id=$1`, [T1], /MT_IMMUTABLE/);
    await expect('reading with b1=1 but NULL current is refused', true, `INSERT INTO mt_test_sample VALUES ($1,2,200,20,18,NULL,47.0,NULL,7)`, [T1], /check constraint/);
    await expect('reading with b3=0 but a BEMF number is refused', true, `INSERT INTO mt_test_sample VALUES ($1,2,200,20,18,2.5,47.0,3.1,7)`, [T1], /check constraint/);
    await expect('reserved status_flags bit is refused', true, `INSERT INTO mt_test_sample VALUES ($1,2,200,20,18,2.5,47.0,NULL,263)`, [T1], /check constraint/);
    await expect('identical retry: receipt attempts can increase', false, `UPDATE mt_upload_receipt SET attempts=attempts+1, last_attempt_at=now() WHERE test_id=$1`, [T1]);
    await expect('receipt payload_hash cannot change', true, `UPDATE mt_upload_receipt SET payload_hash=$2 WHERE test_id=$1`, [T1, D('d')], /MT_IMMUTABLE/);
    await expect('published criteria content cannot change', true, `UPDATE mt_criteria_version SET definition='{"rules":[1]}' WHERE criteria_version_id=$1`, [crit], /MT_IMMUTABLE/);
    await expect('second PUBLISHED criteria for the variant is refused', true,
      `INSERT INTO mt_criteria_version (variant_id, version, definition, status, sha256, created_by, approved_by, published_at) VALUES ($1,2,'{}','PUBLISHED',$2,1,843,now())`, [v, D('e')], /ux_mt_criteria_one_published/);
    await expect('approver = author is refused', true,
      `INSERT INTO mt_profile_version (variant_id, version, max_rpm, step_rpm, duration_s, sample_hz, status, sha256, created_by, approved_by, published_at) VALUES ($1,2,3000,10,120,10,'IN_REVIEW',$2,1,1,NULL)`, [v, D('e')], /check constraint/);
    await expect('PUBLISHED -> SUPERSEDED is allowed', false, `UPDATE mt_profile_version SET status='SUPERSEDED', retired_at=now() WHERE profile_id=$1`, [prof]);
    await expect('SUPERSEDED -> PUBLISHED is refused', true, `UPDATE mt_profile_version SET status='PUBLISHED' WHERE profile_id=$1`, [prof], /MT_LIFECYCLE/);
    const corr = (await q(`INSERT INTO mt_correction (test_id, corrected_fields, reason, added_by, added_operator_ref) VALUES ($1,'{"motor_serial":"CHECK-SN2"}','typo',843,$2) RETURNING correction_id`, [T1, op])).rows[0].correction_id;
    await expect('correction approved by the person who added it is refused', true, `UPDATE mt_correction SET status='APPROVED', decided_by=843, decided_at=now() WHERE correction_id=$1`, [corr], /check constraint/);
    await expect('correction approved by testing head', false, `UPDATE mt_correction SET status='APPROVED', decided_by=1, decided_at=now() WHERE correction_id=$1`, [corr]);
    await expect('correction cannot be decided twice', true, `UPDATE mt_correction SET status='REJECTED' WHERE correction_id=$1`, [corr], /MT_IMMUTABLE/);
    await q(`INSERT INTO mt_audit_event (actor_user_id, action, entity, entity_id) VALUES (1,'CHECK','mt_test_run',$1)`, [T1]);
    await expect('audit events cannot be edited', true, `UPDATE mt_audit_event SET action='X' WHERE entity_id=$1`, [T1], /MT_IMMUTABLE/);
  } finally {
    await q('ROLLBACK');
    const left = (await q(`SELECT (SELECT count(*) FROM mt_test_run) + (SELECT count(*) FROM mt_motor_variant) + (SELECT count(*) FROM mt_audit_event) AS n`)).rows[0].n;
    console.log(`rolled back; rows left in mt tables: ${left}`);
    await c.end();
  }
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(1); });
