-- 적립 항목 1일 청구 횟수 제한 + 적립 내역 항목명(memo) 백필
SET search_path TO hms;

-- NULL = 제한 없음, 1~9 = 하루 최대 청구 횟수
ALTER TABLE earn_catalog
  ADD COLUMN IF NOT EXISTS daily_limit SMALLINT
  CHECK (daily_limit IS NULL OR (daily_limit >= 1 AND daily_limit <= 9));

-- 기존 적립 ledger 행에 항목명을 채워 내역 화면에서 무엇으로 적립됐는지 보이게 한다
UPDATE ledger_entry l SET memo = ec.name
FROM earn_request er
JOIN earn_catalog ec ON ec.id = er.catalog_id
WHERE l.source_type = 'earn' AND l.source_id = er.id
  AND (l.memo IS NULL OR l.memo = '');
