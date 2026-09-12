// 적립 항목 미달성 자동 포인트 — 매일 06:00(Asia/Seoul) 이후 전날(00:00~23:59:59)을 판정한다.
// (판정 기준은 자정이지만 실행·푸시는 아침 6시 — 새벽 알림 방지)
//
// 규칙
//  - 항목에 miss_enabled 가 켜져 있고, 판정일의 요일이 miss_days 에 포함되면 대상
//  - "달성" = 그 날(KST 00:00:00 ~ 23:59:59)에 자녀가 청구를 등록한 기록이 있음
//    (earn_request.created_at 기준. 승인 여부·사진 업로드 시각은 보지 않는다.
//     단 거절된 청구는 '안 한 것'으로 본다. 취소는 행이 지워지므로 자동으로 미달성)
//  - 미달성이면 miss_points 만큼 원장(source_type='miss')에 기록 + 잔액 반영 + 자녀 푸시
//  - miss_record (자녀×항목×날짜 UNIQUE) 로 재실행·중복 부여를 막는다
//  - 서버가 꺼져 있던 날은 다음 실행 때 놓친 날짜를 순서대로 소급 (최대 7일)
import { pool, q, tx } from './db.js';
import { pushToUser } from './push.js';

const TZ = 'Asia/Seoul';
const RUN_AFTER_HOUR = 6;         // 06:00(KST) 이후에 실행
const MAX_BACKFILL_DAYS = 7;
const CFG_KEY = 'miss_last_date';

// 'YYYY-MM-DD' 문자열 <-> UTC 정오 Date (날짜 계산 전용)
const toDate = (s) => new Date(`${s}T12:00:00Z`);
const toStr = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = toDate(s); d.setUTCDate(d.getUTCDate() + n); return toStr(d); };
const dow = (s) => toDate(s).getUTCDay();   // 0=일 … 6=토

// 서울 기준 현재 날짜·시각 (DB 시계를 기준으로 삼아 컨테이너 TZ 설정과 무관하게 동작)
async function seoulNow() {
  const { rows } = await q(
    `SELECT to_char(now() AT TIME ZONE $1, 'YYYY-MM-DD') AS d,
            extract(hour FROM now() AT TIME ZONE $1)::int AS h`, [TZ]);
  return rows[0];
}

async function lastRunDate() {
  const { rows } = await q(`SELECT value FROM app_config WHERE key = $1`, [CFG_KEY]);
  return rows[0] ? rows[0].value : null;
}

