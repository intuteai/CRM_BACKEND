# Motor Test — ERP admin / governance API (for the CRM web screens)

Base: `/api/testing` (same router as the HMI API). Login: existing ERP JWT (`Authorization: Bearer`).
Errors: `{ "error": "<message>", "code": "<CODE>", ...details }`. Timestamps ISO 8601 UTC.

## Roles

Testing roles come from `mt_user_role` (`GET /api/testing/me` → `testing_roles`). **ERP Admins (role_id 1) are treated as `testing_admin`.**

| Action | testing_head | testing_admin | operator | viewer |
|---|---|---|---|---|
| Variants create / edit / (de)activate | ✓ | ✓ | | |
| Profile & criteria: create draft, edit draft, delete draft, submit, return to draft | ✓ | ✓ | | |
| Profile & criteria: approve (publish), withdraw | ✓ | ✓ | | |
| Operators pick-list manage | ✓ | ✓ | | |
| User testing roles manage | | ✓ | | |
| Corrections: add | | | ✓ | |
| Corrections: decide (approve / reject) | ✓ | ✓ | | |
| Read variants, versions, results, corrections | ✓ | ✓ | ✓ (to find a run to correct) | ✓ |
| Read products, operators admin list, pending corrections, audit | ✓ | ✓ | | |
| CSV export of a run | ✓ | ✓ | | ✓ |

The **approver must be a different person from the author** of a version (DB-enforced; answers `409 SECOND_PERSON_REQUIRED`).
A correction must be decided by someone other than who added it (`409 SECOND_PERSON_REQUIRED`).

## Common error codes

`400 VALIDATION_ERROR` (`fields[]: {path,msg}`) · `401 AUTH_NO_TOKEN` · `403 AUTH_INVALID_TOKEN` (re-login) · `403 TESTING_ROLE_REQUIRED` · `404 NOT_FOUND` · `409 LIFECYCLE_CONFLICT` (action not allowed in the current status) · `409 SECOND_PERSON_REQUIRED` · `409 DUPLICATE` · `503 SERVER_UNAVAILABLE`

## Products (for linking a variant)

`GET /api/testing/admin/products` → `{ items: [{ product_id, product_name, product_code, part_number, variant_id|null }] }` (from the ERP `inventory` table)

## Variants

`GET /api/testing/admin/variants?include_inactive=1` → `{ items: [Variant] }`
`GET /api/testing/admin/variants/{variant_id}` → `Variant`
`POST /api/testing/admin/variants` body `{ product_id, code, max_rpm_limit?, rated_voltage_v?, rated_power_w?, rated_current_a?, controller_model?, serial_pattern? }` → `201 Variant`
`PATCH /api/testing/admin/variants/{variant_id}` body: any of the above except `product_id`, plus `active` → `200 Variant`

```
Variant = { variant_id, product_id, product_name, product_code, code, max_rpm_limit, rated_voltage_v, rated_power_w,
            rated_current_a, controller_model, serial_pattern, active, created_by, created_at,
            published_profile_version|null, published_criteria_version|null }
```

## Versions (profiles and criteria) — lifecycle DRAFT → IN_REVIEW → PUBLISHED → SUPERSEDED / WITHDRAWN

`{kind}` is `profiles` or `criteria`.

| Method + path | Body | Result |
|---|---|---|
| `GET /api/testing/admin/variants/{variant_id}/{kind}` | | `{ items: [Version] }` newest version first |
| `GET /api/testing/admin/{kind}/{id}` | | `Version` |
| `POST /api/testing/admin/variants/{variant_id}/{kind}` | profile: `{max_rpm, step_rpm, duration_s, sample_hz}` · criteria: `{definition, source_document?}` | `201 Version` (DRAFT, version = last + 1) |
| `PATCH /api/testing/admin/{kind}/{id}` | same fields (DRAFT only) | `200 Version` |
| `DELETE /api/testing/admin/{kind}/{id}` | (DRAFT only) | `204` |
| `POST /api/testing/admin/{kind}/{id}/submit` | | DRAFT → IN_REVIEW |
| `POST /api/testing/admin/{kind}/{id}/return` | `{ note? }` | IN_REVIEW → DRAFT |
| `POST /api/testing/admin/{kind}/{id}/approve` | | IN_REVIEW → PUBLISHED; sha256 frozen; the previous PUBLISHED version of that variant becomes SUPERSEDED |
| `POST /api/testing/admin/{kind}/{id}/withdraw` | `{ reason }` (required) | PUBLISHED → WITHDRAWN |

