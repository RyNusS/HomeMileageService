-- FCM device tokens (native app push)
SET search_path TO hms;

CREATE TABLE IF NOT EXISTS fcm_token (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES app_user(id),
  token      TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fcm_token_user ON fcm_token(user_id);
