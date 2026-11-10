# Motor Test Module: Technical Notes

Paths are relative to `CRM_BACKEND/` unless they start with `CRM/` (the web frontend). This describes the code as it is at commit `4d9a543b` (2026-11-10). The design sources are `docs/motor-test/T011-erp-inventory.md` (architecture and reuse plan), `docs/motor-test/admin-api.md` (governance API) and `docs/motor-test/contract/` (the HMI interface contract, draft v0.3). Where those documents and the code differ, these notes follow the code and say so.

---

## 1. Overview

The motor-test module stores the results of end-of-line motor tests run on a test bench, and lets the testing head govern how those tests are run and judged. It is Phase 1 of the Motor Test Automation project. Three components share the work:

| Component | Owner | What it does |
|---|---|---|
| **VCU bench** (vehicle control unit on the test rig) | Mayank | Drives the motor through the speed ramp, records one reading per sample (speed, current, voltage, back-EMF, status flags) and computes the **run digest** (D13) over the readings it recorded |
| **Tablet HMI** (operator app) | Pratham | Operator screen. Downloads the published profile, criteria and operator pick-list from the ERP, starts the run, judges the outcome, and uploads the final run. It keeps every run until the ERP returns a receipt. Operators also look up runs and request corrections here. |
| **ERP** (this module) | Rahul | Motor variants, versioned test profiles and acceptance criteria with two-person approval, the operator pick-list, testing roles, immutable storage of every run and reading, corrections, audit, CSV export, and the governance screens in the web CRM |

```
 +-------------+  CAN / local link  +-----------------+   HTTPS REST (JWT, X-App-Version)
 |  VCU bench  | -----------------> |   Tablet HMI    | ---------------------------------+
 | ramp, read- |  readings + run    | operator, pick- |   GET config, POST /results,     |
 | ings, D13   |  digest manifest   | list, verdict   |   corrections                    |
 +-------------+                    +-----------------+                                  |
                                                                                         v
 +--------------------------+   HTTPS REST (JWT)   +------------------------------------------+
 | Web CRM /motor-testing   | -------------------> | ERP backend  /api/testing                |
 | testing head, viewers,   |   governance API     | routes/testing -> controllers -> models  |
 | admins (not operators)   |                      +-------------------+----------------------+
 +--------------------------+                                          |
                                                                       v
                                               PostgreSQL (RDS): mt_* tables, triggers, CHECKs
```

Design rules that run through the whole module:

- **Additive only.** Nothing existing is altered. The module reuses the ERP login, the `users` table and the product list in `inventory`. Everything else is new `mt_*` tables and new `/api/testing` routes.
- **Evidence never changes.** A stored run, its readings, its events, its receipt and every audit event can never be updated or deleted. Database triggers enforce this, not only the API.
- **Verdicts need full evidence.** PASS, FAIL and INVALID are accepted only for a completed run whose readings are all present and whose digest matches.
- **Two people.** A profile or criteria version is approved by someone who did not create, edit or submit it. A correction is decided by someone other than who added it.

**Status on 2026-11-10:** deployed. The backend serves `api.intute.biz/api/testing`, the production database was migrated after an RDS snapshot, and the CRM screens are live (shown only to users with a testing role). No testing roles have been granted and no real runs exist yet.

### 1.1 Module layout

| Layer | Files |
|---|---|
| Mount | `server.js`: `require('./routes/testing')` (line 65), 5 MB JSON parser for `/api/testing` (line 137), router (line 212), contract error handler (line 223) |
| Routes | `routes/testing/index.js` (HMI and governance routes in one router) |
| Access control | `middleware/auth.js#authenticateToken` (existing), `middleware/testingRoles.js` (`requireTestingRole`, `loadTestingRoles`) |
| Controllers | `controllers/testing/testing.controller.js` (HMI API, upload), `controllers/testing/admin.controller.js` (governance, corrections, audit, CSV) |
| Models | `models/testing/testingModel.js` (configuration reads, `storeRun`, lookups), `models/testing/adminModel.js` (governance writes, every one audited) |
| Services | `services/testing/validateRun.js` (`checkSchema`, `checkConsistency`), `services/testing/digest.js` (RFC 8785 canonical JSON, payload hash, D13 run digest) |
| Schema and tools | `scripts/migrations/motor-test/001_mt_schema.sql`, `002_version_second_person.sql`, `003_default_last_modified.sql`, `run.js`, `check_rules.js`, `db.js` |
| Contract | `docs/motor-test/contract/openapi.yaml`, `fixtures/` (27 request/response cases), `vectors/` (hash test vectors), `tools/generate-fixtures.js` |
| Tests | `tests/testing_digest.test.js`, `testing_validate.test.js`, `testing_api.test.js`, `testing_admin_api.test.js` |
| Web | `CRM/src/components/testing/` (route `/motor-testing/*`) |

### 1.2 Request flow

1. `express.json({ limit: '5mb' })` is mounted on `/api/testing` **before** the global 40 MB parser (`server.js` line 137). The global parser then skips the already-parsed body, so a motor-test request can never exceed 5 MB.
2. The global rate limiter (5,000 requests per 10 minutes) applies as for every route.
3. The router runs `authenticateToken` for every route (`router.use`). It is the existing ERP check: 401 `AUTH_NO_TOKEN`, 403 `AUTH_INVALID_TOKEN` for an expired or bad token, 503 `AUTH_UNAVAILABLE` if the user lookup fails.
4. `requireTestingRole(...)` checks the caller's testing roles (section 2).
5. The controller validates input, calls the model and maps errors to `{error, code, ...details}`.
6. Body-parser failures on `/api/testing` reach `testingRoutes.errorHandler` (`server.js` line 223), which is mounted before the global error handler. It answers 413 `PAYLOAD_TOO_LARGE` for `entity.too.large` and 400 `VALIDATION_ERROR` (with `fields`) for invalid JSON, so the tablet always receives the contract format.

