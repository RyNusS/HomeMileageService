-- v1.15.0: family notice board (all roles can write, text + images)
SET search_path TO hms;

CREATE TABLE IF NOT EXISTS notice (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  family_id   BIGINT NOT NULL REFERENCES family(id),
  user_id     BIGINT NOT NULL REFERENCES app_user(id),
  title       TEXT NOT NULL,
  content     TEXT NOT NULL DEFAULT '',
  images      TEXT[] NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notice_family ON notice(family_id, id DESC);
