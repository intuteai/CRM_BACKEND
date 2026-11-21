// Generates vectors/receipt-v2-vectors.json (contract v0.5 DRAFT, signed archive receipt MTRCPT2).
//   node docs/motor-test/contract/tools/generate-receipt-v2-vectors.js
// Then check independently:  python docs/motor-test/contract/tools/check_receipt_v2_vectors.py
// TEST KEYS ONLY: the same published seeds as generate-receipt-vectors.js; never use them outside these vectors.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const R = require('./receipt');
const R2 = require('./receipt_v2');

const OUT = path.join(__dirname, '..', 'vectors', 'receipt-v2-vectors.json');
const sha = (s) => crypto.createHash('sha256').update(s).digest();
const KEYS = { A: R.keyFromSeed(sha('motor-test receipt TEST key A')), B: R.keyFromSeed(sha('motor-test receipt TEST key B')), C: R.keyFromSeed(sha('motor-test receipt TEST key C')) };
const pub = (k) => ({ key_id: k.keyId.toString('hex'), public_key: R.b64urlEncode(k.publicRaw) });
const KEYRING = [pub(KEYS.A), pub(KEYS.B)]; // the VCU's two slots (current A, next B); C is unknown to the VCU

const D_V1 = 'sha256:bea7cd5b154a1cba984f059446dcb90521a4f402b066f8c74650f3c00ea00cf6'; // run-digest vector V1 (3 samples)
const D_EMPTY = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'; // V2 (no samples)
const D_TWO = 'sha256:' + sha('first two of the three V1 samples (placeholder digest)').toString('hex');
const D_OTHER = 'sha256:' + sha('three samples, one reading different (placeholder digest)').toString('hex');
const PAYLOAD = 'sha256:' + sha('example payload_hash').toString('hex');
// Event digests are placeholders (fixed 32-byte values), not MTEVT computations: the receipt only compares them.
const E_RUN = 'sha256:' + sha('MTEVT journal of the example run (placeholder event digest)').toString('hex');
// Real MTEVT2 digest of a CANCEL (started=0, no events, complete log): v05-event-vectors.json case E8.
const E_EMPTY = 'sha256:84a34b8346df42ef14616ec0cfb1645f949220107cd40b54ac72fa2d13b6a649';
const E_LOSS = 'sha256:' + sha('MTEVT journal with known loss (placeholder event digest)').toString('hex');
const E_OTHER = 'sha256:' + sha('MTEVT journal, one event different (placeholder event digest)').toString('hex');

const TEST_ID = '7b1d3e0a-5c1f-4b7e-9e0e-2a9f2c1d4e55';
const base = {
  key_id: KEYS.A.keyId, test_id: TEST_ID, receipt_id: 'e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5b', stored_at: '2026-12-01T09:16:07.412Z',
  sample_count: 3, held_count: 3, stored_sample_count: 3, final_state: 'COMPLETED', outcome: 'PASS', stop_reason: 'RAMP_COMPLETE', started: true,
  run_digest: D_V1, samples_digest: D_V1, payload_hash: PAYLOAD, vcu_id: 'VCU-01', origin_boot_id: 'b00t-0042',
  event_digest: E_RUN, events_stored_digest: E_RUN, warnings_count: 2, command_changes_count: 3,
  event_log_complete: true, b6_coverage_ok: true, capture_end_ms: 61250, start_uptime_ms: 1234567,
};
const CANCEL = {
  sample_count: 0, held_count: 0, stored_sample_count: 0, final_state: 'ABORTED', outcome: 'INCOMPLETE', stop_reason: 'CONFIG_CANCELLED',
  started: false, run_digest: D_EMPTY, samples_digest: D_EMPTY, event_digest: E_EMPTY, events_stored_digest: E_EMPTY,
  warnings_count: 0, command_changes_count: 0, event_log_complete: true, b6_coverage_ok: true, capture_end_ms: null, start_uptime_ms: null,
};
const KNOWN_LOSS = { sample_count: 5, final_state: 'FAULT', stop_reason: 'FAULT', outcome: 'INCOMPLETE', recording_complete: false,
  event_digest: E_LOSS, events_stored_digest: E_LOSS, warnings_count: 4, command_changes_count: 2, event_log_complete: false, b6_coverage_ok: false, capture_end_ms: 40100 };
const manifestOf = (f) => ({ test_id: f.test_id, vcu_id: f.vcu_id, origin_boot_id: f.origin_boot_id, started: f.started,
  recording_complete: f.recording_complete ?? f.held_count === f.sample_count, final_state: f.final_state,
  stop_reason: f.stop_reason, sample_count: f.sample_count, held_count: f.held_count, run_digest: f.run_digest,
  event_digest: f.event_digest, warnings_count: f.warnings_count, command_changes_count: f.command_changes_count,
  event_log_complete: f.event_log_complete, capture_end_ms: f.capture_end_ms ?? null, start_uptime_ms: f.start_uptime_ms ?? null });
