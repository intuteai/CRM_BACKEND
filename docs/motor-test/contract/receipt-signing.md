# Contract v0.4 DRAFT: signed archive receipt, completeness, CANCEL and b0

Status: **draft for review by Mayank (VCU) and Pratham (HMI), 2026-11-18. Not frozen; nothing implemented in
the ERP API yet.** Becomes part of Interface Contract v1 at T012. ACK_ARCHIVED stays disabled on the VCU until
this is agreed and verification is implemented.

| File | What |
|---|---|
| `receipt-signing.md` | This specification |
| `vectors/receipt-vectors.json` | 37 vectors: message bytes, test keys, signatures, VCU manifest, expected decision |
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
| `started_at` | UTC from the **tablet** clock: the moment the tablet received the matching accepted START ACK; `null` = never captured |
| `started_at_source` | `"HMI"` when `started_at` is set; `null` exactly when `started_at` is `null` |
| `ended_at`, `ended_at_source` | same rules as `started_at` / `started_at_source` |
| `hmi_auto_time` (bool) | the tablet's automatic network time **setting** when the stamp was taken; not proof of a recent successful sync |

`HMI` (confirmed by Pratham 2026-11-18): the tablet's UTC at receipt of the matching accepted START ACK, persisted
at once against the `test_id` (with the tablet's monotonic clock and the VCU boot_id) and kept through recovery.
It includes communication delay and does **not** confirm motor movement; RUNNING confirmation stays separate (the
`started` field and STATE). If the tablet never captured the START moment, it sends `started: true`,
`started_at: null`, `started_at_source: null`. **No time is ever reconstructed** from recovery time or VCU uptime.

(Considered and dropped for v0.4: deriving the time from the VCU's `STATE.ms` uptime. Mayank confirmed the uptime
is available, but Pratham will not reconstruct times; can be revisited later.)

Accuracy: about one second (Bluetooth delay and ACK retries), not milliseconds. The ERP treats these times as
approximate and never computes test results from them.

Rules (422 `INCONSISTENT_RUN` otherwise): `started = false` → `sample_count = 0`, `started_at = null`,
`stop_reason = CONFIG_CANCELLED`, `final_state = ABORTED`, `outcome = INCOMPLETE`. `started = true` with
`started_at = null` means "started, UTC unknown". `CONFIG_CANCELLED` only when `started = false`.
`*_source` must be `null` exactly when its time is `null`.

ERP sanity check (PROPOSAL): a run is never rejected for its clock (that would lose evidence). The ERP stores a
`clock_note` when `hmi_auto_time = false`, or `started_at` is later than the ERP receive time, or
`ended_at < started_at`; the lookup shows these times as "unverified".

## 3. Completeness (PROPOSAL)

New manifest/upload field **`held_count`**: the samples the VCU durably holds. `sample_count` stays the declared count.
`run_digest` is D13 over exactly the held samples in `sample_seq` order. `held_count ≤ sample_count`.

- `recording_complete` = `held_count == sample_count` (the VCU knows whether it lost samples).
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
| 71 | 1 | flags | b0 run_digest_match, b1 held_count_match, b2 recording_complete, b3 started; b4–b7 = 0 |
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
5. `FLAGS_INCONSISTENT`: flags disagree with the values; `held > sample_count`; `stored > held`; `started = 0` but not
   a zero-sample `ABORTED/CONFIG_CANCELLED/INCOMPLETE`; `CONFIG_CANCELLED` on a started run.
6. `TEST_ID_MISMATCH`, `VCU_ID_MISMATCH`, `BOOT_ID_MISMATCH`: against the VCU's own manifest (origin boot).
7. `MANIFEST_MISMATCH`: run_digest, sample_count, held_count or started differ from the manifest.
8. `SHORTFALL`: stored_sample_count ≠ held_count.
9. `DIGEST_MISMATCH`: samples_digest ≠ run_digest.
10. `RELEASE`.

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
Accepted: RA1 complete run · RA2 VCU-known incomplete · RA3 CANCEL · RA4 started, zero samples (FAULT) · RA5 b0 = 0 (V10)
· RA6 identifier lengths 1 and 32 · RA7 key B (rotation). Rejected: RR1–RR5 signature/key (including S + L and
key_id/key mismatch) · RR6–RR8 wrong run (test_id, vcu_id, reconnect boot) · RR9–RR13 validly signed shortfall,
digest mismatch, prefix trap, manifest mismatch · RR14–RR16 inconsistent flags/started · RR17–RR25 malformed
message (magic, reserved bits, enum, truncated, trailing byte, identifier lengths 0/33 and characters) · RR26–RR30
malformed encoding (padding, `+ /`, trailing bits, whitespace, 63-byte signature).

Regenerate: `node docs/motor-test/contract/tools/generate-receipt-vectors.js` · Check independently:
`python docs/motor-test/contract/tools/check_receipt_vectors.py` (checks RFC 8032 test 1 first, then all 37
decisions, and re-signs every untampered message byte for byte).

## 10. Open

- Mayank: review of the 37 receipt vectors and of `held_count` / completeness (current uptime: answered, `STATE.ms`).
- Pratham: check automatic time on the bench tablet (informational only; the ERP never treats it as a verified sync).
- Mayank: `held_count` and `origin_boot_id` in the manifest; ESP32-C3 heap, stack and verify-time measurements
  (Ed25519 verify libraries need roughly 10–20 KB of flash; 299 KB free); b4–b7 definitions.
- ERP (after agreement): migration for `CONFIG_CANCELLED`, `started`, `held_count`, origin boot and start fields, the
  key registry and stored signatures; signing key kept outside the image.