---

## 2. Testing roles and access

### 2.1 Roles

The ERP gives each user exactly one `users.role_id`. Testing roles are kept separately in `mt_user_role` (primary key `user_id, testing_role`), so an employee keeps their ERP role and can also hold one or more testing roles. The existing `roles` and `permissions` tables and `middleware/roles.js` are not touched.

| Testing role | Who | Works in |
|---|---|---|
| `operator` | Shop-floor operators | Tablet only: downloads configuration, uploads runs, looks up runs by serial, requests corrections |
| `testing_head` | Testing head | Web CRM: variants, profiles, criteria, operator pick-list, approvals, correction decisions, audit |
| `viewer` | Read-only stakeholders | Web CRM: results, versions, CSV export |
| `testing_admin` | ERP administrators | Everything the testing head can do, plus granting and revoking testing roles |

- **ERP Admins act as** `testing_admin`**.** `loadTestingRoles(userId, erpRoleId)` adds `testing_admin` for `role_id 1`, so the first roles can be granted from the CRM without a database script. This implicit role is derived from the ERP role and cannot be removed through the roles screen.
- Roles are loaded once per request and cached on `req.testingRoles`.
- A caller without a required role gets **403** `TESTING_ROLE_REQUIRED` with `required_role`. This is deliberately not an authentication code, so the tablet never mistakes a missing permission for an expired login. A database failure while loading roles gives 503 `SERVER_UNAVAILABLE`.
- `requireTestingRole` throws at start-up if it is given an unknown role name.
- Only Compage staff can hold testing roles: users with `role_id` 2 (customer), 11 or 12 (Intute AI) are excluded from the user list and refused by `PUT .../testing-roles` (404).
- A testing admin cannot remove their own `testing_admin` grant (409 `LIFECYCLE_CONFLICT`).
- Every grant and revoke writes a `ROLE_GRANTED` or `ROLE_REVOKED` audit event.

**Operator identity (D6, approved interim).** Operators share one ERP account, `testing@compageauto.com` (user 843, ERP role employee). Each upload also carries the person picked on the tablet from the ERP-managed **operator pick-list** (`mt_operator`): `operator_ref` plus an `operator_name` snapshot. Moving to personal accounts later only means granting the `operator` role to each person; no design change. The shared account is an ISO 27001 A.5.16 deviation recorded for the CMP-04 security review.

### 2.2 Role groups in the router

`routes/testing/index.js` defines four groups:

| Group | Roles |
|---|---|
| `CONFIG_READERS` | operator, testing_head, viewer, testing_admin |
| `RESULT_READERS` | operator, viewer, testing_head, testing_admin (operators read results so they can find a run to correct) |
| `EXPORTERS` | viewer, testing_head, testing_admin |
| `EDITORS` | testing_head, testing_admin |

### 2.3 Permission matrix

| Action | testing_head | testing_admin | operator | viewer |
|---|---|---|---|---|
| Read configuration (operators list, variants, published profile and criteria, criteria snapshots) | yes | yes | yes | yes |
| Upload a run (`POST /results`) | | | yes | |
| Read results, run detail, corrections of a run | yes | yes | yes | yes |
| CSV export of a run | yes | yes | | yes |
| Add a correction | | | yes | |
| Decide a correction | yes | yes | | |
| Read variants and versions in the governance views | yes | yes | yes | yes |
| Create and edit variants; create, edit, delete, submit, return, approve, withdraw versions | yes | yes | | |
| Products list, operator pick-list management, pending corrections, audit log | yes | yes | | |
| List users and set testing roles | | yes | | |

Note that only the `operator` role may upload or add corrections. A testing head who also needs to upload must hold `operator` as well (the staging tests give user 843 testing_head, operator and viewer together).

---

## 3. HMI API (tablet)

All paths are under `/api/testing` and need `Authorization: Bearer <JWT>`. The tablet logs in with the existing `POST /api/auth/login` and sends `X-App-Version` on every call, which gives it a 12 h token. Token expiry is the JWT `exp` claim, or `token_expires_at` from `/me`. Only `AUTH_INVALID_TOKEN` and `AUTH_INVALID_USER` mean "log in again". In the tables, "all four" means every testing role, "head" is `testing_head`, "admin" is `testing_admin`, and `:id` in a `/results/...` path is the run's `test_id`. The contract is `docs/motor-test/contract/openapi.yaml` (v0.3, not frozen; it becomes Interface Contract v1 after sign-off at T012).

| Method | Path | Roles | Notes |
|---|---|---|---|
| GET | `/me` | any user | `{user_id, name, testing_roles, token_expires_at}` |
| GET | `/operators` | all four | Active pick-list entries `{operator_ref, name, active}`, sorted by name. The tablet caches it for offline use. |
| GET | `/variants` | all four | Active variants. Query `q`, `page`, `page_size` (1 to 100, default 20). `q` matches code or product name (`%` and `_` are literal). Each item has `has_published_config`. |
| GET | `/variants/:id` | all four | Variant with its current PUBLISHED profile and criteria (with their `sha256`). 404 `NOT_FOUND`; 409 `NOT_PUBLISHED` if either is missing. |
| GET | `/criteria/:id` | all four | Exact snapshot of any criteria version that was ever published (PUBLISHED, SUPERSEDED or WITHDRAWN) |
| POST | `/results` | operator | Store one final run. Idempotent on `test_id` (section 4). |
| GET | `/results` | all four | Query `serial` (required). All runs for one exact serial (1 to 64 characters), newest first, at most 500. Also finds runs whose serial was changed by an APPROVED correction. |
| GET | `/results/:id` | all four | Full run: header fields, receipt, events, the exact profile and criteria used, and one page of readings (query `samples_offset`, `samples_limit` 1 to 5,000, default 2,000) with `samples_page {offset, limit, returned, total}` |
| GET | `/results/:id/corrections` | all four | Corrections of one run, newest first |
| POST | `/results/:id/corrections` | operator | Request a correction (section 6.5) |

