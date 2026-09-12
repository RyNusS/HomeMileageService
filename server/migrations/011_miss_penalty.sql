-- v1.19.0: 적립 항목 미달성 시 자동 포인트 (요일별, 자정 기준 판정)
SET search_path TO hms;

-- miss_enabled: 미달성 자동 포인트 사용 여부
-- miss_points : 부여 포인트 (음수=차감, 양수=지급, 0 불가)
-- miss_days   : 적용 요일 (0=일 … 6=토, Asia/Seoul 기준). 7개 모두면 매일
-- miss_since  : 켠 시점 — 이 날짜(KST) 이전의 날은 판정하지 않는다
-- miss_child_ids: NULL=전 자녀 공통 (향후 자녀별 적용용 예약 컬럼)
ALTER TABLE earn_catalog
  ADD COLUMN IF NOT EXISTS miss_enabled   BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS miss_points    INTEGER CHECK (miss_points IS NULL OR miss_points <> 0),
  ADD COLUMN IF NOT EXISTS miss_days      SMALLINT[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}',
  ADD COLUMN IF NOT EXISTS miss_since     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS miss_child_ids BIGINT[];

-- 원장 source_type 에 'miss' 추가
ALTER TABLE ledger_entry DROP CONSTRAINT IF EXISTS ledger_entry_source_type_check;
ALTER TABLE ledger_entry
  ADD CONSTRAINT ledger_entry_source_type_check
  CHECK (source_type IN ('earn','spend','adjust','miss'));

-- 미달성 부여 기록 (자녀×항목×날짜 1회만 — 배치 재실행 시 중복 방지)
CREATE TABLE IF NOT EXISTS miss_record (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  family_id   BIGINT NOT NULL REFERENCES family(id),
  user_id     BIGINT NOT NULL REFERENCES app_user(id),
  catalog_id  BIGINT NOT NULL REFERENCES earn_catalog(id),
  miss_date   DATE NOT NULL,
  points      INTEGER NOT NULL,
  ledger_id   BIGINT REFERENCES ledger_entry(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, catalog_id, miss_date)
);
CREATE INDEX IF NOT EXISTS idx_miss_record_family ON miss_record(family_id, miss_date DESC);
