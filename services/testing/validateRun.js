// Validation for POST /api/testing/results.
//  checkSchema(body)      -> [] or [{path, msg}]            (400 VALIDATION_ERROR)
//  checkConsistency(body) -> {violations, samplesDigest}    (422 INCONSISTENT_RUN; reserved bits -> 400)
'use strict';
const { runDigest, ContractViolation } = require('./digest');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_ANY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
// Milliseconds at most, so the validator and PostgreSQL compare timestamps at the same precision.
const ISO_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?Z$/;
const U32 = 4294967295;
const I32 = 2147483647;
// eslint-disable-next-line no-control-regex -- matching NUL is the point: PostgreSQL text cannot store it
const BAD_CHARS = /[\u0000]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/; // NUL, lone surrogates (PostgreSQL refuses them)

const FINAL_STATES = ['COMPLETED', 'ABORTED', 'FAULT'];
const STOP_REASONS = ['RAMP_COMPLETE', 'OPERATOR_STOP', 'HB_LOSS', 'FAULT', 'POWER_LOSS'];
const OUTCOMES = ['PASS', 'FAIL', 'INCOMPLETE', 'INVALID'];
const EVENT_TYPES = ['STATE', 'FAULT', 'COMMAND', 'INFO'];
const TOP_FIELDS = ['test_id', 'motor_serial', 'variant_id', 'profile_id', 'profile_sha256', 'criteria_version_id', 'criteria_sha256',
  'operator_id', 'operator_ref', 'operator_name', 'vcu', 'hmi_version', 'started_at', 'ended_at', 'final_state', 'stop_reason',
  'fault_code', 'outcome', 'outcome_reasons', 'sample_count', 'run_digest', 'events', 'samples'];
const SAMPLE_FIELDS = ['sample_seq', 't_ms', 'rpm_cmd', 'rpm_actual', 'current_a', 'voltage_v', 'bemf_v', 'status_flags'];
const MAX_SAMPLES = 40000; // fits the 5 MB body limit (~110 bytes per sample); a 120 s run at 10 Hz is ~1,200

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const isStr = (v, min = 1, max = 200) => typeof v === 'string' && v.length >= min && v.length <= max && !BAD_CHARS.test(v);
// Real calendar dates only (Date.parse would roll 2026-02-30 over to March), year >= 1.
function validDate(v) {
  const m = ISO_UTC.exec(v);
  if (!m) return false;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  if (y < 1 || h > 23 || mi > 59 || s > 59) return false;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}