async function saveRunDate(dateStr) {
  await q(
    `INSERT INTO app_config (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [CFG_KEY, dateStr]);
}

// 하루치 판정. 반환: 부여 건수
export async function evaluateMissForDate(dateStr, log) {
  const weekday = dow(dateStr);
  // 대상 항목: 켜져 있고, 활성이고, 요일 해당, 켠 날짜(miss_since) 이후
  const { rows: items } = await q(
    `SELECT c.id, c.family_id, c.name, c.miss_points, c.miss_child_ids
     FROM earn_catalog c
     WHERE c.miss_enabled AND c.active AND c.miss_points IS NOT NULL
       AND $2 = ANY(c.miss_days)
       AND to_char(COALESCE(c.miss_since, c.created_at) AT TIME ZONE $3, 'YYYY-MM-DD') <= $1`,
    [dateStr, weekday, TZ]);
  if (items.length === 0) return 0;

  let granted = 0;
  const notify = [];
  for (const it of items) {
    // 대상 자녀: 활성 자녀 중 그 날 이전에 만들어진 계정 (miss_child_ids 지정 시 그 안에서만)
    const { rows: kids } = await q(
      `SELECT id, name FROM app_user
       WHERE family_id = $1 AND role = 'child' AND active
         AND to_char(created_at AT TIME ZONE $3, 'YYYY-MM-DD') <= $2
         AND ($4::bigint[] IS NULL OR id = ANY($4::bigint[]))`,
      [it.family_id, dateStr, TZ, it.miss_child_ids]);

    for (const kid of kids) {
      const result = await tx(async (c) => {
        // 이미 처리한 날이면 건너뜀 (재실행 안전)
        const dup = await c.query(
          `SELECT 1 FROM miss_record WHERE user_id = $1 AND catalog_id = $2 AND miss_date = $3`,
          [kid.id, it.id, dateStr]);
        if (dup.rowCount) return null;

        // 달성 여부: 그 날 KST 기준 등록된 청구(거절 제외)가 하나라도 있으면 달성
        const done = await c.query(
          `SELECT 1 FROM earn_request
           WHERE user_id = $1 AND catalog_id = $2 AND status <> 'rejected'
             AND to_char(created_at AT TIME ZONE $4, 'YYYY-MM-DD') = $3
           LIMIT 1`,
          [kid.id, it.id, dateStr, TZ]);
        if (done.rowCount) return null;

        const led = await c.query(
          `INSERT INTO ledger_entry (family_id, user_id, amount, source_type, memo)
           VALUES ($1, $2, $3, 'miss', $4) RETURNING id`,
          [it.family_id, kid.id, it.miss_points, `미달성: ${it.name}`]);
        const rec = await c.query(
          `INSERT INTO miss_record (family_id, user_id, catalog_id, miss_date, points, ledger_id)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [it.family_id, kid.id, it.id, dateStr, it.miss_points, led.rows[0].id]);
        await c.query(
          `UPDATE app_user SET balance_cache = balance_cache + $1 WHERE id = $2`,
          [it.miss_points, kid.id]);
        await c.query(`UPDATE ledger_entry SET source_id = $1 WHERE id = $2`,
          [rec.rows[0].id, led.rows[0].id]);
        return { userId: kid.id };
      });
      if (result) {
        granted += 1;
        notify.push({ userId: result.userId, item: it, date: dateStr });
      }
    }
  }

  for (const n of notify) {
    const p = n.item.miss_points;
    pushToUser(n.userId, {
      title: p < 0 ? '미달성 포인트 차감 😢' : '미달성 포인트',
      body: `${n.date.slice(5).replace('-', '/')} ${n.item.name} 미달성 · ${p > 0 ? '+' : ''}${p}P`,
      tag: 'miss',
    }, log);
  }
  if (log) log.info({ date: dateStr, items: items.length, granted }, 'miss check done');
  return granted;
}

// 놓친 날짜를 어제까지 순서대로 판정. 06:00 이전엔 어제를 아직 판정하지 않는다.
export async function runMissCheck(log, { force = false } = {}) {
  const now = await seoulNow();
  const yesterday = addDays(now.d, -1);
  if (!force && now.h < RUN_AFTER_HOUR) return { skipped: 'too_early' };

  const last = await lastRunDate();
  let from = last ? addDays(last, 1) : yesterday;
  const minFrom = addDays(yesterday, -(MAX_BACKFILL_DAYS - 1));
  if (from < minFrom) from = minFrom;
  if (from > yesterday) return { skipped: 'up_to_date' };

  let total = 0;
  for (let d = from; d <= yesterday; d = addDays(d, 1)) {
    total += await evaluateMissForDate(d, log);
    await saveRunDate(d);
  }
  return { from, to: yesterday, granted: total };
}

// 1분마다 확인(06:00 지나면 그날 처음 한 번만 실제 실행) — 동시 실행은 advisory lock 으로 차단
let running = false;
export function startMissScheduler(log) {
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      // advisory lock 은 세션 단위라 같은 커넥션에서 잡고 풀어야 한다
      const client = await pool.connect();
      try {
        const lock = await client.query(`SELECT pg_try_advisory_lock(7419001) AS ok`);
        if (!lock.rows[0].ok) return;
        try {
          const r = await runMissCheck(log);
          if (r.granted !== undefined && log) log.info(r, 'miss scheduler run');
        } finally {
          await client.query(`SELECT pg_advisory_unlock(7419001)`);
        }
      } finally {
        client.release();
      }
    } catch (err) {
      if (log) log.warn({ err: err.message }, 'miss scheduler error');
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 15 * 1000);              // 기동 직후 한 번 (놓친 날 소급)
  const timer = setInterval(tick, 60 * 1000);
  if (timer.unref) timer.unref();
  return timer;
}
