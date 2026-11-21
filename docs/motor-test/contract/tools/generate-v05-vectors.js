// Generates vectors/v05-event-vectors.json (contract v0.5 DRAFT R2): accepted / rejected / flagged examples and digests.
//   node docs/motor-test/contract/tools/generate-v05-vectors.js
// Then: python docs/motor-test/contract/tools/check_v05_vectors.py
'use strict';
const fs = require('fs');
const path = require('path');
const { validate, eventDigest } = require('./v05');

const B5 = 0x20; const B6 = 0x40; const BASE = 7; // b0-b2 valid
// A run: 10 readings every 100 ms; step 0 marker on reading 0, step 1 marker on reading 5; capture closes at 900 ms.
function run(over = {}) {
  const samples = Array.from({ length: 10 }, (_, i) => ({ sample_seq: i, t_ms: i * 100, status_flags: BASE | (i === 0 || i === 5 ? B5 : 0) }));
  return { started: true, held_count: 10, samples, ...over };
}
const W = (seq, t, kind, source, o = {}) => ({ seq, t_ms: t, phase: t < 0 ? 'PRE_START' : t > 900 ? 'POST_CAPTURE' : 'CAPTURE', kind, source,
  limit_id: source === 'VCU_LIMIT' ? 'RPM_DEVIATION' : null, code: null, status_t_ms: null, reason: null, detail: null, ...o });
const cmds = () => [
  { step: 0, t_ms: 0, rpm_cmd: 500, link: 'OWNS_READING', first_sample_seq: 0 },
  { step: 1, t_ms: 480, rpm_cmd: 1000, link: 'OWNS_READING', first_sample_seq: 5 },
];
function ev(warnings, commands = cmds(), o = {}) {
  const e = { capture_end_ms: 900, warnings, command_changes: commands,
    event_log: { warnings_count: warnings.length, command_changes_count: commands.length, complete: true, lost_count: 0 }, ...o };
  e.event_digest = e.event_digest ?? eventDigest(e);
  return e;
}
const b6 = (seqs) => (r) => { r.samples.forEach((s) => { if (seqs.includes(s.sample_seq)) s.status_flags |= B6; }); return r; };

