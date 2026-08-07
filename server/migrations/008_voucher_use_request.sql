-- v1.16.0: 사용권 사용 전 부모 승인 (휴대폰/게임기 등 서버가 강제할 수 없는 기기용)
-- 컴퓨터처럼 가드 프로그램이 실시간 차감하는 항목은 use_approval = FALSE 로 끄면 즉시 사용.
SET search_path TO hms;

ALTER TABLE spend_catalog
  ADD COLUMN IF NOT EXISTS use_approval BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS voucher_use_request (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  family_id   BIGINT NOT NULL REFERENCES family(id),
  user_id     BIGINT NOT NULL REFERENCES app_user(id),
  voucher_id  BIGINT NOT NULL REFERENCES voucher(id),
  minutes     INT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by  BIGINT REFERENCES app_user(id),
  decided_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_vur_family ON voucher_use_request(family_id, id DESC);
-- 같은 사용권에 대해 대기 중인 신청은 1건만
CREATE UNIQUE INDEX IF NOT EXISTS uq_vur_pending
  ON voucher_use_request(voucher_id) WHERE status = 'pending';
