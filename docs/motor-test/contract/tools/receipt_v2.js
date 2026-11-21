// Signed archive receipt MTRCPT2, contract v0.5 DRAFT - reference implementation (Node >= 18, no dependencies).
// Spec: docs/motor-test/contract/receipt-signing.md, section "MTRCPT2 (contract v0.5)". Vectors: vectors/receipt-v2-vectors.json.
// MTRCPT2 = the MTRCPT1 fixed part (offsets 0..167, magic "MTRCPT2\0") + an event block (offsets 168..248) + the two
// length-prefixed identifiers. MTRCPT1 (tools/receipt.js) is reused unchanged: the common fields are encoded and parsed
// by receipt.js itself, so both versions share one definition of offsets 0..167 and of the identifier rules.
// A VCU dispatches by magic: MTRCPT1 -> decide() (v0.4 runs), MTRCPT2 -> decideV2() (v0.5 runs).
'use strict';
const crypto = require('crypto');
const R = require('./receipt');

const MAGIC_V2 = Buffer.from('MTRCPT2\0', 'latin1');
const V1_FIXED_LEN = 168; // offsets 0..167, identical layout in both versions
const EVENT_BLOCK_LEN = 81; // offsets 168..248
const V2_FIXED_LEN = V1_FIXED_LEN + EVENT_BLOCK_LEN; // 249: the identifiers start here
const MIN_LEN = V2_FIXED_LEN + 4; // 253: two identifiers of 1 byte each
const EVENT_FLAG = { EVENT_DIGEST_MATCH: 1, EVENT_LOG_COMPLETE: 2, B6_COVERAGE_OK: 4, CAPTURE_END_PRESENT: 8, START_UPTIME_PRESENT: 16 };
const EVENT_FLAG_RESERVED = 0xe0;

function digestBytes(d) {
  if (!/^sha256:[0-9a-f]{64}$/.test(d)) throw new Error(`bad digest ${d}`);
  return Buffer.from(d.slice(7), 'hex');
}
const digestString = (b) => `sha256:${b.toString('hex')}`;
function publicKeyObject(publicRaw) {
  return crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicRaw]), format: 'der', type: 'spki' });
}

// Event flags as the ERP derives them. Presence of capture_end_ms / start_uptime_ms is carried ONLY by b3 / b4
// (null = absent); the value bytes of an absent field are 0, never a sentinel.
function deriveEventFlags(f) {
  return (f.events_stored_digest === f.event_digest ? EVENT_FLAG.EVENT_DIGEST_MATCH : 0)
    | (f.event_log_complete ? EVENT_FLAG.EVENT_LOG_COMPLETE : 0)
    | (f.b6_coverage_ok ? EVENT_FLAG.B6_COVERAGE_OK : 0)
    | (f.capture_end_ms !== null && f.capture_end_ms !== undefined ? EVENT_FLAG.CAPTURE_END_PRESENT : 0)
    | (f.start_uptime_ms !== null && f.start_uptime_ms !== undefined ? EVENT_FLAG.START_UPTIME_PRESENT : 0);
}

// Builds the MTRCPT2 message. f = the MTRCPT1 fields (see receipt.js encodeMessage) + event_digest, events_stored_digest,
// warnings_count, command_changes_count, event_log_complete, b6_coverage_ok, capture_end_ms (number|null),
// start_uptime_ms (number|null). f.flags / f.event_flags may be given explicitly (vectors use this for inconsistent
// cases); an explicit capture_end_ms / start_uptime_ms value is written even if its presence bit is clear.
function encodeMessageV2(f) {
  const v1 = R.encodeMessage({ ...f, magic: f.magic || MAGIC_V2 }); // offsets 0..167 + identifiers
  const ev = Buffer.alloc(EVENT_BLOCK_LEN);
  digestBytes(f.event_digest).copy(ev, 0); // 168
  digestBytes(f.events_stored_digest).copy(ev, 32); // 200
  ev.writeUInt32LE(f.warnings_count, 64); // 232
  ev.writeUInt32LE(f.command_changes_count, 68); // 236
  ev.writeUInt8(f.event_flags ?? deriveEventFlags(f), 72); // 240
  ev.writeUInt32LE(f.capture_end_ms ?? 0, 73); // 241
  ev.writeUInt32LE(f.start_uptime_ms ?? 0, 77); // 245
  return Buffer.concat([v1.subarray(0, V1_FIXED_LEN), ev, v1.subarray(V1_FIXED_LEN)]);
}

