# T011 — ERP inventory and reuse plan (Motor Test Automation, Phase 1)

| | |
|---|---|
| Task | T011 · Inventory ERP stack, users/roles and motor master data (D6, D7) |
| Owner | Rahul (ERP) |
| Approver | Saatwik — exit criterion: "Saatwik agrees reuse approach" |
| Date | 2026-11-10 (first issued 2026-11-07) · status: **for approval** |
| Sources | Live read-only inspection of the code (CRM_BACKEND, CRM) and the database (2026-11-04/05), RDS console, team answers 2026-11-05/07 |

## 1. Summary

The ERP can host the motor-test module **without changing anything that exists today**. We reuse the existing login, user accounts and product list; everything else is new tables and new `/api/testing` routes. Development and tests run on a separate staging database; production only receives reviewed migrations.

**Status on 2026-11-10:** the plan below has been implemented, tested on staging (79 automated tests, 24 database rule checks) and deployed: backend live at `api.intute.biz/api/testing`, database migrated after an RDS snapshot, CRM screens live (shown only to users with a testing role). No testing roles granted and no real test runs yet.

**Decision asked of Saatwik:** approve the reuse / extend / new plan in section 5 (closes task T011).

## 2. Existing ERP stack

| Item | Finding |
|---|---|
| Backend | Node.js + Express 4.19, raw SQL with `pg` (no ORM), `express-validator`, JWT auth, helmet, rate limit (5,000 req / 10 min) |
| Frontend | React 19 + Vite (CRM). recharts 2.15.4 added for the result graphs (T048) |
| Database | PostgreSQL **17.9** on AWS RDS, `db.t4g.micro`, single AZ (ap-south-1b), 20 GB with autoscaling (being enabled) |
| Same RDS instance | `erp_migrated` (production ERP, 140 MB), `erp_staging` (new), `PLC_DB_Migrated`, `3W_DB_Migrated` (other apps — not touched) |
| Extensions | `pgcrypto` installed (UUIDs, SHA-256); `pg_partman` available |
| Migrations | Hand-written Node scripts in `scripts/migrations/`, run manually, no tracking table |
| Deploy | Manual GitHub Action → Docker image `:latest` → EC2 (t2.micro) via docker-compose. No automated tests in CI |
| Error format | `{ "error": "<message>", "code": "<MACHINE_CODE>" }` |
| Request size | Global JSON limit 40 MB (a ~1,200-sample upload is ~250 kB) |
| Tests | Jest + supertest (`*.test.js` is gitignored — new tests need `git add -f`) |

## 3. Users, roles and login

| Item | Finding | Consequence |
|---|---|---|
| `users` | Integer `user_id`, **one `role_id` per user**, unique `email` (all 100+ users have one) | `operator_id` in the API is an integer, not a UUID |
| `roles` / `permissions` | 14 roles in a fixed list (`middleware/roles.js`, `ROLE_MAP`) + per-module read/write/delete | Not changed — see testing roles below |
| Login | `POST /api/auth/login` `{email, password}` → JWT, 1 h (12 h with `X-App-Version` header). Expired token → **403 `AUTH_INVALID_TOKEN`**. No refresh, no lockout | Reused as is; agreed with Pratham |
| Shop-floor staff | 45 employees already have personal logins (`em0xx@compageauto.in`); Production is one shared login | Personal operator accounts later need no new users |

**Testing roles (new, additive):** a separate table maps users to testing roles — `testing_head`, `operator`, `viewer`, `testing_admin`. People keep their current ERP role. No edits to the existing roles code or tables.

**Operator identity (D6, approved interim):** operators share `testing@compageauto.com` (created 2026-11-07, user 843, employee role). Each result also stores the operator chosen from an **ERP-managed pick-list** on the tablet. Moving to personal accounts later = granting the `operator` testing role; no design change. The shared account is an ISO 27001 A.5.16 deviation, recorded for the CMP-04 security review.

## 4. Motor master data and serials

| Item | Finding |
|---|---|
| Product master | `inventory` table (`product_id`, `product_name`, `product_code`, `part_number`). Two motors today: **B-125-4D-M 3000 48V** (id 1) and **B-125-M-5D-ES11-E04** (id 2, 5 kW / 48 V / 3000 RPM). `motor_recipes` already references it |
| Motor specs for testing | Not in the ERP (no max RPM, ratings or test data fields) |
| Serial numbers | No motor serial tracking. Parts screen can generate `MFA` + 7 digits; `ipt_kits.motor_serial` is free text (0 rows). **Format still to be confirmed by the testing head** |
| Existing test tables | `work_order_testing_results` is empty and unrelated in shape — not reused |

So the motor variant is a **new table linked to `inventory.product_id`** (no copy of product data), holding only test-specific fields.

## 5. Reuse / extend / new plan

