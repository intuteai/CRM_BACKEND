// Generates vectors/v05-event-vectors.json (contract v0.5 DRAFT R3): accepted / rejected / flagged examples and digests.
//   node docs/motor-test/contract/tools/generate-v05-vectors.js
// Then: python docs/motor-test/contract/tools/check_v05_vectors.py
// P01-P11 = Mayank's R2 review probes (V05_R2_CONSOLIDATED_REVIEW, 2026-11-21).
'use strict';
const fs = require('fs');
const path = require('path');
const { validate, eventDigest } = require('./v05');

const B5 = 0x20; const B6 = 0x40; const BASE = 7;
// A started run: 10 readings every 100 ms; step 0 (500 rpm) marker on reading 0, step 1 (1000 rpm) on reading 5; capture closes at 900 ms.
function run(over = {}) {
  const samples = Array.from({ length: 10 }, (_, i) => ({ sample_seq: i, t_ms: i * 100, rpm_cmd: i < 5 ? 500 : 1000, status_flags: BASE | (i === 0 || i === 5 ? B5 : 0) }));
  return { started: true, start_uptime_ms: 5000, held_count: 10, samples, ...over };
}
const CANCEL_RUN = { started: false, start_uptime_ms: null, held_count: 0, samples: [] };
const W = (seq, t, kind, source, o = {}) => ({ seq, t_ms: t, phase: t < 0 ? 'PRE_START' : t > 900 ? 'POST_CAPTURE' : 'CAPTURE', kind, source,
  limit_id: source === 'VCU_LIMIT' ? 'RPM_DEVIATION' : null, code: null, status_t_ms: null, reason: null, restored_state: null, detail: null, ...o });
const cmds = () => [
  { step: 0, t_ms: 0, rpm_cmd: 500, link: 'OWNS_READING', first_sample_seq: 0 },
  { step: 1, t_ms: 480, rpm_cmd: 1000, link: 'OWNS_READING', first_sample_seq: 5 },
];
const log = (w, c, o = {}) => ({ warnings_count: w.length, command_changes_count: c.length, complete: true, lost_count: 0, ...o });
function ev(r, warnings, commands = cmds(), o = {}) {
  const e = { capture_end_ms: r.started ? 900 : null, warnings, command_changes: commands, event_log: log(warnings, commands, o.event_log), ...o };
  delete e.digest_from; e.event_log = log(warnings, commands, o.event_log);
  e.event_digest = o.event_digest ?? eventDigest(o.digest_from ?? e, r);
  return e;
}
const b6 = (seqs) => (r) => { r.samples.forEach((s) => { if (seqs.includes(s.sample_seq)) s.status_flags |= B6; }); return r; };