Ids are UUIDs; a malformed id in a path answers 404 `NOT_FOUND` without a database query. Readings are always read per test through the primary key, in pages, never all at once (the RDS instance is small).

---

## 4. Result upload (POST /api/testing/results)

### 4.1 Algorithm

The upload is atomic and idempotent. Every check that does not need the database runs before the transaction, and a rejected upload stores no run data.

1. **Size.** A `Content-Length` above 5 MB answers 413 `PAYLOAD_TOO_LARGE` before anything else. (The 5 MB body parser also enforces it.) 5 MB holds about 40,000 readings; a 120 s run at 10 Hz is about 1,200.
2. **Schema check** (`checkSchema`). Exactly the 23 contract fields, no others; lowercase UUID v4 `test_id`; lowercase UUIDs for the other ids; digests as `sha256:` plus 64 lowercase hex; ISO 8601 UTC timestamps with at most millisecond precision and a real calendar date; enum values; strings without NUL or lone surrogates; `outcome_reasons` at most 200 small JSON objects (depth 4, 2 kB each); at most 10,000 events and 40,000 samples; integer ranges for sample fields; float readings that fit a float32 (finite, not overflowing, not underflowing to zero) or `null`; `status_flags` 0 to 255 (reserved bits b8 to b15 must be 0). The `Idempotency-Key` header is required and must equal `test_id`. Any failure answers **400** `VALIDATION_ERROR` with `fields: [{path, msg}]`.
3. **Consistency check** (`checkConsistency`, rules in 4.2). It also computes the ERP's own D13 digest of the uploaded samples (`samplesDigest`). Violations are collected for a 422; reserved flag bits found here answer 400.
4. **Payload hash.** `payload_hash = "sha256:" + SHA-256(RFC 8785 canonical JSON of the whole body)`. A body that cannot be canonicalised answers 400.
5. **One transaction** (`testingModel.storeRun`):
   1. `BEGIN`, `SET LOCAL lock_timeout = '10s'`.
   2. `pg_advisory_xact_lock(hashtextextended(test_id, 7319))` serialises concurrent uploads of the same `test_id`, even before any row exists.
   3. Look up an existing receipt for the `test_id`:
      - same `payload_hash`: increment `attempts`, set `last_attempt_at`, `COMMIT`, answer **200 with the original receipt** (identical retry);
      - different hash: write an `UPLOAD_CONFLICT` audit event, `COMMIT`, answer **409** `PAYLOAD_CONFLICT` with `existing_payload_hash` and `received_payload_hash`. The original run is untouched.
   4. Check references (`checkReferences`): the variant exists; the profile and criteria version exist, were published at some point, belong to that variant, and their `sha256` equals `profile_sha256` / `criteria_sha256`; `operator_ref` is active, or was deactivated after `started_at`; `operator_id` is an ERP user. Any failure: `ROLLBACK`, **400** `UNKNOWN_REFERENCE` with `fields`.
   5. If the consistency check (step 3 above) found violations: `ROLLBACK`, **422** `INCONSISTENT_RUN` with `violations: [{path, rule, msg}]`.
   6. Insert `mt_test_run` (with `uploaded_by` = the authenticated user, `samples_digest` and `run_digest_match`), all readings in one `unnest` insert into `mt_test_sample`, all events into `mt_test_event` (`event_seq` = position in the upload), the `mt_upload_receipt` row, and a `RESULT_STORED` audit event. `COMMIT`, answer **201 with the receipt**.
6. **Any database error** rolls back, discards the connection (`client.release(err)`) and answers **503** `SERVER_UNAVAILABLE`. Nothing was committed, so the tablet retries the same body with backoff.

Readings are inserted as exactly the float32 value that was hashed: each value is rounded once in JS with `Math.fround`, and `-0.0` is stored as `+0.0`. `operator_id` and `operator_name` in the body are never changed; the uploader is recorded separately in `uploaded_by` and is not part of the payload hash, so any operator account can upload a queued run.

| Answer | When | Stored |
|---|---|---|
| 201 | New `test_id`, all checks pass | Run, readings, events, receipt, audit event |
| 200 | Same `test_id`, same payload hash | Only `attempts` and `last_attempt_at` on the receipt |
| 409 `PAYLOAD_CONFLICT` | Same `test_id`, different payload hash | Only an `UPLOAD_CONFLICT` audit event |
| 400 `VALIDATION_ERROR` / `UNKNOWN_REFERENCE` | Schema, header or reference failure | Nothing |
| 413 `PAYLOAD_TOO_LARGE` | Body above 5 MB | Nothing |
| 422 `INCONSISTENT_RUN` | Consistency rule broken | Nothing |
| 503 `SERVER_UNAVAILABLE` | Database error | Nothing; retry the same body |

Receipt: `{receipt_id, test_id, stored_sample_count, payload_hash, samples_digest, run_digest_match, stored_at}`. `stored_at` is the time of the original commit and does not change on retries. Only a 201 or 200 receipt allows the bench and tablet to archive the run (`ACK_ARCHIVED`).

### 4.2 Consistency rules (422 INCONSISTENT_RUN)