const cases = [
  ['E1', 'warning raised and cleared during capture, detail code read', ev([W(0, 250, 'RAISED', 'STATUS_BIT6'), W(1, 290, 'DETAIL', 'SDO_2031_11', { code: 133, status_t_ms: 250 }), W(2, 420, 'CLEARED', 'STATUS_BIT6')]), b6([3, 4])(run()), { accept: true }],
  ['E2', 'warning already active at capture start, cleared later', ev([W(0, -40, 'ACTIVE_AT_START', 'STATUS_BIT6'), W(1, 150, 'CLEARED', 'STATUS_BIT6')]), b6([0, 1])(run()), { accept: true }],
  ['E3', 'status unknown, then known again: no transition; the unknown span counts as active', ev([W(0, 300, 'STATUS_UNKNOWN', 'STATUS_BIT6'), W(1, 500, 'STATUS_KNOWN', 'STATUS_BIT6')]), b6([3, 4, 5])(run()), { accept: true }],
  ['E4', 'detail reply received after capture closed (POST_CAPTURE)', ev([W(0, 880, 'RAISED', 'STATUS_BIT6'), W(1, 960, 'DETAIL', 'SDO_2031_11', { code: 141, status_t_ms: 880 })]), run(), { accept: true }],
  ['E5', 'reply after the 200 ms timeout: DETAIL_UNAVAILABLE TIMEOUT then DETAIL_AMBIGUOUS LATE_REPLY', ev([W(0, 100, 'RAISED', 'VCU_LIMIT'), W(1, 300, 'DETAIL_UNAVAILABLE', 'SDO_2031_11', { status_t_ms: 100, reason: 'TIMEOUT' }), W(2, 340, 'DETAIL_AMBIGUOUS', 'SDO_2031_11', { code: 138, status_t_ms: 100, reason: 'LATE_REPLY' })]), run(), { accept: true }],
  ['E6', 'two changes before one reading: step 1 SUPERSEDED, step 2 owns reading 5', ev([], [cmds()[0], { step: 1, t_ms: 450, rpm_cmd: 800, link: 'SUPERSEDED', first_sample_seq: null }, { step: 2, t_ms: 480, rpm_cmd: 1000, link: 'OWNS_READING', first_sample_seq: 5 }]), run(), { accept: true }],
  ['E7', 'reading acquired but not retained (held 5 of 10; the step 1 marker reading was lost)', ev([], [cmds()[0], { step: 1, t_ms: 480, rpm_cmd: 1000, link: 'READING_NOT_RETAINED', first_sample_seq: 5 }]), run({ held_count: 5, samples: run().samples.slice(0, 5) }), { accept: true }],
  ['E8', 'CANCEL: no events, complete log', ev([], [], { capture_end_ms: null }), { started: false, held_count: 0, samples: [] }, { accept: true }],
  ['R1', 'CLEARED without an open warning', ev([W(0, 200, 'CLEARED', 'STATUS_BIT6')]), run(), { status: 422, rule: 'WARNING_PAIRING' }],
  ['R2', 'phase CAPTURE with a negative t_ms', ev([{ ...W(0, -10, 'RAISED', 'STATUS_BIT6'), phase: 'CAPTURE' }]), run(), { status: 422, rule: 'EVENT_PHASE' }],
  ['R3', 'code on a RAISED record', ev([W(0, 200, 'RAISED', 'STATUS_BIT6', { code: 133 })]), run(), { status: 400, rule: 'EVENT_FIELDS' }],
  ['R4', 'event_log count differs from the array length', ev([W(0, 200, 'RAISED', 'STATUS_BIT6')], cmds(), { event_log: { warnings_count: 2, command_changes_count: 2, complete: true, lost_count: 0 } }), run(), { status: 422, rule: 'EVENT_COUNTS' }],
  ['R5', 'two changes claim the same b5 reading', ev([], [cmds()[0], { step: 1, t_ms: 480, rpm_cmd: 1000, link: 'OWNS_READING', first_sample_seq: 0 }]), run(), { status: 422, rule: 'COMMAND_LINK' }],
  ['R6', 'gap in warnings seq', ev([W(0, 200, 'RAISED', 'STATUS_BIT6'), W(2, 300, 'CLEARED', 'STATUS_BIT6')]), run(), { status: 422, rule: 'EVENT_ORDER' }],
  ['R7', 'event_digest does not match the arrays: stored, receipt event_digest_match = false (no release)', ev([W(0, 200, 'RAISED', 'STATUS_BIT6')], cmds(), { event_digest: 'sha256:' + '0'.repeat(64) }), run(), { accept: true, flags: { event_digest_match: false } }],
  ['F1', 'reading with b6 outside any warning interval: stored, flagged B6_COVERAGE', ev([]), b6([7])(run()), { accept: true, flags: { b6_coverage_ok: false } }],
  ['F2', 'incomplete event log (one known lost event): accepted; evaluation decides (S4)', ev([], cmds(), { event_log: { warnings_count: 0, command_changes_count: 2, complete: false, lost_count: 1 } }), run(), { accept: true }],
];

let failures = 0;
const out = cases.map(([id, description, events, runCtx, expect]) => {
  const got = validate(events, runCtx);
  let ok;
  if (expect.accept) ok = got.ok && Object.entries(expect.flags || {}).every(([k, v]) => got.flags[k] === v)
    && (expect.flags?.event_digest_match === false || got.flags.event_digest_match);
  else ok = !got.ok && got.status === expect.status && got.rule === expect.rule;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${description}: ${got.ok ? 'accepted ' + JSON.stringify(got.flags) : got.status + ' ' + got.rule}`);
  return { id, description, v05_fields: events, run_context: runCtx,
    expected: got.ok ? { result: 'accepted', flags: got.flags, recomputed_event_digest: got.digest } : { result: 'rejected', status: got.status, rule: got.rule } };
});
if (failures) { console.error(`${failures} case(s) unexpected`); process.exit(1); }
const file = path.join(__dirname, '..', 'vectors', 'v05-event-vectors.json');
fs.writeFileSync(file, JSON.stringify({ title: 'Contract v0.5 DRAFT R2 examples (warning events, command changes, event digest)',
  spec: 'docs/motor-test/contract/v05-warning-events.md', note: 'run_context = the stored readings (status_flags: b5 0x20, b6 0x40) the ERP checks links and coverage against.', cases: out }, null, 2) + '\n');
console.log(`wrote ${out.length} cases`);
