-- Motor Test Automation Phase 1 - ERP schema (T042 design / T044 migration).
-- Additive only: new mt_* tables + schema_migrations. Existing tables are only referenced.
-- Run with scripts/migrations/motor-test/run.js (one transaction, recorded in schema_migrations).
-- Conventions: UUID v4 ids (gen_random_uuid), timestamptz (UTC), SI units in column names,
-- digests 'sha256:' + 64 lowercase hex, never UPDATE/DELETE evidence (enforced by triggers).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ------------------------------------------------------------------ helpers
CREATE OR REPLACE FUNCTION mt_forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'MT_IMMUTABLE: % on % is not allowed (test evidence is never changed or deleted)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END $$;

-- ------------------------------------------------------------------ people
-- Testing roles, separate from the ERP's single users.role_id.
CREATE TABLE mt_user_role (
  user_id      integer     NOT NULL REFERENCES users(user_id),
  testing_role text        NOT NULL CHECK (testing_role IN ('testing_head','operator','viewer','testing_admin')),
  granted_by   integer     NOT NULL REFERENCES users(user_id),
  granted_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, testing_role)
);

-- Operator pick-list shown on the tablet while operators share one ERP account.
CREATE TABLE mt_operator (
  operator_ref   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  user_id        integer     REFERENCES users(user_id),          -- set once the person has a personal login
  active         boolean     NOT NULL DEFAULT true,
  created_by     integer     NOT NULL REFERENCES users(user_id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  deactivated_at timestamptz,
  CHECK (active OR deactivated_at IS NOT NULL)
);
CREATE UNIQUE INDEX ux_mt_operator_active_name ON mt_operator (lower(btrim(name))) WHERE active;

-- ------------------------------------------------------------------ master data
-- Test-specific data for a motor model; product identity stays in inventory.
CREATE TABLE mt_motor_variant (
  variant_id       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id       integer     NOT NULL UNIQUE REFERENCES inventory(product_id),
  code             text        NOT NULL UNIQUE,
  max_rpm_limit    integer     CHECK (max_rpm_limit > 0),       -- from testing head (D4), TBD until signed
  rated_voltage_v  numeric,
  rated_power_w    numeric,
  rated_current_a  numeric,
  controller_model text,
  serial_pattern   text,                                         -- regex, from testing head
  active           boolean     NOT NULL DEFAULT true,
  created_by       integer     NOT NULL REFERENCES users(user_id),
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Ramp profile versions. Content frozen once submitted; sha256 frozen at publish.
CREATE TABLE mt_profile_version (
  profile_id     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id     uuid        NOT NULL REFERENCES mt_motor_variant(variant_id),
  version        integer     NOT NULL CHECK (version > 0),
  max_rpm        integer     NOT NULL CHECK (max_rpm > 0),
  step_rpm       integer     NOT NULL CHECK (step_rpm > 0),
  duration_s     integer     NOT NULL CHECK (duration_s > 0),
  sample_hz      integer     NOT NULL CHECK (sample_hz >= 5),
  sha256         text        CHECK (sha256 ~ '^sha256:[0-9a-f]{64}$'),
  status         text        NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','IN_REVIEW','PUBLISHED','SUPERSEDED','WITHDRAWN')),
  created_by     integer     NOT NULL REFERENCES users(user_id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  submitted_at   timestamptz,
  approved_by    integer     REFERENCES users(user_id),
  published_at   timestamptz,
  retired_at     timestamptz,                                    -- superseded or withdrawn
  retired_reason text,
  UNIQUE (variant_id, version),
  CHECK (approved_by IS NULL OR approved_by <> created_by),      -- second person approves
  CHECK (status IN ('DRAFT','IN_REVIEW') OR (sha256 IS NOT NULL AND approved_by IS NOT NULL AND published_at IS NOT NULL)),
  CHECK (status <> 'WITHDRAWN' OR retired_reason IS NOT NULL)
);
CREATE UNIQUE INDEX ux_mt_profile_one_published ON mt_profile_version (variant_id) WHERE status = 'PUBLISHED';

-- Criteria versions: rule meaning in `definition`; values only from the signed sheet (D5).
CREATE TABLE mt_criteria_version (
  criteria_version_id uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id          uuid        NOT NULL REFERENCES mt_motor_variant(variant_id),
  version             integer     NOT NULL CHECK (version > 0),
  definition          jsonb       NOT NULL,
  source_document     text,                                      -- reference of the signed sheet
  sha256              text        CHECK (sha256 ~ '^sha256:[0-9a-f]{64}$'),
  status              text        NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','IN_REVIEW','PUBLISHED','SUPERSEDED','WITHDRAWN')),
  created_by          integer     NOT NULL REFERENCES users(user_id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  submitted_at        timestamptz,
  approved_by         integer     REFERENCES users(user_id),
  published_at        timestamptz,
  retired_at          timestamptz,
  retired_reason      text,
  UNIQUE (variant_id, version),
  CHECK (approved_by IS NULL OR approved_by <> created_by),
  CHECK (status IN ('DRAFT','IN_REVIEW') OR (sha256 IS NOT NULL AND approved_by IS NOT NULL AND published_at IS NOT NULL)),
  CHECK (status <> 'WITHDRAWN' OR retired_reason IS NOT NULL)
);
CREATE UNIQUE INDEX ux_mt_criteria_one_published ON mt_criteria_version (variant_id) WHERE status = 'PUBLISHED';

-- Version lifecycle guard (profiles and criteria):
-- DRAFT: editable, deletable. IN_REVIEW: only back to DRAFT or on to PUBLISHED.
-- PUBLISHED: content frozen; may only become SUPERSEDED or WITHDRAWN. SUPERSEDED/WITHDRAWN: frozen forever.
CREATE OR REPLACE FUNCTION mt_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  content_changed boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'DRAFT' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'MT_IMMUTABLE: only DRAFT versions can be deleted (status %)', OLD.status USING ERRCODE = 'restrict_violation';
  END IF;
  content_changed := (to_jsonb(NEW) - ARRAY['status','submitted_at','approved_by','published_at','retired_at','retired_reason','sha256'])
                  IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','submitted_at','approved_by','published_at','retired_at','retired_reason','sha256']);
  IF OLD.status = 'DRAFT' THEN
    IF NEW.status NOT IN ('DRAFT','IN_REVIEW') THEN
      RAISE EXCEPTION 'MT_LIFECYCLE: DRAFT can only move to IN_REVIEW' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF content_changed THEN
    RAISE EXCEPTION 'MT_IMMUTABLE: content of a % version cannot change; create a new version', OLD.status USING ERRCODE = 'restrict_violation';
  END IF;
  IF (OLD.status = 'IN_REVIEW' AND NEW.status IN ('IN_REVIEW','DRAFT','PUBLISHED'))
     OR (OLD.status = 'PUBLISHED' AND NEW.status IN ('SUPERSEDED','WITHDRAWN')) THEN
    IF OLD.status = 'PUBLISHED' AND (NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
                                     OR NEW.published_at IS DISTINCT FROM OLD.published_at) THEN
      RAISE EXCEPTION 'MT_IMMUTABLE: publication record cannot change' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'MT_LIFECYCLE: % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER trg_mt_profile_guard BEFORE UPDATE OR DELETE ON mt_profile_version FOR EACH ROW EXECUTE FUNCTION mt_version_guard();
CREATE TRIGGER trg_mt_criteria_guard BEFORE UPDATE OR DELETE ON mt_criteria_version FOR EACH ROW EXECUTE FUNCTION mt_version_guard();

-- ------------------------------------------------------------------ test records (never changed)
CREATE TABLE mt_test_run (
  test_id             uuid        PRIMARY KEY,                    -- UUID v4 from the HMI
  motor_serial        text        NOT NULL CHECK (length(motor_serial) BETWEEN 1 AND 64),
  variant_id          uuid        NOT NULL REFERENCES mt_motor_variant(variant_id),
  profile_id          uuid        NOT NULL REFERENCES mt_profile_version(profile_id),
  criteria_version_id uuid        NOT NULL REFERENCES mt_criteria_version(criteria_version_id),
  operator_id         integer     NOT NULL REFERENCES users(user_id),      -- account that ran the test
  operator_ref        uuid        NOT NULL REFERENCES mt_operator(operator_ref),
  operator_name       text        NOT NULL,                                -- snapshot at test time
  uploaded_by         integer     NOT NULL REFERENCES users(user_id),      -- authenticated uploader
  vcu_id              text        NOT NULL,
  vcu_fw_version      text        NOT NULL,
  vcu_boot_id         text        NOT NULL,
  hmi_version         text        NOT NULL,
  started_at          timestamptz,
  ended_at            timestamptz,
  final_state         text        NOT NULL CHECK (final_state IN ('COMPLETED','ABORTED','FAULT')),
  stop_reason         text        NOT NULL CHECK (stop_reason IN ('RAMP_COMPLETE','OPERATOR_STOP','HB_LOSS','FAULT','POWER_LOSS')),
  fault_code          text,
  outcome             text        NOT NULL CHECK (outcome IN ('PASS','FAIL','INCOMPLETE','INVALID')),
  outcome_reasons     jsonb       NOT NULL DEFAULT '[]'::jsonb,
  sample_count        integer     NOT NULL CHECK (sample_count >= 0),      -- VCU manifest count
  stored_sample_count integer     NOT NULL CHECK (stored_sample_count >= 0 AND stored_sample_count <= sample_count),
  run_digest          text        NOT NULL CHECK (run_digest ~ '^sha256:[0-9a-f]{64}$'),
  samples_digest      text        NOT NULL CHECK (samples_digest ~ '^sha256:[0-9a-f]{64}$'),
  run_digest_match    boolean     NOT NULL,
  received_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (outcome = 'INCOMPLETE' OR final_state = 'COMPLETED'),           -- never PASS/FAIL/INVALID unless completed
  CHECK (final_state = 'COMPLETED' OR outcome = 'INCOMPLETE'),           -- ABORTED/FAULT are always INCOMPLETE (D11 proposal)
  CHECK (final_state <> 'COMPLETED' OR sample_count > 0),
  CHECK (outcome = 'INCOMPLETE' OR (run_digest_match AND stored_sample_count = sample_count)),  -- verdicts need full evidence
  CHECK (final_state <> 'FAULT' OR fault_code IS NOT NULL),
  CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX ix_mt_test_run_serial ON mt_test_run (motor_serial, started_at DESC);
CREATE INDEX ix_mt_test_run_received ON mt_test_run (received_at DESC);
CREATE TRIGGER trg_mt_test_run_immutable BEFORE UPDATE OR DELETE ON mt_test_run FOR EACH ROW EXECUTE FUNCTION mt_forbid_change();

-- One row per reading (D7). Floats are real (IEEE binary32) so the D13 digest can be rebuilt exactly;
-- NULL = invalid reading (NaN in the digest). Reads always go through the primary key, in pages.
CREATE TABLE mt_test_sample (
  test_id      uuid     NOT NULL REFERENCES mt_test_run(test_id),
  sample_seq   bigint   NOT NULL CHECK (sample_seq BETWEEN 0 AND 4294967295),
  t_ms         bigint   NOT NULL CHECK (t_ms BETWEEN 0 AND 4294967295),
  rpm_cmd      integer  NOT NULL,
  rpm_actual   integer  NOT NULL,
  current_a    real,
  voltage_v    real,
  bemf_v       real,
  status_flags smallint NOT NULL CHECK (status_flags BETWEEN 0 AND 255),
  PRIMARY KEY (test_id, sample_seq),
  CHECK ((current_a IS NOT NULL) = ((status_flags & 2) <> 0)),
  CHECK ((voltage_v IS NOT NULL) = ((status_flags & 4) <> 0)),
  CHECK ((bemf_v    IS NOT NULL) = ((status_flags & 8) <> 0))
);
CREATE TRIGGER trg_mt_test_sample_immutable BEFORE UPDATE OR DELETE ON mt_test_sample FOR EACH ROW EXECUTE FUNCTION mt_forbid_change();

CREATE TABLE mt_test_event (
  test_id   uuid    NOT NULL REFERENCES mt_test_run(test_id),
  event_seq integer NOT NULL CHECK (event_seq >= 0),               -- order within the upload
  t_ms      bigint  NOT NULL CHECK (t_ms >= 0),
  type      text    NOT NULL CHECK (type IN ('STATE','FAULT','COMMAND','INFO')),
  code      text    NOT NULL,
  detail    text,
  PRIMARY KEY (test_id, event_seq)
);
CREATE TRIGGER trg_mt_test_event_immutable BEFORE UPDATE OR DELETE ON mt_test_event FOR EACH ROW EXECUTE FUNCTION mt_forbid_change();

-- Idempotency anchor. Only attempts/last_attempt_at may change (identical retries).
CREATE TABLE mt_upload_receipt (
  test_id           uuid        PRIMARY KEY REFERENCES mt_test_run(test_id),
  receipt_id        uuid        NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  payload_hash      text        NOT NULL CHECK (payload_hash ~ '^sha256:[0-9a-f]{64}$'),
  first_received_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at   timestamptz NOT NULL DEFAULT now(),
  attempts          integer     NOT NULL DEFAULT 1 CHECK (attempts >= 1)
);
CREATE OR REPLACE FUNCTION mt_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.test_id <> OLD.test_id OR NEW.receipt_id <> OLD.receipt_id
     OR NEW.payload_hash <> OLD.payload_hash OR NEW.first_received_at <> OLD.first_received_at
     OR NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'MT_IMMUTABLE: a receipt can only record further attempts' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_mt_receipt_guard BEFORE UPDATE OR DELETE ON mt_upload_receipt FOR EACH ROW EXECUTE FUNCTION mt_receipt_guard();

-- Corrections: a new record linked to the original run; the original is never edited.
-- Operator adds, testing head approves (Saatwik, 2026-11-07).
CREATE TABLE mt_correction (
  correction_id      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id            uuid        NOT NULL REFERENCES mt_test_run(test_id),
  corrected_fields   jsonb       NOT NULL CHECK (jsonb_typeof(corrected_fields) = 'object' AND corrected_fields <> '{}'::jsonb),
  reason             text        NOT NULL CHECK (length(btrim(reason)) > 0),
  added_by           integer     NOT NULL REFERENCES users(user_id),
  added_operator_ref uuid        REFERENCES mt_operator(operator_ref),   -- who, while the account is shared
  added_at           timestamptz NOT NULL DEFAULT now(),
  status             text        NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  decided_by         integer     REFERENCES users(user_id),
  decided_at         timestamptz,
  decision_note      text,
  CHECK ((status = 'PENDING') = (decided_by IS NULL AND decided_at IS NULL)),
  CHECK (decided_by IS NULL OR decided_by <> added_by)
);
CREATE INDEX ix_mt_correction_test ON mt_correction (test_id);
CREATE OR REPLACE FUNCTION mt_correction_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'PENDING'
     OR (to_jsonb(NEW) - ARRAY['status','decided_by','decided_at','decision_note'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','decided_by','decided_at','decision_note']) THEN
    RAISE EXCEPTION 'MT_IMMUTABLE: a correction can only be decided once' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_mt_correction_guard BEFORE UPDATE OR DELETE ON mt_correction FOR EACH ROW EXECUTE FUNCTION mt_correction_guard();

-- ------------------------------------------------------------------ audit (append-only)
CREATE TABLE mt_audit_event (
  event_id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at                 timestamptz NOT NULL DEFAULT now(),
  actor_user_id      integer     REFERENCES users(user_id),
  actor_operator_ref uuid        REFERENCES mt_operator(operator_ref),
  action             text        NOT NULL,      -- e.g. CRITERIA_PUBLISHED, ROLE_GRANTED, UPLOAD_CONFLICT, CSV_EXPORTED
  entity             text        NOT NULL,
  entity_id          text,
  detail             jsonb       NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX ix_mt_audit_entity ON mt_audit_event (entity, entity_id);
CREATE INDEX ix_mt_audit_at ON mt_audit_event (at DESC);
CREATE TRIGGER trg_mt_audit_immutable BEFORE UPDATE OR DELETE ON mt_audit_event FOR EACH ROW EXECUTE FUNCTION mt_forbid_change();
