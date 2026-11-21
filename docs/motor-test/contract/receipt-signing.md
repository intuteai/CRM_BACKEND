# Contract v0.4: signed archive receipt, completeness, CANCEL and b0

**Deployment status (2026-11-19, authoritative):** v0.4 is **live on staging and production** (backend commit 69aacd0c,
migration 004 on both databases). Uploads opt in with `contract_version: "0.4"`; v0.3 uploads stay accepted.
Receipt signing: **staging active** (key_id `70e57bbf84ae97cc`); **production key loaded** (key_id `61322efab675c04c`) and
will sign from the first real bench upload, which needs the published pilot criteria (T046). `run_kind`: staging accepts
`bench`, `host_simulation`, `synthetic`; production only `bench`. The contract text is still a draft until the T012
sign-off. No key is provisioned in any VCU yet; ACK_ARCHIVED stays disabled.

The rules below are agreed with Mayank (VCU) and Pratham (HMI) unless marked PROPOSAL; the text becomes part of
Interface Contract v1 at the T012 sign-off. ACK_ARCHIVED stays disabled on the VCU until device verification is
implemented and the retention/release agreement is in place.

| File | What |
|---|---|
| `receipt-signing.md` | This specification |
| `vectors/receipt-vectors.json` | 54 vectors: message bytes, test keys, signatures, VCU manifest, expected decision (52 + 2 appended in R4, section 11) |
| `vectors/run-digest-vectors.json` | D13 vectors, now with V10 (b0 = 0) |
| `tools/receipt.js` | Reference implementation, both sides (Node, no dependencies) |
| `tools/generate-receipt-vectors.js` | Regenerates the receipt vectors |
| `tools/check_receipt_vectors.py` | Independent check, VCU side: Ed25519 from RFC 8032 in plain Python, no shared code |
| `tools/receipt_v2.js` | MTRCPT2 (v0.5, DRAFT) reference implementation; reuses `receipt.js` unchanged (section 11) |
| `tools/generate-receipt-v2-vectors.js` | Regenerates the MTRCPT2 vectors (same test keys A/B/C) |
| `vectors/receipt-v2-vectors.json` | 50 MTRCPT2 vectors (section 11, draft R4) |
| `tools/check_receipt_v2_vectors.py` | Independent MTRCPT2 check, VCU side (own parser/decision; Ed25519 from `check_receipt_vectors.py`); runs the 54 MTRCPT1 checks first, then the cross-version checks |

## 1. Agreed (Mayank, 2026-11-18)

- **b0 = 0 (RPM invalid):** `rpm_actual` keeps the raw int32 in the record and in JSON (no null, no sentinel);
  digest bytes unchanged. The app and ERP treat it as unavailable: never used for graphs or criteria (shown as a gap).
  Vector **V10**.
- **b4–b7:** per-sample VCU conditions, defined by the VCU owner (triggering, clearing, latching). Any numeric
  threshold or timeout in them needs the testing head's approval. The ERP stores and hashes them without interpreting them.
- **CANCEL:** zero-sample `ABORTED` / `CONFIG_CANCELLED`, never counted as an executed motor test.
- **Signature verification alone never releases data.** Release needs every check in section 6.

## 2. Run start and clock (Pratham agreed the tablet side, 2026-11-18)

The VCU keeps boot-scoped uptime, not UTC. Nothing may invent a timestamp.

| Upload field | Meaning |
|---|---|
| `started` (bool) | The VCU's own field: durable START intent and acquisition clock established (not proof of motor movement) |
| `origin_boot_id` | The VCU boot the run started in (immutable; not the current reconnect/recovery boot) |
| `start_uptime_ms` | VCU uptime at START in `origin_boot_id`; `null` when `started = false` |
| `started_at` | Approximate UTC from the **tablet**: either the receipt time of the matching accepted START ACK (`HMI`) or a time derived from VCU uptime (`HMI_DERIVED`); `null` = UTC unknown |
| `started_at_source` | enum `HMI` \| `HMI_DERIVED`; `null` exactly when `started_at` is `null` |
| `ended_at`, `ended_at_source` | same rules as `started_at` / `started_at_source` |
| `hmi_auto_time` (bool) | the tablet's automatic network time **setting** when the stamp was taken; not proof of a recent successful sync |