const cases = [];
const add = (id, description, r, e, expect) => cases.push([id, description, e, r, expect]);
const OK = { accept: true };
{ const r = b6([3, 4])(run()); add('E1', 'warning raised and cleared during capture, detail code read', r, ev(r, [W(0, 250, 'RAISED', 'STATUS_BIT6'), W(1, 290, 'DETAIL', 'SDO_2031_11', { code: 133, status_t_ms: 250 }), W(2, 420, 'CLEARED', 'STATUS_BIT6')]), OK); }
{ const r = b6([0, 1])(run()); add('E2', 'warning already active at capture start, cleared later', r, ev(r, [W(0, -40, 'ACTIVE_AT_START', 'STATUS_BIT6'), W(1, 150, 'CLEARED', 'STATUS_BIT6')]), OK); }
{ const r = b6([3, 4, 5])(run()); add('E3', 'status unknown, then known again as CLEAR (no transition); the unknown span counts as active', r, ev(r, [W(0, 300, 'STATUS_UNKNOWN', 'STATUS_BIT6'), W(1, 500, 'STATUS_KNOWN', 'STATUS_BIT6', { restored_state: 'CLEAR' })]), OK); }
{ const r = run(); add('E4', 'detail reply received after capture closed (POST_CAPTURE)', r, ev(r, [W(0, 880, 'RAISED', 'STATUS_BIT6'), W(1, 960, 'DETAIL', 'SDO_2031_11', { code: 141, status_t_ms: 880 })]), OK); }
{ const r = run(); add('E5', 'reply after the timeout: DETAIL_UNAVAILABLE TIMEOUT then DETAIL_AMBIGUOUS LATE_REPLY', r, ev(r, [W(0, 100, 'RAISED', 'VCU_LIMIT'), W(1, 300, 'DETAIL_UNAVAILABLE', 'SDO_2031_11', { status_t_ms: 100, reason: 'TIMEOUT' }), W(2, 340, 'DETAIL_AMBIGUOUS', 'SDO_2031_11', { code: 138, status_t_ms: 100, reason: 'LATE_REPLY' })]), OK); }
{ const r = run(); add('E6', 'two changes before one reading: step 1 SUPERSEDED, step 2 owns reading 5', r, ev(r, [], [cmds()[0], { step: 1, t_ms: 450, rpm_cmd: 800, link: 'SUPERSEDED', first_sample_seq: null }, { step: 2, t_ms: 480, rpm_cmd: 1000, link: 'OWNS_READING', first_sample_seq: 5 }]), OK); }
{ const r = run({ held_count: 5, samples: run().samples.slice(0, 5) }); add('E7', 'reading acquired but not retained (held 5 of 10; the step 1 marker reading was lost)', r, ev(r, [], [cmds()[0], { step: 1, t_ms: 480, rpm_cmd: 1000, link: 'READING_NOT_RETAINED', first_sample_seq: 5 }]), OK); }
add('E8', 'CANCEL: no events, no commands, capture_end_ms null, complete log', CANCEL_RUN, ev(CANCEL_RUN, [], []), OK);
{ const r = b6([3, 4, 5, 6])(run()); add('E9', 'P03 fixed: RAISED, STATUS_UNKNOWN, STATUS_KNOWN restored ACTIVE, then a genuine CLEARED', r, ev(r, [W(0, 250, 'RAISED', 'STATUS_BIT6'), W(1, 400, 'STATUS_UNKNOWN', 'STATUS_BIT6'), W(2, 520, 'STATUS_KNOWN', 'STATUS_BIT6', { restored_state: 'ACTIVE' }), W(3, 680, 'CLEARED', 'STATUS_BIT6')]), OK); }
{ const r = run(); add('E10', 'P04 fixed: incomplete log, step 0 lost, real step 1 retained with its identity (no renumbering)', r, ev(r, [], [cmds()[1]], { event_log: { complete: false, lost_count: 1 } }), OK); }
{ const r = run(); add('E11', 'incomplete log with an unknown number of lost events (lost_count null) and a seq gap', r, ev(r, [W(0, 200, 'RAISED', 'STATUS_BIT6'), W(3, 600, 'CLEARED', 'STATUS_BIT6')], cmds(), { event_log: { complete: false, lost_count: null } }), OK); }
{ const r = run(); add('E12', 'equal timestamps are allowed; order is seq', r, ev(r, [W(0, 300, 'RAISED', 'STATUS_BIT6'), W(1, 300, 'DETAIL', 'SDO_2031_11', { code: 133, status_t_ms: 300 })]), OK); }
{ const r = run(); add('R1', 'CLEARED without an open warning', r, ev(r, [W(0, 200, 'CLEARED', 'STATUS_BIT6')]), { status: 422, rule: 'WARNING_PAIRING' }); }
{ const r = run(); add('R2', 'phase CAPTURE with a negative t_ms', r, ev(r, [{ ...W(0, -10, 'RAISED', 'STATUS_BIT6'), phase: 'CAPTURE' }]), { status: 422, rule: 'EVENT_PHASE' }); }
{ const r = run(); add('R3', 'code on a RAISED record', r, ev(r, [W(0, 200, 'RAISED', 'STATUS_BIT6', { code: 133 })]), { status: 400, rule: 'EVENT_FIELDS' }); }
{ const r = run(); const w = [W(0, 200, 'RAISED', 'STATUS_BIT6')]; add('R4', 'event_log count differs from the array length', r, ev(r, w, cmds(), { event_log: { warnings_count: 2 } }), { status: 422, rule: 'EVENT_COUNTS' }); }
{ const r = run(); add('R5', 'two changes claim the same b5 reading', r, ev(r, [], [cmds()[0], { step: 1, t_ms: 480, rpm_cmd: 500, link: 'OWNS_READING', first_sample_seq: 0 }]), { status: 422, rule: 'COMMAND_LINK' }); }
{ const r = run(); add('R6', 'gap in warnings seq with a complete log', r, ev(r, [W(0, 200, 'RAISED', 'STATUS_BIT6'), W(2, 300, 'CLEARED', 'STATUS_BIT6')]), { status: 422, rule: 'EVENT_ORDER' }); }
{ const r = run(); add('R7', 'event_digest does not match the arrays: stored, event_digest_match = false (no release)', r, ev(r, [W(0, 200, 'RAISED', 'STATUS_BIT6')], cmds(), { event_digest: 'sha256:' + '0'.repeat(64) }), { accept: true, flags: { event_digest_match: false } }); }
{ const r = run({ held_count: 0, samples: [] }); add('P01', 'started run, complete log, no command changes (step 0 missing)', r, ev(r, [], []), { status: 422, rule: 'COMMAND_MISSING_STEP0' }); }
add('P02', 'CANCEL with capture_end_ms 900', CANCEL_RUN, ev(CANCEL_RUN, [], [], { capture_end_ms: 900 }), { status: 422, rule: 'CANCEL_SHAPE' });
{ const r = run(); add('P02b', 'CANCEL with a command change', CANCEL_RUN, ev(CANCEL_RUN, [], [cmds()[0]]), { status: 422, rule: 'CANCEL_SHAPE' }); void r; }
{ const r = run(); add('P03b', 'STATUS_KNOWN without restored_state', r, ev(r, [W(0, 300, 'STATUS_UNKNOWN', 'STATUS_BIT6'), W(1, 500, 'STATUS_KNOWN', 'STATUS_BIT6')]), { status: 400, rule: 'EVENT_FIELDS' }); }
{ const r = run(); add('P04b', 'complete log that starts at step 1 (step 0 missing but claimed complete)', r, ev(r, [], [cmds()[1]]), { status: 422, rule: 'COMMAND_ORDER' }); }
{ const r = run(); add('C1', 'lost_count 4294967295 (reserved, never a valid count)', r, ev(r, [], cmds(), { event_log: { complete: false, lost_count: 4294967295 } }), { status: 400, rule: 'EVENT_FIELDS' }); }
{ const r = b6([3, 4])(run()); const good = ev(r, [W(0, 250, 'RAISED', 'STATUS_BIT6'), W(1, 420, 'CLEARED', 'STATUS_BIT6')]); add('D1', 'capture_end_ms changed 900 -> 901 after the VCU digest was taken: digest no longer matches', r, { ...good, capture_end_ms: 901 }, { accept: true, flags: { event_digest_match: false } }); }
{ const r = run(); add('P05', 'kind "toString" (prototype name) is not an enum value', r, ev(r, [{ ...W(0, 200, 'RAISED', 'STATUS_BIT6'), kind: 'toString' }]), { status: 400, rule: 'EVENT_FIELDS' }); }
{ const r = run(); add('P06', 'source "constructor" is not an enum value', r, ev(r, [{ ...W(0, 200, 'RAISED', 'STATUS_BIT6'), source: 'constructor' }]), { status: 400, rule: 'EVENT_FIELDS' }); }
{ const r = run(); add('P07', 'detail status_t_ms (10000) after the reply time (290)', r, ev(r, [W(0, 250, 'RAISED', 'STATUS_BIT6'), W(1, 290, 'DETAIL', 'SDO_2031_11', { code: 133, status_t_ms: 10000 })]), { status: 422, rule: 'EVENT_CAUSALITY' }); }
{ const r = run(); add('P08', 'CLEARED at 100 after RAISED at 250 (time goes backwards in seq order)', r, ev(r, [W(0, 250, 'RAISED', 'STATUS_BIT6'), W(1, 100, 'CLEARED', 'STATUS_BIT6')]), { status: 422, rule: 'EVENT_ORDER' }); }
{ const r = run(); add('P09', 'crossed ownership: step 0 owns reading 5, step 1 owns reading 0', r, ev(r, [], [{ step: 0, t_ms: 0, rpm_cmd: 1000, link: 'OWNS_READING', first_sample_seq: 5 }, { step: 1, t_ms: 0, rpm_cmd: 500, link: 'OWNS_READING', first_sample_seq: 0 }]), { status: 422, rule: 'COMMAND_LINK' }); }
{ const r = run(); add('P10', 'complete log: last change claims SUPERSEDED with no later change', r, ev(r, [], [cmds()[0], { step: 1, t_ms: 480, rpm_cmd: 1000, link: 'SUPERSEDED', first_sample_seq: null }]), { status: 422, rule: 'COMMAND_LINK' }); }
// ---- R4 (Mayank R3 review): incomplete logs keep true records whose partner was lost, reported as unproven
{ const r = b6([3, 4])(run()); add('G1', 'incomplete log: RAISED (seq 0) lost, DETAIL and CLEARED retained -> accepted, CLEARED unproven', r, ev(r, [W(1, 290, 'DETAIL', 'SDO_2031_11', { code: 133, status_t_ms: 250 }), W(2, 420, 'CLEARED', 'STATUS_BIT6')], cmds(), { event_log: { complete: false, lost_count: 1 } }), { accept: true, unproven: 1 }); }
{ const r = run(); add('G2', 'incomplete log: the superseding change was lost, the real SUPERSEDED kept -> accepted, unproven (reading 5 has no owner)', r, ev(r, [], [cmds()[0], { step: 1, t_ms: 450, rpm_cmd: 800, link: 'SUPERSEDED', first_sample_seq: null }], { event_log: { complete: false, lost_count: 1 } }), { accept: true, unproven: 1 }); }
{ const r = run(); add('G3', 'incomplete log but no loss before the record (seq 0, contiguous, lost_count 1): CLEARED from clear is impossible -> rejected', r, ev(r, [W(0, 200, 'CLEARED', 'STATUS_BIT6')], cmds(), { event_log: { complete: false, lost_count: 1 } }), { status: 422, rule: 'WARNING_PAIRING' }); }
{ const r = run(); add('G4', 'incomplete log: STATUS_UNKNOWN lost, STATUS_KNOWN (restored CLEAR) kept -> accepted, unproven', r, ev(r, [W(1, 500, 'STATUS_KNOWN', 'STATUS_BIT6', { restored_state: 'CLEAR' })], cmds(), { event_log: { complete: false, lost_count: null } }), { accept: true, unproven: 1 }); }
{ const r = run(); add('P11', 'command change after capture closed', r, ev(r, [], [...cmds(), { step: 2, t_ms: 950, rpm_cmd: 0, link: 'NO_READING', first_sample_seq: null }]), { status: 422, rule: 'COMMAND_WINDOW' }); }
{ const r = run(); add('P12', 'owned reading carries a different rpm_cmd than the change', r, ev(r, [], [cmds()[0], { step: 1, t_ms: 480, rpm_cmd: 1200, link: 'OWNS_READING', first_sample_seq: 5 }]), { status: 422, rule: 'COMMAND_LINK' }); }
{ const r = run(); add('P13', 'NO_READING on a change that is not the last', r, ev(r, [], [cmds()[0], { step: 1, t_ms: 480, rpm_cmd: 800, link: 'NO_READING', first_sample_seq: null }, { step: 2, t_ms: 490, rpm_cmd: 1000, link: 'OWNS_READING', first_sample_seq: 5 }]), { status: 422, rule: 'COMMAND_LINK' }); }
{ const r = b6([7])(run()); add('F1', 'reading with b6 outside any warning interval: stored, flagged B6_COVERAGE', r, ev(r, []), { accept: true, flags: { b6_coverage_ok: false } }); }
{ const r = b6([6, 7])(run()); add('F2', 'STATUS_KNOWN restored ACTIVE keeps coverage after the known time (reading 7 at 700 ms is covered)', r, ev(r, [W(0, 550, 'STATUS_UNKNOWN', 'STATUS_BIT6'), W(1, 650, 'STATUS_KNOWN', 'STATUS_BIT6', { restored_state: 'ACTIVE' })]), { accept: true, flags: { b6_coverage_ok: true } }); }