// A float32 reading: finite, not overflowing and not underflowing to zero (PostgreSQL `real` refuses both).
function isFloat32(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  const f = Math.fround(v);
  return Number.isFinite(f) && !(f === 0 && v !== 0);
}
// outcome_reasons entries: plain JSON, depth <= 4, <= 2 kB each, no NUL / lone surrogates, finite numbers.
function safeJson(v, depth = 0) {
  if (depth > 4) return false;
  if (v === null || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') return v.length <= 1000 && !BAD_CHARS.test(v);
  if (Array.isArray(v)) return v.length <= 200 && v.every((x) => safeJson(x, depth + 1));
  if (isObj(v)) return Object.keys(v).length <= 50 && Object.entries(v).every(([k, x]) => !BAD_CHARS.test(k) && safeJson(x, depth + 1));
  return false;
}

function checkSchema(b) {
  const f = [];
  const add = (path, msg) => f.push({ path, msg });
  if (!isObj(b)) return [{ path: '', msg: 'body must be a JSON object' }];

  for (const k of Object.keys(b)) if (!TOP_FIELDS.includes(k)) add(k, 'is not an allowed field');
  for (const k of TOP_FIELDS) if (!(k in b)) add(k, 'is required');

  const need = (k, ok, msg) => { if (k in b && !ok(b[k])) add(k, msg); };
  need('test_id', (v) => typeof v === 'string' && UUID_V4.test(v), 'must be a lowercase UUID v4');
  need('motor_serial', (v) => isStr(v, 1, 64) && v.trim() === v, 'must be 1-64 characters without leading/trailing spaces');
  for (const k of ['variant_id', 'profile_id', 'criteria_version_id', 'operator_ref']) need(k, (v) => typeof v === 'string' && UUID_ANY.test(v), 'must be a lowercase UUID');
  for (const k of ['profile_sha256', 'criteria_sha256', 'run_digest']) need(k, (v) => typeof v === 'string' && DIGEST.test(v), 'must be "sha256:" + 64 lowercase hex');
  need('operator_id', (v) => isInt(v, 1, I32), 'must be a positive integer');
  need('operator_name', (v) => isStr(v, 1, 100) && v.trim().length > 0, 'must be 1-100 characters');
  need('hmi_version', (v) => isStr(v, 1, 50), 'must be 1-50 characters');
  for (const k of ['started_at', 'ended_at']) need(k, (v) => v === null || (typeof v === 'string' && validDate(v)), 'must be null or ISO 8601 UTC like 2026-12-01T09:14:03Z');
  need('final_state', (v) => FINAL_STATES.includes(v), `must be one of ${FINAL_STATES.join(', ')}`);
  need('stop_reason', (v) => STOP_REASONS.includes(v), `must be one of ${STOP_REASONS.join(', ')}`);
  need('fault_code', (v) => v === null || isStr(v, 1, 64), 'must be null or 1-64 characters');
  need('outcome', (v) => OUTCOMES.includes(v), `must be one of ${OUTCOMES.join(', ')}`);
  need('outcome_reasons', (v) => Array.isArray(v) && v.length <= 200 && v.every((x) => isObj(x) && safeJson(x) && JSON.stringify(x).length <= 2000),
    'must be an array (max 200) of small objects (max depth 4, 2 kB each, finite numbers, no NUL characters)');
  need('sample_count', (v) => isInt(v, 0, I32), 'must be an integer 0..2147483647');

  if ('vcu' in b) {
    if (!isObj(b.vcu)) add('vcu', 'must be an object');
    else {
      for (const k of Object.keys(b.vcu)) if (!['vcu_id', 'fw_version', 'boot_id'].includes(k)) add(`vcu.${k}`, 'is not an allowed field');
      for (const k of ['vcu_id', 'fw_version', 'boot_id']) if (!isStr(b.vcu[k], 1, 64)) add(`vcu.${k}`, 'is required, 1-64 characters');
    }
  }

  if ('events' in b) {
    if (!Array.isArray(b.events) || b.events.length > 10000) add('events', 'must be an array (max 10000)');
    else b.events.forEach((e, i) => {
      if (!isObj(e)) return add(`events[${i}]`, 'must be an object');
      if (!isInt(e.t_ms, 0, U32)) add(`events[${i}].t_ms`, 'must be an integer >= 0');
      if (!EVENT_TYPES.includes(e.type)) add(`events[${i}].type`, `must be one of ${EVENT_TYPES.join(', ')}`);
      if (!isStr(e.code, 1, 64)) add(`events[${i}].code`, 'must be 1-64 characters');
      if (e.detail !== undefined && e.detail !== null && !isStr(e.detail, 0, 1000)) add(`events[${i}].detail`, 'must be null or text up to 1000 characters');
    });
  }

  if ('samples' in b) {
    if (!Array.isArray(b.samples) || b.samples.length > MAX_SAMPLES) add('samples', `must be an array (max ${MAX_SAMPLES})`);
    else b.samples.forEach((s, i) => {
      const p = `samples[${i}]`;
      if (!isObj(s)) return add(p, 'must be an object');
      for (const k of Object.keys(s)) if (!SAMPLE_FIELDS.includes(k)) add(`${p}.${k}`, 'is not an allowed field');
      if (!isInt(s.sample_seq, 0, U32)) add(`${p}.sample_seq`, 'must be an integer 0..4294967295');
      if (!isInt(s.t_ms, 0, U32)) add(`${p}.t_ms`, 'must be an integer >= 0');
      if (!isInt(s.rpm_cmd, -I32 - 1, I32)) add(`${p}.rpm_cmd`, 'must be a 32-bit integer');
      if (!isInt(s.rpm_actual, -I32 - 1, I32)) add(`${p}.rpm_actual`, 'must be a 32-bit integer');
      for (const k of ['current_a', 'voltage_v', 'bemf_v']) {
        if (!(k in s)) add(`${p}.${k}`, 'is required (null when invalid)');
        else if (s[k] !== null && !isFloat32(s[k])) add(`${p}.${k}`, 'must be null or a float32 number (finite, not too large, not too close to zero)');
      }
      if (!Number.isInteger(s.status_flags) || s.status_flags < 0 || s.status_flags > 0xffff) add(`${p}.status_flags`, 'must be an integer');
      else if (s.status_flags > 255) add(`${p}.status_flags`, `reserved bits b8-b15 must be 0 (got 0x${s.status_flags.toString(16).padStart(4, '0')})`);
    });
  }
  return f;
}

// Assumes checkSchema passed.
function checkConsistency(b) {
  const v = [];
  const add = (path, rule, msg) => v.push({ path, rule, msg });
  const verdict = b.outcome !== 'INCOMPLETE';

  if (b.final_state !== 'COMPLETED' && verdict) add('outcome', 'PASS_REQUIRES_COMPLETED', 'PASS/FAIL/INVALID require final_state COMPLETED; ABORTED and FAULT runs must be INCOMPLETE');
  if (b.final_state === 'COMPLETED' && b.sample_count === 0) add('sample_count', 'COMPLETED_NEEDS_SAMPLES', 'a COMPLETED run must have sample_count > 0');
  if (b.final_state === 'FAULT' && !b.fault_code) add('fault_code', 'FAULT_CODE_REQUIRED', 'fault_code is required when final_state is FAULT');
  if (b.started_at && b.ended_at && Date.parse(b.ended_at) < Date.parse(b.started_at)) add('ended_at', 'TIME_ORDER', 'ended_at is before started_at'); // both ms precision
  if (b.samples.length > b.sample_count) add('samples', 'TOO_MANY_SAMPLES', `${b.samples.length} samples uploaded but sample_count is ${b.sample_count}`);
  b.samples.forEach((s, i) => { if (s.sample_seq >= b.sample_count) add(`samples[${i}].sample_seq`, 'SEQ_OUT_OF_RANGE', `sample_seq ${s.sample_seq} is not below sample_count ${b.sample_count}`); });

  let samplesDigest = null;
  try {
    samplesDigest = runDigest(b.samples);
  } catch (e) {
    if (!(e instanceof ContractViolation)) throw e;
    if (e.status === 400) return { badRequest: [{ path: e.path, msg: e.message }] };
    add(e.path, e.rule, e.message);
  }

  if (verdict && samplesDigest) {
    if (b.samples.length !== b.sample_count) {
      const have = new Set(b.samples.map((s) => s.sample_seq));
      const missing = [];
      for (let k = 0; k < b.sample_count && missing.length < 5; k++) if (!have.has(k)) missing.push(k);
      add('samples', 'COMPLETE_EVIDENCE_REQUIRED', `outcome ${b.outcome} needs samples 0..sample_count-1 with no gaps (got ${b.samples.length} of ${b.sample_count}${missing.length ? `, missing sample_seq ${missing.join(', ')}` : ''})`);
    } else if (samplesDigest !== b.run_digest) {
      add('run_digest', 'DIGEST_MATCH_REQUIRED', 'outcome PASS/FAIL/INVALID needs run_digest equal to the digest of the uploaded samples');
    }
  }
  return { violations: v, samplesDigest };
}

module.exports = { checkSchema, checkConsistency, MAX_SAMPLES };