// Strict parse. Returns { msg } or { reason }.
function decodeMessageV2(b) {
  if (b.length < 8) return { reason: 'MALFORMED_MESSAGE' };
  if (!b.subarray(0, 8).equals(MAGIC_V2)) return { reason: 'BAD_VERSION' };
  if (b.length < MIN_LEN) return { reason: 'MALFORMED_MESSAGE' };
  // The common part (enums, run flags + reserved bits, identifier lengths/characters, no trailing bytes) is parsed by
  // the MTRCPT1 decoder on the same bytes without the event block.
  const common = R.decodeMessage(Buffer.concat([R.MAGIC, b.subarray(8, V1_FIXED_LEN), b.subarray(V2_FIXED_LEN)]));
  if (!common.msg) return { reason: 'MALFORMED_MESSAGE' };
  const eventFlags = b[240];
  const captureEnd = b.readUInt32LE(241);
  const startUptime = b.readUInt32LE(245);
  if (eventFlags & EVENT_FLAG_RESERVED) return { reason: 'MALFORMED_MESSAGE' };
  if (!(eventFlags & EVENT_FLAG.CAPTURE_END_PRESENT) && captureEnd !== 0) return { reason: 'MALFORMED_MESSAGE' };
  if (!(eventFlags & EVENT_FLAG.START_UPTIME_PRESENT) && startUptime !== 0) return { reason: 'MALFORMED_MESSAGE' };
  const { vcu_id: vcuId, origin_boot_id: bootId, ...rest } = common.msg;
  return { msg: {
    ...rest,
    event_digest: digestString(b.subarray(168, 200)), events_stored_digest: digestString(b.subarray(200, 232)),
    warnings_count: b.readUInt32LE(232), command_changes_count: b.readUInt32LE(236), event_flags: eventFlags,
    capture_end_ms: eventFlags & EVENT_FLAG.CAPTURE_END_PRESENT ? captureEnd : null,
    start_uptime_ms: eventFlags & EVENT_FLAG.START_UPTIME_PRESENT ? startUptime : null,
    vcu_id: vcuId, origin_boot_id: bootId,
  } };
}

// ------------------------------------------------------------------ VCU decision (MTRCPT2)

