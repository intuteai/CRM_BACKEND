// The ERP's hashing code must reproduce every shared contract vector (D13 run digest + payload hash).
// Pure, no database.
const path = require('path');
const { runDigest, payloadHash, canonicalJson } = require('../services/testing/digest');

const DIR = path.join(__dirname, '..', 'docs', 'motor-test', 'contract');
const runVectors = require(path.join(DIR, 'vectors', 'run-digest-vectors.json')).vectors;
const payloadVectors = require(path.join(DIR, 'vectors', 'payload-hash-vectors.json')).vectors;
const pcVectors = require(path.join(DIR, 'vectors', 'profile-criteria-hash-vectors.json'));
const bodyOf = (v) => v.body || require(path.join(DIR, 'fixtures', v.body_ref)).request.body;

describe('run digest vectors (D13)', () => {
  it.each(runVectors.map((v) => [v.id, v]))('%s', (id, v) => {
    if (v.expected_digest) {
      expect(runDigest(v.samples)).toBe(v.expected_digest);
    } else {
      let err;
      try { runDigest(v.samples); } catch (e) { err = e; }
      expect(err).toBeDefined();
      expect({ status: err.status, code: err.code, path: err.path }).toEqual({
        status: v.expected_rejection.status, code: v.expected_rejection.code, path: v.expected_rejection.path,
      });
    }
  });
});

describe('payload hash vectors', () => {
  it.each(payloadVectors.map((v) => [v.id, v]))('%s', (id, v) => {
    expect(payloadHash(bodyOf(v))).toBe(v.expected_payload_hash);
    if (v.expected_canonical_json) expect(canonicalJson(v.body)).toBe(v.expected_canonical_json);
  });

  it('key order and whitespace do not change the hash (P1 = P2), a changed reading does (P1 != P3)', () => {
    const [p1, p2, p3] = payloadVectors;
    expect(p1.expected_payload_hash).toBe(p2.expected_payload_hash);
    expect(p1.expected_payload_hash).not.toBe(p3.expected_payload_hash);
  });
});

describe('profile and criteria hash vectors', () => {
  it('profile', () => expect(payloadHash(pcVectors.profile.definition)).toBe(pcVectors.profile.expected_sha256));
  it('criteria', () => expect(payloadHash(pcVectors.criteria.definition)).toBe(pcVectors.criteria.expected_sha256));
});
