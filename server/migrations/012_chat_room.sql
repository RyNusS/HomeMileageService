-- v1.20.0: 채팅 방 분리 (가족 공용 방 + 사용자별 AI 1:1 방)
SET search_path TO hms;

-- 방 목록
--   type='family' : 가족 공용 방 (기존 채팅). 가족당 1개, owner 없음
--   type='ai'     : 소유자 1인만 볼 수 있는 AI 대화방. 사용자당 1개
CREATE TABLE IF NOT EXISTS chat_room (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  family_id     BIGINT NOT NULL REFERENCES family(id),
  type          TEXT NOT NULL CHECK (type IN ('family','ai')),
  owner_user_id BIGINT REFERENCES app_user(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((type = 'family' AND owner_user_id IS NULL)
      OR (type = 'ai'     AND owner_user_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_room_family ON chat_room(family_id)     WHERE type = 'family';
CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_room_ai     ON chat_room(owner_user_id) WHERE type = 'ai';

-- 메시지에 방 구분 + AI 발신 표시
--   room_id  : 어느 방의 메시지인가
--   is_ai    : TRUE면 제미나이가 보낸 말풍선 (user_id 는 질문한 사람을 가리킨다)
--   ai_model : 그때 사용한 모델명 (추후 모델 교체 이력 추적용)
--   shared   : AI 방에서 가족 방으로 공유해 온 말풍선
ALTER TABLE chat_message
  ADD COLUMN IF NOT EXISTS room_id  BIGINT REFERENCES chat_room(id),
  ADD COLUMN IF NOT EXISTS is_ai    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS ai_model TEXT,
  ADD COLUMN IF NOT EXISTS shared   BOOLEAN NOT NULL DEFAULT FALSE;

-- 기존 가족마다 공용 방 생성
INSERT INTO chat_room (family_id, type)
SELECT f.id, 'family' FROM family f
WHERE NOT EXISTS (SELECT 1 FROM chat_room r WHERE r.family_id = f.id AND r.type = 'family');

-- 기존 메시지 전량을 각 가족의 공용 방으로 이관
UPDATE chat_message m
   SET room_id = r.id
  FROM chat_room r
 WHERE r.family_id = m.family_id
   AND r.type = 'family'
   AND m.room_id IS NULL;

ALTER TABLE chat_message ALTER COLUMN room_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_chat_message_room ON chat_message(room_id, id);

-- 읽음 위치를 방별로 관리 (기존 행은 가족 공용 방 기록으로 이관)
ALTER TABLE chat_read ADD COLUMN IF NOT EXISTS room_id BIGINT REFERENCES chat_room(id);

UPDATE chat_read cr
   SET room_id = r.id
  FROM app_user u
  JOIN chat_room r ON r.family_id = u.family_id AND r.type = 'family'
 WHERE cr.user_id = u.id
   AND cr.room_id IS NULL;

-- 이관되지 못한 고아 행(가족 없는 사용자 등)은 버린다
DELETE FROM chat_read WHERE room_id IS NULL;

ALTER TABLE chat_read ALTER COLUMN room_id SET NOT NULL;
ALTER TABLE chat_read DROP CONSTRAINT IF EXISTS chat_read_pkey;
ALTER TABLE chat_read ADD PRIMARY KEY (user_id, room_id);
