-- super_admin accounts are not tied to a family
SET search_path TO hms;
ALTER TABLE app_user ALTER COLUMN family_id DROP NOT NULL;
