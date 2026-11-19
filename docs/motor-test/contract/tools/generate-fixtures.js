#!/usr/bin/env node
// Generates every example JSON and hash for the motor-test HMI <-> ERP contract draft,
// so fixtures and hashes can never drift apart. Pure Node, no dependencies.
//
//   node docs/motor-test/contract/tools/generate-fixtures.js
//
// It also re-checks the run-digest vectors (D13) against the values computed
// independently in Python, so the JavaScript rule is proven to match Mayank's.

'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures');
const VEC = path.join(ROOT, 'vectors');

// ---------------------------------------------------------------- hashing rules

const sha256 = (buf) => 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');

// RFC 8785 JSON Canonicalization Scheme: keys sorted by UTF-16 code units,
// ECMAScript number and string serialisation, no whitespace.
function canonicalJson(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number cannot be canonicalised');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

// payload_hash: SHA-256 of the UTF-8 canonical JSON of the whole request body.
const payloadHash = (body) => sha256(Buffer.from(canonicalJson(body), 'utf8'));

// Run digest (D13): 30 bytes per sample, little-endian, ascending sample_seq.
class ContractViolation extends Error {
  constructor(kind, status, code, pathRef, msg) {
    super(msg);
    Object.assign(this, { kind, status, code, path: pathRef });
  }
}
const FLOATS = [['current_a', 1], ['voltage_v', 2], ['bemf_v', 3]];
const QNAN = Buffer.from([0x00, 0x00, 0xc0, 0x7f]);

function sampleRecord(s, i) {
  const flags = s.status_flags;
  if ((flags & 0xff00) !== 0) {
    throw new ContractViolation('reserved_bits', 400, 'VALIDATION_ERROR', `samples[${i}].status_flags`,
      `reserved bits b8-b15 must be 0 (got 0x${flags.toString(16).padStart(4, '0')})`);
  }
  const b = Buffer.alloc(30);
  b.writeUInt32LE(s.sample_seq, 0);
  b.writeUInt32LE(s.t_ms, 4);
  b.writeInt32LE(s.rpm_cmd, 8);
  b.writeInt32LE(s.rpm_actual, 12);
  FLOATS.forEach(([name, bit], k) => {
    const valid = ((flags >> bit) & 1) === 1;
    const v = s[name];
    const off = 16 + 4 * k;
    if (!valid) {
      if (v !== null) throw new ContractViolation('invalid_but_number', 422, 'INCONSISTENT_RUN', `samples[${i}].${name}`,
        `validity bit b${bit} is 0 but a number was sent (must be null)`);
      QNAN.copy(b, off);
    } else {
      if (v === null) throw new ContractViolation('valid_but_null', 422, 'INCONSISTENT_RUN', `samples[${i}].${name}`,
        `validity bit b${bit} is 1 but value is null`);
      b.writeFloatLE(Object.is(v, -0) ? 0 : v, off); // round-to-nearest-even to binary32
      if (b.readUInt32LE(off) === 0x80000000) b.writeUInt32LE(0, off); // -0.0 -> +0.0
    }
  });
  b.writeUInt16LE(flags, 28);
  return b;
}

function runDigest(samples) {
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].sample_seq <= samples[i - 1].sample_seq) {
      throw new ContractViolation('seq_order', 422, 'INCONSISTENT_RUN', `samples[${i}].sample_seq`,
        'samples must be in strictly ascending sample_seq order');
    }
  }
  return sha256(Buffer.concat(samples.map(sampleRecord)));
}

// Shortest decimal that round-trips to the same binary32 value (D13 rule 4).
function f32(x) {
  const target = Math.fround(x);
  for (let p = 1; p <= 9; p++) {
    const s = Number(target.toPrecision(p));
    if (Math.fround(s) === target) return Object.is(s, -0) ? 0 : s;
  }
  return target;
}

// ---------------------------------------------------------------- D13 vectors

const S = (seq, t, cmd, act, i, v, bemf, flags) => ({
  sample_seq: seq, t_ms: t, rpm_cmd: cmd, rpm_actual: act, current_a: i, voltage_v: v, bemf_v: bemf, status_flags: flags,
});
const base = [S(0, 0, 0, 0, 0.0, 48.0, null, 7), S(1, 100, 10, 8, 1.25, 47.5, null, 7), S(2, 200, 20, 18, 2.5, 47.0, null, 7)];

