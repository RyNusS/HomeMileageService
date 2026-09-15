-- v1.20.0: AI 채팅 설정·사용량
SET search_path TO hms;

-- 사용자별 AI 설정 (부모가 자녀별로 조정). 기본: 켜짐 / 하루 50회 / 숙제 가드 켜짐
--   ai_enabled        : 이 사용자가 AI 방을 쓸 수 있는지
--   ai_daily_limit    : 하루 질문 횟수 상한 (0 = 사실상 사용 불가)
--   ai_homework_guard : TRUE면 숙제·독후감·일기 등은 정답을 대신 만들어 주지 않고 힌트만 준다
ALTER TABLE app_user
  ADD COLUMN IF NOT EXISTS ai_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS ai_daily_limit    INTEGER NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS ai_homework_guard BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE app_user DROP CONSTRAINT IF EXISTS app_user_ai_daily_limit_check;
ALTER TABLE app_user ADD CONSTRAINT app_user_ai_daily_limit_check CHECK (ai_daily_limit >= 0);

-- 사용자 x 날짜 질문 횟수. use_date 는 서버가 Asia/Seoul 기준으로 계산해 넣는다
CREATE TABLE IF NOT EXISTS ai_usage (
  user_id  BIGINT  NOT NULL REFERENCES app_user(id),
  use_date DATE    NOT NULL,
  count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, use_date)
);
