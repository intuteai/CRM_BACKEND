// Every contract fixture must get exactly its documented answer from the validation layer
// (the reference checks needing the database are covered in testing_api.test.js). Pure, no database.
const path = require('path');
const fs = require('fs');
const { checkSchema, checkConsistency } = require('../services/testing/validateRun');

const FIX = path.join(__dirname, '..', 'docs', 'motor-test', 'contract', 'fixtures');
const load = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
const body = (f) => { const x = load(f); return x.request.body || load(x.request.body_ref).request.body; };

// Mirrors the order in the controller: schema -> (reserved bits) -> consistency.
function judge(b) {
  const fields = checkSchema(b);
  if (fields.length) return { status: 400, code: 'VALIDATION_ERROR', fields };
  const c = checkConsistency(b);
  if (c.badRequest) return { status: 400, code: 'VALIDATION_ERROR', fields: c.badRequest };
  if (c.violations.length) return { status: 422, code: 'INCONSISTENT_RUN', violations: c.violations };
  return { status: 'ok', samplesDigest: c.samplesDigest };
}

describe('valid fixtures pass validation', () => {
  it.each(['10-result-valid-completed.json', '12-result-conflict.json', '13-result-zero-sample-fault.json', '14-result-aborted-partial.json'])('%s', (f) => {
    const r = judge(body(f));
    expect(r.status).toBe('ok');
  });

  it('a valid completed run digest equals its run_digest; the zero-sample digest is SHA-256 of nothing', () => {
    const v = body('10-result-valid-completed.json');
    expect(judge(v).samplesDigest).toBe(v.run_digest);
    expect(judge(body('13-result-zero-sample-fault.json')).samplesDigest).toBe('sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('error fixtures get their documented status, code and path', () => {
  const cases = fs.readdirSync(FIX).filter((f) => /^2\d-error|^3\d-error/.test(f))
    .filter((f) => !['21-error-unknown-reference.json', '31-error-unknown-operator.json', '22-error-idempotency-key-mismatch.json',
      '29-error-too-large.json', '30-error-server.json'].includes(f)); // database / transport cases: see testing_api.test.js
  it.each(cases)('%s', (f) => {
    const fx = load(f);
    const [status, expected] = Object.entries(fx.responses)[0];
    const r = judge(fx.request.body);
    expect(r.status).toBe(Number(status));
    expect(r.code).toBe(expected.code);
    const want = (expected.fields || expected.violations).map((x) => x.path).sort();
    const got = (r.fields || r.violations).map((x) => x.path).sort();
    expect(got).toEqual(want);
  });
});

describe('schema edge cases', () => {
  const v = () => JSON.parse(JSON.stringify(body('10-result-valid-completed.json')));
  it('refuses unknown top-level and sample fields', () => {
    const b = v(); b.extra = 1; b.samples[0].foo = 2;
    expect(checkSchema(b).map((x) => x.path)).toEqual(expect.arrayContaining(['extra', 'samples[0].foo']));
  });
  it('refuses a non-v4 test_id and a non-UTC timestamp', () => {
    const b = v(); b.test_id = '7b1d3e0a-5c1f-1b7e-9e0e-2a9f2c1d4e55'; b.started_at = '2026-12-01 09:14:03';
    expect(checkSchema(b).map((x) => x.path)).toEqual(expect.arrayContaining(['test_id', 'started_at']));
  });
  it('refuses samples with a sample_seq not below sample_count', () => {
    const b = v(); b.outcome = 'INCOMPLETE'; b.samples[12].sample_seq = 99;
    const r = checkConsistency(b);
    expect(r.violations.map((x) => x.rule)).toContain('SEQ_OUT_OF_RANGE');
  });
  // Regression: inputs the database would refuse must be 400, never a 503 the tablet retries forever.
  it.each([
    ['impossible calendar date', (b) => { b.started_at = '2026-02-30T00:00:00Z'; }, 'started_at'],
    ['year zero', (b) => { b.ended_at = '0000-01-01T00:00:00Z'; }, 'ended_at'],
    ['sub-millisecond timestamp', (b) => { b.started_at = '2026-12-01T09:14:03.0005Z'; }, 'started_at'],
    ['sample_count beyond int32', (b) => { b.sample_count = 3000000000; }, 'sample_count'],
    ['float32 underflow', (b) => { b.samples[0].current_a = 1e-50; }, 'samples[0].current_a'],
    ['float32 overflow', (b) => { b.samples[0].voltage_v = 1e39; }, 'samples[0].voltage_v'],
    ['NUL character in serial', (b) => { b.motor_serial = 'AB\u0000C'; }, 'motor_serial'],
    ['lone surrogate in event code', (b) => { b.events[0].code = 'X\uD800'; }, 'events[0].code'],
    ['deeply nested outcome_reasons', (b) => { b.outcome_reasons = [{ a: { b: { c: { d: { e: { f: 1 } } } } } }]; }, 'outcome_reasons'],
    ['non-finite number in outcome_reasons', (b) => { b.outcome_reasons = [{ measured: Infinity }]; }, 'outcome_reasons'],
  ])('%s -> 400 at the right path', (name, mutate, pathWanted) => {
    const b = v(); mutate(b);
    expect(checkSchema(b).map((x) => x.path)).toContain(pathWanted);
  });
  it('accepts a valid leap day and millisecond timestamps', () => {
    const b = v(); b.started_at = '2028-02-29T09:14:03.123Z';
    expect(checkSchema(b)).toEqual([]);
  });

  it('accepts a COMPLETED run with a gap as INCOMPLETE (D11 proposal) but not as PASS', () => {
    const b = v(); b.samples.splice(4, 1); b.outcome = 'INCOMPLETE';
    expect(checkConsistency(b).violations).toEqual([]);
    b.outcome = 'PASS';
    expect(checkConsistency(b).violations.map((x) => x.rule)).toContain('COMPLETE_EVIDENCE_REQUIRED');
  });
});
