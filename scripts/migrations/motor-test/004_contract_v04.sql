-- Contract v0.4 (docs/motor-test/contract/receipt-signing.md): completeness fields, run start/clock fields,
-- run_kind, CONFIG_CANCELLED, the agreed lifecycle table, and the signed archive receipt with its key registry.
-- Additive only: new nullable columns (legacy v0.3 rows keep NULL), one new table, wider/added CHECKs.
-- Every existing row must satisfy the new CHECKs or the whole migration rolls back (run.js runs it in one transaction).

-- ---------------------------------------------------------------- runs
ALTER TABLE mt_test_run
  ADD COLUMN contract_version   text    NOT NULL DEFAULT '0.3' CHECK (contract_version IN ('0.3', '0.4')),
  ADD COLUMN run_kind           text    CHECK (run_kind IN ('bench', 'host_simulation', 'synthetic')),
  ADD COLUMN started            boolean,
  ADD COLUMN start_uptime_ms    bigint  CHECK (start_uptime_ms BETWEEN 0 AND 4294967295),
  ADD COLUMN started_at_source  text    CHECK (started_at_source IN ('HMI', 'HMI_DERIVED')),
  ADD COLUMN ended_at_source    text    CHECK (ended_at_source IN ('HMI', 'HMI_DERIVED')),
  ADD COLUMN hmi_auto_time      boolean,
  ADD COLUMN held_count         integer CHECK (held_count >= 0),
  ADD COLUMN recording_complete boolean,
  ADD COLUMN config_hash        text    CHECK (length(config_hash) BETWEEN 1 AND 128);

-- CONFIG_CANCELLED joins the stop reasons.
ALTER TABLE mt_test_run DROP CONSTRAINT mt_test_run_stop_reason_check;
ALTER TABLE mt_test_run ADD CONSTRAINT mt_test_run_stop_reason_check
  CHECK (stop_reason IN ('RAMP_COMPLETE', 'OPERATOR_STOP', 'HB_LOSS', 'FAULT', 'POWER_LOSS', 'CONFIG_CANCELLED'));

-- Lifecycle table agreed with the VCU (every run, any contract version).
ALTER TABLE mt_test_run ADD CONSTRAINT mt_test_run_lifecycle_check CHECK (
     (final_state = 'COMPLETED' AND stop_reason = 'RAMP_COMPLETE')
  OR (final_state = 'ABORTED'   AND stop_reason IN ('OPERATOR_STOP', 'HB_LOSS', 'CONFIG_CANCELLED'))
  OR (final_state = 'FAULT'     AND stop_reason IN ('FAULT', 'POWER_LOSS')));

-- v0.4 rows: all v0.4 facts present and consistent; v0.3 rows: none of them.
ALTER TABLE mt_test_run ADD CONSTRAINT mt_test_run_v04_check CHECK (
  CASE contract_version
    WHEN '0.3' THEN run_kind IS NULL AND started IS NULL AND start_uptime_ms IS NULL AND held_count IS NULL
                AND recording_complete IS NULL AND started_at_source IS NULL AND ended_at_source IS NULL
                AND hmi_auto_time IS NULL AND config_hash IS NULL AND stop_reason <> 'CONFIG_CANCELLED'
    ELSE run_kind IS NOT NULL AND started IS NOT NULL AND held_count IS NOT NULL AND recording_complete IS NOT NULL
     AND held_count <= sample_count AND stored_sample_count <= held_count
     AND (NOT recording_complete OR held_count = sample_count)            -- complete => equal counts (not the reverse)
     AND (outcome = 'INCOMPLETE' OR recording_complete)                    -- verdicts need a complete recording
     AND (started_at IS NULL) = (started_at_source IS NULL)
     AND (ended_at IS NULL) = (ended_at_source IS NULL)
     AND CASE WHEN started
          THEN start_uptime_ms IS NOT NULL AND stop_reason <> 'CONFIG_CANCELLED'
          ELSE start_uptime_ms IS NULL AND started_at IS NULL AND sample_count = 0 AND held_count = 0
           AND final_state = 'ABORTED' AND stop_reason = 'CONFIG_CANCELLED' AND outcome = 'INCOMPLETE' AND recording_complete
         END
  END);

-- ---------------------------------------------------------------- receipt signing keys
-- Public keys only. The private key never enters the database, the code or the image.
CREATE TABLE mt_receipt_key (
  key_id      text        PRIMARY KEY CHECK (key_id ~ '^[0-9a-f]{16}$'),   -- first 8 bytes of SHA-256(public key), hex
  alg         text        NOT NULL DEFAULT 'Ed25519' CHECK (alg = 'Ed25519'),
  public_key  bytea       NOT NULL UNIQUE CHECK (length(public_key) = 32),
  valid_from  timestamptz NOT NULL DEFAULT now(),
  retired_at  timestamptz,                                                  -- no longer used for new receipts; old ones stay verifiable
  revoked_at  timestamptz,                                                  -- must not be trusted; removed from VCU slots
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION mt_receipt_key_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.key_id <> OLD.key_id OR NEW.public_key <> OLD.public_key OR NEW.alg <> OLD.alg
     OR NEW.valid_from <> OLD.valid_from
     OR (OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at)
     OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'MT_IMMUTABLE: a receipt key can only be retired or revoked, once' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_mt_receipt_key_guard BEFORE UPDATE OR DELETE ON mt_receipt_key FOR EACH ROW EXECUTE FUNCTION mt_receipt_key_guard();

-- ---------------------------------------------------------------- signed receipts
ALTER TABLE mt_upload_receipt
  ADD COLUMN signing_key_id text  REFERENCES mt_receipt_key(key_id),
  ADD COLUMN signed_message bytea CHECK (length(signed_message) BETWEEN 172 AND 234),
  ADD COLUMN signature      bytea CHECK (length(signature) = 64),
  ADD CONSTRAINT mt_upload_receipt_signed_check CHECK (
    (signing_key_id IS NULL AND signed_message IS NULL AND signature IS NULL)
    OR (signing_key_id IS NOT NULL AND signed_message IS NOT NULL AND signature IS NOT NULL));

-- The signature is written with the receipt and can never change afterwards.
CREATE OR REPLACE FUNCTION mt_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.test_id <> OLD.test_id OR NEW.receipt_id <> OLD.receipt_id
     OR NEW.payload_hash <> OLD.payload_hash OR NEW.first_received_at <> OLD.first_received_at
     OR NEW.attempts < OLD.attempts
     OR NEW.signing_key_id IS DISTINCT FROM OLD.signing_key_id
     OR NEW.signed_message IS DISTINCT FROM OLD.signed_message
     OR NEW.signature IS DISTINCT FROM OLD.signature THEN
    RAISE EXCEPTION 'MT_IMMUTABLE: a receipt can only record further attempts' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