```
Version (profile)  = { profile_id, variant_id, version, max_rpm, step_rpm, duration_s, sample_hz, sha256|null, status,
                       created_by, created_by_name, created_at, submitted_at, approved_by, approved_by_name,
                       published_at, retired_at, retired_reason }
Version (criteria) = { criteria_version_id, variant_id, version, definition, source_document, sha256|null, status,
                       created_by, created_by_name, created_at, submitted_at, approved_by, approved_by_name,
                       published_at, retired_at, retired_reason }
```

Criteria `definition` shape (values come only from the testing head's signed sheet; the server adds `variant_id` and `version`):

```json
{ "schema": 1, "units": {"current":"A","voltage":"V","speed":"rpm"},
  "rules": [
    {"id":"I_MAX","type":"max","signal":"current_a","limit":12.5,"filter":{"kind":"none","window_ms":null},"exclude_first_ms":0},
    {"id":"V_SUPPLY","type":"range","signal":"voltage_v","min":44,"max":52,"on_violation":"INVALID"},
    {"id":"I_AT_RPM","type":"checkpoint","signal":"current_a","at_rpm":1500,"rpm_window":50,"method":"window_mean","min":3,"max":6}
  ] }
```
(The numbers above only illustrate the shape.) `rules[].type` ∈ `max | min | range | checkpoint | tracking | reach | bemf_constant`; `signal` ∈ `current_a | voltage_v | rpm_actual | bemf_v`.

## Operators (pick-list)

`GET /api/testing/admin/operators?include_inactive=1` → `{ items: [{ operator_ref, name, user_id|null, active, created_at, deactivated_at }] }`
`POST /api/testing/admin/operators` `{ name, user_id? }` → `201` · `PATCH /api/testing/admin/operators/{operator_ref}` `{ name?, user_id?, active? }` → `200`

## Users and testing roles (testing_admin)

`GET /api/testing/admin/users?q=&limit=50` → `{ items: [{ user_id, name, email, erp_role, testing_roles: [] }] }` (Compage staff only)
`PUT /api/testing/admin/users/{user_id}/testing-roles` `{ roles: ["operator","viewer"] }` → `200 { user_id, testing_roles }` (you cannot remove your own `testing_admin`)

## Corrections (original run never changes)

`GET /api/testing/results/{test_id}/corrections` → `{ items: [Correction] }`
`POST /api/testing/results/{test_id}/corrections` (operator) `{ corrected_fields: { motor_serial?, operator_ref?, remark? }, reason, operator_ref? }` → `201 Correction` (PENDING)
`POST /api/testing/corrections/{correction_id}/decide` (testing_head/admin) `{ decision: "APPROVED"|"REJECTED", note? }` → `200 Correction`
`GET /api/testing/admin/corrections?status=PENDING` → `{ items: [Correction] }`

```
Correction = { correction_id, test_id, corrected_fields, reason, added_by, added_by_name, added_operator_ref, added_operator_name,
               added_at, status, decided_by, decided_by_name, decided_at, decision_note }
```
An APPROVED `motor_serial` correction makes the run findable under the corrected serial too.

## Audit and export

`GET /api/testing/admin/audit?entity=&entity_id=&limit=100` → `{ items: [{ event_id, at, actor_user_id, actor_name, actor_operator_ref, action, entity, entity_id, detail }] }`
`GET /api/testing/results/{test_id}/export.csv` → `text/csv` of all readings (audited as `CSV_EXPORTED`)

## Already available (HMI API, see contract/openapi.yaml)

`GET /me`, `GET /operators`, `GET /variants`, `GET /variants/{id}`, `GET /criteria/{id}`, `GET /results?serial=`, `GET /results/{test_id}` (readings paged: `samples_offset`, `samples_limit` ≤ 5000; response has `samples_page.total`).
