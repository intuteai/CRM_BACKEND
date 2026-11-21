// Contract v0.5 DRAFT R2 reference: event validation and the event digest (docs/motor-test/contract/v05-warning-events.md).
// Not used by the ERP API yet. tools/check_v05_vectors.py re-computes the digests independently.
'use strict';
const crypto = require('crypto');

const PHASE = { PRE_START: 1, CAPTURE: 2, POST_CAPTURE: 3 };
const KIND = { ACTIVE_AT_START: 1, RAISED: 2, CLEARED: 3, STATUS_UNKNOWN: 4, STATUS_KNOWN: 5, DETAIL: 6, DETAIL_UNAVAILABLE: 7, DETAIL_AMBIGUOUS: 8 };
const SOURCE = { STATUS_BIT6: 1, VCU_LIMIT: 2, SDO_2031_11: 3 };
const REASON = { TIMEOUT: 1, ABORT: 2, MALFORMED: 3, LATE_REPLY: 4 };
const LINK = { OWNS_READING: 1, SUPERSEDED: 2, NO_READING: 3, READING_NOT_RETAINED: 4 };
const TRANSITION_KINDS = ['ACTIVE_AT_START', 'RAISED', 'CLEARED', 'STATUS_UNKNOWN', 'STATUS_KNOWN'];
const DETAIL_KINDS = ['DETAIL', 'DETAIL_UNAVAILABLE', 'DETAIL_AMBIGUOUS'];
const LIMIT_RE = /^[A-Z0-9_]{1,40}$/;

const fail = (status, rule, msg) => ({ ok: false, status, rule, msg });
const isI32 = (v) => Number.isInteger(v) && v >= -2147483648 && v <= 2147483647;
const isU32 = (v) => Number.isInteger(v) && v >= 0 && v <= 4294967295;

