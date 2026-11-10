-- Second-person approval must exclude everyone who shaped the version, not only its author:
-- whoever last edited the draft and whoever submitted it for review may not approve it.

ALTER TABLE mt_profile_version  ADD COLUMN last_modified_by integer REFERENCES users(user_id),
                                ADD COLUMN submitted_by     integer REFERENCES users(user_id);
ALTER TABLE mt_criteria_version ADD COLUMN last_modified_by integer REFERENCES users(user_id),
                                ADD COLUMN submitted_by     integer REFERENCES users(user_id);

UPDATE mt_profile_version  SET last_modified_by = created_by WHERE last_modified_by IS NULL;
UPDATE mt_criteria_version SET last_modified_by = created_by WHERE last_modified_by IS NULL;
ALTER TABLE mt_profile_version  ALTER COLUMN last_modified_by SET NOT NULL;
ALTER TABLE mt_criteria_version ALTER COLUMN last_modified_by SET NOT NULL;

ALTER TABLE mt_profile_version ADD CONSTRAINT mt_profile_approver_independent
  CHECK (approved_by IS NULL OR (approved_by <> created_by AND approved_by <> last_modified_by AND approved_by IS DISTINCT FROM submitted_by));
ALTER TABLE mt_criteria_version ADD CONSTRAINT mt_criteria_approver_independent
  CHECK (approved_by IS NULL OR (approved_by <> created_by AND approved_by <> last_modified_by AND approved_by IS DISTINCT FROM submitted_by));

-- Same lifecycle guard as 001, with submitted_by treated as workflow data (not content).
CREATE OR REPLACE FUNCTION mt_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  content_changed boolean;
  wf text[] := ARRAY['status','submitted_at','submitted_by','approved_by','published_at','retired_at','retired_reason','sha256'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'DRAFT' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'MT_IMMUTABLE: only DRAFT versions can be deleted (status %)', OLD.status USING ERRCODE = 'restrict_violation';
  END IF;
  content_changed := (to_jsonb(NEW) - wf) IS DISTINCT FROM (to_jsonb(OLD) - wf);
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
                                     OR NEW.published_at IS DISTINCT FROM OLD.published_at OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by) THEN
      RAISE EXCEPTION 'MT_IMMUTABLE: publication record cannot change' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'MT_LIFECYCLE: % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation';
END $$;
