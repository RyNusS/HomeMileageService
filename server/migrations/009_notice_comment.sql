-- v1.17.0: 공지사항 댓글 (최대 100자, 작성자·부모가 삭제)
SET search_path TO hms;

CREATE TABLE IF NOT EXISTS notice_comment (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  notice_id   BIGINT NOT NULL REFERENCES notice(id) ON DELETE CASCADE,
  family_id   BIGINT NOT NULL REFERENCES family(id),
  user_id     BIGINT NOT NULL REFERENCES app_user(id),
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notice_comment ON notice_comment(notice_id, id);