// ev = { capture_end_ms, event_log, warnings, command_changes, event_digest }
// run = { started, held_count, samples:[{sample_seq, t_ms, status_flags}] }
// Returns { ok:true, flags:{ event_digest_match, b6_coverage_ok }, digest } or a failure.
function validate(ev, run) {
  const W = ev.warnings; const C = ev.command_changes; const L = ev.event_log;
  if (!Array.isArray(W) || !Array.isArray(C) || !L || typeof L !== 'object') return fail(400, 'EVENT_FIELDS', 'warnings, command_changes and event_log are required');
  if (W.length > 10000 || C.length > 10000) return fail(400, 'EVENT_FIELDS', 'at most 10000 records per array');
  if (!(ev.capture_end_ms === null ? run.started === false : isU32(ev.capture_end_ms))) return fail(400, 'EVENT_FIELDS', 'capture_end_ms: uint32, null only for CANCEL');
  if (typeof L.complete !== 'boolean' || !isU32(L.warnings_count) || !isU32(L.command_changes_count)
    || !(L.complete ? L.lost_count === 0 : (L.lost_count === null || (isU32(L.lost_count) && L.lost_count >= 1)))) return fail(400, 'EVENT_FIELDS', 'event_log fields');
  // ---- field combinations (400)
  for (const [i, w] of W.entries()) {
    const p = `warnings[${i}]`;
    if (!isU32(w.seq) || !isI32(w.t_ms) || !(w.phase in PHASE) || !(w.kind in KIND) || !(w.source in SOURCE)) return fail(400, 'EVENT_FIELDS', `${p}: seq/t_ms/phase/kind/source`);
    const detail = DETAIL_KINDS.includes(w.kind);
    if (detail !== (w.source === 'SDO_2031_11')) return fail(400, 'EVENT_FIELDS', `${p}: detail kinds only with SDO_2031_11, transitions only with STATUS_BIT6 / VCU_LIMIT`);
    if ((w.limit_id !== null) !== (w.source === 'VCU_LIMIT') || (w.limit_id !== null && !LIMIT_RE.test(w.limit_id))) return fail(400, 'EVENT_FIELDS', `${p}: limit_id only (and always) with VCU_LIMIT`);
    if ((w.code !== null) !== ['DETAIL', 'DETAIL_AMBIGUOUS'].includes(w.kind) || (w.code !== null && !(Number.isInteger(w.code) && w.code >= 0 && w.code <= 65535))) return fail(400, 'EVENT_FIELDS', `${p}: code only on DETAIL / DETAIL_AMBIGUOUS`);
    if ((w.status_t_ms !== null) !== detail || (w.status_t_ms !== null && !isI32(w.status_t_ms))) return fail(400, 'EVENT_FIELDS', `${p}: status_t_ms only on detail kinds`);
    const needReason = ['DETAIL_UNAVAILABLE', 'DETAIL_AMBIGUOUS'].includes(w.kind);
    if ((w.reason !== null) !== needReason || (w.reason !== null && !(w.reason in REASON))
      || (w.kind === 'DETAIL_AMBIGUOUS' && w.reason !== 'LATE_REPLY') || (w.kind === 'DETAIL_UNAVAILABLE' && w.reason === 'LATE_REPLY')) return fail(400, 'EVENT_FIELDS', `${p}: reason`);
    if (w.detail !== null && !(typeof w.detail === 'string' && w.detail.length <= 200)) return fail(400, 'EVENT_FIELDS', `${p}: detail`);
  }
  for (const [i, c] of C.entries()) {
    const p = `command_changes[${i}]`;
    if (!isU32(c.step) || !isI32(c.t_ms) || c.t_ms < 0 || !isI32(c.rpm_cmd) || !(c.link in LINK)) return fail(400, 'EVENT_FIELDS', `${p}: step/t_ms/rpm_cmd/link`);
    const needSeq = ['OWNS_READING', 'READING_NOT_RETAINED'].includes(c.link);
    if ((c.first_sample_seq !== null) !== needSeq || (needSeq && !isU32(c.first_sample_seq))) return fail(400, 'EVENT_FIELDS', `${p}: first_sample_seq per link`);
  }
  // ---- counts, order, phase (422)
  if (L.warnings_count !== W.length || L.command_changes_count !== C.length) return fail(422, 'EVENT_COUNTS', 'event_log counts differ from the arrays');
  if (W.some((w, i) => w.seq !== i)) return fail(422, 'EVENT_ORDER', 'warnings seq must be 0..n-1');
  if (C.some((c, i) => c.step !== i || (i > 0 && c.t_ms < C[i - 1].t_ms))) return fail(422, 'COMMAND_ORDER', 'step 0..n-1 with non-decreasing t_ms');
  for (const w of W) {
    const ph = w.t_ms < 0 ? 'PRE_START' : (ev.capture_end_ms !== null && w.t_ms > ev.capture_end_ms ? 'POST_CAPTURE' : 'CAPTURE');
    if (w.phase !== ph || (w.kind === 'ACTIVE_AT_START' && w.t_ms > 0)) return fail(422, 'EVENT_PHASE', `warnings seq ${w.seq}: phase ${w.phase} does not match t_ms ${w.t_ms}`);
  }
  // ---- pairing per source+limit
  const state = new Map(); // key -> clear|active|unknown
  for (const w of W.filter((x) => TRANSITION_KINDS.includes(x.kind))) {
    const k = `${w.source}/${w.limit_id}`; const s = state.get(k) || 'clear';
    const ok = { ACTIVE_AT_START: s === 'clear', RAISED: s === 'clear', CLEARED: s === 'active', STATUS_UNKNOWN: true, STATUS_KNOWN: s === 'unknown' }[w.kind];
    if (!ok) return fail(422, 'WARNING_PAIRING', `warnings seq ${w.seq}: ${w.kind} not allowed when ${k} is ${s}`);
    state.set(k, { ACTIVE_AT_START: 'active', RAISED: 'active', CLEARED: 'clear', STATUS_UNKNOWN: 'unknown', STATUS_KNOWN: 'clear' }[w.kind]);
  }
  // ---- command links
  const stored = new Map(run.samples.map((s) => [s.sample_seq, s]));
  const owners = new Map();
  for (const c of C) {
    if (c.link === 'OWNS_READING') {
      const s = stored.get(c.first_sample_seq);
      if (!s || !(s.status_flags & 0x20) || s.t_ms < c.t_ms) return fail(422, 'COMMAND_LINK', `step ${c.step}: owned reading must be stored, carry b5 and not precede the change`);
      if (owners.has(c.first_sample_seq)) return fail(422, 'COMMAND_LINK', `steps ${owners.get(c.first_sample_seq)} and ${c.step} claim reading ${c.first_sample_seq}`);
      owners.set(c.first_sample_seq, c.step);
    }
    if (c.link === 'READING_NOT_RETAINED' && c.first_sample_seq < run.held_count) return fail(422, 'COMMAND_LINK', `step ${c.step}: a not-retained reading must be beyond held_count`);
  }
  if (run.samples.some((s) => (s.status_flags & 0x20) && !owners.has(s.sample_seq))) return fail(422, 'COMMAND_LINK', 'every stored b5 reading must be owned by exactly one change');
  // ---- flags (stored, not rejected)
  const intervals = []; const open = new Map();
  for (const w of W.filter((x) => TRANSITION_KINDS.includes(x.kind))) {
    const k = `${w.source}/${w.limit_id}`;
    if (['ACTIVE_AT_START', 'RAISED', 'STATUS_UNKNOWN'].includes(w.kind) && !open.has(k)) open.set(k, w.t_ms);
    if (['CLEARED', 'STATUS_KNOWN'].includes(w.kind) && open.has(k)) { intervals.push([open.get(k), w.t_ms]); open.delete(k); }
  }
  for (const start of open.values()) intervals.push([start, Infinity]);
  const b6CoverageOk = run.samples.every((s) => !(s.status_flags & 0x40) || intervals.some(([a, b]) => s.t_ms >= a && s.t_ms <= b));
  const digest = eventDigest(ev);
  return { ok: true, flags: { event_digest_match: digest === ev.event_digest, b6_coverage_ok: b6CoverageOk }, digest };
}