| Rule | Meaning |
|---|---|
| `PASS_REQUIRES_COMPLETED` | PASS, FAIL and INVALID need `final_state` COMPLETED; ABORTED and FAULT runs must be INCOMPLETE |
| `COMPLETED_NEEDS_SAMPLES` | A COMPLETED run needs `sample_count > 0` (FAULT and ABORTED runs may have 0 samples) |
| `FAULT_CODE_REQUIRED` | `fault_code` is required when `final_state` is FAULT |
| `TIME_ORDER` | `ended_at` is before `started_at` |
| `TOO_MANY_SAMPLES` | More samples uploaded than `sample_count` |
| `SEQ_OUT_OF_RANGE` | A `sample_seq` is not below `sample_count` |
| `SEQ_ORDER` | Samples are not in strictly ascending `sample_seq` order |
| `VALIDITY_FLAG_MISMATCH` | A validity bit and its value disagree (bit 0 with a number, or bit 1 with `null`) |
| `COMPLETE_EVIDENCE_REQUIRED` | PASS, FAIL or INVALID with gaps: samples `0..sample_count-1` must all be present (the message lists up to five missing `sample_seq` values) |
| `DIGEST_MATCH_REQUIRED` | PASS, FAIL or INVALID whose `run_digest` differs from the digest of the uploaded samples |

An INCOMPLETE run may have gaps and a non-matching digest; the receipt then reports `run_digest_match: false`. Open decision D11 (testing head) proposes that a COMPLETED run with unrecoverable gaps is accepted as INCOMPLETE; the code already behaves this way.

---

## 5. Hashing rules

All hashes are written `sha256:` plus 64 lowercase hex. The implementation is `services/testing/digest.js`; it must reproduce every vector in `docs/motor-test/contract/vectors/` exactly, which `tests/testing_digest.test.js` checks.

### 5.1 Payload hash

`payload_hash` is the SHA-256 of the **RFC 8785** (JSON Canonicalization Scheme) form of the whole request body: object keys sorted, no whitespace, numbers and strings in their shortest JSON form. Key order and whitespace therefore do not change the hash; a changed reading does. Headers and the uploader are not included. Vectors: `payload-hash-vectors.json` (P1 to P5).

### 5.2 Run digest (D13)

The VCU and the ERP compute the same digest over the readings. Each sample becomes one **30-byte little-endian record**, and the digest is the SHA-256 of the records concatenated in ascending `sample_seq` order. A run with zero samples has the digest of nothing (`sha256:e3b0c442...b855`).

| Offset | Size | Field | Encoding |
|---|---|---|---|
| 0 | 4 | `sample_seq` | uint32 |
| 4 | 4 | `t_ms` | uint32 |
| 8 | 4 | `rpm_cmd` | int32 |
| 12 | 4 | `rpm_actual` | int32 |
| 16 | 4 | `current_a` | float32; quiet NaN (`00 00 c0 7f`) when bit 1 is 0 |
| 20 | 4 | `voltage_v` | float32; quiet NaN when bit 2 is 0 |
| 24 | 4 | `bemf_v` | float32; quiet NaN when bit 3 is 0 |
| 28 | 2 | `status_flags` | uint16; bits 8 to 15 must be 0 |

- An invalid reading is `null` in JSON and quiet NaN in the record. A valid reading must be a number.
- `-0.0` is written as `+0.0`.
- `status_flags` bits: b0 rpm valid, b1 current valid, b2 voltage valid, b3 BEMF valid, b4 CAN stale, b5 setpoint changed, b6 protective warning, b7 storage lag.
- Vectors: `run-digest-vectors.json` (V1 to V9, each checked in Python and JavaScript).

Readings are stored in `real` (IEEE binary32) columns. PostgreSQL 12 and later return `real` as the shortest exact text, so a run read back from `GET /results/:testId` rebuilds the same digest.

### 5.3 Profile and criteria hashes

Frozen when a version is approved (`adminModel.sha256Of`), using the same canonical-JSON hash:

- **Profile:** hash of `{variant_id, version, max_rpm, step_rpm, duration_s, sample_hz}`.
- **Criteria:** hash of the stored `definition`, which always contains `variant_id` and `version` (the server sets both; values sent by the client are dropped).

The tablet caches the published profile and criteria with their `sha256` and sends both hashes with every upload; the ERP refuses an upload whose hashes do not match the versions it names. Vectors: `profile-criteria-hash-vectors.json`.

---

## 6. Governance API (web CRM)

Base `/api/testing`, same router and login. Contract: `docs/motor-test/admin-api.md`. Every change runs in one transaction together with its `mt_audit_event` row (`adminModel.tx` and `audit`). Database errors are mapped in one place (`admin.controller.js#handle`): unique violation 23505 → 409 `DUPLICATE`, foreign key 23503 → 400 `UNKNOWN_REFERENCE`, CHECK 23514 → 400 `VALIDATION_ERROR`, restrict violation 23001 (the `MT_IMMUTABLE` trigger errors) → 409 `LIFECYCLE_CONFLICT`, anything else → 503 `SERVER_UNAVAILABLE`.

### 6.1 Endpoints

