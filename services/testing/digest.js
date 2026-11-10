// Hashing rules for motor-test uploads (Interface Contract D13 + payload hash).
// Must match docs/motor-test/contract/vectors/*.json exactly; tests/testing_digest.test.js checks that.
'use strict';
const crypto = require('crypto');

const sha256 = (buf) => 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');

class ContractViolation extends Error {
  constructor(status, code, path, msg, rule) {
    super(msg);
    Object.assign(this, { status, code, path, rule });
  }
}

// RFC 8785 JSON Canonicalization Scheme.
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

// payload_hash: SHA-256 of the canonical JSON of the whole request body.
const payloadHash = (body) => sha256(Buffer.from(canonicalJson(body), 'utf8'));

const FLOATS = [['current_a', 1], ['voltage_v', 2], ['bemf_v', 3]];
const QNAN = Buffer.from([0x00, 0x00, 0xc0, 0x7f]);

// One 30-byte little-endian record (D13). Throws ContractViolation on a flag/value mismatch.
function sampleRecord(s, i) {
  const flags = s.status_flags;
  if ((flags & 0xff00) !== 0) {
    throw new ContractViolation(400, 'VALIDATION_ERROR', `samples[${i}].status_flags`,
      `reserved bits b8-b15 must be 0 (got 0x${flags.toString(16).padStart(4, '0')})`, 'RESERVED_BITS');
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
      if (v !== null) throw new ContractViolation(422, 'INCONSISTENT_RUN', `samples[${i}].${name}`, `validity bit b${bit} is 0 but a number was sent (must be null)`, 'VALIDITY_FLAG_MISMATCH');
      QNAN.copy(b, off);
    } else {
      if (v === null) throw new ContractViolation(422, 'INCONSISTENT_RUN', `samples[${i}].${name}`, `validity bit b${bit} is 1 but value is null`, 'VALIDITY_FLAG_MISMATCH');
      b.writeFloatLE(v, off);
      if (b.readUInt32LE(off) === 0x80000000) b.writeUInt32LE(0, off); // -0.0 -> +0.0
    }
  });
  b.writeUInt16LE(flags, 28);
  return b;
}

// SHA-256 over the 30-byte records in the given (ascending) order.
function runDigest(samples) {
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].sample_seq <= samples[i - 1].sample_seq) {
      throw new ContractViolation(422, 'INCONSISTENT_RUN', `samples[${i}].sample_seq`, 'samples must be in strictly ascending sample_seq order', 'SEQ_ORDER');
    }
  }
  return sha256(Buffer.concat(samples.map(sampleRecord)));
}

module.exports = { canonicalJson, payloadHash, runDigest, sampleRecord, ContractViolation, sha256 };