| Workpack entity | Decision | ERP object | Notes |
|---|---|---|---|
| Operator / user identity | **Reuse** | `users`, existing login | No changes |
| Testing roles | **New** | `mt_user_role` | Separate from `roles`; every grant/revoke audited |
| Operator pick-list | **New** | `mt_operator` | Names shown on the tablet while the account is shared |
| motor_variant | **Extend (link)** | `mt_motor_variant` → `inventory.product_id` | Test fields: code, max RPM limit, ratings, serial pattern, active |
| test_profile_version | **New** | `mt_profile_version` | Immutable once published, sha256 frozen |
| criteria_version | **New** | `mt_criteria_version` | DRAFT → IN_REVIEW → PUBLISHED → SUPERSEDED / WITHDRAWN; approver must not be the author, last editor or submitter |
| test_run | **New** | `mt_test_run` | Never updated or deleted (enforced by database triggers) |
| test_sample | **New** | `mt_test_sample` | **One row per reading (D7 approved)**; float32 columns so the digest can be recomputed exactly |
| test_event | **New** | `mt_test_event` | |
| upload_receipt | **New** | `mt_upload_receipt` | Idempotency anchor; records uploader separately from operator |
| Corrections | **New** | `mt_correction` | Operator adds (linked to original), testing head approves; who/when/why stored |
| audit_event | **New** | `mt_audit_event` | Append-only |
| Migration tracking | **New** | `schema_migrations` | Each new migration runs in one transaction |

These are the final names (T042 design, migrations 001–003). Nothing in the existing schema is altered. ERP Admins act as `testing_admin`, so roles can be granted from the CRM without a database script. Operators work only on the tablet: they upload results and request corrections there; the web screens are for the testing head, viewers and admins.

## 6. Storage and volume (D7)

- **Approved:** relational rows, one per reading.
- Volume: up to 10 tests/day now, 30+ later; ~1,200 readings per test; **8-year retention** → about 88,000 tests and 105 million reading rows (~13 GB) over 8 years.
- The database server has little memory: readings are always fetched by test, through the primary key, in pages — never all at once. At this volume one table stays fast; splitting it by period is deferred until it grows large.
- Each upload is limited to 5 MB (about 40,000 readings); a 120 s run at 10 Hz is about 1,200.

## 7. Environments

| Environment | Database | Backend |
|---|---|---|
| Staging | `erp_staging` (created 2026-11-05: full production structure + roles, permissions, users, products only; 15-connection cap) | Same EC2 as production, port 8001, ~150 MB memory cap, own image tag, `.env` and database user limited to staging; stopped when idle; swap added by Saatwik first |
| Production | `erp_migrated` (migrated 2026-11-10 after an RDS snapshot) | Existing backend; new routes under `/api/testing` (live) |

All development, automated tests, destructive tests (ERP-T08) and fake runs stay on staging.

## 8. Backup and recovery (agreed 2026-11-07)

- Recovery target: up to **~5 minutes** of database changes lost on server failure, restore in **30–60 minutes**. No paid infrastructure.
- Saatwik: backup retention 1 → 35 days, storage autoscaling, CloudWatch alarms (storage, memory, CPU, connections).
- Rahul: manual snapshot before every migration, deleted once verified.
- Test readings are also protected end to end: the bench and tablet keep each run until the ERP receipt.
- **Open:** an 8-year copy (35-day backups do not cover the retention period).

## 9. Findings for the security review (CMP-04)

1. The application connects to the database as `ERPadmin` (member of `rds_superuser`) — not least privilege. Test records are therefore protected by triggers, not only by permissions.
2. The live backend (`config/db.js`) does not verify the database's TLS certificate. The new motor-test migration tools do (AWS RDS certificate bundle).
3. No CloudWatch alarms existed (being added).
4. Shared operator account (section 3); its temporary password must be changed before the tablets go to the shop floor.
5. Expired token returns 403 instead of 401 — handled by the HMI as agreed.
6. An independent code review of the new module found 6 input-handling bugs and an automated security review found 1 approval loophole; all 7 were fixed with tests before deployment.

## 10. Open items

| Item | Owner | Blocks |
|---|---|---|
| Pilot motor, signed criteria v1, test method, outcome rules, serial format, operator names, viewers | Testing head | T045–T047 data, T046 |
| 8-year long-term backup copy | Saatwik | Go-live |
| Swap on EC2 before staging deploy | Saatwik | T049 |
| Grant testing roles (operator account, testing head, viewers) | Rahul (ERP Admin) | First real use |
| Change the shared operator password | Saatwik / Rahul | Tablets on the shop floor |

## 11. Approval

Approve the reuse / extend / new plan in section 5 (reuse login, users and `inventory`; everything else new and additive):

Approved by: ____________________ (Saatwik) Date: __________
