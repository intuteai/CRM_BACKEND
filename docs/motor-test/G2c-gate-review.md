# G2c gate review — ERP build (staging)

Motor Test Automation · Phase 1 · prepared 2026-11-21 by Rahul (ERP). Approver per roadmap: Rahul; acknowledged by the testing head (Saatwik). Status: **ready except one exit criterion** (pilot configuration, waiting for T046).

## 1. Exit criteria and evidence

| # | Exit criterion (roadmap) | Status | Evidence |
|---|---|---|---|
| 1 | Migrations | **Met** | `scripts/migrations/motor-test/001–004` applied to `erp_staging` and production `erp_migrated` (004 on 2026-11-19 after snapshot `erp-pre-migration-004-2026-11-19`); `check_rules.js` proves 38 database rules (immutability, lifecycle, two-person approval, receipts) |
| 2 | Roles | **Met** | Separate `mt_user_role` (operator, viewer, testing_head, testing_admin), every endpoint role-checked, grants audited; ERP-T01 Pass; production operator account granted `operator` 2026-11-19 (approved by the testing head) |
| 3 | Versioned criteria / profiles | **Met** | DRAFT → IN_REVIEW → PUBLISHED → SUPERSEDED/WITHDRAWN; approver ≠ author/editor/submitter (database CHECK); published content and sha256 immutable; four status-flag rule types accepted (2026-11-21); ERP-T02 Pass |
| 4 | Idempotent atomic POST | **Met** | `POST /api/testing/results` (v0.3 + v0.4): one transaction, per-test_id lock, 200 identical retry, 409 conflict audited, 422 consistency rules, signed receipt (Ed25519); ERP-T03–T08 Pass incl. kill-DB-connection test |
| 5 | GET endpoints | **Met** | variants, variant detail, criteria snapshot, operators, serial lookup, run detail (paged readings), CSV export, corrections; ERP-T09 (browser, real staging data) and ERP-T10 (3 M readings, lookup p95 81 ms) Pass |
| 6 | Staging live | **Met** | `https://api.intute.biz/staging` since 2026-11-12 (X-Staging-Key), own DB login, anonymised users, signed receipts (key 70e57bbf84ae97cc); tablet connected and uploading (INT-03, INT-04 Pass) |
| 7 | **…with pilot config** | **Open** | Needs the signed limits sheet (T046, due 2026-12-09): pilot motor type, profile v1, criteria v1 entered and published by a second person. Template and editor support ready |

## 2. Required tests (roadmap: ERP-T01..T08, INT-04)

| Test | Result | Date | Where |
|---|---|---|---|
| ERP-T01 Role enforcement | Pass | 2026-11-17 | staging (80 → 113 automated tests) |
| ERP-T02 Immutable criteria versions | Pass | 2026-11-10 | staging |
| ERP-T03 Valid completed run (1,214 samples) | Pass | 2026-11-17 | deployed staging |
| ERP-T04 Identical retry and concurrency | Pass | 2026-11-10 | staging |
| ERP-T05 Conflicting payload | Pass | 2026-11-10 | staging |
| ERP-T06 Zero-sample FAULT | Pass | 2026-11-10 | staging |
| ERP-T07 Invalid payloads | Pass | 2026-11-10 | staging |
| ERP-T08 DB failure mid-transaction | Pass (13/13; found and fixed a whole-backend crash, deployed to production) | 2026-11-17 | deployed staging |
| INT-04 Staging smoke test from the tablet | Pass | 2026-11-19 | tablet → staging |

Beyond the gate: ERP-T09 serial lookup + graphs Pass, ERP-T10 load (scaled to 25 %) Pass, ERP-T11 restore drill Pass (snapshot restored to a separate instance, evidence identical), INT-03 Pass (tablet consumes the contract, v0.4 signed receipts).

## 3. Delivered beyond the original scope

- Contract v0.4 agreed with VCU and HMI and live on staging and production: completeness (`held_count`, `recording_complete`), CANCEL, start-time sources, `run_kind` (production accepts only `bench`), agreed lifecycle table, signed archive receipts (52 vectors independently verified by the VCU side).
- Status-flag criteria rules (b4–b7, step coverage) agreed with the testing head; ERP and editor live 2026-11-21.
- Contract v0.5 draft R2 (warning events, event digest) under review.
- Restore-check tool, production signing key generated on the server, technical documentation chapter and PDF current.

## 4. Open items (not blocking the gate except T046)

| Item | Owner |
|---|---|
| T046 pilot configuration (exit criterion 7) | Saatwik (sheet) → Rahul (entry) → second approver |
| v0.5 warning events: Mayank's review, decisions S1–S6 | Mayank, Saatwik |
| CloudWatch alarms; monthly pg_dump to Glacier | Saatwik |
| Security review CMP-04 findings (confidential report; deferred) | Rahul |

## 5. Sign-off

| Role | Name | Decision | Date | Signature |
|---|---|---|---|---|
| Gate approver (ERP) | Rahul Srivastava | Approve when exit criterion 7 is met | | |
| Testing head | Saatwik Choudhary | Acknowledge | | |