| Method | Path | Roles | Notes |
|---|---|---|---|
| GET | `/admin/products` | head, admin | `inventory` products with their `variant_id` (or null), for linking a variant |
| GET | `/admin/variants` | all four | Query `include_inactive=1` adds inactive ones. Variants with product name and the published profile and criteria version numbers |
| POST | `/admin/variants` | head, admin | `{product_id, code, max_rpm_limit?, rated_voltage_v?, rated_power_w?, rated_current_a?, controller_model?, serial_pattern?}` → 201 |
| GET | `/admin/variants/:id` | all four | One variant |
| PATCH | `/admin/variants/:id` | head, admin | Any create field except `product_id`, plus `active` |
| GET | `/admin/variants/:id/{kind}` | all four | All versions, newest first. `{kind}` is `profiles` or `criteria`. |
| POST | `/admin/variants/:id/{kind}` | head, admin | New DRAFT, version = last + 1 |
| GET | `/admin/{kind}/:id` | all four | One version, with `created_by_name` and `approved_by_name` |
| PATCH | `/admin/{kind}/:id` | head, admin | Edit a DRAFT |
| DELETE | `/admin/{kind}/:id` | head, admin | Delete a DRAFT → 204 |
| POST | `/admin/{kind}/:id/submit` | head, admin | DRAFT → IN_REVIEW |
| POST | `/admin/{kind}/:id/return` | head, admin | IN_REVIEW → DRAFT, optional `{note}` |
| POST | `/admin/{kind}/:id/approve` | head, admin | IN_REVIEW → PUBLISHED (second person only) |
| POST | `/admin/{kind}/:id/withdraw` | head, admin | PUBLISHED → WITHDRAWN, `{reason}` required |
| GET | `/admin/operators` | head, admin | Query `include_inactive=1` adds inactive ones. Pick-list with `user_id`, `created_at`, `deactivated_at` |
| POST | `/admin/operators` | head, admin | `{name, user_id?}` → 201 |
| PATCH | `/admin/operators/:ref` | head, admin | `{name?, user_id?, active?}` |
| GET | `/admin/users` | testing_admin | Query `q`, `limit`. Compage staff with ERP role and testing roles (`limit` 1 to 200, default 50) |
| PUT | `/admin/users/:userId/testing-roles` | testing_admin | `{roles: [...]}` replaces the user's testing roles |
| POST | `/corrections/:id/decide` | head, admin | `{decision: "APPROVED" or "REJECTED", note?}` |
| GET | `/admin/corrections` | head, admin | Corrections of all runs, optionally filtered by `status` (PENDING, APPROVED, REJECTED), at most 500 |
| GET | `/admin/audit` | head, admin | Query `entity`, `entity_id`, `limit`. Audit events newest first (`limit` 1 to 500, default 100) |
| GET | `/results/:testId/export.csv` | viewer, head, admin | All readings as CSV |

Appendix A lists these routes with `{kind}` and `{action}` placeholders, because the router builds them in a loop.

### 6.2 Motor variants

A variant holds the test-specific data for one motor model and links to `inventory.product_id`; product identity is never copied. Rules:

- One variant per product (`product_id UNIQUE`) and a unique `code` (1 to 50 characters: letters, digits, space, `. _ - /`).
- `max_rpm_limit`: null or 1 to 100,000. A profile's `max_rpm` may not exceed it.
- `rated_voltage_v`, `rated_power_w`, `rated_current_a`: null or a number of at least 0. `controller_model`: up to 100 characters.
- `serial_pattern`: null or a valid regular expression up to 200 characters. It is stored for the tablet; the ERP does not check serials against it.
- Variants are deactivated (`active: false`), never deleted. `VARIANT_UPDATED` audit events record before and after values.

### 6.3 Profile and criteria versions

**Profile fields:** `max_rpm` (1 to 100,000, at most the variant limit), `step_rpm` (1 to 10,000), `duration_s` (1 to 3,600), `sample_hz` (5 to 1,000), with `duration_s x sample_hz` at most 36,000 readings so a run always fits one upload.

**Criteria fields:** `definition` (object, at most 100 kB) and `source_document` (reference of the signed sheet, up to 300 characters). `definition.rules[]` is validated: `id` is UPPER_CASE (1 to 40 characters) and unique; `type` is one of `max, min, range, checkpoint, tracking, reach, bemf_constant`; `signal` is one of `current_a, voltage_v, rpm_actual, bemf_v`; numeric parameters (`limit, min, max, at_rpm, rpm_window, exclude_first_ms, max_err_rpm, exclude_transient_ms, target_rpm, tolerance_rpm, min_rpm`) are numbers or null; `min` may not exceed `max`. Limit values come only from the testing head's signed sheet (D5); the ERP does not evaluate the rules, the tablet does.

**Lifecycle:**

```
 DRAFT --submit--> IN_REVIEW --approve--> PUBLISHED --(next approve)--> SUPERSEDED
   ^                   |                      |
   +------return-------+                      +--withdraw (reason)--> WITHDRAWN
 DRAFT: editable and deletable.  IN_REVIEW, PUBLISHED, SUPERSEDED, WITHDRAWN: content frozen.
```

- `create` locks the variant row and inserts version = max + 1 with `created_by` and `last_modified_by` set to the author.
- `PATCH` (DRAFT only) sets `last_modified_by` to the editor. `submit` records `submitted_at` and `submitted_by`; `return` clears them.
- `approve` locks the variant row (one publish at a time per variant), then the version. The approver must differ from `created_by`, `last_modified_by` and `submitted_by`, otherwise **409** `SECOND_PERSON_REQUIRED`. It computes and freezes `sha256`, moves the variant's current PUBLISHED version to SUPERSEDED (`retired_reason` "Superseded by version N"), and publishes this one with `approved_by` and `published_at`.
- `withdraw` needs a reason of 1 to 500 characters and leaves the variant without a published version of that kind, so `GET /variants/:id` answers 409 `NOT_PUBLISHED` until a new version is approved.
- An action in the wrong status answers 409 `LIFECYCLE_CONFLICT` with the current `status`.
- Audit actions: `PROFILE_` or `CRITERIA_` plus `DRAFT_CREATED`, `DRAFT_UPDATED`, `DRAFT_DELETED`, `SUBMITTED`, `RETURNED`, `PUBLISHED`, `WITHDRAWN`.

