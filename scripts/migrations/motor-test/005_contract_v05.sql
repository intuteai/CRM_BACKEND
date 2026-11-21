-- Contract v0.5 (docs/motor-test/contract/v05-warning-events.md R4): warning events, command changes, event-log
-- completeness, the MTEVT2 event digest, receipt-version pinning and the longer MTRCPT2 signed message.
-- Additive only: new nullable run columns (v0.3 / v0.4 rows keep NULL), two new immutable tables, widened CHECKs.

ALTER TABLE mt_test_run DROP CONSTRAINT mt_test_run_contract_version_check;
ALTER TABLE mt_test_run ADD CONSTRAINT mt_test_run_contract_version_check CHECK (contract_version IN ('0.3', '0.4', '0.5'));

ALTER TABLE mt_test_run
  ADD COLUMN receipt_version        smallint CHECK (receipt_version IN (1, 2)),
  ADD COLUMN capture_end_ms         bigint   CHECK (capture_end_ms BETWEEN 0 AND 4294967295),
  ADD COLUMN event_log_complete     boolean,
  ADD COLUMN event_lost_count       bigint   CHECK (event_lost_count BETWEEN 1 AND 4294967294),
  ADD COLUMN warnings_count         integer  CHECK (warnings_count >= 0),
  ADD COLUMN command_changes_count  integer  CHECK (command_changes_count >= 0),
  ADD COLUMN event_digest           text     CHECK (event_digest ~ '^sha256:[0-9a-f]{64}$'),
  ADD COLUMN events_stored_digest   text     CHECK (events_stored_digest ~ '^sha256:[0-9a-f]{64}$'),
  ADD COLUMN event_digest_match     boolean,
  ADD COLUMN b6_coverage_ok         boolean,
  ADD COLUMN unproven               jsonb;

-- receipt_version pinned per run: 1 for v0.4, 2 for v0.5, none for v0.3. v0.5 facts present exactly on v0.5 runs.
ALTER TABLE mt_test_run ADD CONSTRAINT mt_test_run_v05_check CHECK (
  CASE contract_version
    WHEN '0.5' THEN receipt_version = 2 AND event_log_complete IS NOT NULL AND warnings_count IS NOT NULL
      AND command_changes_count IS NOT NULL AND event_digest IS NOT NULL AND events_stored_digest IS NOT NULL
      AND event_digest_match IS NOT NULL AND b6_coverage_ok IS NOT NULL AND unproven IS NOT NULL
      AND (capture_end_ms IS NULL) = (NOT started)
      AND (NOT event_log_complete OR event_lost_count IS NULL)  -- complete => nothing lost (stored as NULL; upload sends 0)
    WHEN '0.4' THEN receipt_version = 1 AND capture_end_ms IS NULL AND event_log_complete IS NULL AND event_digest IS NULL
    ELSE receipt_version IS NULL AND capture_end_ms IS NULL AND event_log_complete IS NULL AND event_digest IS NULL
  END) NOT VALID;
-- Existing v0.4 rows have receipt_version NULL: backfill is an UPDATE on immutable runs, so the check is NOT VALID
-- (enforced for new rows only); readers treat a v0.4 row without receipt_version as version 1.

CREATE TABLE mt_test_warning_event (
  test_id        uuid     NOT NULL REFERENCES mt_test_run(test_id),
  seq            bigint   NOT NULL CHECK (seq BETWEEN 0 AND 4294967295),
  t_ms           integer  NOT NULL,                                       -- signed, run-relative
  phase          text     NOT NULL CHECK (phase IN ('PRE_START', 'CAPTURE', 'POST_CAPTURE')),
  kind           text     NOT NULL CHECK (kind IN ('ACTIVE_AT_START', 'RAISED', 'CLEARED', 'STATUS_UNKNOWN', 'STATUS_KNOWN', 'DETAIL', 'DETAIL_UNAVAILABLE', 'DETAIL_AMBIGUOUS')),
  source         text     NOT NULL CHECK (source IN ('STATUS_BIT6', 'VCU_LIMIT', 'SDO_2031_11')),
  limit_id       text     CHECK (limit_id ~ '^[A-Z0-9_]{1,40}$'),
  code           integer  CHECK (code BETWEEN 0 AND 65535),
  status_t_ms    integer,
  reason         text     CHECK (reason IN ('TIMEOUT', 'ABORT', 'MALFORMED', 'LATE_REPLY')),
  restored_state text     CHECK (restored_state IN ('ACTIVE', 'CLEAR')),
  detail         text     CHECK (length(detail) <= 200),
  PRIMARY KEY (test_id, seq),
  CHECK (status_t_ms IS NULL OR status_t_ms <= t_ms),
  CHECK ((restored_state IS NOT NULL) = (kind = 'STATUS_KNOWN'))
);
CREATE TRIGGER trg_mt_test_warning_event_immutable BEFORE UPDATE OR DELETE ON mt_test_warning_event FOR EACH ROW EXECUTE FUNCTION mt_forbid_change();

CREATE TABLE mt_test_command_change (
  test_id          uuid    NOT NULL REFERENCES mt_test_run(test_id),
  step             bigint  NOT NULL CHECK (step BETWEEN 0 AND 4294967295),
  t_ms             integer NOT NULL CHECK (t_ms >= 0),
  rpm_cmd          integer NOT NULL,
  link             text    NOT NULL CHECK (link IN ('OWNS_READING', 'SUPERSEDED', 'NO_READING', 'READING_NOT_RETAINED')),
  first_sample_seq bigint  CHECK (first_sample_seq BETWEEN 0 AND 4294967295),
  PRIMARY KEY (test_id, step),
  CHECK ((first_sample_seq IS NOT NULL) = (link IN ('OWNS_READING', 'READING_NOT_RETAINED')))
);
CREATE TRIGGER trg_mt_test_command_change_immutable BEFORE UPDATE OR DELETE ON mt_test_command_change FOR EACH ROW EXECUTE FUNCTION mt_forbid_change();

-- MTRCPT2 signed messages are 253-315 bytes (MTRCPT1 172-234).
ALTER TABLE mt_upload_receipt DROP CONSTRAINT mt_upload_receipt_signed_message_check;
ALTER TABLE mt_upload_receipt ADD CONSTRAINT mt_upload_receipt_signed_message_check CHECK (length(signed_message) BETWEEN 172 AND 315);
