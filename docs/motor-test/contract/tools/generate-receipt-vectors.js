// Generates vectors/receipt-vectors.json (contract v0.4 DRAFT, signed archive receipt).
//   node docs/motor-test/contract/tools/generate-receipt-vectors.js
// Then check independently:  python docs/motor-test/contract/tools/check_receipt_vectors.py
// TEST KEYS ONLY: the seeds are published here and must never be used outside these vectors.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const R = require('./receipt');

const OUT = path.join(__dirname, '..', 'vectors', 'receipt-vectors.json');
const sha = (s) => crypto.createHash('sha256').update(s).digest();
const KEYS = { A: R.keyFromSeed(sha('motor-test receipt TEST key A')), B: R.keyFromSeed(sha('motor-test receipt TEST key B')), C: R.keyFromSeed(sha('motor-test receipt TEST key C')) };
const pub = (k) => ({ key_id: k.keyId.toString('hex'), public_key: R.b64urlEncode(k.publicRaw) });
const KEYRING = [pub(KEYS.A), pub(KEYS.B)]; // the VCU's two slots (current A, next B); C is unknown to the VCU

const D_V1 = 'sha256:bea7cd5b154a1cba984f059446dcb90521a4f402b066f8c74650f3c00ea00cf6'; // run-digest vector V1 (3 samples)
const D_EMPTY = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'; // V2 (no samples)
const D_V10 = 'sha256:' + fs.readFileSync(path.join(__dirname, '..', 'vectors', 'run-digest-vectors.json'), 'utf8')
  .match(/"id": "V10"[\s\S]*?"expected_digest": "sha256:([0-9a-f]{64})"/)[1];
const D_TWO = 'sha256:' + sha('first two of the three V1 samples (placeholder digest)').toString('hex');
const D_OTHER = 'sha256:' + sha('three samples, one reading different (placeholder digest)').toString('hex');
const PAYLOAD = 'sha256:' + sha('example payload_hash').toString('hex');

const TEST_ID = '7b1d3e0a-5c1f-4b7e-9e0e-2a9f2c1d4e55';
const base = {
  key_id: KEYS.A.keyId, test_id: TEST_ID, receipt_id: 'e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5b', stored_at: '2026-12-01T09:16:07.412Z',
  sample_count: 3, held_count: 3, stored_sample_count: 3, final_state: 'COMPLETED', outcome: 'PASS', stop_reason: 'RAMP_COMPLETE', started: true,
  run_digest: D_V1, samples_digest: D_V1, payload_hash: PAYLOAD, vcu_id: 'VCU-01', origin_boot_id: 'b00t-0042',
};
const manifestOf = (f) => ({ test_id: f.test_id, vcu_id: f.vcu_id, origin_boot_id: f.origin_boot_id, started: f.started, final_state: f.final_state,
  stop_reason: f.stop_reason, sample_count: f.sample_count, held_count: f.held_count, run_digest: f.run_digest });