Old runs keep pointing at the exact profile and criteria version they used; `GET /criteria/:id` serves any version that was ever published.

### 6.4 Operator pick-list

`mt_operator` holds the names shown on the tablet. A name is 1 to 100 characters and must be unique among active entries (case-insensitive). `user_id` links a person once they have a personal login. Deactivating sets `deactivated_at`; reactivating clears it. Entries are never deleted. An upload is accepted for an operator who was active when the run started, even if deactivated before the upload arrived.

### 6.5 Corrections

The original run never changes. A correction is a new `mt_correction` record linked to it.

- **Add** (operator, from the tablet): `{corrected_fields, reason, operator_ref?}`. `corrected_fields` must contain at least one of `motor_serial` (1 to 64 characters, no surrounding spaces), `operator_ref` (a pick-list entry) or `remark` (1 to 500 characters). Any other field is refused with "cannot be corrected (verdicts and readings never change)". `reason` is 1 to 500 characters. The top-level `operator_ref` records who asked while the account is shared. Unknown operator refs answer 400 `UNKNOWN_REFERENCE`; an unknown run answers 404. The correction starts PENDING and is audited as `CORRECTION_ADDED`.
- **Decide** (testing_head or testing_admin): APPROVED or REJECTED with an optional note, once only (otherwise 409 `LIFECYCLE_CONFLICT`). The decider must differ from `added_by` (409 `SECOND_PERSON_REQUIRED`). Audited as `CORRECTION_DECIDED`.
- An APPROVED `motor_serial` correction makes the run findable under the corrected serial as well as the original one (`listRunsBySerial`).

### 6.6 Audit log

`mt_audit_event` is append-only. Each event records `at`, `actor_user_id`, `actor_operator_ref` (the picked operator, where known), `action`, `entity`, `entity_id` and a JSON `detail`. Actions written by the code: `RESULT_STORED`, `UPLOAD_CONFLICT`, `VARIANT_CREATED`, `VARIANT_UPDATED`, the version actions in 6.3, `OPERATOR_CREATED`, `OPERATOR_UPDATED`, `ROLE_GRANTED`, `ROLE_REVOKED`, `CORRECTION_ADDED`, `CORRECTION_DECIDED`, `CSV_EXPORTED`. Corrections and exports are filed under entity `mt_test_run` with the `test_id`, so the audit of one run shows its whole history.

### 6.7 CSV export

`GET /results/:testId/export.csv` returns every reading of the run, ordered by `sample_seq`, as `text/csv` with the header `sample_seq,t_ms,rpm_cmd,rpm_actual,current_a,voltage_v,bemf_v,status_flags` and the file name `motor-test-<test_id>.csv`. Invalid readings are empty cells. Each export writes a `CSV_EXPORTED` audit event with the row count.

### 6.8 Web screens

`CRM/src/components/testing/` is mounted at `/motor-testing/*` (`CRM/src/routeConfig.jsx`). The route is open to Compage ERP roles; the module reads `GET /api/testing/me` and shows only what the user's testing roles allow, and the API enforces the same rules. Screens: serial lookup, run detail with charts (recharts), motor types (variants) with the versions panel and criteria editor, operators, testing roles, and pending corrections. Operators do not use the web screens.

---

## 7. Database

### 7.1 Tables

All tables are new and prefixed `mt_`. Ids are UUID v4 (`gen_random_uuid()` from `pgcrypto`), timestamps are `timestamptz`, units are SI and named in the column.

| Table | Purpose | Key points |
|---|---|---|
| `mt_user_role` | Testing roles | PK `(user_id, testing_role)`; role CHECK in the four names; `granted_by`, `granted_at` |
| `mt_operator` | Operator pick-list | `operator_ref` PK; name 1 to 100 characters; unique active name (`ux_mt_operator_active_name`); `CHECK (active OR deactivated_at IS NOT NULL)` |
| `mt_motor_variant` | Test data for one product | `product_id` UNIQUE FK to `inventory`; `code` UNIQUE; `max_rpm_limit > 0` |
| `mt_profile_version` | Ramp profile versions | `UNIQUE (variant_id, version)`; positive values, `sample_hz >= 5`; status CHECK; one PUBLISHED per variant (`ux_mt_profile_one_published`) |
| `mt_criteria_version` | Acceptance criteria versions | Same lifecycle columns and rules as profiles; `definition jsonb`, `source_document` |
| `mt_test_run` | One stored run | `test_id` PK from the HMI; references variant, profile, criteria, operator and users; digests and `run_digest_match`; indexes on `(motor_serial, started_at DESC)` and `received_at DESC` |
| `mt_test_sample` | One row per reading (D7) | PK `(test_id, sample_seq)`; `real` floats; validity CHECKs |
| `mt_test_event` | Run events | PK `(test_id, event_seq)`; type in STATE, FAULT, COMMAND, INFO |
| `mt_upload_receipt` | Idempotency anchor | `test_id` PK, `receipt_id` UNIQUE, `payload_hash`, `first_received_at`, `last_attempt_at`, `attempts` |
| `mt_correction` | Corrections | `corrected_fields` a non-empty object; status PENDING, APPROVED or REJECTED |
| `mt_audit_event` | Append-only audit | `event_id` identity PK; indexes on `(entity, entity_id)` and `at DESC` |
| `schema_migrations` | Migration tracking | `name` PK, file `sha256`, `applied_at`, `applied_by` (created by `run.js`) |

Volume (D7): up to 10 tests a day now and 30 or more later, about 1,200 readings per test, kept 8 years: about 88,000 runs and 105 million reading rows (about 13 GB). Readings are always fetched per test through the primary key, so one table stays fast; partitioning is deferred.