const EF = R2.EVENT_FLAG;
const EF_ALL = EF.EVENT_DIGEST_MATCH | EF.EVENT_LOG_COMPLETE | EF.B6_COVERAGE_OK | EF.CAPTURE_END_PRESENT | EF.START_UPTIME_PRESENT; // 0x1f

// Each case: [id, description, fields (signed), tamper/manifest override, expected reason].
const cases = [
  // ---------------------------------------------------------------- accepted
  ['R2A1', 'complete COMPLETED/PASS run with events (2 warnings, 3 command changes, event log complete, b6 coverage OK); ERP holds exactly the VCU samples and events', {}],
  ['R2A2', 'known-loss run: FAULT/FAULT/INCOMPLETE, VCU holds 3 of 5, recording and event log incomplete, b6 coverage not OK; ERP holds exactly the VCU samples and events -> release', KNOWN_LOSS],
  ['R2A3', 'CANCEL (started=0): capture_end and start_uptime absent (b3=b4=0, value bytes 0), zero counts, real MTEVT2 digest of the CANCEL journal (v0.5 vector E8)', CANCEL],
  ['R2A4', 'signed with key B (rotation: B is in the second slot)', { key: 'B' }],
  ['R2A5', 'boundaries: start_uptime_ms present with value 0 (presence by b4, never a sentinel), capture_end_ms 0xFFFFFFFF, max counts, vcu_id 1 byte, origin_boot_id 32 bytes', { start_uptime_ms: 0, capture_end_ms: 0xffffffff, warnings_count: 0xffffffff, command_changes_count: 0xffffffff, vcu_id: 'V', origin_boot_id: 'b'.repeat(32) }],
  ['R2A6', 'complete samples, event log complete but b6 coverage not OK (evaluation matter, reported, not a release blocker), outcome INVALID', { b6_coverage_ok: false, outcome: 'INVALID' }],
  // ---------------------------------------------------------------- event rules (new in MTRCPT2)
  ['R2R1', 'event_digest in the receipt differs from the VCU manifest event_digest (ERP stored what it was sent, but not the VCU journal)', { event_digest: E_OTHER, events_stored_digest: E_OTHER }, { manifest: { event_digest: E_RUN } }, 'MANIFEST_MISMATCH'],
  ['R2R2', 'ERP-stored event digest differs from the uploaded event_digest (b0 clear): ERP does not hold exactly the VCU events', { events_stored_digest: E_OTHER }, {}, 'EVENT_DIGEST_MISMATCH'],
  ['R2R3', 'event flag b0 set although events_stored_digest != event_digest', { events_stored_digest: E_OTHER, event_flags: EF_ALL }, {}, 'FLAGS_INCONSISTENT'],
  ['R2R4', 'event flag b0 clear although events_stored_digest == event_digest', { event_flags: EF_ALL & ~EF.EVENT_DIGEST_MATCH }, {}, 'FLAGS_INCONSISTENT'],
  ['R2R5', 'CANCEL (started=0) with capture_end_ms present', { ...CANCEL, capture_end_ms: 0 }, {}, 'FLAGS_INCONSISTENT'],
  ['R2R6', 'CANCEL (started=0) with start_uptime_ms present', { ...CANCEL, start_uptime_ms: 5000 }, {}, 'FLAGS_INCONSISTENT'],
  ['R2R7', 'started run with start_uptime_ms absent (b4 clear)', { start_uptime_ms: null }, {}, 'FLAGS_INCONSISTENT'],
  ['R2R8', 'started run with capture_end_ms absent (b3 clear)', { capture_end_ms: null }, {}, 'FLAGS_INCONSISTENT'],
  ['R2R9', 'capture_end_ms value differs from the VCU manifest', {}, { manifest: { capture_end_ms: 61249 } }, 'MANIFEST_MISMATCH'],
  ['R2R10', 'start_uptime_ms value differs from the VCU manifest', {}, { manifest: { start_uptime_ms: 1234568 } }, 'MANIFEST_MISMATCH'],
  ['R2R11', 'start_uptime_ms presence differs from the VCU manifest (receipt present, manifest null)', {}, { manifest: { start_uptime_ms: null } }, 'MANIFEST_MISMATCH'],
  ['R2R12', 'capture_end_ms presence differs from the VCU manifest (receipt present with 0, manifest null)', { capture_end_ms: 0 }, { manifest: { capture_end_ms: null } }, 'MANIFEST_MISMATCH'],
  ['R2R13', 'warnings_count differs from the VCU manifest', { warnings_count: 1 }, { manifest: { warnings_count: 2 } }, 'MANIFEST_MISMATCH'],
  ['R2R14', 'command_changes_count differs from the VCU manifest', { command_changes_count: 4 }, { manifest: { command_changes_count: 3 } }, 'MANIFEST_MISMATCH'],
  ['R2R15', 'event_log_complete (b1) differs from the VCU manifest', {}, { manifest: { event_log_complete: false } }, 'MANIFEST_MISMATCH'],
  ['R2R16', 'non-zero bytes in an absent capture_end_ms (b3 clear, value 1) on a CANCEL', { ...CANCEL, capture_end_ms: 1, event_flags: EF.EVENT_DIGEST_MATCH | EF.EVENT_LOG_COMPLETE | EF.B6_COVERAGE_OK }, {}, 'MALFORMED_MESSAGE'],
  ['R2R17', 'non-zero bytes in an absent start_uptime_ms (b4 clear, value 0x01000000) on a CANCEL', { ...CANCEL, start_uptime_ms: 0x01000000, event_flags: EF.EVENT_DIGEST_MATCH | EF.EVENT_LOG_COMPLETE | EF.B6_COVERAGE_OK }, {}, 'MALFORMED_MESSAGE'],
  ['R2R18', 'reserved event flag bit b5 set', { event_flags: EF_ALL | 0x20 }, {}, 'MALFORMED_MESSAGE'],
  ['R2R19', 'reserved event flag bit b7 set', { event_flags: EF_ALL | 0x80 }, {}, 'MALFORMED_MESSAGE'],
  ['R2R20', 'reserved run flag bit b4 set (MTRCPT1 rule, still applies)', { flags: 0x1f }, {}, 'MALFORMED_MESSAGE'],
  ['R2R21', 'a valid MTRCPT1 message (vector RA1 bytes) given to the MTRCPT2 decoder', {}, { v1: true }, 'BAD_VERSION'],
  ['R2R22', 'MTRCPT2 magic on an MTRCPT1-layout body (no event block, 172 bytes)', {}, { v1: true, v1Magic: R2.MAGIC_V2 }, 'MALFORMED_MESSAGE'],
  ['R2R23', 'both sample digest and event digest differ: the sample check comes first', { samples_digest: D_OTHER, events_stored_digest: E_OTHER, outcome: 'INCOMPLETE' }, {}, 'DIGEST_MISMATCH'],
  // ---------------------------------------------------------------- MTRCPT1 rules carried over
  ['R2R24', 'ERP stored 2 of the 3 held samples', { stored_sample_count: 2, samples_digest: D_TWO, outcome: 'INCOMPLETE' }, {}, 'SHORTFALL'],
  ['R2R25', 'counts equal but the stored samples differ', { samples_digest: D_OTHER, outcome: 'INCOMPLETE' }, {}, 'DIGEST_MISMATCH'],
  ['R2R26', 'validly signed with the reconnect boot id instead of the origin boot', { origin_boot_id: 'b00t-0043' }, { manifest: { origin_boot_id: 'b00t-0042' } }, 'BOOT_ID_MISMATCH'],
  ['R2R27', 'final_state FAULT with outcome PASS', { final_state: 'FAULT', stop_reason: 'FAULT' }, {}, 'LIFECYCLE_INCONSISTENT'],
  ['R2R28', 'validly signed receipt for another test_id', {}, { manifest: { test_id: '5e8d2c1b-7a6f-4e3d-9b2a-1c0f8e7d6a5b' } }, 'TEST_ID_MISMATCH'],
  // ---------------------------------------------------------------- signature / key / encoding / length
  ['R2R29', 'one message byte changed after signing (warnings_count, offset 232)', {}, { flipMessageByte: 232 }, 'BAD_SIGNATURE'],
  ['R2R30', 'one signature byte changed', {}, { flipSignatureByte: 5 }, 'BAD_SIGNATURE'],
  ['R2R31', 'non-canonical signature: S + L (same signature otherwise valid)', {}, { addLtoS: true }, 'BAD_SIGNATURE'],
  ['R2R32', 'key_id of a key the VCU does not hold (key C)', { key: 'C' }, {}, 'UNKNOWN_KEY'],
  ['R2R33', 'message truncated by one byte (signature over the truncated bytes)', {}, { truncate: 1 }, 'MALFORMED_MESSAGE'],
  ['R2R34', 'one extra trailing byte (signature over the longer bytes)', {}, { append: 1 }, 'MALFORMED_MESSAGE'],
  ['R2R35', 'base64url with "=" padding on the signature', {}, { sigText: (s) => s + '==' }, 'MALFORMED_ENCODING'],
  ['R2R36', 'whitespace inside the message text', {}, { msgText: (s) => s.slice(0, 10) + ' ' + s.slice(10) }, 'MALFORMED_ENCODING'],
];

