# Motor Test ERP API — early draft v0.2 (2026-11-07)

**Changes in v0.2:** operator pick-list. New `GET /api/testing/operators` (fixture 07). Uploads now carry `operator_ref` (picked from the list) + `operator_name` (snapshot) instead of free text; unknown or inactive `operator_ref` → 400 `UNKNOWN_REFERENCE` (fixture 31). Shared account is real: `testing@compageauto.com`, user 843, role employee.

For Pratham (HMI) and Mayank (VCU). **Not frozen**: becomes Interface Contract v1 after sign-off at T012.

| File | What |
|---|---|
| `openapi.yaml` | OpenAPI 3 spec: login, `/api/testing/me`, variants, criteria, results |
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