### 7.2 Rules enforced in the database

The important rules are enforced by the database itself, so they hold even if the API has a bug.

**Immutability triggers**

| Trigger | Table | Rule |
|---|---|---|
| `trg_mt_test_run_immutable`, `trg_mt_test_sample_immutable`, `trg_mt_test_event_immutable`, `trg_mt_audit_immutable` | runs, readings, events, audit | `mt_forbid_change()`: every UPDATE and DELETE fails with `MT_IMMUTABLE` |
| `trg_mt_receipt_guard` | `mt_upload_receipt` | Only `attempts` (never decreasing) and `last_attempt_at` may change; no delete |
| `trg_mt_correction_guard` | `mt_correction` | Only a PENDING correction may change, and only its decision fields; no delete |
| `trg_mt_profile_guard`, `trg_mt_criteria_guard` | versions | `mt_version_guard()`: only DRAFT can be deleted; DRAFT may only move to IN_REVIEW; outside DRAFT the content columns are frozen; allowed moves are IN_REVIEW → DRAFT or PUBLISHED and PUBLISHED → SUPERSEDED or WITHDRAWN; a PUBLISHED row's `sha256`, `approved_by`, `published_at` and `submitted_by` never change |
| `trg_mt_profile_default_modifier`, `trg_mt_criteria_default_modifier` | versions | BEFORE INSERT: `last_modified_by` defaults to `created_by` |

**CHECK constraints on runs and readings**

- `outcome = 'INCOMPLETE' OR final_state = 'COMPLETED'` and `final_state = 'COMPLETED' OR outcome = 'INCOMPLETE'`: verdicts only for completed runs, and ABORTED or FAULT runs are always INCOMPLETE.
- `final_state <> 'COMPLETED' OR sample_count > 0`.
- `outcome = 'INCOMPLETE' OR (run_digest_match AND stored_sample_count = sample_count)`: verdicts need full, matching evidence.
- `final_state <> 'FAULT' OR fault_code IS NOT NULL`; `ended_at >= started_at` when both are set; `stored_sample_count <= sample_count`; digest format on `run_digest` and `samples_digest`.
- Readings: `status_flags` 0 to 255; `current_a`, `voltage_v` and `bemf_v` are non-null exactly when bits 1, 2 and 3 are set.

**Two-person approval**

- Versions: `mt_profile_approver_independent` and `mt_criteria_approver_independent` (migration 002) require `approved_by` to differ from `created_by`, `last_modified_by` and `submitted_by`. The original 001 CHECK (`approved_by <> created_by`) also remains.
- Any status other than DRAFT or IN_REVIEW requires `sha256`, `approved_by` and `published_at`; WITHDRAWN requires `retired_reason`.
- Corrections: `decided_by <> added_by`, and `(status = 'PENDING') = (decided_by IS NULL AND decided_at IS NULL)`.

`check_rules.js` proves these rules on staging (section 8).

---

## 8. Migrations

Motor-test migrations are plain SQL files `NNN_*.sql` in `scripts/migrations/motor-test/`, applied by `run.js`. This is different from the older ERP migrations, which are dated Node scripts with no tracking table.

| File | Content |
|---|---|
| `001_mt_schema.sql` | `pgcrypto`, all `mt_*` tables, indexes, CHECKs and triggers |
| `002_version_second_person.sql` | `last_modified_by` and `submitted_by` on both version tables, the approver-independence CHECKs, and the updated `mt_version_guard()` that treats `submitted_by` as workflow data |
| `003_default_last_modified.sql` | BEFORE INSERT triggers that default `last_modified_by` to `created_by` |

`run.js` behaviour:

- Connects to exactly one named database (`--db`). Connection settings come from `db.js`, which reads the repo `.env` and **verifies the RDS TLS certificate** against the AWS RDS CA bundle (`DB_SSL_CA` can point elsewhere).
- Creates `schema_migrations` if it is missing. Each pending file runs in its own transaction together with its `schema_migrations` row; on error it is rolled back and the run stops.
- An applied file whose content changed since (its SHA-256 differs) stops the run: add a new migration instead of editing an applied one.
- `--dry-run` lists pending files with the session set to read-only, so it never writes.
- Refuses the production database `erp_migrated` unless `--production` is given.

```
# staging
node scripts/migrations/motor-test/run.js --db erp_staging --dry-run
node scripts/migrations/motor-test/run.js --db erp_staging
node scripts/migrations/motor-test/check_rules.js --db erp_staging

# production: take a manual RDS snapshot first, review, then
node scripts/migrations/motor-test/run.js --db erp_migrated --production --dry-run
node scripts/migrations/motor-test/run.js --db erp_migrated --production
```

`check_rules.js` runs 24 checks (valid runs stored; invalid runs, edits and deletes refused; receipt, version, correction and audit rules) inside one transaction that is always rolled back, and prints the number of rows left in the `mt_` tables. It refuses `erp_migrated`.

Recovery agreement (2026-11-07): a manual snapshot before every migration, deleted once verified; at most about 5 minutes of changes lost on a server failure and a 30 to 60 minute restore. Migrations 001 to 003 were applied to `erp_staging` first and to `erp_migrated` on 2026-11-10 after a snapshot.

---

## 9. Environments and tests

### 9.1 Environments

| Environment | Database | Backend |
|---|---|---|
| Staging | `erp_staging` on the same RDS instance (created 2026-11-05: full production structure plus roles, permissions, users and products only; 15-connection cap) | **Planned:** same EC2 host as production on port 8001, about 150 MB memory cap, its own image tag, `.env` and a database user limited to staging; stopped when idle (needs swap on the EC2 host first) |
| Production | `erp_migrated` (migrated 2026-11-10) | The existing backend; the routes are live under `/api/testing` |

