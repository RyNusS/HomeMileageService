-- v1.28.0: PC 가드 설정을 가족 단위로 서버에 저장 (여러 PC에 한 번에 적용)
--   max_session_min   : 사용권으로 쓸 때 1회 최대 세션(분)
--   allowed_start/end : 사용권으로 쓸 수 있는 시간대 (HH:MM, Asia/Seoul)
--   offline_grace_min : 서버 연결이 끊겨도 봐주는 시간(분)
--   free_windows      : 요일별 자유 이용 시간 [{day:0~6(0=일), start:'HH:MM', end:'HH:MM'}]
--                       이 시간에는 로그인만 하면 사용권 차감 없이 쓴다.
--                       사용 가능 시간대·1회 최대 세션보다 우선한다.
SET search_path TO hms;

CREATE TABLE IF NOT EXISTS pc_settings (
  family_id         BIGINT PRIMARY KEY REFERENCES family(id),
  max_session_min   INTEGER NOT NULL DEFAULT 60 CHECK (max_session_min BETWEEN 5 AND 1440),
  allowed_start     TEXT NOT NULL DEFAULT '08:00',
  allowed_end       TEXT NOT NULL DEFAULT '21:30',
  offline_grace_min INTEGER NOT NULL DEFAULT 15 CHECK (offline_grace_min BETWEEN 1 AND 120),
  free_windows      JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_by        BIGINT REFERENCES app_user(id),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
