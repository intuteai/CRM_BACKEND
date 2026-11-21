// Signed archive receipt (contract v0.4, docs/motor-test/contract/receipt-signing.md sections 4-5).
// The ERP signs a fixed little-endian message with Ed25519 so the VCU can trust the receipt before it releases data.
// Key: RECEIPT_SIGNING_SEED = base64url of the 32-byte Ed25519 seed (private key). It lives only in the server's
// environment file (never in git, the Docker image or the database); the database holds the public key (mt_receipt_key).
// Without the variable, v0.4 receipts carry signed_receipt: null.
'use strict';
const crypto = require('crypto');

const MAGIC = Buffer.from('MTRCPT1\0', 'latin1');
const FINAL_STATE = { COMPLETED: 1, ABORTED: 2, FAULT: 3 };
const OUTCOME = { PASS: 1, FAIL: 2, INCOMPLETE: 3, INVALID: 4 };
const STOP_REASON = { RAMP_COMPLETE: 1, OPERATOR_STOP: 2, HB_LOSS: 3, FAULT: 4, POWER_LOSS: 5, CONFIG_CANCELLED: 6 };
const FLAG = { RUN_DIGEST_MATCH: 1, HELD_COUNT_MATCH: 2, RECORDING_COMPLETE: 4, STARTED: 8 };
const ID_RE = /^[A-Za-z0-9._-]{1,32}$/;

let cached; // { privateKey, publicRaw, keyId } | null
function loadKey() {
  if (cached !== undefined) return cached;
  const text = String(process.env.RECEIPT_SIGNING_SEED || '').trim();
  if (!text) { cached = null; return cached; }
  const seed = Buffer.from(text, 'base64url');
  if (seed.length !== 32 || seed.toString('base64url') !== text) throw new Error('RECEIPT_SIGNING_SEED must be base64url of exactly 32 bytes');
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  const publicRaw = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
  cached = { privateKey, publicRaw, keyId: crypto.createHash('sha256').update(publicRaw).digest().subarray(0, 8).toString('hex') };
  return cached;
}
function resetKeyCache() { cached = undefined; } // tests only

const uuidBytes = (u) => Buffer.from(u.replace(/-/g, ''), 'hex');
const digestBytes = (d) => Buffer.from(d.slice(7), 'hex');

// f: { key_id(hex), test_id, receipt_id, stored_at(Date), sample_count, held_count, stored_sample_count, final_state,
//      outcome, stop_reason, run_digest, samples_digest, payload_hash, recording_complete, started, vcu_id, origin_boot_id }
function buildMessage(f) {
  if (!ID_RE.test(f.vcu_id) || !ID_RE.test(f.origin_boot_id)) throw new Error('vcu_id / origin_boot_id outside receipt identifier rules');
  const vcu = Buffer.from(f.vcu_id, 'latin1');
  const boot = Buffer.from(f.origin_boot_id, 'latin1');
  const b = Buffer.alloc(170 + vcu.length + boot.length);
  MAGIC.copy(b, 0);
  Buffer.from(f.key_id, 'hex').copy(b, 8);
  uuidBytes(f.test_id).copy(b, 16);
  uuidBytes(f.receipt_id).copy(b, 32);
  b.writeBigInt64LE(BigInt(f.stored_at.getTime()), 48);
  b.writeUInt32LE(f.sample_count, 56);
  b.writeUInt32LE(f.held_count, 60);
  b.writeUInt32LE(f.stored_sample_count, 64);
  b.writeUInt8(FINAL_STATE[f.final_state], 68);
  b.writeUInt8(OUTCOME[f.outcome], 69);
  b.writeUInt8(STOP_REASON[f.stop_reason], 70);
  b.writeUInt8((f.samples_digest === f.run_digest ? FLAG.RUN_DIGEST_MATCH : 0)
    | (f.stored_sample_count === f.held_count ? FLAG.HELD_COUNT_MATCH : 0)
    | (f.recording_complete ? FLAG.RECORDING_COMPLETE : 0) // the VCU's own flag, never derived from the counts
    | (f.started ? FLAG.STARTED : 0), 71);
  digestBytes(f.run_digest).copy(b, 72);
  digestBytes(f.samples_digest).copy(b, 104);
  digestBytes(f.payload_hash).copy(b, 136);
  b.writeUInt8(vcu.length, 168);
  vcu.copy(b, 169);
  b.writeUInt8(boot.length, 169 + vcu.length);
  boot.copy(b, 170 + vcu.length);
  return b;
}

// MTRCPT2 (contract v0.5, receipt-signing.md section 11): the MTRCPT1 fields with magic "MTRCPT2\0", plus an event block
// before the identifiers. Optional values are 0 with a presence flag, never a sentinel.
const MAGIC2 = Buffer.from('MTRCPT2\0', 'latin1');
const EVENT_FLAG = { EVENT_DIGEST_MATCH: 1, EVENT_LOG_COMPLETE: 2, B6_COVERAGE_OK: 4, CAPTURE_END_PRESENT: 8, START_UPTIME_PRESENT: 16 };
// f: the MTRCPT1 fields + { event_digest, events_stored_digest, warnings_count, command_changes_count, event_log_complete,
//     b6_coverage_ok, capture_end_ms (number|null), start_uptime_ms (number|null) }
function buildMessageV2(f) {
  const v1 = buildMessage(f);
  const block = Buffer.alloc(81);
  digestBytes(f.event_digest).copy(block, 0);
  digestBytes(f.events_stored_digest).copy(block, 32);
  block.writeUInt32LE(f.warnings_count, 64);
  block.writeUInt32LE(f.command_changes_count, 68);
  block.writeUInt8((f.events_stored_digest === f.event_digest ? EVENT_FLAG.EVENT_DIGEST_MATCH : 0)
    | (f.event_log_complete ? EVENT_FLAG.EVENT_LOG_COMPLETE : 0)
    | (f.b6_coverage_ok ? EVENT_FLAG.B6_COVERAGE_OK : 0)
    | (f.capture_end_ms !== null ? EVENT_FLAG.CAPTURE_END_PRESENT : 0)
    | (f.start_uptime_ms !== null ? EVENT_FLAG.START_UPTIME_PRESENT : 0), 72);
  block.writeUInt32LE(f.capture_end_ms ?? 0, 73);
  block.writeUInt32LE(f.start_uptime_ms ?? 0, 77);
  return Buffer.concat([MAGIC2, v1.subarray(8, 168), block, v1.subarray(168)]);
}

// Returns { key_id, signed_message, signature } or null when no key is configured. version 2 = MTRCPT2.
function signReceipt(fields, version = 1) {
  const key = loadKey();
  if (!key) return null;
  const message = version === 2 ? buildMessageV2({ ...fields, key_id: key.keyId }) : buildMessage({ ...fields, key_id: key.keyId });
  return { key_id: key.keyId, public_key: key.publicRaw, signed_message: message, signature: crypto.sign(null, message, key.privateKey) };
}

const signedReceiptJson = (r) => (r && r.signing_key_id
  ? { alg: 'Ed25519', key_id: r.signing_key_id, message: Buffer.from(r.signed_message).toString('base64url'), signature: Buffer.from(r.signature).toString('base64url') }
  : null);

module.exports = { loadKey, resetKeyCache, buildMessage, buildMessageV2, signReceipt, signedReceiptJson };