All development, automated tests, destructive tests (ERP-T08) and fake runs stay on staging. The RDS instance is PostgreSQL 17.9 (`db.t4g.micro`, single AZ). Until the staging backend exists, the OpenAPI server URL is a placeholder (`staging-host-TBD`).

### 9.2 Tests

| File | Database | Covers |
|---|---|---|
| `testing_digest.test.js` | none | Every D13 run-digest vector, every payload-hash vector (key order and whitespace do not matter, a changed reading does), profile and criteria hash vectors |
| `testing_validate.test.js` | none | Every contract fixture gets its documented answer from `checkSchema` / `checkConsistency`; unknown fields; non-v4 ids; non-UTC timestamps; out-of-range `sample_seq`; leap day and millisecond timestamps; D11 gap handling |
| `testing_api.test.js` | `erp_staging` | HMI end to end: 401 and 403 codes, `/me`, variant detail, pick-list, 201 receipt (ERP-T03), identical retry x5 and two concurrent identical uploads (ERP-T04), conflict 409 with audit (ERP-T05), zero-sample FAULT (ERP-T06), key mismatch, 413, malformed JSON, readings read back exactly |
| `testing_admin_api.test.js` | `erp_staging` | Governance end to end: variants, drafts, variant RPM limit, second-person approval (author, editor and submitter), frozen published versions, supersede, return, withdraw, criteria validation, pick-list, roles, corrections, CSV export |

The two database suites set `DB_NAME=erp_staging` before loading `config/db` and refuse to run if `current_database()` is anything else. They create their own throwaway product, variant, versions and operator, grant testing roles to staging user 843 (user 1, an ERP Admin, acts as `testing_admin`), and remove everything afterwards (cleanup bypasses the immutability triggers with `session_replication_role = replica`, which is acceptable on staging test data only). Because both suites grant and revoke roles for the same user, they must run **serially**:

```
npx jest --runInBand tests/testing_digest.test.js tests/testing_validate.test.js tests/testing_api.test.js tests/testing_admin_api.test.js
```

`*.test.js` files are gitignored but tracked, so a new test file must be added with `git add -f`. The contract fixtures and vectors are regenerated with `node docs/motor-test/contract/tools/generate-fixtures.js`. T011 records 79 automated tests and 24 database rule checks passing on staging before deployment.

---

## 10. Error codes

| Code | HTTP | Raised by |
|---|---|---|
| `AUTH_NO_TOKEN` | 401 | No bearer token |
| `AUTH_INVALID_TOKEN`, `AUTH_INVALID_USER` | 403 | Expired or bad token, unknown user: log in again |
| `AUTH_UNAVAILABLE` | 503 | User lookup failed during authentication |
| `TESTING_ROLE_REQUIRED` | 403 | Logged in but missing the testing role (`required_role` in the body) |
| `VALIDATION_ERROR` | 400 | Bad body, header, query or JSON (`fields[]`); also a database CHECK violation on governance writes |
| `UNKNOWN_REFERENCE` | 400 | Unknown or unpublished variant, profile, criteria or operator, hash mismatch, unknown user (`fields[]`) |
| `NOT_FOUND` | 404 | Unknown or malformed id |
| `NOT_PUBLISHED` | 409 | Variant without a published profile and criteria |
| `PAYLOAD_CONFLICT` | 409 | Same `test_id`, different payload (both hashes in the body) |
| `LIFECYCLE_CONFLICT` | 409 | Action not allowed in the current status; removing your own `testing_admin` |
| `SECOND_PERSON_REQUIRED` | 409 | Approving your own version, or deciding your own correction |
| `DUPLICATE` | 409 | Unique violation (second variant for a product, duplicate code or active operator name) |
| `PAYLOAD_TOO_LARGE` | 413 | Body above 5 MB |
| `INCONSISTENT_RUN` | 422 | Consistency rule broken (`violations[]`) |
| `SERVER_UNAVAILABLE` | 503 | Database error; nothing committed, retry |

---

## 11. Known limits and open items

**Security review:** findings and their status are tracked in the CMP-04 security review report, which is kept outside this repository. The database triggers protect test records against application bugs; they are not a substitute for restricting database credentials. An expired token returns 403 instead of 401; the HMI handles this as agreed.

**Open items:**

| Item | Owner |
|---|---|
| Pilot motor, signed criteria v1, test method, outcome rules, serial format, operator names, viewers | Testing head |
| D11: COMPLETED run with unrecoverable gaps (proposed: accepted as INCOMPLETE, as the code does now) | Testing head |
| `max_rpm` and criteria limits: example values are not approved (D4, D5, D9) | Testing head |
| 8-year long-term backup copy (35-day RDS backups do not cover the retention period) | Saatwik |
| Swap on the EC2 host, then the staging backend on port 8001 and a staging URL for the HMI (T049) | Saatwik |
| Grant the first testing roles (operator account, testing head, viewers) | Rahul (ERP Admin) |
| Change the shared operator password | Saatwik / Rahul |
| Certificate pinning and renewal process for the tablet | Pratham and IT |
| Contract sign-off: draft v0.3 becomes Interface Contract v1 at T012 | Mayank, Pratham, Rahul |

**Technical limits:**

- One upload holds at most 40,000 readings (5 MB); profiles are limited to 36,000 readings per run to leave room for the stop phase.
- `GET /results?serial=` returns at most 500 runs; correction and audit lists are capped at 500.
- The ERP stores the tablet's verdict and checks its consistency; it does not re-evaluate the criteria rules against the readings.
- `serial_pattern` is stored but not enforced by the ERP.
- There is no automated test run in CI; the suites are run by hand against staging.
