// earn/spend catalog CRUD (parent manages, child reads active items)
import { q } from '../db.js';

export async function catalogRoutes(app) {
  app.get('/catalog/earn', { onRequest: app.authRequired }, async (req) => {
    const activeOnly = req.user.role === 'child';
    // 자녀에게는 오늘 청구 횟수(대기+승인)를 함께 내려 1일 제한 UI에 사용
    const { rows } = await q(
      `SELECT c.id, c.name, c.points, c.proof_required, c.active, c.sort, c.daily_limit,
              c.miss_enabled, c.miss_points, c.miss_days,
              (SELECT count(*)::int FROM earn_request r
               WHERE r.catalog_id = c.id AND r.user_id = $2
                 AND r.status IN ('pending','approved')
                 AND (r.created_at AT TIME ZONE 'Asia/Seoul')::date
                     = (now() AT TIME ZONE 'Asia/Seoul')::date) AS used_today
       FROM earn_catalog c
       WHERE c.family_id = $1 ${activeOnly ? 'AND c.active' : ''}
       ORDER BY c.sort, c.id`, [req.user.family_id, req.user.sub]);
    return rows.map((r) => ({ ...r, id: Number(r.id) }));
  });

  app.get('/catalog/spend', { onRequest: app.authRequired }, async (req) => {
    const activeOnly = req.user.role === 'child';
    const { rows } = await q(
      `SELECT id, name, kind, unit_minutes, unit_label, price_points, active, sort, use_approval
       FROM spend_catalog
       WHERE family_id = $1 ${activeOnly ? 'AND active' : ''}
       ORDER BY sort, id`, [req.user.family_id]);
    return rows.map((r) => ({ ...r, id: Number(r.id) }));
  });

  // daily_limit: null(제한 없음) 또는 1~9
  const parseDailyLimit = (v) => {
    if (v === null || v === undefined || v === '') return { ok: true, value: null };
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 9) return { ok: false };
    return { ok: true, value: n };
  };

  // 미달성 자동 포인트: { miss_enabled, miss_points(0 제외 정수, 음수 허용), miss_days([0..6]) }
  // 켜져 있으면 포인트·요일이 반드시 유효해야 한다. 꺼져 있으면 값은 보존만 한다.
  const parseMiss = (b) => {
    if (!b || !Object.prototype.hasOwnProperty.call(b, 'miss_enabled')) return { ok: true, has: false };
    const enabled = Boolean(b.miss_enabled);
    let points = null;
    if (b.miss_points !== undefined && b.miss_points !== null && b.miss_points !== '') {
      const n = Number(b.miss_points);
      if (!Number.isInteger(n) || n === 0 || Math.abs(n) > 100000) return { ok: false };
      points = n;
    }
    let days = null;
    if (Array.isArray(b.miss_days)) {
      days = [...new Set(b.miss_days.map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
    }
    if (enabled && (points === null || !days || days.length === 0)) return { ok: false };
    return { ok: true, has: true, enabled, points, days };
  };

  app.post('/catalog/earn', { onRequest: app.parentOnly }, async (req, reply) => {
    const { name, points, proof_required = false, sort = 0 } = req.body || {};
    if (!name || !Number.isInteger(Number(points)) || Number(points) <= 0) {
      return reply.code(400).send({ error: 'bad_fields' });
    }
    const dl = parseDailyLimit(req.body && req.body.daily_limit);
    if (!dl.ok) return reply.code(400).send({ error: 'bad_daily_limit' });
    const ms = parseMiss(req.body);
    if (!ms.ok) return reply.code(400).send({ error: 'bad_miss' });
    const { rows } = await q(
      `INSERT INTO earn_catalog (family_id, name, points, proof_required, sort, daily_limit,
                                 miss_enabled, miss_points, miss_days, miss_since)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::smallint[], '{0,1,2,3,4,5,6}'),
               CASE WHEN $7 THEN now() ELSE NULL END)
       RETURNING id`,
      [req.user.family_id, name, Number(points), Boolean(proof_required),
       Number(sort) || 0, dl.value,
       ms.has ? ms.enabled : false, ms.has ? ms.points : null, ms.has ? ms.days : null]);
    return { id: Number(rows[0].id) };
  });

  app.patch('/catalog/earn/:id', { onRequest: app.parentOnly }, async (req, reply) => {
    const b = req.body || {};
    // daily_limit는 null로 되돌릴 수 있어야 하므로 COALESCE 대신 명시적 플래그로 처리
    const hasDL = Object.prototype.hasOwnProperty.call(b, 'daily_limit');
    const dl = parseDailyLimit(b.daily_limit);
    if (hasDL && !dl.ok) return reply.code(400).send({ error: 'bad_daily_limit' });
    const ms = parseMiss(b);
    if (!ms.ok) return reply.code(400).send({ error: 'bad_miss' });
    // miss_since: 꺼짐→켜짐으로 바뀌는 순간 기록 (그 이전 날짜는 판정하지 않음)
    const { rowCount } = await q(
      `UPDATE earn_catalog SET
         name = COALESCE($1, name),
         points = COALESCE($2, points),
         proof_required = COALESCE($3, proof_required),
         active = COALESCE($4, active),
         sort = COALESCE($5, sort),
         daily_limit = CASE WHEN $6 THEN $7::smallint ELSE daily_limit END,
         miss_since = CASE WHEN $10 AND $11 AND NOT miss_enabled THEN now() ELSE miss_since END,
         miss_enabled = CASE WHEN $10 THEN $11 ELSE miss_enabled END,
         miss_points = CASE WHEN $10 THEN COALESCE($12::int, miss_points) ELSE miss_points END,
         miss_days = CASE WHEN $10 THEN COALESCE($13::smallint[], miss_days) ELSE miss_days END
       WHERE id = $8 AND family_id = $9`,
      [b.name ?? null, b.points ?? null, b.proof_required ?? null,
       b.active ?? null, b.sort ?? null, hasDL, hasDL ? dl.value : null,
       req.params.id, req.user.family_id,
       ms.has, ms.has ? ms.enabled : false, ms.has ? ms.points : null, ms.has ? ms.days : null]);
    if (!rowCount) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  // 항목 순서 일괄 변경: { ids: [id, id, ...] } — 배열 순서대로 sort 부여
  const makeReorder = (table) => async (req, reply) => {
    const ids = req.body && req.body.ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 200
        || !ids.every((v) => Number.isInteger(Number(v)))) {
      return reply.code(400).send({ error: 'bad_fields' });
    }
    await q(
      `UPDATE ${table} SET sort = u.ord
       FROM (SELECT unnest($1::bigint[]) AS id, generate_series(1, $2) AS ord) u
       WHERE ${table}.id = u.id AND ${table}.family_id = $3`,
      [ids.map(Number), ids.length, req.user.family_id]);
    return { ok: true };
  };
  app.post('/catalog/earn/reorder', { onRequest: app.parentOnly }, makeReorder('earn_catalog'));
  app.post('/catalog/spend/reorder', { onRequest: app.parentOnly }, makeReorder('spend_catalog'));

  app.post('/catalog/spend', { onRequest: app.parentOnly }, async (req, reply) => {
    const { name, kind, unit_minutes, unit_label, price_points, sort = 0 } = req.body || {};
    if (!name || !['time_voucher', 'cash'].includes(kind)) return reply.code(400).send({ error: 'bad_fields' });
    if (!Number.isInteger(Number(price_points)) || Number(price_points) <= 0) return reply.code(400).send({ error: 'bad_fields' });
    if (kind === 'time_voucher' && (!Number.isInteger(Number(unit_minutes)) || Number(unit_minutes) <= 0)) {
      return reply.code(400).send({ error: 'unit_minutes_required' });
    }
    // use_approval: 사용권을 쓰기 전에 부모 승인을 받을지 (기본 켜짐).
    // 컴퓨터처럼 가드 프로그램이 실시간으로 차감하는 항목만 꺼서 즉시 사용하게 한다.
    const useApproval = (req.body && req.body.use_approval) === undefined
      ? true : Boolean(req.body.use_approval);
    const { rows } = await q(
      `INSERT INTO spend_catalog (family_id, name, kind, unit_minutes, unit_label, price_points, sort, use_approval)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [req.user.family_id, name, kind,
       kind === 'time_voucher' ? Number(unit_minutes) : null,
       unit_label || null, Number(price_points), Number(sort) || 0, useApproval]);
    return { id: Number(rows[0].id) };
  });

  app.patch('/catalog/spend/:id', { onRequest: app.parentOnly }, async (req, reply) => {
    const b = req.body || {};
    const { rowCount } = await q(
      `UPDATE spend_catalog SET
         name = COALESCE($1, name),
         unit_minutes = COALESCE($2, unit_minutes),
         unit_label = COALESCE($3, unit_label),
         price_points = COALESCE($4, price_points),
         active = COALESCE($5, active),
         sort = COALESCE($6, sort),
         use_approval = COALESCE($7, use_approval)
       WHERE id = $8 AND family_id = $9`,
      [b.name ?? null, b.unit_minutes ?? null, b.unit_label ?? null,
       b.price_points ?? null, b.active ?? null, b.sort ?? null,
       b.use_approval === undefined || b.use_approval === null ? null : Boolean(b.use_approval),
       req.params.id, req.user.family_id]);
    if (!rowCount) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });
}
