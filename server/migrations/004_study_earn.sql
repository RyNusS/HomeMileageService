-- 외부 앱(학습 등) 적립 청구 메타 + 중복 청구 차단
SET search_path TO hms;

ALTER TABLE earn_request ADD COLUMN IF NOT EXISTS source_kind TEXT;
ALTER TABLE earn_request ADD COLUMN IF NOT EXISTS ext_ref     TEXT;
ALTER TABLE earn_request ADD COLUMN IF NOT EXISTS meta        JSONB;

-- 같은 가족·자녀·외부참조(예: 학습 세트 ID)로는 1회만 청구 가능
-- (취소는 행 삭제라 슬롯이 풀리고, 거절된 청구는 재청구를 막는다)
CREATE UNIQUE INDEX IF NOT EXISTS uq_earn_request_ext_ref
  ON earn_request (family_id, user_id, ext_ref)
  WHERE ext_ref IS NOT NULL;