// Expected values computed independently in Python (scratchpad digest_vectors.py, 2026-11-07).
const digestVectors = [
  ['V1', "Mayank's 3-sample example", base, 'sha256:bea7cd5b154a1cba984f059446dcb90521a4f402b066f8c74650f3c00ea00cf6'],
  ['V2', 'zero-sample FAULT/ABORTED run', [], 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['V3', 'negative zero current is normalised (equals V1)', [S(0, 0, 0, 0, -0, 48.0, null, 7), ...base.slice(1)], 'sha256:bea7cd5b154a1cba984f059446dcb90521a4f402b066f8c74650f3c00ea00cf6'],
  ['V4', 'BEMF invalid (b3=0) but a number was sent', [S(0, 0, 0, 0, 0.0, 48.0, 12.5, 7), ...base.slice(1)], { status: 422, code: 'INCONSISTENT_RUN', path: 'samples[0].bemf_v' }],
  ['V5', 'current invalid (b1=0) is encoded as quiet NaN', [S(0, 0, 0, 0, null, 48.0, null, 5)], 'sha256:45f5f293b3a860a955073b0c807c4819ad3fc1559f8be8a51dff5415237350e8'],
  ['V6', 'non-exact decimals, BEMF valid (flags 15)', [S(611, 61100, 1520, 1508, 4.82, 47.9, 3.1, 15)], 'sha256:2fd7e06e4312214d4acd68de6f032aac6ecfd650e1d92bc17e21ab3c844be315'],
  ['V7', 'negative rpm_actual (int32)', [S(0, 0, 0, -3, 0.0, 48.0, null, 7)], 'sha256:7cda0eb89de5a74293773e7a6a76c675c19bc68303c2f052c206a589c162de76'],
  ['V8', 'reserved status_flags bit set', [S(0, 0, 0, 0, 0.0, 48.0, null, 0x0107)], { status: 400, code: 'VALIDATION_ERROR', path: 'samples[0].status_flags' }],
  ['V9', 'validity bit set (b1=1) but value is null', [S(0, 0, 0, 0, null, 48.0, null, 7)], { status: 422, code: 'INCONSISTENT_RUN', path: 'samples[0].current_a' }],
  // v0.4 (agreed with Mayank 2026-11-18): b0 = 0 keeps the raw int32 rpm_actual in the record and the JSON (no null, no
  // sentinel); the digest bytes are unchanged. The app/ERP treat that rpm_actual as unavailable for graphs and criteria.
  // Expected value computed independently in Python (struct, 2026-11-18).
  ['V10', 'rpm invalid (b0=0): raw rpm_actual 1234 kept, digest unchanged; value unavailable for graphs/criteria', [S(0, 0, 0, 1234, 0.0, 48.0, null, 6)], 'sha256:611904ca35e5179b51ba4a8c64e2895dfb4e9c6b71fbe6760eb8b62f3828cd16'],
];

let failures = 0;
const digestOut = digestVectors.map(([id, description, samples, expected]) => {
  let got;
  try {
    got = runDigest(samples);
  } catch (e) {
    if (!(e instanceof ContractViolation)) throw e;
    got = { status: e.status, code: e.code, path: e.path };
  }
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${description}: ${typeof got === 'string' ? got : JSON.stringify(got)}`);
  const vector = { id, description, samples };
  if (typeof expected === 'string') vector.expected_digest = expected;
  else vector.expected_rejection = { ...expected, note: 'Upload rejected before the database transaction; nothing is stored.' };
  if (id === 'V1') vector.expected_bytes_hex = Buffer.concat(samples.map(sampleRecord)).toString('hex');
  return vector;
});
if (failures) {
  console.error(`${failures} run-digest vector(s) disagree with the Python reference; stopping.`);
  process.exit(1);
}

// ---------------------------------------------------------------- example data

const IDS = {
  test: '7b1d3e0a-5c1f-4b7e-9e0e-2a9f2c1d4e55',
  testFault: 'c2a4e6f8-1b3d-4f5a-8c7e-9d0b1a2c3e4f',
  testAborted: '5e8d2c1b-7a6f-4e3d-9b2a-1c0f8e7d6a5b',
  variant: '0f3b6a9c-2d5e-4a8b-b1c4-d7e0f3a6b9c2',
  profile: '9a1c3e5f-7b2d-4f6a-8e0c-2b4d6f8a0c1e',
  criteria: '4d6f8a0c-2e4a-4c6e-a8b0-c2e4a6c8e0b2',
  receipt: 'e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5b',
  receiptFault: 'a7b8c9d0-e1f2-4a3b-9c4d-5e6f7a8b9c0d',
  receiptAborted: 'b3c4d5e6-f7a8-4b9c-8d0e-1f2a3b4c5d6e',
};
const OPERATOR_REF = '6c8e0a2b-4d6f-4a8c-9e0b-2d4f6a8c0e1a';
// operator_id = ERP account that ran the test (shared account for now);
// operator_ref/operator_name = person picked from GET /api/testing/operators (name is a snapshot).
const OPERATOR = { operator_id: 843, operator_ref: OPERATOR_REF, operator_name: 'Example Operator A' }; // shared testing account (real account, created 2026-11-07)

// Profile and criteria definitions (EXAMPLE ONLY). Brief values: 10 rpm steps, 120 s, 10 Hz (proposed).
// max_rpm 3000 is taken from the product label of B-125-M-5D-ES11-E04 and is NOT approved (D4/D9).
const profileDefinition = { variant_id: IDS.variant, version: 1, max_rpm: 3000, step_rpm: 10, duration_s: 120, sample_hz: 10 };
// Criteria values are deliberately null: limits come only from the testing head's signed sheet (D5).
const criteriaDefinition = {
  schema: 1, variant_id: IDS.variant, version: 1,
  units: { current: 'A', voltage: 'V', speed: 'rpm' },
  rules: [
    { id: 'I_MAX', type: 'max', signal: 'current_a', limit: null, filter: { kind: 'none', window_ms: null }, exclude_first_ms: null },
    { id: 'V_SUPPLY', type: 'range', signal: 'voltage_v', min: null, max: null, on_violation: 'INVALID' },
  ],
};
const profileSha = payloadHash(profileDefinition);
const criteriaSha = payloadHash(criteriaDefinition);

// Synthetic 0 -> 120 rpm ramp, 13 samples at 10 Hz (a real run has ~1,200). Values are illustrative.
function rampSamples(n) {
  const out = [];
  for (let k = 0; k < n; k++) {
    out.push({
      sample_seq: k, t_ms: k * 100, rpm_cmd: k * 10, rpm_actual: Math.max(0, k * 10 - 2),
      current_a: f32(0.12 + k * 0.35), voltage_v: f32(48.1 - k * 0.05), bemf_v: null, status_flags: 7,
    });
  }
  return out;
}

function runBody({ testId, finalState, stopReason, faultCode, outcome, reasons, samples, sampleCount, events, endedAt }) {
  const manifestDigest = runDigest(samples.slice(0, sampleCount));
  return {
    test_id: testId,
    motor_serial: 'EXAMPLE-SERIAL-0001',
    variant_id: IDS.variant,
    profile_id: IDS.profile,
    profile_sha256: profileSha,
    criteria_version_id: IDS.criteria,
    criteria_sha256: criteriaSha,
    ...OPERATOR,
    vcu: { vcu_id: 'VCU-01', fw_version: '1.0.3', boot_id: 'b00t-0042' },
    hmi_version: '1.0.0',
    started_at: '2026-12-01T09:14:03Z',
    ended_at: endedAt,
    final_state: finalState,
    stop_reason: stopReason,
    fault_code: faultCode,
    outcome,
    outcome_reasons: reasons,
    sample_count: sampleCount,
    run_digest: manifestDigest,
    events,
    samples,
  };
}

const fullSamples = rampSamples(13);
const valid = runBody({
  testId: IDS.test, finalState: 'COMPLETED', stopReason: 'RAMP_COMPLETE', faultCode: null, outcome: 'PASS', reasons: [],
  samples: fullSamples, sampleCount: 13, endedAt: '2026-12-01T09:16:05Z',
  events: [
    { t_ms: 0, type: 'STATE', code: 'RUNNING', detail: null },
    { t_ms: 1200, type: 'STATE', code: 'STOPPING', detail: 'RAMP_COMPLETE' },
    { t_ms: 1650, type: 'STATE', code: 'COMPLETED', detail: null },
  ],
});

const conflicting = JSON.parse(JSON.stringify(valid));
conflicting.samples[5].current_a = f32(conflicting.samples[5].current_a + 0.1); // same test_id, different data
conflicting.run_digest = runDigest(conflicting.samples);

const zeroFault = runBody({
  testId: IDS.testFault, finalState: 'FAULT', stopReason: 'FAULT', faultCode: 'F_OVERCURRENT', outcome: 'INCOMPLETE',
  reasons: [{ criterion: null, reason: 'FAULT_BEFORE_FIRST_SAMPLE', detail: 'F_OVERCURRENT from CONTROLLER' }],
  samples: [], sampleCount: 0, endedAt: '2026-12-01T09:14:04Z',
  events: [{ t_ms: 0, type: 'STATE', code: 'RUNNING', detail: null }, { t_ms: 40, type: 'FAULT', code: 'F_OVERCURRENT', detail: 'source=CONTROLLER latched=true' }],
});

const aborted = runBody({
  testId: IDS.testAborted, finalState: 'ABORTED', stopReason: 'OPERATOR_STOP', faultCode: null, outcome: 'INCOMPLETE',
  reasons: [{ criterion: null, reason: 'OPERATOR_STOP', detail: 'Stopped by operator at t_ms 700' }],
  samples: rampSamples(8), sampleCount: 8, endedAt: '2026-12-01T09:15:10Z',
  events: [{ t_ms: 0, type: 'STATE', code: 'RUNNING', detail: null }, { t_ms: 700, type: 'STATE', code: 'STOPPING', detail: 'OPERATOR_STOP' }, { t_ms: 900, type: 'STATE', code: 'ABORTED', detail: null }],
});

function receipt(body, receiptId, storedAt) {
  return {
    receipt_id: receiptId,
    test_id: body.test_id,
    stored_sample_count: body.samples.length,
    payload_hash: payloadHash(body),
    samples_digest: runDigest(body.samples),
    run_digest_match: runDigest(body.samples) === body.run_digest,
    stored_at: storedAt,
  };
}
const validReceipt = receipt(valid, IDS.receipt, '2026-12-01T09:16:07Z');

// ---------------------------------------------------------------- write fixtures

const files = {};
const put = (name, obj) => { files[name] = obj; };
const RESULTS = 'POST /api/testing/results';
const headers = (testId) => ({ Authorization: 'Bearer <token>', 'Content-Type': 'application/json', 'X-App-Version': '1.0.0', 'Idempotency-Key': testId });

// Example JWT. The signature is fake on purpose; the ERP signs real tokens with its own secret.
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const exampleToken = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ user_id: 843, role_id: 9, name: 'Testing Bench', iat: 1796116800, exp: 1796160000 })}.EXAMPLE_SIGNATURE_NOT_VALID`;

put('01-login.json', {
  note: 'Existing ERP login. Send X-App-Version on every call to get a 12 h token.',
  request: { method: 'POST', path: '/api/auth/login', headers: { 'Content-Type': 'application/json', 'X-App-Version': '1.0.0' }, body: { email: 'testing@compageauto.com', password: '<password>' } },
  responses: {
    200: { role: 'employee', token: exampleToken, name: 'Testing Bench', user_id: 843 },
    400: { error: 'Email and password are required', code: 'AUTH_MISSING_FIELDS' },
    401: { error: 'Invalid credentials', code: 'AUTH_INVALID_CREDENTIALS' },
    429: { error: 'Too many requests, please wait and try again', code: 'RATE_LIMIT_EXCEEDED' },
  },
  token_notes: 'JWT (HS256). Decoded payload: {user_id, role_id, name, iat, exp}; exp is seconds since 1970-01-01 UTC. Shared account testing@compageauto.com, role employee (approved by Saatwik).',
});

put('02-me.json', {
  note: 'NEW endpoint. Who am I, my testing roles, and when my token expires.',
  request: { method: 'GET', path: '/api/testing/me', headers: { Authorization: 'Bearer <token>', 'X-App-Version': '1.0.0' } },
  responses: { 200: { user_id: 843, name: 'Testing Bench', testing_roles: ['operator'], token_expires_at: '2026-12-01T21:20:00Z' } },
});

put('03-auth-errors.json', {
  note: 'Returned by ANY authenticated endpoint. Only AUTH_INVALID_TOKEN / AUTH_INVALID_USER mean "log in again".',
  responses: {
    '401 no token': { error: 'No token provided', code: 'AUTH_NO_TOKEN' },
    '403 expired or invalid token -> log in again': { error: 'Invalid token', code: 'AUTH_INVALID_TOKEN' },
    '403 account no longer exists -> log in again': { error: 'User not found', code: 'AUTH_INVALID_USER' },
    '403 logged in but no testing role for this action -> NEEDS_REVIEW, do not re-login': { error: 'Your account has no testing permission for this action', code: 'TESTING_ROLE_REQUIRED', required_role: 'operator' },
    '503 auth database unavailable -> retry with backoff': { error: 'The server is temporarily unavailable. Please try again.', code: 'AUTH_UNAVAILABLE' },
  },
});

put('04-variants-list.json', {
  request: { method: 'GET', path: '/api/testing/variants?q=B-125&page=1&page_size=20' },
  responses: { 200: { items: [{ variant_id: IDS.variant, code: 'B-125-M-5D-ES11-E04', name: 'B-125-M-5D-ES11-E04', product_id: 2, active: true, has_published_config: true }], page: 1, page_size: 20, total: 1 } },
});

put('05-variant-detail.json', {
  note: 'EXAMPLE: profile values from the brief are not approved; criteria limits are null until the testing head signs criteria v1 (D5).',
  request: { method: 'GET', path: `/api/testing/variants/${IDS.variant}` },
  responses: {
    200: {
      variant_id: IDS.variant, code: 'B-125-M-5D-ES11-E04', product_id: 2, active: true,
      serial_pattern: null, max_rpm_limit: null,
      profile: { profile_id: IDS.profile, ...profileDefinition, sha256: profileSha, status: 'PUBLISHED', published_at: '2026-12-01T08:00:00Z' },
      criteria: { criteria_version_id: IDS.criteria, version: 1, sha256: criteriaSha, status: 'PUBLISHED', published_at: '2026-12-01T08:00:00Z', definition: criteriaDefinition },
    },
    404: { error: 'Variant not found', code: 'NOT_FOUND' },
    409: { error: 'This variant has no published profile and criteria yet', code: 'NOT_PUBLISHED' },
  },
});

put('06-criteria-snapshot.json', {
  note: 'Any version that was ever published, including SUPERSEDED and WITHDRAWN.',
  request: { method: 'GET', path: `/api/testing/criteria/${IDS.criteria}` },
  responses: { 200: { criteria_version_id: IDS.criteria, variant_id: IDS.variant, version: 1, sha256: criteriaSha, status: 'PUBLISHED', definition: criteriaDefinition }, 404: { error: 'Criteria version not found', code: 'NOT_FOUND' } },
});

put('07-operators.json', {
  note: 'NEW in v0.2. Operator pick-list, maintained in the ERP by the testing head. Show active names on the tablet; send the picked operator_ref and its name with each result. Names are examples.',
  request: { method: 'GET', path: '/api/testing/operators', headers: { Authorization: 'Bearer <token>', 'X-App-Version': '1.0.0' } },
  responses: {
    200: { items: [
      { operator_ref: OPERATOR_REF, name: 'Example Operator A', active: true },
      { operator_ref: '1f3a5c7e-9b0d-4e2f-a4c6-e8a0c2e4a6c8', name: 'Example Operator B', active: true },
    ] },
  },
});

put('10-result-valid-completed.json', {
  note: 'Synthetic 13-sample run (a real run has ~1,200). Expected: 201 Created.',
  request: { method: 'POST', path: '/api/testing/results', headers: headers(IDS.test), body: valid },
  responses: { 201: validReceipt },
});

put('11-result-identical-retry.json', {
  note: 'Exactly the same body again (e.g. the 201 was lost). Any user with the operator role may send it. Expected: 200 with the ORIGINAL receipt, byte-for-byte.',
  request: { method: 'POST', path: '/api/testing/results', headers: headers(IDS.test), body_ref: '10-result-valid-completed.json' },
  responses: { 200: validReceipt },
});

put('12-result-conflict.json', {
  note: 'Same test_id, one reading changed (samples[5].current_a). Expected: 409, original record unchanged, conflict audited. HMI: NEEDS_REVIEW, never ACK_ARCHIVED.',
  request: { method: 'POST', path: '/api/testing/results', headers: headers(IDS.test), body: conflicting },
  responses: { 409: { error: 'A different result was already stored for this test_id', code: 'PAYLOAD_CONFLICT', test_id: IDS.test, existing_payload_hash: validReceipt.payload_hash, received_payload_hash: payloadHash(conflicting) } },
});

put('13-result-zero-sample-fault.json', {
  note: 'FAULT before the first sample. Valid record. Expected: 201; visible in serial lookup with outcome INCOMPLETE.',
  request: { method: 'POST', path: '/api/testing/results', headers: headers(IDS.testFault), body: zeroFault },
  responses: { 201: receipt(zeroFault, IDS.receiptFault, '2026-12-01T09:14:06Z') },
});

put('14-result-aborted-partial.json', {
  note: 'Operator STOP after 8 samples. Expected: 201 with outcome INCOMPLETE.',
  request: { method: 'POST', path: '/api/testing/results', headers: headers(IDS.testAborted), body: aborted },
  responses: { 201: receipt(aborted, IDS.receiptAborted, '2026-12-01T09:15:12Z') },
});

// Error cases: each is a small change to the valid body.
const variantOf = (mutate) => { const b = JSON.parse(JSON.stringify(valid)); mutate(b); return b; };
const errorCases = [
  ['20-error-validation.json', 'Wrong type and a missing field.', variantOf((b) => { b.samples[3].t_ms = 'three hundred'; delete b.hmi_version; }),
    400, { error: 'Request body failed validation', code: 'VALIDATION_ERROR', fields: [{ path: 'hmi_version', msg: 'is required' }, { path: 'samples[3].t_ms', msg: 'must be an integer >= 0' }] }],
  ['21-error-unknown-reference.json', 'criteria_sha256 does not match the stored version.', variantOf((b) => { b.criteria_sha256 = 'sha256:' + '0'.repeat(64); }),
    400, { error: 'Unknown reference or hash mismatch', code: 'UNKNOWN_REFERENCE', fields: [{ path: 'criteria_sha256', msg: 'does not match criteria version ' + IDS.criteria }] }],
  ['31-error-unknown-operator.json', 'operator_ref is not in the operator pick-list (or was inactive when the run started).', variantOf((b) => { b.operator_ref = '00000000-0000-4000-8000-000000000000'; }),
    400, { error: 'Unknown reference or hash mismatch', code: 'UNKNOWN_REFERENCE', fields: [{ path: 'operator_ref', msg: 'is not an active operator in the pick-list' }] }],
  ['22-error-idempotency-key-mismatch.json', 'Idempotency-Key header differs from body test_id.', valid,
    400, { error: 'Idempotency-Key header must equal test_id', code: 'VALIDATION_ERROR', fields: [{ path: 'header:Idempotency-Key', msg: 'must equal body.test_id' }] }, { 'Idempotency-Key': IDS.testFault }],
  ['23-error-pass-not-completed.json', 'PASS with final_state ABORTED.', variantOf((b) => { b.final_state = 'ABORTED'; b.stop_reason = 'OPERATOR_STOP'; }),
    422, { error: 'The run is internally inconsistent', code: 'INCONSISTENT_RUN', violations: [{ path: 'outcome', rule: 'PASS_REQUIRES_COMPLETED', msg: 'PASS/FAIL/INVALID require final_state COMPLETED; ABORTED and FAULT runs must be INCOMPLETE' }] }],
  ['24-error-count-mismatch.json', 'PASS claimed but only 12 of 13 samples uploaded.', variantOf((b) => { b.samples.splice(6, 1); }),
    422, { error: 'The run is internally inconsistent', code: 'INCONSISTENT_RUN', violations: [{ path: 'samples', rule: 'COMPLETE_EVIDENCE_REQUIRED', msg: 'outcome PASS needs samples 0..sample_count-1 with no gaps (got 12 of 13, missing sample_seq 6)' }] }],
  ['25-error-digest-mismatch.json', 'run_digest does not match the uploaded samples for a PASS run.', variantOf((b) => { b.run_digest = 'sha256:' + 'f'.repeat(64); }),
    422, { error: 'The run is internally inconsistent', code: 'INCONSISTENT_RUN', violations: [{ path: 'run_digest', rule: 'DIGEST_MATCH_REQUIRED', msg: 'outcome PASS/FAIL/INVALID needs run_digest equal to the digest of the uploaded samples' }] }],
  ['26-error-validity-flag-number.json', 'Vector V4: bit b3 = 0 but bemf_v is a number.', variantOf((b) => { b.samples[0].bemf_v = 12.5; }),
    422, { error: 'The run is internally inconsistent', code: 'INCONSISTENT_RUN', violations: [{ path: 'samples[0].bemf_v', rule: 'VALIDITY_FLAG_MISMATCH', msg: 'validity bit b3 is 0 but a number was sent (must be null)' }] }],
  ['27-error-validity-flag-null.json', 'Vector V9: bit b1 = 1 but current_a is null.', variantOf((b) => { b.samples[0].current_a = null; }),
    422, { error: 'The run is internally inconsistent', code: 'INCONSISTENT_RUN', violations: [{ path: 'samples[0].current_a', rule: 'VALIDITY_FLAG_MISMATCH', msg: 'validity bit b1 is 1 but value is null' }] }],
  ['28-error-reserved-bits.json', 'Vector V8: reserved status_flags bit set.', variantOf((b) => { b.samples[0].status_flags = 0x0107; }),
    400, { error: 'Request body failed validation', code: 'VALIDATION_ERROR', fields: [{ path: 'samples[0].status_flags', msg: 'reserved bits b8-b15 must be 0 (got 0x0107)' }] }],
  ['29-error-too-large.json', 'Body above the 5 MB limit for this endpoint.', null,
    413, { error: 'Request body is larger than 5 MB', code: 'PAYLOAD_TOO_LARGE' }],
  ['30-error-server.json', 'Database unavailable; nothing was committed. HMI retries with backoff, same body.', null,
    503, { error: 'The server is temporarily unavailable. Please try again.', code: 'SERVER_UNAVAILABLE' }],
];
for (const [name, note, body, status, response, headerOverride] of errorCases) {
  const request = { method: 'POST', path: '/api/testing/results', headers: { ...headers(IDS.test), ...(headerOverride || {}) } };
  if (body) request.body = body;
  put(name, { note: `${note} Nothing is stored.`, request, responses: { [status]: response } });
}

// ---- v0.3: corrections from the tablet (operators never need the web CRM)
const CORRECTION_ID = 'd4e5f6a7-b8c9-4d0e-9f1a-2b3c4d5e6f70';
const correctionBody = { corrected_fields: { motor_serial: 'EXAMPLE-SERIAL-0010' }, reason: 'Serial mistyped at the bench; label reads 0010', operator_ref: OPERATOR_REF };
const correction = {
  correction_id: CORRECTION_ID, test_id: IDS.test, corrected_fields: correctionBody.corrected_fields, reason: correctionBody.reason,
  added_by: 843, added_by_name: 'Testing Bench', added_operator_ref: OPERATOR_REF, added_operator_name: 'Example Operator A',
  added_at: '2026-12-01T10:02:11Z', status: 'PENDING', decided_by: null, decided_by_name: null, decided_at: null, decision_note: null,
};
put('50-correction-add.json', {
  note: 'NEW in v0.3. Operator asks to correct a stored run (only motor_serial, operator_ref or a remark; readings and verdicts never change). The original run stays as it was; the testing head approves or rejects it in the ERP. operator_ref = who is asking (pick-list).',
  request: { method: 'POST', path: `/api/testing/results/${IDS.test}/corrections`, headers: { Authorization: 'Bearer <token>', 'Content-Type': 'application/json', 'X-App-Version': '1.0.0' }, body: correctionBody },
  responses: {
    201: correction,
    400: { error: 'Request failed validation', code: 'VALIDATION_ERROR', fields: [{ path: 'corrected_fields.outcome', msg: 'cannot be corrected (verdicts and readings never change)' }] },
    404: { error: 'Test run not found', code: 'NOT_FOUND' },
  },
});
put('51-corrections-list.json', {
  note: 'NEW in v0.3. Corrections for one run, newest first, with their status (PENDING / APPROVED / REJECTED). An APPROVED motor_serial correction also makes the run findable under the corrected serial.',
  request: { method: 'GET', path: `/api/testing/results/${IDS.test}/corrections`, headers: { Authorization: 'Bearer <token>', 'X-App-Version': '1.0.0' } },
  responses: { 200: { items: [{ ...correction, status: 'APPROVED', decided_by: 12, decided_by_name: 'Testing Head', decided_at: '2026-12-01T11:30:00Z', decision_note: 'Checked against the motor label' }] } },
});

put('40-results-by-serial.json', {
  note: 'Operators may call this too (v0.3), to find the run they want to correct.',
  request: { method: 'GET', path: '/api/testing/results?serial=EXAMPLE-SERIAL-0001' },
  responses: {
    200: {
      motor_serial: 'EXAMPLE-SERIAL-0001',
      runs: [valid, aborted].map((b) => ({
        test_id: b.test_id, started_at: b.started_at, ended_at: b.ended_at, final_state: b.final_state, outcome: b.outcome,
        operator_id: b.operator_id, operator_ref: b.operator_ref, operator_name: b.operator_name, uploaded_by: 843, variant_code: 'B-125-M-5D-ES11-E04',
        profile_version: 1, criteria_version: 1, sample_count: b.sample_count, stored_sample_count: b.samples.length, received_at: '2026-12-01T09:16:07Z',
      })),
    },
  },
});

// ---------------------------------------------------------------- v0.4 (opt-in: contract_version "0.4")
// Spec: receipt-signing.md sections 2-6. Implemented on staging only until the production signing key is set up.
// Signed receipts here use TEST key A from vectors/receipt-vectors.json (seed = SHA-256 of its public label);
// a real server signs with its own key. Every signed fixture must pass the VCU decision (asserted below).

const R = require('./receipt');
const TEST_KEY_A = R.keyFromSeed(crypto.createHash('sha256').update('motor-test receipt TEST key A').digest());
const KEYRING_A = [{ key_id: TEST_KEY_A.keyId.toString('hex'), public_key: R.b64urlEncode(TEST_KEY_A.publicRaw) }];
const V4 = {
  test: '3f6a9c2e-8b1d-4e7a-9c5f-0a2b4c6d8e10', receipt: 'c9e1a3b5-d7f2-4c4e-8a6b-0d2f4b6c8e55',
  testCancel: '8d2f4a6c-0e1b-4c3d-a5e7-9f1b3d5c7e92', receiptCancel: '2b4d6f8a-0c1e-4e3a-b5c7-d9e1f3a5b766',
  testLoss: '1a3c5e7f-9b2d-4f6a-8c0e-2b4d6f8a1c33', receiptLoss: '9f1b3d5c-7e2a-4b4c-8d6e-0f2a4c6e8a77',
  testPower: '6e8a0c2d-4f1b-4a3c-9e5d-7f9b1d3e5a44', receiptPower: '4a6c8e0b-2d3f-4f5a-9b7c-1e3a5c7e9b88',
};
const STAGING = 'https://api.intute.biz/staging';
const stagingHeaders = (testId) => ({ ...headers(testId), 'X-Staging-Key': '<staging key>' });

function runBodyV04({ testId, started = true, startUptimeMs = 812345, startedAt = '2026-12-01T09:14:03Z', startedAtSource = 'HMI',
  endedAt, endedAtSource = 'HMI', finalState, stopReason, faultCode, outcome, reasons, samples, sampleCount, heldCount,
  recordingComplete, events }) {
  return {
    contract_version: '0.4',
    test_id: testId,
    motor_serial: 'EXAMPLE-SERIAL-0001',
    variant_id: IDS.variant,
    profile_id: IDS.profile,
    profile_sha256: profileSha,
    criteria_version_id: IDS.criteria,
    criteria_sha256: criteriaSha,
    ...OPERATOR,
    vcu: { vcu_id: 'esp32c3-001122334455', fw_version: '1.0.3', origin_boot_id: '1122334455667788' },
    hmi_version: '1.1.0',
    run_kind: 'bench',
    started,
    start_uptime_ms: started ? startUptimeMs : null,
    started_at: startedAt,
    started_at_source: startedAt === null ? null : startedAtSource,
    ended_at: endedAt,
    ended_at_source: endedAt === null ? null : endedAtSource,
    hmi_auto_time: true,
    final_state: finalState,
    stop_reason: stopReason,
    fault_code: faultCode,
    outcome,
    outcome_reasons: reasons,
    sample_count: sampleCount,
    held_count: heldCount,
    recording_complete: recordingComplete,
    config_hash: payloadHash(profileDefinition), // example: the CONFIG hash the VCU reported in CONFIG_ACK
    run_digest: runDigest(samples.slice(0, heldCount)), // D13 over the held samples 0..held_count-1
    events,
    samples,
  };
}

// The VCU's own durable record of the run (what decide() compares the signed message with).
const vcuManifestOf = (b) => ({
  test_id: b.test_id, vcu_id: b.vcu.vcu_id, origin_boot_id: b.vcu.origin_boot_id, started: b.started,
  recording_complete: b.recording_complete, final_state: b.final_state, stop_reason: b.stop_reason,
  sample_count: b.sample_count, held_count: b.held_count, run_digest: b.run_digest,
});

function receiptV04(body, receiptId, storedAt) {
  const r = receipt(body, receiptId, storedAt);
  const message = R.encodeMessage({
    key_id: TEST_KEY_A.keyId, test_id: r.test_id, receipt_id: r.receipt_id, stored_at: r.stored_at,
    sample_count: body.sample_count, held_count: body.held_count, stored_sample_count: r.stored_sample_count,
    final_state: body.final_state, outcome: body.outcome, stop_reason: body.stop_reason,
    started: body.started, recording_complete: body.recording_complete,
    run_digest: body.run_digest, samples_digest: r.samples_digest, payload_hash: r.payload_hash,
    vcu_id: body.vcu.vcu_id, origin_boot_id: body.vcu.origin_boot_id,
  });
  r.signed_receipt = {
    alg: 'Ed25519', key_id: TEST_KEY_A.keyId.toString('hex'),
    message: R.b64urlEncode(message), signature: R.b64urlEncode(R.signMessage(message, TEST_KEY_A.privateKey)),
  };
  const got = R.decide(r.signed_receipt, KEYRING_A, vcuManifestOf(body));
  if (!got.release) throw new Error(`v0.4 fixture ${body.test_id}: signed receipt fails the VCU decision (${got.reason})`);
  console.log(`PASS v0.4 signed receipt ${body.test_id}: ${got.reason}`);
  return r;
}

const signingNote = 'signed_receipt is signed with TEST key A from vectors/receipt-vectors.json (public seed; never on a real VCU). '
  + 'A real server signs with its own key, so key_id and signature differ; signed_receipt is null when the server has no signing key configured.';
const verifyWith = (body) => ({ vcu_keyring: KEYRING_A, vcu_manifest: vcuManifestOf(body), expected_decision: 'RELEASE' });

const v4Valid = runBodyV04({
  testId: V4.test, endedAt: '2026-12-01T09:16:05Z', finalState: 'COMPLETED', stopReason: 'RAMP_COMPLETE', faultCode: null,
  outcome: 'PASS', reasons: [], samples: rampSamples(13), sampleCount: 13, heldCount: 13, recordingComplete: true,
  events: valid.events,
});
const v4ValidReceipt = receiptV04(v4Valid, V4.receipt, '2026-12-01T09:16:07Z');

const v4Cancel = runBodyV04({
  testId: V4.testCancel, started: false, startedAt: null, endedAt: '2026-12-01T09:20:11Z',
  finalState: 'ABORTED', stopReason: 'CONFIG_CANCELLED', faultCode: null, outcome: 'INCOMPLETE',
  reasons: [{ criterion: null, reason: 'CONFIG_CANCELLED', detail: 'Cancelled by operator before START' }],
  samples: [], sampleCount: 0, heldCount: 0, recordingComplete: true,
  events: [{ t_ms: 0, type: 'STATE', code: 'ABORTED', detail: 'CONFIG_CANCELLED' }],
});

const v4Loss = runBodyV04({
  testId: V4.testLoss, startedAtSource: 'HMI_DERIVED', endedAt: '2026-12-01T09:14:04Z', endedAtSource: 'HMI_DERIVED',
  finalState: 'FAULT', stopReason: 'FAULT', faultCode: 'SAMPLE_LOSS', outcome: 'INCOMPLETE',
  reasons: [{ criterion: null, reason: 'SAMPLE_LOSS', detail: 'VCU detected recording loss at sample_seq 3; holds 3 of 5' }],
  samples: rampSamples(3), sampleCount: 5, heldCount: 3, recordingComplete: false,
  events: [{ t_ms: 0, type: 'STATE', code: 'RUNNING', detail: null }, { t_ms: 400, type: 'FAULT', code: 'SAMPLE_LOSS', detail: null }],
});

// Power loss: the VCU rebooted, so ended_at could not be stamped or derived (UTC unknown -> null, source null).
const v4Power = runBodyV04({
  testId: V4.testPower, endedAt: null, finalState: 'FAULT', stopReason: 'POWER_LOSS', faultCode: 'POWER_LOSS', outcome: 'INCOMPLETE',
  reasons: [{ criterion: null, reason: 'POWER_LOSS', detail: 'Evidenced power interruption during the run; holds 6 of 7' }],
  samples: rampSamples(6), sampleCount: 7, heldCount: 6, recordingComplete: false,
  events: [{ t_ms: 0, type: 'STATE', code: 'RUNNING', detail: null }],
});

put('60-v04-result-valid-completed.json', {
  note: `v0.4 (staging only). Complete COMPLETED/PASS run, recording_complete=true, held_count = sample_count = 13. Expected: 201 with signed_receipt; an identical retry gets 200 with the byte-identical receipt (signature included). ${signingNote}`,
  server: STAGING,
  request: { method: 'POST', path: '/api/testing/results', headers: stagingHeaders(V4.test), body: v4Valid },
  responses: { 201: v4ValidReceipt, 200: v4ValidReceipt },
  verify: verifyWith(v4Valid),
});
put('61-v04-result-cancel.json', {
  note: `v0.4 CANCEL before start: started=false, zero samples, ABORTED/CONFIG_CANCELLED/INCOMPLETE, recording_complete=true, start_uptime_ms and started_at null. Never counted as an executed motor test. Expected: 201. ${signingNote}`,
  server: STAGING,
  request: { method: 'POST', path: '/api/testing/results', headers: stagingHeaders(V4.testCancel), body: v4Cancel },
  responses: { 201: receiptV04(v4Cancel, V4.receiptCancel, '2026-12-01T09:20:13Z') },
  verify: verifyWith(v4Cancel),
});
put('62-v04-result-known-loss.json', {
  note: `v0.4 recording already incomplete at the VCU: FAULT/FAULT, fault_code SAMPLE_LOSS, held_count 3 of sample_count 5, recording_complete=false; the ERP stores all 3 held samples (run_digest covers samples 0..2). Times derived from VCU uptime (HMI_DERIVED). Expected: 201, INCOMPLETE; the VCU may release. ${signingNote}`,
  server: STAGING,
  request: { method: 'POST', path: '/api/testing/results', headers: stagingHeaders(V4.testLoss), body: v4Loss },
  responses: { 201: receiptV04(v4Loss, V4.receiptLoss, '2026-12-01T09:14:08Z') },
  verify: verifyWith(v4Loss),
});
put('63-v04-result-power-loss.json', {
  note: `v0.4 evidenced power interruption: FAULT/POWER_LOSS, held_count 6 of sample_count 7, recording_complete=false, ended_at unknown (null, source null). Expected: 201, INCOMPLETE. ${signingNote}`,
  server: STAGING,
  request: { method: 'POST', path: '/api/testing/results', headers: stagingHeaders(V4.testPower), body: v4Power },
  responses: { 201: receiptV04(v4Power, V4.receiptPower, '2026-12-01T09:31:40Z') },
  verify: verifyWith(v4Power),
});

const v4VariantOf = (mutate) => { const b = JSON.parse(JSON.stringify(v4Valid)); mutate(b); return b; };
const v4ErrorCases = [
  ['64-v04-error-run-kind-not-allowed.json', 'v0.4 run_kind host_simulation sent to PRODUCTION (production accepts only bench; staging accepts bench, host_simulation and synthetic).',
    'https://api.intute.biz', v4VariantOf((b) => { b.run_kind = 'host_simulation'; }),
    422, { error: 'run_kind host_simulation is not accepted on this server', code: 'RUN_KIND_NOT_ALLOWED' }],
  ['65-v04-error-completed-hb-loss.json', 'v0.4 final_state COMPLETED with stop_reason HB_LOSS (lifecycle table).', STAGING,
    v4VariantOf((b) => { b.stop_reason = 'HB_LOSS'; }),
    422, { error: 'The run is internally inconsistent', code: 'INCONSISTENT_RUN', violations: [{ path: 'stop_reason', rule: 'LIFECYCLE_STOP_REASON', msg: 'final_state COMPLETED permits stop_reason RAMP_COMPLETE only (got HB_LOSS)' }] }],
  ['66-v04-error-pass-not-recording-complete.json', 'v0.4 outcome PASS with recording_complete=false (equal counts never imply completeness).', STAGING,
    v4VariantOf((b) => { b.recording_complete = false; }),
    422, { error: 'The run is internally inconsistent', code: 'INCONSISTENT_RUN', violations: [{ path: 'recording_complete', rule: 'RECORDING_COMPLETE_REQUIRED', msg: 'outcome PASS/FAIL/INVALID needs recording_complete=true' }] }],
  ['67-v04-error-boot-id.json', 'v0.4 body still sends vcu.boot_id (renamed to vcu.origin_boot_id in v0.4).', STAGING,
    v4VariantOf((b) => { b.vcu = { vcu_id: b.vcu.vcu_id, fw_version: b.vcu.fw_version, boot_id: b.vcu.origin_boot_id }; }),
    400, { error: 'Request body failed validation', code: 'VALIDATION_ERROR', fields: [{ path: 'vcu.boot_id', msg: 'is not allowed in contract_version 0.4 (use vcu.origin_boot_id)' }, { path: 'vcu.origin_boot_id', msg: 'is required' }] }],
];
for (const [name, note, server, body, status, response] of v4ErrorCases) {
  const h = server === STAGING ? stagingHeaders(body.test_id) : headers(body.test_id);
  put(name, { note: `${note} Nothing is stored; no signed_receipt on any error.`, server, request: { method: 'POST', path: '/api/testing/results', headers: h, body }, responses: { [status]: response } });
}
// The lifecycle table also applies to v0.3 uploads (no contract_version): ABORTED + POWER_LOSS is now rejected.
const abortedPowerLoss = JSON.parse(JSON.stringify(aborted));
abortedPowerLoss.stop_reason = 'POWER_LOSS';
put('68-error-v03-aborted-power-loss.json', {
  note: 'v0.3 body (no contract_version, the deployed app format): final_state ABORTED with stop_reason POWER_LOSS. Accepted before v0.4; now rejected because the lifecycle table applies to all uploads (power loss is FAULT/POWER_LOSS). Nothing is stored.',
  request: { method: 'POST', path: '/api/testing/results', headers: headers(IDS.testAborted), body: abortedPowerLoss },
  responses: { 422: { error: 'The run is internally inconsistent', code: 'INCONSISTENT_RUN', violations: [{ path: 'stop_reason', rule: 'LIFECYCLE_STOP_REASON', msg: 'final_state ABORTED permits stop_reason OPERATOR_STOP, HB_LOSS or CONFIG_CANCELLED (got POWER_LOSS)' }] } },
});

fs.mkdirSync(FIX, { recursive: true });
fs.mkdirSync(VEC, { recursive: true });
for (const [name, obj] of Object.entries(files)) fs.writeFileSync(path.join(FIX, name), JSON.stringify(obj, null, 2) + '\n');

fs.writeFileSync(path.join(VEC, 'run-digest-vectors.json'), JSON.stringify({
  rule: 'D13 (Proposed, ready for joint review): SHA-256 over 30-byte little-endian records in ascending sample_seq: u32 sample_seq, u32 t_ms, i32 rpm_cmd, i32 rpm_actual, f32 current_a, f32 voltage_v, f32 bemf_v, u16 status_flags. Invalid float (bit b1/b2/b3 = 0) = quiet NaN 00 00 C0 7F and must be null in JSON. -0.0 -> +0.0. Reserved bits b8-b15 must be 0. Digest string "sha256:" + 64 lowercase hex.',
  vectors: digestOut,
}, null, 2) + '\n');

// Payload-hash vectors.
const reordered = Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(valid))).reverse());
const payloadVectors = [
  { id: 'P1', description: 'valid completed run (fixture 10)', body_ref: '10-result-valid-completed.json', canonical_json_sha256_of: 'whole request body', expected_payload_hash: payloadHash(valid) },
  { id: 'P2', description: 'same body, top-level keys in another order and pretty-printed: hash must equal P1', body: reordered, expected_payload_hash: payloadHash(reordered) },
  { id: 'P3', description: 'one reading changed (fixture 12): hash must differ from P1', body_ref: '12-result-conflict.json', expected_payload_hash: payloadHash(conflicting) },
  { id: 'P4', description: 'zero-sample fault (fixture 13)', body_ref: '13-result-zero-sample-fault.json', expected_payload_hash: payloadHash(zeroFault) },
  { id: 'P5', description: 'canonical JSON of a tiny object, to check the serialiser itself', body: { b: [1, 2.5, -0, 'xé'], a: null, c: { z: true, y: 1e21 } }, expected_canonical_json: canonicalJson({ b: [1, 2.5, -0, 'xé'], a: null, c: { z: true, y: 1e21 } }), expected_payload_hash: payloadHash({ b: [1, 2.5, -0, 'xé'], a: null, c: { z: true, y: 1e21 } }) },
];
if (payloadVectors[1].expected_payload_hash !== payloadVectors[0].expected_payload_hash) throw new Error('P2 must equal P1');
if (payloadVectors[2].expected_payload_hash === payloadVectors[0].expected_payload_hash) throw new Error('P3 must differ from P1');
fs.writeFileSync(path.join(VEC, 'payload-hash-vectors.json'), JSON.stringify({
  rule: 'payload_hash = "sha256:" + lowercase hex SHA-256 of the UTF-8 bytes of the RFC 8785 (JCS) canonical JSON of the whole request body. The uploader (from the token) and HTTP headers are not part of it.',
  vectors: payloadVectors,
}, null, 2) + '\n');

fs.writeFileSync(path.join(VEC, 'profile-criteria-hash-vectors.json'), JSON.stringify({
  rule: 'profile sha256 and criteria sha256 = "sha256:" + SHA-256 of the JCS canonical JSON of the definition object, frozen at publish. VCU recomputes the profile hash from CONFIG.',
  profile: { definition: profileDefinition, expected_sha256: profileSha },
  criteria: { definition: criteriaDefinition, expected_sha256: criteriaSha },
}, null, 2) + '\n');

console.log(`wrote ${Object.keys(files).length} fixtures and 3 vector files`);
console.log('valid run payload_hash:', validReceipt.payload_hash);