`HMI` (confirmed by Pratham 2026-11-18): the tablet's UTC at receipt of the matching accepted START ACK, persisted
at once against the `test_id` (with the tablet's monotonic clock and the VCU boot_id) and kept through recovery.
It includes communication delay and does **not** confirm motor movement; RUNNING confirmation stays separate (the
`started` field and STATE). A captured `HMI` stamp is never replaced during recovery.

`HMI_DERIVED` (agreed by Pratham and Mayank 2026-11-18; only when no `HMI` stamp was captured): the time is
reconstructed from the VCU's own recorded uptime, never from the recovery time. The VCU's current uptime comes from
its `STATE` message (`boot`, `ms`: uint32 boot-scoped uptime in ms) that accompanies HELLO and heartbeat responses
(no firmware change). Every condition must hold, otherwise the time stays `null`:
- a **fresh** STATE from the current connection, with `STATE.boot == origin_boot_id` (never across two boots);
- `start_uptime_ms` = the run's durably recorded start uptime from the VCU manifest, not the START ACK arrival time;
- `elapsed = (STATE.ms − start_uptime_ms) mod 2^32`; `started_at = tablet_utc_at_STATE − elapsed`;
- wraparound (Mayank 2026-11-18): uint32 ms wraps every ~49.7 days, so one value cannot rule out a full wrap, and
  UTC subtraction alone cannot bound it because the tablet's wall clock may change. When it sends CONFIG, the tablet
  persists a **monotonic-clock anchor** with the `test_id`: its monotonic time (e.g. Android `elapsedRealtime`) and an
  identifier of the tablet boot. Derive only if the tablet boot is still the same (clock/boot continuity verified)
  and `mono_now − mono_at_CONFIG < 2^32 ms`, which establishes `0 ≤ elapsed < 2^32 ms` (exactly one candidate). If
  continuity cannot be verified (for example after a tablet reboot), `started_at` and `started_at_source` stay `null`;
- the result is approximate tablet-derived UTC (BLE processing, queueing, transport); it never affects control timing
  or evaluation.

If neither applies: `started: true`, `started_at: null`, `started_at_source: null`.

Accuracy: estimated at about one second (Bluetooth delay and ACK retries), not milliseconds. **This estimate still
needs validation on the bench.** The ERP treats these times as approximate and never computes test results from them.

Rules (422 `INCONSISTENT_RUN` otherwise): `started = false` → `sample_count = 0`, `held_count = 0`, no samples,
`started_at = null`, `start_uptime_ms = null`, `recording_complete = true`, `stop_reason = CONFIG_CANCELLED`,
`final_state = ABORTED`, `outcome = INCOMPLETE` (rule CANCEL_SHAPE). `started = true` with
`started_at = null` means "started, UTC unknown". `CONFIG_CANCELLED` only when `started = false`.
`*_source` must be `null` exactly when its time is `null`.

ERP sanity check (PROPOSAL): a run is never rejected for its clock (that would lose evidence). The ERP stores a
`clock_note` when `hmi_auto_time = false`, or `started_at` is later than the ERP receive time, or
`ended_at < started_at`; the lookup shows these times as "unverified".

## 3. Completeness (definitions accepted by ERP and VCU, 2026-11-18, VCU-ERP-04-R1; app renames pending Pratham)

Exact uint32 values with `0 ≤ held_count ≤ sample_count`; an unknown count is never replaced by 0 or by `held_count`.

- **`sample_count`**: the VCU's authoritative declared number of acquisition slots required during the run's **actual**
  capture window, including known missed slots. Not the planned or admitted maximum, never inferred from the profile
  or from ERP counts.
- **`held_count`**: exact number of validated D13 records durably retained by the VCU and covered by `run_digest`.
  On detected recording loss the VCU keeps the **contiguous validated prefix** and terminates acquisition, so held
  readings are `sample_seq` 0 … held_count − 1.
- **`recording_complete`**: the VCU's own flag: true only when the stream is coherent with no known loss **and** the
  counts are equal. Equal counts alone never prove completeness. Signed as flag b2 (section 5).
- `run_digest`: D13 over all held records in ascending `sample_seq`; never over absent or invented samples.
  `stored_sample_count` / `samples_digest` are ERP fields, not aliases of either VCU count.
- **Unfinalized runs:** unknown-count, uncertain-reset or corrupt histories have no final manifest and get **no
  receipt**. They stay retained on the VCU (never deleted). How such evidence eventually reaches the ERP is an
  **open requirement**, to be agreed separately.
- Names (external, no implicit aliasing): `vcu_id` (e.g. `esp32c3-` + 12 lowercase hex), `origin_boot_id` (16 lowercase
  hex; replaces the upload's `vcu.boot_id`), `start_uptime_ms`, `held_count`, `sample_count`, `recording_complete`,
  `run_kind`, `config_hash`, `run_digest` (was the manifest `digest`). The VCU keeps a versioned durable format;
  legacy files are never rewritten.
- **`run_kind`:** the ERP stores it. Staging accepts explicitly marked synthetic runs (e.g. `host_simulation`);
  production rejects every kind except a real bench run.
- Retention/release policy is a **separate agreement**.
- A **complete recording uploaded with missing samples**: ERP stores fewer than `held_count` → receipt shows a
  shortfall → the VCU keeps the data; the tablet re-uploads the missing samples under the same `test_id`.
- A **recording already incomplete at the VCU**: the ERP must hold all `held_count` samples with the same digest;
  then the VCU may release. The run is stored as `INCOMPLETE`.
- Because the digest covers every held sample with its `sample_seq`, and `held_count` is compared with the VCU's
  own value, a matching prefix cannot authorise release (vector RR11).

## 4. Receipt JSON

The existing receipt gains one object. The VCU decides **only** from the signed message bytes; no other JSON
field takes part in the decision.

```json
"signed_receipt": {
  "alg": "Ed25519",
  "key_id": "<16 hex>",
  "message": "<base64url of the message bytes>",
  "signature": "<base64url of the 64-byte signature>"
}
```

The tablet forwards `message` and `signature` to the VCU unchanged.

## 5. Signed message (v1), little-endian, 172 to 234 bytes

| Offset | Size | Field | Encoding |
|---|---|---|---|
| 0 | 8 | magic | ASCII `MTRCPT1` + 0x00 (version 1) |
| 8 | 8 | key_id | first 8 bytes of SHA-256(public key) |
| 16 | 16 | test_id | UUID, the 16 bytes in written order (`7b1d3e0a-…` → `7b 1d 3e 0a …`) |
| 32 | 16 | receipt_id | UUID, same encoding |
| 48 | 8 | stored_at | i64, Unix milliseconds UTC of the original commit |
| 56 | 4 | sample_count | u32 |
| 60 | 4 | held_count | u32 |
| 64 | 4 | stored_sample_count | u32, samples the ERP stored |
| 68 | 1 | final_state | 1 COMPLETED, 2 ABORTED, 3 FAULT |
| 69 | 1 | outcome | 1 PASS, 2 FAIL, 3 INCOMPLETE, 4 INVALID |
| 70 | 1 | stop_reason | 1 RAMP_COMPLETE, 2 OPERATOR_STOP, 3 HB_LOSS, 4 FAULT, 5 POWER_LOSS, 6 CONFIG_CANCELLED |
| 71 | 1 | flags | b0 run_digest_match, b1 held_count_match, b2 recording_complete (the VCU's uploaded flag), b3 started; b4–b7 = 0 |
| 72 | 32 | run_digest | raw SHA-256 bytes, as uploaded (from the VCU manifest) |
| 104 | 32 | samples_digest | raw SHA-256 bytes, computed by the ERP over the stored samples |
| 136 | 32 | payload_hash | raw SHA-256 bytes; signed for the record only (the VCU cannot recompute it) |
| 168 | 1+n | vcu_id | u8 length n (1–32) + ASCII `[A-Za-z0-9._-]`; equals the manifest field `vcu_id` |
| 169+n | 1+m | origin_boot_id | u8 length m (1–32) + ASCII `[A-Za-z0-9._-]` |

No trailing bytes. b0 and b1 must agree with the values they summarise (b0 ⇔ samples_digest = run_digest,
b1 ⇔ stored = held). b2 is the VCU's uploaded `recording_complete`, not derived from the counts: b2 set requires
held = sample_count, but equal counts with b2 clear are valid (equal counts never prove completeness). A disagreement
is rejected even with a valid signature (section 6, step 5).

**Ed25519:** pure Ed25519 (RFC 8032 section 5.1): no prehash, no context. Public key 32 bytes, signature 64 bytes (R‖S).
Reject S ≥ L (non-canonical). **base64url:** RFC 4648 section 5 alphabet, no padding, no whitespace; unused trailing bits
must be zero (decode then re-encode must give the same text).

## 6. VCU release decision

Checks in this order; the first failure is the reason (vectors use these names). Release only on `RELEASE`.

1. `MALFORMED_ENCODING`: message or signature not strict base64url, or signature not 64 bytes.
2. `BAD_VERSION` (magic) / `MALFORMED_MESSAGE` (length, unknown enum code, reserved flag bits, identifier length or characters).
3. `UNKNOWN_KEY`: key_id not in the VCU's provisioned, non-revoked keys.
4. `BAD_SIGNATURE`: Ed25519 verification fails (including S ≥ L).

   4a. `RECEIPT_VERSION_MISMATCH` (added in v0.5 draft R4, section 11): the VCU manifest records a `receipt_version`
   other than 1 (a v0.5 run records 2). A v0.4 manifest without the field, or with 1, keeps this v1 path unchanged.
5. `FLAGS_INCONSISTENT`: b0 or b1 disagree with the values; b2 set with `held ≠ sample_count` (b2 clear with equal
   counts is allowed: equal counts never prove completeness); `held > sample_count`; `stored > held`; `started = 0`
   but not a zero-sample, recording-complete `ABORTED/CONFIG_CANCELLED/INCOMPLETE`; `CONFIG_CANCELLED` on a started run.
6. `LIFECYCLE_INCONSISTENT` (added after Mayank's review, 2026-11-18): stop_reason not permitted for final_state (table
   below); or a verdict (PASS/FAIL/INVALID) without final_state COMPLETED and complete evidence (flags b0, b1, b2 all set).
   ABORTED and FAULT are always INCOMPLETE.
7. `TEST_ID_MISMATCH`, `VCU_ID_MISMATCH`, `BOOT_ID_MISMATCH`: against the VCU's own manifest (origin boot).
8. `MANIFEST_MISMATCH`: run_digest, sample_count, held_count, started, **recording_complete (b2), final_state or stop_reason** differ from the manifest.
9. `SHORTFALL`: stored_sample_count ≠ held_count.
10. `DIGEST_MISMATCH`: samples_digest ≠ run_digest.
11. `RELEASE`.

Permitted combinations (agreed with Mayank 2026-11-18):

| final_state | stop_reason | outcome |
|---|---|---|
| COMPLETED | RAMP_COMPLETE | PASS, FAIL or INVALID with complete matching evidence; otherwise INCOMPLETE |
| ABORTED | OPERATOR_STOP, HB_LOSS; CONFIG_CANCELLED only when started = 0 (a controlled abort) | INCOMPLETE |
| FAULT | FAULT (fault_code in the upload, e.g. `SAMPLE_LOSS`); POWER_LOSS (an evidenced power interruption during an unfinished run) | INCOMPLETE |

Notes from the VCU (Mayank): an unexplained reset is **not** automatically POWER_LOSS; VCU_RESET / reset-cause
diagnostics are kept until the cause is established. A run already finalised and verified keeps its original outcome
after a reboot. VCU_RESET recovery is not finalised yet (no recovered terminal-manifest transaction), so it is outside
this receipt version.

Which signed lifecycle fields the VCU checks against its own manifest: **final_state and stop_reason** (the VCU is
authoritative for how its run ended) and started. **outcome** is the tablet's verdict (D10), which the VCU does not
hold, so the VCU checks it only through the combination rules. The ERP upload validation will enforce the same table
(today it enforces only "verdict ⇒ COMPLETED"; v0.4 implementation work).

## 7. Keys

- The ERP holds the private keys (outside the code and the Docker image). The VCU holds only public keys, in two
  slots: current and next. No secret is stored on the VCU.
- **Rotation:** provision the new public key into the free slot (VCU config update), then the ERP starts signing with it.
- **Registry (ERP):** key_id, public key, valid_from, retired_at, revoked_at. Retired keys stay listed forever,
  so any old receipt can still be checked. A **revoked** key is removed from the VCU slots by config update; the ERP
  never signs with it again.
- **Re-issue:** the ERP can return a stored run's receipt signed with the current key: identical message except
  key_id, new signature. Used when a VCU no longer holds the old key.

## 8. Retries and idempotency

The message is built and signed once, at the original commit, and stored with the receipt. A 200 identical retry
returns the byte-identical receipt and signature (Ed25519 is deterministic). 409 conflict and every 4xx/5xx carry no
`signed_receipt`. If samples are re-uploaded after a shortfall (section 3), the ERP issues a new receipt for the new
stored state; the VCU only acts on one that passes section 6.

## 9. Vectors (`vectors/receipt-vectors.json`)

Test keys A, B (VCU slots) and C (unknown), from public seeds: **never provision them on a real VCU.**
Accepted: RA8 FAULT / POWER_LOSS (VCU holds 3 of 5, ERP holds all 3) · RA1 complete run · RA2 VCU-known incomplete · RA3 CANCEL · RA4 started, zero samples (FAULT) · RA5 b0 = 0 (V10)
· RA6 identifier lengths 1 and 32 · RA7 key B (rotation). Rejected: RR1–RR5 signature/key (including S + L and
key_id/key mismatch) · RR6–RR8 wrong run (test_id, vcu_id, reconnect boot) · RR9–RR13 validly signed shortfall,
digest mismatch, prefix trap, manifest mismatch · RR14–RR16 inconsistent flags/started · RR17–RR25 malformed
message (magic, reserved bits, enum, truncated, trailing byte, identifier lengths 0/33 and characters) · RR26–RR30
malformed encoding (padding, `+ /`, trailing bits, whitespace, 63-byte signature) · RR31–RR37 lifecycle (added after
Mayank's review: FAULT + PASS, COMPLETED + HB_LOSS, ABORTED + FAIL, ABORTED + POWER_LOSS, PASS on a VCU-incomplete
recording, final_state and stop_reason differing from the manifest). RR9–RR12 now use outcome INCOMPLETE so they
still test the shortfall, digest and manifest checks (a PASS there is caught earlier by step 6) · b2 = VCU
`recording_complete` (VCU-ERP-04-R1): RA9 equal counts but not complete, archivable as INCOMPLETE · RR38 the same with
PASS · RR39 complete with unequal counts · RR40–RR41 b2 differs from the manifest (both directions) · RR42 CANCEL not
complete · RR43 CANCEL with PASS. The 45 earlier vectors keep identical bytes, signatures and decisions.
Appended in v0.5 draft R4 (receipt-version pinning, section 11): RA10 RA1 with a manifest that pins `receipt_version`
1 (`RELEASE`) · RR44 the RA1 message against the manifest of a v0.5 run (`receipt_version` 2, common fields equal to
MTRCPT2 R2A1's manifest), decided by this MTRCPT1 decider (`RECEIPT_VERSION_MISMATCH`). The 52 earlier vectors keep
identical bytes, signatures, manifests and decisions (their manifests carry no `receipt_version`).

Regenerate: `node docs/motor-test/contract/tools/generate-receipt-vectors.js` · Check independently:
`python docs/motor-test/contract/tools/check_receipt_vectors.py` (checks RFC 8032 test 1 first, then all 54
decisions, and re-signs every untampered message byte for byte).

## 10. Open

- Mayank: 45 vectors and the lifecycle table verified 2026-11-18; to re-verify: the b2 amendment (52 vectors). Still open:
  b4–b7, production limits, firmware verifier, key provisioning, retention/release policy, the unfinalized-run ingestion path.
- Pratham: app renames `digest` → `run_digest`, `vcu.boot_id` → `origin_boot_id`; new fields `held_count`, `recording_complete`, `run_kind`.
- Bench tablet (Redmi Pad 2) checked by Pratham 2026-11-18: automatic time and time zone on (`auto_time=1`,
  `auto_time_zone=1`, Asia/Calcutta). Settings only, not proof of a recent sync; the app records `hmi_auto_time` at
  each stamp. Times are still sent in UTC (`Z`); the tablet's time zone never appears in the upload.
- Mayank: `held_count` and `origin_boot_id` in the manifest; ESP32-C3 heap, stack and verify-time measurements
  (Ed25519 verify libraries need roughly 10–20 KB of flash; 299 KB free); b4–b7 definitions.
- ERP (after agreement): migration for `CONFIG_CANCELLED`, `started`, `held_count`, origin boot and start fields, the
  key registry and stored signatures; signing key kept outside the image.

## 11. MTRCPT2 (contract v0.5)

**DRAFT R4 (2026-11-21), after Mayank's R3 review (V05_R3_MTRCPT2_REVIEW); for review by Mayank.** Not implemented in
the ERP service yet. The MTRCPT1 message bytes are unchanged; its 52 earlier vectors keep identical bytes, signatures,
manifests and decisions (R4 appends RA10 and RR44, section 9). The receipt JSON (section 4), Ed25519 and base64url
rules (section 5), keys (section 7) and retries (section 8) are the same for both versions.

**Changes in R4:** receipt-version pinning by the VCU manifest (`RECEIPT_VERSION_MISMATCH`, replaces dispatch by
magic); two new `FLAGS_INCONSISTENT` rules (a started run with a complete event log needs START step 0; a CANCEL is
complete, empty event evidence); b6_coverage_ok stated as signed and reported only; verification vs. deletion and
INVALID evidence clarified (section 11.3); the open questions of R3 closed (section 11.5); 8 new MTRCPT2 vectors.

**Receipt-version pinning (R4; replaces "dispatch by magic").** Selecting the decoder by the received magic would let a
genuinely signed MTRCPT1 receipt with matching common fields bypass the v0.5 event checks (Mayank's probe
R3_RECEIPT_MAGIC_DOWNGRADE: v1 decider `RELEASE`). Therefore:

- When the VCU **creates a run**, it persists the required receipt version in its own durable manifest:
  `receipt_version` = 1 for a v0.4 run, 2 for a v0.5 run (including an empty CANCEL). It is never changed afterwards.
- The VCU selects the permitted decoder **only** from that manifest value: 2 → MTRCPT2 (section 11.3); otherwise →
  MTRCPT1 (section 6). The received magic must then match the selected decoder (`BAD_VERSION` otherwise).
- Both decoders check the manifest right after the signature checks and before the flag checks, with reason
  `RECEIPT_VERSION_MISMATCH`: the MTRCPT1 decider rejects when `receipt_version` is present and ≠ 1; the MTRCPT2
  decider rejects when `receipt_version` ≠ 2 (**required** for v2; absent is a mismatch).
- A v0.5 run rejects a genuinely signed MTRCPT1 receipt even when every common field matches. There is **no fallback**
  to MTRCPT1 after an MTRCPT2 failure: the first decision is final.
- An unknown or legacy format never acquires a version by inference and never silently gains archive authority.
  Existing v0.4 manifests without the field keep their explicit v1 path (all 52 earlier MTRCPT1 vectors).
- Reference: `decideForRun()` in `tools/receipt_v2.js`. Vectors: RR44 (v1 set, decided by the MTRCPT1 decider),
  R2R21 (MTRCPT1 bytes to the MTRCPT2 decoder, `BAD_VERSION`), R2R37-R2R39 (v2 set). Both generators and the
  independent Python check also verify the downgrade probe across the two vector files.

### 11.1 Signed message (v2), little-endian, 253 to 315 bytes

Offsets 0-167 are exactly the MTRCPT1 layout (section 5) except the magic. The event block is inserted **before** the
two length-prefixed identifiers.

| Offset | Size | Field | Encoding |
|---|---|---|---|
| 0 | 8 | magic | ASCII `MTRCPT2` + 0x00 (version 2) |
| 8 | 160 | key_id … payload_hash | as MTRCPT1 offsets 8-167 (incl. run flags at 71: b0-b3, b4-b7 = 0) |
| 168 | 32 | event_digest | raw SHA-256, as uploaded (the VCU's MTEVT digest, `v05-warning-events.md` section 6) |
| 200 | 32 | events_stored_digest | raw SHA-256, recomputed by the ERP from the stored arrays |
| 232 | 4 | warnings_count | u32 |
| 236 | 4 | command_changes_count | u32 |
| 240 | 1 | event_flags | b0 event_digest_match (events_stored_digest = event_digest), b1 event_log_complete, b2 b6_coverage_ok, b3 capture_end_present, b4 start_uptime_present; b5-b7 = 0 |
| 241 | 4 | capture_end_ms | u32; 0 when absent. Presence **only** via b3, never a sentinel |
| 245 | 4 | start_uptime_ms | u32; 0 when absent. Presence **only** via b4 |
| 249 | 1+n | vcu_id | u8 length n (1-32) + ASCII `[A-Za-z0-9._-]` |
| 250+n | 1+m | origin_boot_id | u8 length m (1-32) + same rules |

Total 251+n+m bytes. No trailing bytes. The value bytes of an absent field must be exactly 0 (`MALFORMED_MESSAGE`
otherwise); a present value may be 0 (vector R2A5).

### 11.2 VCU manifest (v2)

`receipt_version` = 2 (required; persisted when the run is created, see above), the MTRCPT1 manifest fields (test_id,
vcu_id, origin_boot_id, started, recording_complete, final_state, stop_reason, sample_count, held_count, run_digest)
plus: `event_digest`, `warnings_count`, `command_changes_count`, `event_log_complete`, `capture_end_ms` (number or
null), `start_uptime_ms` (number or null).

**b6_coverage_ok is not a manifest field.** It stays signed (event b2) and reported as evaluator evidence, but the VCU
does **not** compare it, until the VCU has an agreed, independently computed and durable value (an agreed algorithm and
version, actually implemented). It never authorises local motor safety or enable.

### 11.3 VCU release decision (v2)

Same order and names as section 6; the first failure is the reason. Release only on `RELEASE`.

1. `MALFORMED_ENCODING`: as section 6.
2. `BAD_VERSION` (magic is not `MTRCPT2\0`) / `MALFORMED_MESSAGE`: length (shorter than 253, identifier lengths, trailing
   bytes), unknown enum code, reserved bits in **either** flags byte (run b4-b7, event b5-b7), non-zero bytes in an
   absent capture_end_ms / start_uptime_ms, identifier characters.
3. `UNKNOWN_KEY`.
4. `BAD_SIGNATURE` (including S ≥ L).

   4a. `RECEIPT_VERSION_MISMATCH` (R4): the VCU manifest's `receipt_version` is not 2 (absent included).
5. `FLAGS_INCONSISTENT`: every MTRCPT1 rule (section 6, step 5), plus: event b0 ≠ (events_stored_digest =
   event_digest); b4 start_uptime_present ≠ started (run flag b3); b3 capture_end_present ≠ started; and, new in R4:
   - **complete started log needs START step 0:** started = 1 with event_log_complete (event b1) = 1 and
     command_changes_count = 0. A known-incomplete log (b1 = 0) with a lost step 0 is **not** rejected by this rule;
     its gap is retained under the agreed ingestion rules (vector R2A7);
   - **CANCEL = complete, empty event evidence:** started = 0 with warnings_count ≠ 0, command_changes_count ≠ 0 or
     event_log_complete (b1) = 0. If the system cannot establish that shape, it retains the unresolved evidence
     instead of producing a receipt-eligible CANCEL.
6. `LIFECYCLE_INCONSISTENT`: as section 6 (the event flags do not take part).
7. `TEST_ID_MISMATCH`, `VCU_ID_MISMATCH`, `BOOT_ID_MISMATCH`.
8. `MANIFEST_MISMATCH`: every MTRCPT1 field (section 6, step 8), plus event_digest, warnings_count,
   command_changes_count, event_log_complete (event b1), capture_end_ms and start_uptime_ms (presence and value).
9. `SHORTFALL`: stored_sample_count ≠ held_count.
10. `DIGEST_MISMATCH`: samples_digest ≠ run_digest.
11. `EVENT_DIGEST_MISMATCH`: event b0 clear (the ERP did not store exactly the VCU's events).
12. `RELEASE`.

Release requires the ERP to hold exactly what the VCU holds: the samples (steps 9-10) and the events (step 11, with
step 8 binding event_digest to the VCU's own journal). Event-log completeness (b1) and b6 coverage (b2) are
evaluation and retention matters: they are signed and reported, b1 must equal the manifest (and obey the step 5
shape rules), b6_coverage_ok is reported only and not compared (section 11.2); neither blocks release (vectors R2A2,
R2A6, R2A7). **The final retention/release agreement is still pending**; these rules may change with it.

**Verification is not permission to delete.** A `RELEASE` result only says the ERP holds exactly the VCU's evidence
(authentic, for this run, equal to the VCU's own manifest). Whether and when data may be deleted is the separate
retention/release agreement; ACK_ARCHIVED and deletion stay disabled until it exists. A future implementation keeps
successful signature/evidence comparison separate from permission to release storage.

**INVALID evidence is reported, not hidden; PASS eligibility is separate.** A run whose evidence is incomplete or
quality-failed (for example an incomplete event log, or b6 coverage not OK) is still archived and verified like any
other, and its problems are reported. A verdict still needs final_state COMPLETED with complete sample evidence
(section 6, step 6), and event completeness affects evaluation (section 11.5), not release.

### 11.4 Vectors (`vectors/receipt-v2-vectors.json`, 50)

Same test keys A, B (VCU slots) and C (unknown) as section 9. Event digests are fixed placeholder 32-byte values
(labelled in the file), not MTEVT computations, except the CANCEL vectors, which use the real MTEVT2 digest of the
complete, empty CANCEL journal (`v05-event-vectors.json` case E8). No vector yet couples a real MTEVT2 transcript to
an MTRCPT2 receipt end to end. Every manifest carries `receipt_version` 2 unless the vector says otherwise; the 42
R3 vectors keep identical message bytes, signatures and decisions (their manifests only gained `receipt_version` 2).

Accepted: R2A1 complete run with events · R2A2 known-loss run (FAULT/FAULT, VCU holds 3 of 5, recording and event log
incomplete, b6 not OK) · R2A3 CANCEL (capture_end / start_uptime absent, zero counts, empty-journal digest) · R2A4 key B
· R2A5 boundaries (start_uptime_ms present with value 0, capture_end_ms and counts 0xFFFFFFFF, identifiers 1 and 32
bytes) · R2A6 b6 coverage not OK on a complete run (INVALID) · R2A7 (R4) known-loss run, event log incomplete with
START step 0 lost (command_changes_count 0): the complete-log rule does not apply, release.
Rejected: R2R1 event_digest ≠ manifest (`MANIFEST_MISMATCH`) · R2R2 stored event digest differs
(`EVENT_DIGEST_MISMATCH`) · R2R3-R2R4 event b0 inconsistent, both directions · R2R5-R2R6 capture_end / start_uptime
present on a CANCEL · R2R7-R2R8 start_uptime / capture_end absent on a started run (`FLAGS_INCONSISTENT`) · R2R9-R2R10
capture_end / start_uptime value ≠ manifest · R2R11-R2R12 start_uptime / capture_end presence ≠ manifest · R2R13-R2R14
warnings / command_changes count ≠ manifest · R2R15 event_log_complete ≠ manifest (`MANIFEST_MISMATCH`) · R2R16-R2R17
non-zero bytes in an absent field · R2R18-R2R19 reserved event flag b5 / b7 · R2R20 reserved run flag b4 · R2R22
`MTRCPT2` magic on an MTRCPT1-layout body (`MALFORMED_MESSAGE`) · R2R21 the MTRCPT1 RA1 message, byte-identical, given
to the v2 decoder (`BAD_VERSION`) · R2R23 sample and event digests both differ (`DIGEST_MISMATCH` comes first) ·
R2R24-R2R28 MTRCPT1 rules carried over (`SHORTFALL`, `DIGEST_MISMATCH`, `BOOT_ID_MISMATCH`, `LIFECYCLE_INCONSISTENT`,
`TEST_ID_MISMATCH`) · R2R29-R2R31 byte flip in the event block, signature byte flip, S + L (`BAD_SIGNATURE`) · R2R32
key C (`UNKNOWN_KEY`) · R2R33-R2R34 truncated / trailing byte (`MALFORMED_MESSAGE`) · R2R35-R2R36 padding, whitespace
(`MALFORMED_ENCODING`).
New in R4: R2R37 valid R2A1 message, manifest `receipt_version` 1 · R2R38 valid R2A1 message, manifest without
`receipt_version` (never inferred) · R2R39 position check: flags inconsistent (as R2R40) **and** manifest
`receipt_version` 1, the version check comes first (all three `RECEIPT_VERSION_MISMATCH`) · R2R40 Mayank's probe
R3_STARTED_COMPLETE_EVENT_LOG_WITHOUT_STEP0: started, event b1 = 1, command_changes_count 0 in receipt and manifest ·
R2R41 CANCEL with warnings_count 1 · R2R42 CANCEL with command_changes_count 1 · R2R43 CANCEL with event b1 = 0 (all
four `FLAGS_INCONSISTENT`, counts and b1 equal in receipt and manifest, so only the new rules reject them).

Cross-version checks (in the generator and independently in the Python check): every accepted MTRCPT2 vector has
`receipt_version` 2 in its manifest and the MTRCPT1 decider answers `BAD_VERSION`; the run dispatcher releases it;
the MTRCPT1 RA1 message against the R2A1 manifest gives `RECEIPT_VERSION_MISMATCH` from the MTRCPT1 decider (vector
RR44, whose manifest has the same common fields as R2A1's) and `BAD_VERSION` from the MTRCPT2 decider that the
manifest selects, with no fallback.

Regenerate: `node docs/motor-test/contract/tools/generate-receipt-v2-vectors.js` · Check independently:
`python docs/motor-test/contract/tools/check_receipt_v2_vectors.py` (runs the 54 MTRCPT1 checks, then all 50 MTRCPT2
decisions and the cross-version checks; re-signs every untampered message byte for byte and compares the parsed
fields with `decoded_message`).

### 11.5 Open questions of R3: closed in R4 (Mayank's R3 review)

- **CANCEL event evidence: adopted.** A CANCEL carries zero warning and command-change counts, event_log_complete
  (b1) = 1, the canonical complete-empty MTEVT2 digest and absent capture_end / start_uptime. Enforced as
  `FLAGS_INCONSISTENT` (step 5; vectors R2R41-R2R43). Run-origin preflight evidence is excluded, not invented.
- **b6_coverage_ok: reported only.** Signed and reported as evaluator evidence, not in the VCU manifest and not
  compared, until the VCU has an agreed independent calculation (section 11.2).
- **Verdict vs. event completeness:** event completeness affects **evaluation**, not release. The testing head's rule
  S4 applies: an incomplete event log makes the run INVALID (never PASS). Release only needs exact equality with the
  VCU's evidence; the receipt does not demand event b1 for every outcome (an INVALID run may need to report an
  event-evidence problem). Agreed FAIL/INVALID/INCOMPLETE combinations stay with Saatwik and Pratham.
- **capture_end_ms** stays an opaque u32 for the receipt: presence via b3, value compared with the VCU manifest only
  (no range or meaning checked by the receipt decision).

Still open (not receipt rules): the final retention/release agreement; the ingestion route for incomplete logs whose
retained records cannot prove pairing/successor relationships (`v05-warning-events.md`); a coupled MTEVT2-to-MTRCPT2
end-to-end vector.