function eventDigest(ev) {
  const parts = [Buffer.from('MTEVT1\0\0', 'latin1')];
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
  parts.push(u32(ev.warnings.length));
  for (const w of ev.warnings) {
    const lim = w.limit_id === null ? Buffer.alloc(0) : Buffer.from(w.limit_id, 'latin1');
    const mask = (w.code !== null ? 1 : 0) | (w.status_t_ms !== null ? 2 : 0) | (w.limit_id !== null ? 4 : 0);
    const head = Buffer.alloc(4 + 4 + 5 + 2 + 4 + 1);
    head.writeUInt32LE(w.seq, 0); head.writeInt32LE(w.t_ms, 4);
    head.writeUInt8(PHASE[w.phase], 8); head.writeUInt8(KIND[w.kind], 9); head.writeUInt8(SOURCE[w.source], 10);
    head.writeUInt8(w.reason === null ? 0 : REASON[w.reason], 11); head.writeUInt8(mask, 12);
    head.writeUInt16LE(w.code ?? 0, 13); head.writeInt32LE(w.status_t_ms ?? 0, 15); head.writeUInt8(lim.length, 19);
    parts.push(head, lim);
  }
  parts.push(u32(ev.command_changes.length));
  for (const c of ev.command_changes) {
    const b = Buffer.alloc(4 + 4 + 4 + 1 + 1 + 4);
    b.writeUInt32LE(c.step, 0); b.writeInt32LE(c.t_ms, 4); b.writeInt32LE(c.rpm_cmd, 8); b.writeUInt8(LINK[c.link], 12);
    b.writeUInt8(c.first_sample_seq === null ? 0 : 1, 13); b.writeUInt32LE(c.first_sample_seq ?? 0, 14);
    parts.push(b);
  }
  parts.push(Buffer.from([ev.event_log.complete ? 1 : 0]), u32(ev.event_log.lost_count === null ? 0xffffffff : ev.event_log.lost_count));
  return 'sha256:' + crypto.createHash('sha256').update(Buffer.concat(parts)).digest('hex');
}

module.exports = { validate, eventDigest, PHASE, KIND, SOURCE, REASON, LINK };