// signed = { message, signature } (base64url strings, exactly as received)
// keyring = [{ key_id: hex16, public_key: base64url }] - the VCU's provisioned, non-revoked keys
// manifest = the VCU's own durable record of the run: the MTRCPT1 manifest fields + event_digest, warnings_count,
//   command_changes_count, event_log_complete, capture_end_ms (number|null), start_uptime_ms (number|null)
// Returns { release: boolean, reason }. Checks run in this order; the first failure is the reason.
function decideV2(signed, keyring, manifest) {
  const { FLAG } = R;
  const message = R.b64urlDecodeStrict(signed.message);
  const signature = R.b64urlDecodeStrict(signed.signature);
  if (!message || !signature || signature.length !== 64) return { release: false, reason: 'MALFORMED_ENCODING' };
  const { msg, reason } = decodeMessageV2(message);
  if (!msg) return { release: false, reason };
  const key = keyring.find((k) => k.key_id === msg.key_id);
  if (!key) return { release: false, reason: 'UNKNOWN_KEY' };
  const s = BigInt('0x' + Buffer.from(signature.subarray(32)).reverse().toString('hex'));
  if (s >= R.ED25519_L) return { release: false, reason: 'BAD_SIGNATURE' }; // non-canonical S (RFC 8032 5.1.7)
  if (!crypto.verify(null, message, publicKeyObject(R.b64urlDecodeStrict(key.public_key)), signature)) return { release: false, reason: 'BAD_SIGNATURE' };
  const started = (msg.flags & FLAG.STARTED) !== 0;
  const ef = msg.event_flags;
  // Signed flags must agree with the signed values: every MTRCPT1 rule, plus the event rules.
  if (((msg.flags & FLAG.RUN_DIGEST_MATCH) !== 0) !== (msg.samples_digest === msg.run_digest)
    || ((msg.flags & FLAG.HELD_COUNT_MATCH) !== 0) !== (msg.stored_sample_count === msg.held_count)
    || ((msg.flags & FLAG.RECORDING_COMPLETE) && msg.held_count !== msg.sample_count)
    || msg.held_count > msg.sample_count || msg.stored_sample_count > msg.held_count
    || (!started && (!(msg.flags & FLAG.RECORDING_COMPLETE) || msg.sample_count !== 0 || msg.stop_reason !== 'CONFIG_CANCELLED' || msg.final_state !== 'ABORTED' || msg.outcome !== 'INCOMPLETE'))
    || (started && msg.stop_reason === 'CONFIG_CANCELLED')
    || ((ef & EVENT_FLAG.EVENT_DIGEST_MATCH) !== 0) !== (msg.events_stored_digest === msg.event_digest)
    || ((ef & EVENT_FLAG.START_UPTIME_PRESENT) !== 0) !== started
    || ((ef & EVENT_FLAG.CAPTURE_END_PRESENT) !== 0) !== started) return { release: false, reason: 'FLAGS_INCONSISTENT' };
  const verdict = msg.outcome !== 'INCOMPLETE';
  if (!R.STOP_FOR_STATE[msg.final_state].includes(msg.stop_reason)
    || (verdict && (msg.final_state !== 'COMPLETED' || (msg.flags & 0x07) !== 0x07))) return { release: false, reason: 'LIFECYCLE_INCONSISTENT' };
  if (msg.test_id !== manifest.test_id) return { release: false, reason: 'TEST_ID_MISMATCH' };
  if (msg.vcu_id !== manifest.vcu_id) return { release: false, reason: 'VCU_ID_MISMATCH' };
  if (msg.origin_boot_id !== manifest.origin_boot_id) return { release: false, reason: 'BOOT_ID_MISMATCH' };
  if (msg.run_digest !== manifest.run_digest || msg.sample_count !== manifest.sample_count || msg.held_count !== manifest.held_count
    || started !== manifest.started
    || ((msg.flags & FLAG.RECORDING_COMPLETE) !== 0) !== manifest.recording_complete
    || msg.final_state !== manifest.final_state || msg.stop_reason !== manifest.stop_reason
    || msg.event_digest !== manifest.event_digest
    || msg.warnings_count !== manifest.warnings_count || msg.command_changes_count !== manifest.command_changes_count
    || ((ef & EVENT_FLAG.EVENT_LOG_COMPLETE) !== 0) !== manifest.event_log_complete
    || msg.capture_end_ms !== manifest.capture_end_ms || msg.start_uptime_ms !== manifest.start_uptime_ms) return { release: false, reason: 'MANIFEST_MISMATCH' };
  if (msg.stored_sample_count !== msg.held_count) return { release: false, reason: 'SHORTFALL' };
  if (msg.samples_digest !== msg.run_digest) return { release: false, reason: 'DIGEST_MISMATCH' };
  if (!(ef & EVENT_FLAG.EVENT_DIGEST_MATCH)) return { release: false, reason: 'EVENT_DIGEST_MISMATCH' };
  return { release: true, reason: 'RELEASE' };
}

module.exports = {
  MAGIC_V2, EVENT_FLAG, EVENT_FLAG_RESERVED, V2_FIXED_LEN, MIN_LEN,
  deriveEventFlags, encodeMessageV2, decodeMessageV2, decideV2,
};