// Each case: fields (signed), optional manifest override, optional raw tampering of the encoded strings.
const cases = [
  // ---------------------------------------------------------------- accepted
  ['RA1', 'complete COMPLETED/PASS run, ERP holds all 3 samples', {}],
  ['RA2', 'VCU-known incomplete recording (holds 3 of 5), ERP holds all 3 -> release; stays INCOMPLETE', { sample_count: 5, final_state: 'ABORTED', outcome: 'INCOMPLETE', stop_reason: 'OPERATOR_STOP' }],
  ['RA3', 'CANCEL before start: zero-sample ABORTED/CONFIG_CANCELLED, started=0', { sample_count: 0, held_count: 0, stored_sample_count: 0, final_state: 'ABORTED', outcome: 'INCOMPLETE', stop_reason: 'CONFIG_CANCELLED', started: false, run_digest: D_EMPTY, samples_digest: D_EMPTY }],
  ['RA4', 'started run that recorded nothing (FAULT, 0 samples)', { sample_count: 0, held_count: 0, stored_sample_count: 0, final_state: 'FAULT', outcome: 'INCOMPLETE', stop_reason: 'FAULT', run_digest: D_EMPTY, samples_digest: D_EMPTY }],
  ['RA5', 'b0 = 0 (rpm_actual unavailable, raw int32 kept): digest = run-digest vector V10', { sample_count: 1, held_count: 1, stored_sample_count: 1, run_digest: D_V10, samples_digest: D_V10 }],
  ['RA6', 'identifier length boundaries: vcu_id 1 byte, origin_boot_id 32 bytes', { vcu_id: 'V', origin_boot_id: 'b'.repeat(32) }],
  ['RA7', 'signed with key B (rotation: B is in the second slot)', { key: 'B' }],
  // ---------------------------------------------------------------- signature / key
  ['RR1', 'one message byte changed after signing (stored_at)', {}, { flipMessageByte: 50 }, 'BAD_SIGNATURE'],
  ['RR2', 'one signature byte changed', {}, { flipSignatureByte: 5 }, 'BAD_SIGNATURE'],
  ['RR3', 'non-canonical signature: S + L (same signature otherwise valid)', {}, { addLtoS: true }, 'BAD_SIGNATURE'],
  ['RR4', 'key_id of a key the VCU does not hold (key C)', { key: 'C' }, {}, 'UNKNOWN_KEY'],
  ['RR5', 'key_id says key A but signed with key B', { key: 'B', key_id: KEYS.A.keyId }, {}, 'BAD_SIGNATURE'],
  // ---------------------------------------------------------------- validly signed, wrong run
  ['RR6', 'validly signed receipt for another test_id', {}, { manifest: { test_id: '5e8d2c1b-7a6f-4e3d-9b2a-1c0f8e7d6a5b' } }, 'TEST_ID_MISMATCH'],
  ['RR7', 'validly signed, other vcu_id', {}, { manifest: { vcu_id: 'VCU-02' } }, 'VCU_ID_MISMATCH'],
  ['RR8', 'validly signed with the reconnect boot id instead of the origin boot', { origin_boot_id: 'b00t-0043' }, { manifest: { origin_boot_id: 'b00t-0042' } }, 'BOOT_ID_MISMATCH'],
  // ---------------------------------------------------------------- validly signed shortfall / mismatch
  ['RR9', 'complete recording uploaded with a missing sample: ERP stored 2 of the 3 held', { stored_sample_count: 2, samples_digest: D_TWO, outcome: 'INCOMPLETE' }, {}, 'SHORTFALL'],
  ['RR10', 'counts equal but the stored samples differ (digest mismatch)', { samples_digest: D_OTHER, outcome: 'INCOMPLETE' }, {}, 'DIGEST_MISMATCH'],
  ['RR11', 'prefix trap: receipt claims held_count 2 and the 2-sample digest, VCU holds 3', { held_count: 2, stored_sample_count: 2, run_digest: D_TWO, samples_digest: D_TWO, outcome: 'INCOMPLETE' }, { manifest: { held_count: 3, run_digest: D_V1 } }, 'MANIFEST_MISMATCH'],
  ['RR12', 'sample_count differs from the VCU manifest', { sample_count: 4, outcome: 'INCOMPLETE' }, { manifest: { sample_count: 3 } }, 'MANIFEST_MISMATCH'],
  ['RR13', 'started bit differs from the VCU manifest (VCU never started)', {}, { manifest: { started: false } }, 'MANIFEST_MISMATCH'],
  ['RR14', 'signed flags claim HELD_COUNT_MATCH but stored < held', { stored_sample_count: 2, samples_digest: D_TWO, flags: R.FLAG.HELD_COUNT_MATCH | R.FLAG.RECORDING_COMPLETE | R.FLAG.STARTED }, {}, 'FLAGS_INCONSISTENT'],
  ['RR15', 'started = 0 but samples are held', { started: false }, {}, 'FLAGS_INCONSISTENT'],
  ['RR16', 'CONFIG_CANCELLED on a started run', { stop_reason: 'CONFIG_CANCELLED', final_state: 'ABORTED', outcome: 'INCOMPLETE' }, {}, 'FLAGS_INCONSISTENT'],
  // ---------------------------------------------------------------- malformed message
  ['RR17', 'wrong magic / version (MTRCPT2)', { magic: Buffer.from('MTRCPT2\0', 'latin1') }, {}, 'BAD_VERSION'],
  ['RR18', 'reserved flag bit b4 set', { flags: 0x1f }, {}, 'MALFORMED_MESSAGE'],
  ['RR19', 'final_state code 9 (unknown)', { final_state: 9 }, {}, 'MALFORMED_MESSAGE'],
  ['RR20', 'message truncated by one byte (signature over the truncated bytes)', {}, { truncate: 1 }, 'MALFORMED_MESSAGE'],
  ['RR21', 'one extra trailing byte (signature over the longer bytes)', {}, { append: 1 }, 'MALFORMED_MESSAGE'],
  ['RR22', 'vcu_id length 0', { vcu_id: '' }, {}, 'MALFORMED_MESSAGE'],
  ['RR23', 'vcu_id length 33', { vcu_id: 'V'.repeat(33) }, {}, 'MALFORMED_MESSAGE'],
  ['RR24', 'vcu_id with a character outside [A-Za-z0-9._-] (space)', { vcu_id: 'VCU 01' }, {}, 'MALFORMED_MESSAGE'],
  ['RR25', 'origin_boot_id length 33', { origin_boot_id: 'b'.repeat(33) }, {}, 'MALFORMED_MESSAGE'],
  // ---------------------------------------------------------------- malformed encoding
  ['RR26', 'base64url with "=" padding on the signature', {}, { sigText: (s) => s + '==' }, 'MALFORMED_ENCODING'],
  ['RR27', 'standard base64 characters (+ /) instead of base64url', {}, { msgText: (s) => s.replace(/-/g, '+').replace(/_/g, '/') + (/[-_]/.test(s) ? '' : '+') }, 'MALFORMED_ENCODING'],
  ['RR28', 'non-canonical trailing bits in the signature text', {}, { sigText: (s) => s.slice(0, -1) + nextTrailing(s) }, 'MALFORMED_ENCODING'],
  ['RR29', 'whitespace inside the message text', {}, { msgText: (s) => s.slice(0, 10) + ' ' + s.slice(10) }, 'MALFORMED_ENCODING'],
  ['RR30', 'signature 63 bytes', {}, { sigBytes: (b) => b.subarray(0, 63) }, 'MALFORMED_ENCODING'],
  // ---------------------------------------------------------------- lifecycle (review findings by Mayank, 2026-11-18)
  ['RR31', 'Mayank probe 1: final_state FAULT with outcome PASS (RA1 otherwise)', { final_state: 'FAULT' }, {}, 'LIFECYCLE_INCONSISTENT'],
  ['RR32', 'Mayank probe 2: final_state COMPLETED with stop_reason HB_LOSS', { stop_reason: 'HB_LOSS' }, {}, 'LIFECYCLE_INCONSISTENT'],
  ['RR33', 'ABORTED / OPERATOR_STOP with outcome FAIL (a verdict on an aborted run)', { final_state: 'ABORTED', stop_reason: 'OPERATOR_STOP', outcome: 'FAIL' }, {}, 'LIFECYCLE_INCONSISTENT'],
  ['RR34', 'FAULT with stop_reason POWER_LOSS (not permitted for FAULT)', { final_state: 'FAULT', stop_reason: 'POWER_LOSS', outcome: 'INCOMPLETE' }, {}, 'LIFECYCLE_INCONSISTENT'],
  ['RR35', 'PASS although the VCU recording is incomplete (held 3 of 5)', { sample_count: 5 }, {}, 'LIFECYCLE_INCONSISTENT'],
  ['RR36', 'consistent ABORTED receipt, but the VCU manifest says FAULT', { final_state: 'ABORTED', stop_reason: 'OPERATOR_STOP', outcome: 'INCOMPLETE' }, { manifest: { final_state: 'FAULT', stop_reason: 'FAULT' } }, 'MANIFEST_MISMATCH'],
  ['RR37', 'stop_reason HB_LOSS in the receipt, OPERATOR_STOP in the VCU manifest', { final_state: 'ABORTED', stop_reason: 'HB_LOSS', outcome: 'INCOMPLETE' }, { manifest: { stop_reason: 'OPERATOR_STOP' } }, 'MANIFEST_MISMATCH'],
];

