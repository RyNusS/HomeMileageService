-- v1.18.0: 가족 채팅 (가족당 방 하나, 텍스트/사진, 읽음·접속 상태)
SET search_path TO hms;

CREATE TABLE IF NOT EXISTS chat_message (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  family_id   BIGINT NOT NULL REFERENCES family(id),
  user_id     BIGINT NOT NULL REFERENCES app_user(id),
  kind        TEXT NOT NULL DEFAULT 'text',          -- text | photo
  content     TEXT NOT NULL DEFAULT '',
  image       TEXT,                                  -- uploads 파일명 (kind=photo)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_chat_message_family ON chat_message(family_id, id);

-- 사용자별 읽음 위치 + 채팅 화면 접속 시각(활성 중이면 푸시 생략)
CREATE TABLE IF NOT EXISTS chat_read (
  user_id       BIGINT PRIMARY KEY REFERENCES app_user(id),
  last_read_id  BIGINT NOT NULL DEFAULT 0,
  seen_at       TIMESTAMPTZ
);