let failures = 0;
const out = cases.map(([id, description, events, runCtx, expect]) => {
  const got = validate(events, runCtx);
  let ok;
  if (expect.accept) ok = got.ok && (expect.unproven === undefined || got.flags.unproven.length === expect.unproven) && Object.entries(expect.flags || {}).every(([k, v]) => got.flags[k] === v) && (expect.flags?.event_digest_match === false || got.flags.event_digest_match);
  else ok = !got.ok && got.status === expect.status && got.rule === expect.rule;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${description}: ${got.ok ? 'accepted ' + JSON.stringify(got.flags) : got.status + ' ' + got.rule + ' (' + got.msg + ')'}`);
  return { id, description, v05_fields: events, run_context: runCtx,
    expected: got.ok ? { result: 'accepted', flags: got.flags, recomputed_event_digest: got.digest } : { result: 'rejected', status: got.status, rule: got.rule } };
});
if (failures) { console.error(`${failures} case(s) unexpected`); process.exit(1); }
const file = path.join(__dirname, '..', 'vectors', 'v05-event-vectors.json');
fs.writeFileSync(file, JSON.stringify({ title: 'Contract v0.5 DRAFT R4 examples (warning events, command changes, event digest MTEVT2)',
  spec: 'docs/motor-test/contract/v05-warning-events.md',
  note: 'run_context = the run facts the ERP checks against (started, start_uptime_ms, held_count, stored readings with status_flags b5 0x20 / b6 0x40 and rpm_cmd). P01-P13 cover the probes of Mayank\'s R2 review.', cases: out }, null, 2) + '\n');
console.log(`wrote ${out.length} cases`);