// 64-byte signature -> 86 base64url chars; the last char carries 4 data bits + 2 unused bits. Set an unused bit.
function nextTrailing(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  return alphabet[alphabet.indexOf(s[s.length - 1]) | 1];
}

let failures = 0;
const vectors = cases.map(([id, description, over, tamper = {}, expectReason = 'RELEASE']) => {
  const { key = 'A', ...fieldOver } = over;
  const f = { ...base, key_id: KEYS[key].keyId, ...fieldOver };
  let message = R.encodeMessage(f);
  if (tamper.truncate) message = message.subarray(0, message.length - tamper.truncate);
  if (tamper.append) message = Buffer.concat([message, Buffer.alloc(tamper.append)]);
  let signature = R.signMessage(message, KEYS[key].privateKey);
  if (tamper.flipMessageByte !== undefined) { message = Buffer.from(message); message[tamper.flipMessageByte] ^= 0x01; }
  if (tamper.flipSignatureByte !== undefined) { signature = Buffer.from(signature); signature[tamper.flipSignatureByte] ^= 0x01; }
  if (tamper.addLtoS) {
    const s = BigInt('0x' + Buffer.from(signature.subarray(32)).reverse().toString('hex')) + R.ED25519_L;
    const sBytes = Buffer.from(s.toString(16).padStart(64, '0'), 'hex').reverse();
    signature = Buffer.concat([signature.subarray(0, 32), sBytes]);
  }
  if (tamper.sigBytes) signature = tamper.sigBytes(signature);
  let messageText = R.b64urlEncode(message);
  let signatureText = R.b64urlEncode(signature);
  if (tamper.msgText) messageText = tamper.msgText(messageText);
  if (tamper.sigText) signatureText = tamper.sigText(signatureText);
  const manifest = { ...manifestOf({ ...base, ...fieldOver }), ...(tamper.manifest || {}) };
  const signed = { alg: 'Ed25519', key_id: f.key_id.toString('hex'), message: messageText, signature: signatureText };

  const got = R.decide(signed, KEYRING, manifest);
  const expected = { release: expectReason === 'RELEASE', reason: expectReason };
  const ok = got.release === expected.release && got.reason === expected.reason;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${description}: ${got.reason}`);
  const decoded = R.decodeMessage(message).msg || null;
  return { id, description, signed_receipt: signed, message_hex: message.toString('hex'), decoded_message: decoded, vcu_manifest: manifest, expected };
});
if (failures) { console.error(`${failures} receipt vector(s) did not give the expected decision`); process.exit(1); }

fs.writeFileSync(OUT, JSON.stringify({
  title: 'Signed archive receipt vectors - contract v0.4 DRAFT (not frozen)',
  spec: 'docs/motor-test/contract/receipt-signing.md',
  warning: 'TEST KEYS ONLY. Seeds are SHA-256 of the labels below and are public; never provision them on a real VCU.',
  test_keys: Object.fromEntries(Object.entries(KEYS).map(([k, v]) => [k, {
    seed_label: `motor-test receipt TEST key ${k}`, seed_hex: sha(`motor-test receipt TEST key ${k}`).toString('hex'),
    key_id: v.keyId.toString('hex'), public_key: R.b64urlEncode(v.publicRaw), public_key_hex: v.publicRaw.toString('hex'),
  }])),
  vcu_keyring: KEYRING,
  decision_order: ['MALFORMED_ENCODING', 'BAD_VERSION / MALFORMED_MESSAGE', 'UNKNOWN_KEY', 'BAD_SIGNATURE', 'FLAGS_INCONSISTENT', 'LIFECYCLE_INCONSISTENT', 'TEST_ID_MISMATCH', 'VCU_ID_MISMATCH', 'BOOT_ID_MISMATCH', 'MANIFEST_MISMATCH', 'SHORTFALL', 'DIGEST_MISMATCH', 'RELEASE'],
  vectors,
}, null, 2) + '\n');
console.log(`wrote ${vectors.length} vectors to ${path.relative(process.cwd(), OUT)}`);
