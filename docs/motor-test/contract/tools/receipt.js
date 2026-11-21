// Signed archive receipt, contract v0.4 DRAFT - reference implementation (Node >= 18, no dependencies).
// Spec: docs/motor-test/contract/receipt-signing.md. Vectors: vectors/receipt-vectors.json.
// The ERP signs; the VCU verifies and decides. This file implements both sides so the vectors can be generated
// and re-checked; tools/check_receipt_vectors.py is an independent Python implementation of the VCU side.
// R4 (v0.5 draft R4, after Mayank's R3 review): receipt-version pinning. The VCU-owned manifest may carry
// receipt_version; this MTRCPT1 decider rejects RECEIPT_VERSION_MISMATCH when it is present and not 1 (a v0.5 run
// never accepts an MTRCPT1 receipt). v0.4 manifests without the field keep their v1 path. Message bytes unchanged.
'use strict';
const crypto = require('crypto');

const MAGIC = Buffer.from('MTRCPT1\0', 'latin1');
const FIXED_LEN = 168; // bytes before the two length-prefixed identifiers
const ID_RE = /^[A-Za-z0-9._-]{1,32}$/;
const FINAL_STATE = { COMPLETED: 1, ABORTED: 2, FAULT: 3 };
const OUTCOME = { PASS: 1, FAIL: 2, INCOMPLETE: 3, INVALID: 4 };
const STOP_REASON = { RAMP_COMPLETE: 1, OPERATOR_STOP: 2, HB_LOSS: 3, FAULT: 4, POWER_LOSS: 5, CONFIG_CANCELLED: 6 };
const FLAG = { RUN_DIGEST_MATCH: 1, HELD_COUNT_MATCH: 2, RECORDING_COMPLETE: 4, STARTED: 8 };
const ED25519_L = (1n << 252n) + 27742317777372353535851937790883648493n;
// Permitted stop_reason per final_state (review by Mayank 2026-11-18): ABORTED = controlled abort; an evidenced power
// interruption during an unfinished run is FAULT / POWER_LOSS; SAMPLE_LOSS is FAULT / FAULT with fault_code SAMPLE_LOSS.
const STOP_FOR_STATE = {
  COMPLETED: ['RAMP_COMPLETE'],
  ABORTED: ['OPERATOR_STOP', 'HB_LOSS', 'CONFIG_CANCELLED'],
  FAULT: ['FAULT', 'POWER_LOSS'],
};
const name = (map, v) => Object.keys(map).find((k) => map[k] === v);

// ------------------------------------------------------------------ encodings

// Strict base64url (RFC 4648 section 5): alphabet A-Z a-z 0-9 - _, no padding, no whitespace,
// unused trailing bits must be zero (re-encoding must give the same text).
function b64urlEncode(buf) { return Buffer.from(buf).toString('base64url'); }
function b64urlDecodeStrict(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  const buf = Buffer.from(s, 'base64url');
  return buf.toString('base64url') === s ? buf : null;
}
function uuidBytes(u) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(u)) throw new Error(`bad uuid ${u}`);
  return Buffer.from(u.replace(/-/g, ''), 'hex'); // the 16 bytes in the order they are written
}
function uuidString(b) {
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function digestBytes(d) {
  if (!/^sha256:[0-9a-f]{64}$/.test(d)) throw new Error(`bad digest ${d}`);
  return Buffer.from(d.slice(7), 'hex');
}
const digestString = (b) => `sha256:${b.toString('hex')}`;

// ------------------------------------------------------------------ keys

function keyFromSeed(seed) { // seed: 32 bytes (RFC 8032 private key)
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const privateKey = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const publicRaw = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
  return { privateKey, publicRaw, keyId: keyIdOf(publicRaw) };
}
function keyIdOf(publicRaw) { return crypto.createHash('sha256').update(publicRaw).digest().subarray(0, 8); }
function publicKeyObject(publicRaw) {
  return crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicRaw]), format: 'der', type: 'spki' });
}

// ------------------------------------------------------------------ message

