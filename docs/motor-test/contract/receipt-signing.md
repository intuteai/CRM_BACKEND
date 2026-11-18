# Contract v0.4 DRAFT: signed archive receipt, completeness, CANCEL and b0

Status: **draft for review by Mayank (VCU) and Pratham (HMI), 2026-11-18. Not frozen; nothing implemented in
the ERP API yet.** Becomes part of Interface Contract v1 at T012. ACK_ARCHIVED stays disabled on the VCU until
this is agreed and verification is implemented.

| File | What |
|---|---|
| `receipt-signing.md` | This specification |
| `vectors/receipt-vectors.json` | 52 vectors: message bytes, test keys, signatures, VCU manifest, expected decision |
| `vectors/run-digest-vectors.json` | D13 vectors, now with V10 (b0 = 0) |
| `tools/receipt.js` | Reference implementation, both sides (Node, no dependencies) |
| `tools/generate-receipt-vectors.js` | Regenerates the receipt vectors |
| `tools/check_receipt_vectors.py` | Independent check, VCU side: Ed25519 from RFC 8032 in plain Python, no shared code |

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

Rules (422 `INCONSISTENT_RUN` otherwise): `started = false` → `sample_count = 0`, `started_at = null`,
`stop_reason = CONFIG_CANCELLED`, `final_state = ABORTED`, `outcome = INCOMPLETE`. `started = true` with
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

No trailing bytes. Flags must agree with the values they summarise (b0 ⇔ samples_digest = run_digest,
b1 ⇔ stored = held, b2 ⇔ held = sample_count); a disagreement is rejected even with a valid signature.

**Ed25519:** pure Ed25519 (RFC 8032 section 5.1): no prehash, no context. Public key 32 bytes, signature 64 bytes (R‖S).
Reject S ≥ L (non-canonical). **base64url:** RFC 4648 section 5 alphabet, no padding, no whitespace; unused trailing bits
must be zero (decode then re-encode must give the same text).

## 6. VCU release decision

Checks in this order; the first failure is the reason (vectors use these names). Release only on `RELEASE`.

1. `MALFORMED_ENCODING`: message or signature not strict base64url, or signature not 64 bytes.
2. `BAD_VERSION` (magic) / `MALFORMED_MESSAGE` (length, unknown enum code, reserved flag bits, identifier length or characters).
3. `UNKNOWN_KEY`: key_id not in the VCU's provisioned, non-revoked keys.
4. `BAD_SIGNATURE`: Ed25519 verification fails (including S ≥ L).
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

Regenerate: `node docs/motor-test/contract/tools/generate-receipt-vectors.js` · Check independently:
`python docs/motor-test/contract/tools/check_receipt_vectors.py` (checks RFC 8032 test 1 first, then all 52
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