let failures = 0;
const vectors = cases.map(([id, description, over, tamper = {}, expectReason = 'RELEASE']) => {
  const { key = 'A', ...fieldOver } = over;
  const f = { ...base, key_id: KEYS[key].keyId, ...fieldOver };
  let message = tamper.v1 ? R.encodeMessage({ ...f, magic: tamper.v1Magic }) : R2.encodeMessageV2(f);
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
  let messageText = R.b64urlEncode(message);
  let signatureText = R.b64urlEncode(signature);
  if (tamper.msgText) messageText = tamper.msgText(messageText);
  if (tamper.sigText) signatureText = tamper.sigText(signatureText);
  const manifest = { ...manifestOf({ ...base, ...fieldOver }), ...(tamper.manifest || {}) };
  const signed = { alg: 'Ed25519', key_id: f.key_id.toString('hex'), message: messageText, signature: signatureText };

  const got = R2.decideV2(signed, KEYRING, manifest);
  const expected = { release: expectReason === 'RELEASE', reason: expectReason };
  const ok = got.release === expected.release && got.reason === expected.reason;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${description}: ${got.reason}`);
  const decoded = R2.decodeMessageV2(message).msg || null;
  return { id, description, signed_receipt: signed, message_hex: message.toString('hex'), message_length: message.length, decoded_message: decoded, vcu_manifest: manifest, expected };
});

// The v1 case R2R21 must use exactly the bytes of MTRCPT1 vector RA1 (MTRCPT1 is unchanged).
const v1Doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vectors', 'receipt-vectors.json'), 'utf8'));
const ra1 = v1Doc.vectors.find((v) => v.id === 'RA1');
const r2r21 = vectors.find((v) => v.id === 'R2R21');
if (ra1.message_hex !== r2r21.message_hex || ra1.signed_receipt.signature !== r2r21.signed_receipt.signature) {
  failures++; console.log('FAIL R2R21 is not byte-identical to MTRCPT1 vector RA1');
}
// Dispatch by magic: the MTRCPT1 decider must reject every MTRCPT2 message as BAD_VERSION.
const accepted = vectors.filter((v) => v.expected.release);
for (const v of accepted) {
  const got = R.decide(v.signed_receipt, KEYRING, v.vcu_manifest);
  if (got.reason !== 'BAD_VERSION') { failures++; console.log(`FAIL ${v.id}: MTRCPT1 decide gave ${got.reason}, expected BAD_VERSION`); }
}
if (failures) { console.error(`${failures} receipt v2 vector(s) did not give the expected decision`); process.exit(1); }

fs.writeFileSync(OUT, JSON.stringify({
  title: 'Signed archive receipt MTRCPT2 vectors - contract v0.5 DRAFT (not frozen; for review by Mayank)',
  spec: 'docs/motor-test/contract/receipt-signing.md, section "MTRCPT2 (contract v0.5)"',
  warning: 'TEST KEYS ONLY. Seeds are SHA-256 of the labels below and are public; never provision them on a real VCU. Event digests are placeholder 32-byte values, not MTEVT computations.',
  test_keys: Object.fromEntries(Object.entries(KEYS).map(([k, v]) => [k, {
    seed_label: `motor-test receipt TEST key ${k}`, seed_hex: sha(`motor-test receipt TEST key ${k}`).toString('hex'),
    key_id: v.keyId.toString('hex'), public_key: R.b64urlEncode(v.publicRaw), public_key_hex: v.publicRaw.toString('hex'),
  }])),
  placeholder_digests: {
    [E_RUN]: 'MTEVT journal of the example run (placeholder)', [E_EMPTY]: 'MTEVT digest of an empty event journal (placeholder)',
    [E_LOSS]: 'MTEVT journal with known loss (placeholder)', [E_OTHER]: 'a different event journal (placeholder)',
  },
  vcu_keyring: KEYRING,
  decision_order: ['MALFORMED_ENCODING', 'BAD_VERSION / MALFORMED_MESSAGE', 'UNKNOWN_KEY', 'BAD_SIGNATURE', 'FLAGS_INCONSISTENT', 'LIFECYCLE_INCONSISTENT', 'TEST_ID_MISMATCH', 'VCU_ID_MISMATCH', 'BOOT_ID_MISMATCH', 'MANIFEST_MISMATCH', 'SHORTFALL', 'DIGEST_MISMATCH', 'EVENT_DIGEST_MISMATCH', 'RELEASE'],
  vectors,
}, null, 2) + '\n');
console.log(`wrote ${vectors.length} vectors to ${path.relative(process.cwd(), OUT)}`);