// Builds the signed message. f.flags may be given explicitly (vectors use this to build inconsistent cases);
// otherwise it is derived from the values, as the ERP will do.
function encodeMessage(f) {
  const vcu = Buffer.from(f.vcu_id, 'latin1');
  const boot = Buffer.from(f.origin_boot_id, 'latin1');
  const b = Buffer.alloc(FIXED_LEN + 2 + vcu.length + boot.length);
  (f.magic || MAGIC).copy(b, 0);
  f.key_id.copy(b, 8);
  uuidBytes(f.test_id).copy(b, 16);
  uuidBytes(f.receipt_id).copy(b, 32);
  b.writeBigInt64LE(BigInt(Date.parse(f.stored_at)), 48);
  b.writeUInt32LE(f.sample_count, 56);
  b.writeUInt32LE(f.held_count, 60);
  b.writeUInt32LE(f.stored_sample_count, 64);
  b.writeUInt8(FINAL_STATE[f.final_state] ?? f.final_state, 68);
  b.writeUInt8(OUTCOME[f.outcome] ?? f.outcome, 69);
  b.writeUInt8(STOP_REASON[f.stop_reason] ?? f.stop_reason, 70);
  b.writeUInt8(f.flags ?? deriveFlags(f), 71);
  digestBytes(f.run_digest).copy(b, 72);
  digestBytes(f.samples_digest).copy(b, 104);
  digestBytes(f.payload_hash).copy(b, 136);
  b.writeUInt8(vcu.length, 168);
  vcu.copy(b, 169);
  b.writeUInt8(boot.length, 169 + vcu.length);
  boot.copy(b, 170 + vcu.length);
  return b;
}
function deriveFlags(f) {
  return (f.samples_digest === f.run_digest ? FLAG.RUN_DIGEST_MATCH : 0)
    | (f.stored_sample_count === f.held_count ? FLAG.HELD_COUNT_MATCH : 0)
    // b2 = the VCU's own recording_complete (VCU-ERP-04-R1): equal counts alone never prove completeness
    | ((f.recording_complete ?? f.held_count === f.sample_count) ? FLAG.RECORDING_COMPLETE : 0)
    | (f.started ? FLAG.STARTED : 0);
}

// Strict parse. Returns { msg } or { reason }.
function decodeMessage(b) {
  if (b.length < FIXED_LEN + 4) return { reason: b.length >= 8 && !b.subarray(0, 8).equals(MAGIC) ? 'BAD_VERSION' : 'MALFORMED_MESSAGE' };
  if (!b.subarray(0, 8).equals(MAGIC)) return { reason: 'BAD_VERSION' };
  const finalState = name(FINAL_STATE, b[68]); const outcome = name(OUTCOME, b[69]); const stop = name(STOP_REASON, b[70]);
  const flags = b[71];
  if (!finalState || !outcome || !stop || (flags & 0xf0)) return { reason: 'MALFORMED_MESSAGE' };
  const vl = b[168];
  if (vl < 1 || vl > 32 || b.length < 170 + vl) return { reason: 'MALFORMED_MESSAGE' };
  const bl = b[169 + vl];
  if (bl < 1 || bl > 32 || b.length !== 170 + vl + bl) return { reason: 'MALFORMED_MESSAGE' };
  const vcuId = b.subarray(169, 169 + vl).toString('latin1');
  const bootId = b.subarray(170 + vl).toString('latin1');
  if (!ID_RE.test(vcuId) || !ID_RE.test(bootId)) return { reason: 'MALFORMED_MESSAGE' };
  return { msg: {
    key_id: b.subarray(8, 16).toString('hex'), test_id: uuidString(b.subarray(16, 32)), receipt_id: uuidString(b.subarray(32, 48)),
    stored_at: new Date(Number(b.readBigInt64LE(48))).toISOString(),
    sample_count: b.readUInt32LE(56), held_count: b.readUInt32LE(60), stored_sample_count: b.readUInt32LE(64),
    final_state: finalState, outcome, stop_reason: stop, flags,
    run_digest: digestString(b.subarray(72, 104)), samples_digest: digestString(b.subarray(104, 136)), payload_hash: digestString(b.subarray(136, 168)),
    vcu_id: vcuId, origin_boot_id: bootId,
  } };
}

function signMessage(message, privateKey) { return crypto.sign(null, message, privateKey); }

// ------------------------------------------------------------------ VCU decision

