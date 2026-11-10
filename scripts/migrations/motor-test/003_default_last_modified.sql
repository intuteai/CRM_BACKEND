-- last_modified_by defaults to the author on insert, so no insert path can leave it empty.
CREATE OR REPLACE FUNCTION mt_version_default_modifier() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.last_modified_by := coalesce(NEW.last_modified_by, NEW.created_by);
  RETURN NEW;
END $$;
CREATE TRIGGER trg_mt_profile_default_modifier BEFORE INSERT ON mt_profile_version FOR EACH ROW EXECUTE FUNCTION mt_version_default_modifier();
CREATE TRIGGER trg_mt_criteria_default_modifier BEFORE INSERT ON mt_criteria_version FOR EACH ROW EXECUTE FUNCTION mt_version_default_modifier();
