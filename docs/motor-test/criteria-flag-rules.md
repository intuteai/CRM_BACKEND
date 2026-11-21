# Criteria rule types for status flags (b4–b7)

Status: **agreed with Saatwik (testing head) 2026-11-19/20 (values provisional until the onsite trace and bench runs);
definitions for review by Pratham (tablet evaluator, D10) and Mayank (flag semantics).** Accepted by the ERP criteria editor/API from this version; the tablet
evaluates them. Numbers come only from the testing head's signed limits sheet.

Principle: the VCU flags record the true state at each reading and are never changed afterwards
(VCU_FLAGS_B4_B7_PROPOSAL_R1). The criteria decide what they mean for the run.

Flag bits (status_flags): b4 CAN stale/unavailable · b5 setpoint changed · b6 protective warning/status unavailable ·
b7 storage lag. **b5 is set on the first reading after each effective speed-command change** (VCU event time, not
storage or acknowledgement timing; agreed by Saatwik and Mayank 2026-11-20); there is no time window in the firmware.
Rules refer to the flags by `bit` (4–7). b0–b3 are validity bits and keep their existing meaning
(an invalid value is never used by any value rule).

## Common terms

- **Readings** = the stored readings of the run, in `sample_seq` order.
- **Period** = 1000 / `sample_hz` of the profile version used (ms).
- A **step** starts at a reading with b5 set and ends just before the next reading with b5 set, or at the last reading.
  Readings before the first b5 reading belong to no step (the VCU sets b5 when START applies the first command).
- A reading is **fresh and valid** for a list of signals when b4 is clear and the validity bit of every listed signal is
  set (rpm_actual b0, current_a b1, voltage_v b2, bemf_v b3).
- A **stretch** = consecutive readings (`sample_seq` increasing by exactly 1) that all have the bit set. A missing
  `sample_seq` ends a stretch. **Stretch length** = number of readings in it × period.

## 1. `flag_share` — share and longest stretch of a flag

| Field | Type | Meaning |
|---|---|---|
| `id` | UPPER_CASE | rule id |
| `type` | `"flag_share"` | |
| `bit` | integer 4–7 | flag checked |
| `max_fraction` | number 0–1, or null | violation if (readings with the bit set) / (all readings) **>** this; null = not checked |
| `max_continuous_ms` | number ≥ 0, or null | violation if the longest stretch **>** this; null = not checked |
| `on_violation` | `"FAIL"` \| `"INVALID"` | |

At least one of `max_fraction` / `max_continuous_ms` must be set. Example (shape only; numbers from the signed sheet):
`{"id":"CAN_STALE","type":"flag_share","bit":4,"max_fraction":0.02,"max_continuous_ms":1000,"on_violation":"INVALID"}`.

## 2. `flag_any` — any reading with a flag

| Field | Type | Meaning |
|---|---|---|
| `id`, `type` | `"flag_any"` | |
| `bit` | integer 4–7 | violation if **any** reading has this bit set |
| `on_violation` | `"FAIL"` \| `"INVALID"` | |

This is how a run-level latch is expressed: e.g. any b6 reading makes the whole run INVALID, while each reading's flag
stays exactly as recorded. Example: `{"id":"PROTECTIVE_WARNING","type":"flag_any","bit":6,"on_violation":"INVALID"}`.

## 3. `flag_exclusion` — ignore readings after a flag (no verdict of its own)

| Field | Type | Meaning |
|---|---|---|
| `id`, `type` | `"flag_exclusion"` | |
| `bit` | integer 4–7 | trigger flag (typically 5, setpoint changed) |
| `window_ms` | number ≥ 0 | readings with `t_ms` in **[t_flag, t_flag + window_ms]** of any reading with the bit set are excluded |
| `applies_to` | array of rule ids, or null | value rules affected; null = every value rule (`max`, `min`, `range`, `checkpoint`, `tracking`, `reach`, `bemf_constant`) |

It never excludes readings from `flag_share` / `flag_any`, never produces a violation, and never removes readings from
the stored evidence (graphs still show them; the ERP may shade the excluded spans). Example:
`{"id":"SETTLE_AFTER_STEP","type":"flag_exclusion","bit":5,"window_ms":1500,"applies_to":null}`.
Meaningful with a stepped profile (D9: Saatwik chose fixed time per step, settle X then hold; with a strict ramp nearly
every reading would carry b5).

## 4. `step_coverage` — enough fresh readings after each settle (R2)

| Field | Type | Meaning |
|---|---|---|
| `id`, `type` | `"step_coverage"` | |
| `bit` | integer 4–7 | flag that starts a step (5, setpoint changed) |
| `settle_ms` | number ≥ 0 | only readings with `t_ms` **>** step start + settle_ms count; a reading at exactly start + settle_ms is still settling (same inclusive boundary as `flag_exclusion`; usually the same X). Example X = 1500, step start 1000 ms: 2499 and 2500 ms not counted, 2501 ms counted |
| `min_readings` | integer ≥ 1 | violation if **any** step has fewer fresh, valid readings after its settle window |
| `signals` | non-empty array of signals | which validity bits a reading needs to count (e.g. `["rpm_actual","current_a","voltage_v"]`) |
| `on_violation` | `"FAIL"` | `"INVALID"` | |

A step without enough readings can never pass silently. Settling readings stay in the counts and the digest; they are only
not counted here. Example (shape only): `{"id":"STEP_COVERAGE","type":"step_coverage","bit":5,"settle_ms":1500,
"min_readings":5,"signals":["rpm_actual","current_a","voltage_v"],"on_violation":"INVALID"}` (Saatwik: at least 5,
INVALID). The tablet should report the failing step (its start reading and rpm_cmd) in `outcome_reasons`.

## Evaluation order (tablet)

1. Value rules ignore invalid values (b0–b3) as today, and readings excluded by any `flag_exclusion` that applies to them.
2. Flag rules (`flag_share`, `flag_any`, `step_coverage`) use all stored readings; warnings inside a b5 settle window
   still count for `flag_any`.
3. Outcome as today: any INVALID violation → INVALID; else any FAIL violation → FAIL; else PASS (only for a COMPLETED,
   complete, digest-matching run — unchanged).

## Not covered yet

Warning transitions between readings (Saatwik 2026-11-20: `flag_any` must count them too) need timestamped warning
events in the upload: contract v0.5, after Mayank implements the approved 0x2031:11 polling.

Per-code warning rules (Saatwik's FAIL / INVALID / N/A / log list for VEICHI codes) need the detailed warning code
(0x2031:11) in the upload: no field exists today. It waits for Mayank's reviewed read path and a contract addition.
Until then, `flag_any` on b6 = INVALID covers protective warnings.
