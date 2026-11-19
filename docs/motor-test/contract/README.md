# Motor Test ERP API — early draft v0.3 (2026-11-10)

**v0.4 DRAFT (2026-11-18, for review, not implemented):** signed archive receipt (Ed25519) so the VCU can trust
the ERP's receipt before ACK_ARCHIVED, completeness rule (`held_count`), CANCEL before start, run start without UTC,
and b0 = 0 (vector V10). See [`receipt-signing.md`](receipt-signing.md) and `vectors/receipt-vectors.json`
(52 vectors, checked independently by `tools/check_receipt_vectors.py`).

## v0.4 in the API (`openapi.yaml` 0.4.0-draft, 2026-11-19)

**Status: implemented on staging only** (`https://api.intute.biz/staging`, header `X-Staging-Key`); production after
the signing-key setup.

- **Opt-in per upload:** send `contract_version: "0.4"` (schema `RunUploadV04`). Without it the upload is v0.3
  (schema `RunUpload`, what the deployed app sends) and stays accepted, except that the **lifecycle table now applies
  to every upload**: COMPLETED → RAMP_COMPLETE; ABORTED → OPERATOR_STOP / HB_LOSS / CONFIG_CANCELLED;
  FAULT → FAULT / POWER_LOSS (so v0.3 ABORTED + POWER_LOSS is now 422, fixture 68).
- **New fields:** `vcu.origin_boot_id` (replaces `vcu.boot_id`, which is 400 in v0.4), `run_kind`
  (`bench` | `host_simulation` | `synthetic`; production accepts only `bench`, else 422 `RUN_KIND_NOT_ALLOWED`),
  `started`, `start_uptime_ms`, `started_at_source` / `ended_at_source` (`HMI` | `HMI_DERIVED` | null),
  `hmi_auto_time`, `held_count`, `recording_complete`, `config_hash`; `stop_reason` adds `CONFIG_CANCELLED`.
  `run_digest` covers the held samples 0..held_count-1.
- **New 422 INCONSISTENT_RUN rules:** LIFECYCLE_STOP_REASON, RECORDING_COMPLETE_REQUIRED, RECORDING_COMPLETE_COUNTS,
  CANCEL_SHAPE, SEQ_OUT_OF_RANGE, TIME_SOURCE (details in `openapi.yaml`, POST /api/testing/results).
- **Receipt:** v0.4 201/200 receipts add `signed_receipt` `{alg, key_id, message, signature}` (or null when the server
  has no signing key). A 200 retry returns it byte-identical; errors never carry it; v0.3 receipts never have it.
- **Run detail** (`GET /api/testing/results/{test_id}`) also returns `contract_version`, `run_kind`, `started`,
  `start_uptime_ms`, `*_source`, `hmi_auto_time`, `held_count`, `recording_complete`, `config_hash`, `origin_boot_id`
  (null for v0.3 runs, except `contract_version` "0.3").
- **Fixtures 60–68:** 60 complete PASS (201 + identical 200) · 61 CANCEL · 62 known loss (FAULT/SAMPLE_LOSS, held 3 of 5)
  · 63 FAULT/POWER_LOSS · 64 `host_simulation` on production · 65 COMPLETED + HB_LOSS · 66 PASS with
  `recording_complete=false` · 67 `vcu.boot_id` in a v0.4 body · 68 v0.3 ABORTED + POWER_LOSS. Signed receipts in
  60–63 use **TEST key A** from `vectors/receipt-vectors.json` (a real server uses its own key); each fixture has a
  `verify` block (keyring + VCU manifest) and the generator asserts the VCU decision is `RELEASE`.

**Changes in v0.3:** corrections move to the tablet, so operators never need the web CRM. Operators can look up runs by serial (`GET /api/testing/results?serial=`) and request a correction of a stored run (`POST /api/testing/results/{test_id}/corrections`, fixture 50: motor_serial, operator_ref or a remark only; readings and verdicts never change), and see its status (`GET …/corrections`, fixture 51). The testing head approves or rejects in the ERP. These endpoints are already live on the ERP.

**Changes in v0.2:** operator pick-list. New `GET /api/testing/operators` (fixture 07). Uploads now carry `operator_ref` (picked from the list) + `operator_name` (snapshot) instead of free text; unknown or inactive `operator_ref` → 400 `UNKNOWN_REFERENCE` (fixture 31). Shared account is real: `testing@compageauto.com`, user 843, role employee.

For Pratham (HMI) and Mayank (VCU). **Not frozen**: becomes Interface Contract v1 after sign-off at T012.

| File | What |
|---|---|
| `openapi.yaml` | OpenAPI 3 spec (0.4.0-draft): login, `/api/testing/me`, variants, criteria, results |
| `fixtures/` | Request + response JSON for every case (valid, retry, conflict, zero-sample fault, aborted, every error) |
| `vectors/run-digest-vectors.json` | D13 run digest V1–V9 (Mayank's rule), each checked in Python and JavaScript |
| `vectors/payload-hash-vectors.json` | Upload `payload_hash` P1–P5 |
| `vectors/profile-criteria-hash-vectors.json` | Profile / criteria `sha256` rule |
| `tools/generate-fixtures.js` | Regenerates all of the above: `node docs/motor-test/contract/tools/generate-fixtures.js` |

## Rules in one place

- **Login:** existing `POST /api/auth/login` `{email, password}` with `X-App-Version` → 12 h JWT. Expiry: JWT `exp` or `GET /api/testing/me`.
- **Errors:** `{error, code, ...}`. Re-login only on `AUTH_INVALID_TOKEN` / `AUTH_INVALID_USER`. `TESTING_ROLE_REQUIRED` = permission problem (NEEDS_REVIEW).
- **Upload:** `Idempotency-Key` = `test_id`. 201 new · 200 identical retry with the original receipt · 409 different payload. Nothing is stored on any 4xx/5xx.
- **payload_hash:** `sha256:` + SHA-256 of the RFC 8785 canonical JSON of the whole body. Uploader and headers excluded.
- **run_digest (D13):** 30-byte little-endian record per sample; invalid float = quiet NaN and `null` in JSON; `-0.0` → `0.0`; reserved flag bits must be 0.
- **Shared account:** while operators share `testing@compageauto.com`, every upload carries the operator picked from the pick-list (`operator_ref` + `operator_name`).

## Example values

All IDs, serials, user ids and readings are made up. `max_rpm 3000` comes from the product label and is **not approved** (D4/D9). Criteria limits are `null` on purpose: limits only come from the testing head's signed sheet (D5).

## Open items

- D11: COMPLETED run with unrecoverable gaps — proposed: accepted as INCOMPLETE (testing head).
- Role of the shared account, staging URL and test accounts (Saatwik / T049).
- Certificate pinning and renewal process (Pratham + IT).