// signed = { message, signature } (base64url strings, exactly as received)
// keyring = [{ key_id: hex16, public_key: base64url }] - the VCU's provisioned, non-revoked keys
// manifest = the VCU's own durable record of the run (receipt_version: absent or 1 for a v0.4 run)
// Returns { release: boolean, reason }. Checks run in this order; the first failure is the reason.
function decide(signed, keyring, manifest) {
  const message = b64urlDecodeStrict(signed.message);
  const signature = b64urlDecodeStrict(signed.signature);
  if (!message || !signature || signature.length !== 64) return { release: false, reason: 'MALFORMED_ENCODING' };
  const { msg, reason } = decodeMessage(message);
  if (!msg) return { release: false, reason };
  const key = keyring.find((k) => k.key_id === msg.key_id);
  if (!key) return { release: false, reason: 'UNKNOWN_KEY' };
  const s = BigInt('0x' + Buffer.from(signature.subarray(32)).reverse().toString('hex'));
  if (s >= ED25519_L) return { release: false, reason: 'BAD_SIGNATURE' }; // non-canonical S (RFC 8032 5.1.7)
  if (!crypto.verify(null, message, publicKeyObject(b64urlDecodeStrict(key.public_key)), signature)) return { release: false, reason: 'BAD_SIGNATURE' };
  // Receipt-version pinning (R4): the version the VCU persisted when it created the run decides which receipt is
  // permitted. Present and not 1 (e.g. 2 = a v0.5 run) -> reject, even with a valid signature and matching fields.
  if (manifest.receipt_version !== undefined && manifest.receipt_version !== 1) return { release: false, reason: 'RECEIPT_VERSION_MISMATCH' };
  // Signed flags must agree with the signed values (never trust one without the other).
  if (((msg.flags & FLAG.RUN_DIGEST_MATCH) !== 0) !== (msg.samples_digest === msg.run_digest)
    || ((msg.flags & FLAG.HELD_COUNT_MATCH) !== 0) !== (msg.stored_sample_count === msg.held_count)
    || ((msg.flags & FLAG.RECORDING_COMPLETE) && msg.held_count !== msg.sample_count) // complete => equal counts (not the reverse)
    || msg.held_count > msg.sample_count || msg.stored_sample_count > msg.held_count
    || (!(msg.flags & FLAG.STARTED) && (!(msg.flags & FLAG.RECORDING_COMPLETE) || msg.sample_count !== 0 || msg.stop_reason !== 'CONFIG_CANCELLED' || msg.final_state !== 'ABORTED' || msg.outcome !== 'INCOMPLETE'))
    || ((msg.flags & FLAG.STARTED) && msg.stop_reason === 'CONFIG_CANCELLED')) return { release: false, reason: 'FLAGS_INCONSISTENT' };
  // Lifecycle combinations: stop_reason must fit final_state; a verdict (PASS/FAIL/INVALID) needs COMPLETED with
  // complete, matching evidence; ABORTED and FAULT are always INCOMPLETE (D11).
  const verdict = msg.outcome !== 'INCOMPLETE';
  if (!STOP_FOR_STATE[msg.final_state].includes(msg.stop_reason)
    || (verdict && (msg.final_state !== 'COMPLETED' || (msg.flags & 0x07) !== 0x07))) return { release: false, reason: 'LIFECYCLE_INCONSISTENT' };
  if (msg.test_id !== manifest.test_id) return { release: false, reason: 'TEST_ID_MISMATCH' };
  if (msg.vcu_id !== manifest.vcu_id) return { release: false, reason: 'VCU_ID_MISMATCH' };
  if (msg.origin_boot_id !== manifest.origin_boot_id) return { release: false, reason: 'BOOT_ID_MISMATCH' };
  // The VCU is authoritative for how its run ended: final_state and stop_reason must equal its manifest.
  // outcome is the HMI's verdict (D10), so the VCU checks it only through the combination rules above.
  if (msg.run_digest !== manifest.run_digest || msg.sample_count !== manifest.sample_count || msg.held_count !== manifest.held_count
    || ((msg.flags & FLAG.STARTED) !== 0) !== manifest.started
    || ((msg.flags & FLAG.RECORDING_COMPLETE) !== 0) !== manifest.recording_complete
    || msg.final_state !== manifest.final_state || msg.stop_reason !== manifest.stop_reason) return { release: false, reason: 'MANIFEST_MISMATCH' };
  if (msg.stored_sample_count !== msg.held_count) return { release: false, reason: 'SHORTFALL' };
  if (msg.samples_digest !== msg.run_digest) return { release: false, reason: 'DIGEST_MISMATCH' };
  return { release: true, reason: 'RELEASE' };
}

module.exports = {
  MAGIC, FINAL_STATE, OUTCOME, STOP_REASON, FLAG, ED25519_L, STOP_FOR_STATE,
  b64urlEncode, b64urlDecodeStrict, keyFromSeed, keyIdOf, encodeMessage, decodeMessage, deriveFlags, signMessage, decide,
};
