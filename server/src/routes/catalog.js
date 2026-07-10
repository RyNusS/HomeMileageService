// earn/spend catalog CRUD (parent manages, child reads active items)
import { q } from '../db.js';

export async function catalogRoutes(app) {
  app.get('/catalog/earn', { onRequest: app.authRequired }, async (req) => {
    const activeOnly = req.user.role === 'child';
    // 자녀에게는 오늘 청구 횟수(대기+승인)를 함께 내려 1일 제한 UI에 사용
    const { rows } = await q(
      `SELECT c.id, c.name, c.points, c.proof_required, c.active, c.sort, c.daily_limit,
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
      `SELECT id, name, kind, unit_minutes, unit_label, price_points, active, sort
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

  app.post('/catalog/earn', { onRequest: app.parentOnly }, async (req, reply) => {
    const { name, points, proof_required = false, sort = 0 } = req.body || {};
    if (!name || !Number.isInteger(Number(points)) || Number(points) <= 0) {
      return reply.code(400).send({ error: 'bad_fields' });
    }
    const dl = parseDailyLimit(req.body && req.body.daily_limit);
    if (!dl.ok) return reply.code(400).send({ error: 'bad_daily_limit' });
    const { rows } = await q(
      `INSERT INTO earn_catalog (family_id, name, points, proof_required, sort, daily_limit)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [req.user.family_id, name, Number(points), Boolean(proof_required),
       Number(sort) || 0, dl.value]);
    return { id: Number(rows[0].id) };
  });

  app.patch('/catalog/earn/:id', { onRequest: app.parentOnly }, async (req, reply) => {
    const b = req.body || {};
    // daily_limit는 null로 되돌릴 수 있어야 하므로 COALESCE 대신 명시적 플래그로 처리
    const hasDL = Object.prototype.hasOwnProperty.call(b, 'daily_limit');
    const dl = parseDailyLimit(b.daily_limit);
    if (hasDL && !dl.ok) return reply.code(400).send({ error: 'bad_daily_limit' });
    const { rowCount } = await q(
      `UPDATE earn_catalog SET
         name = COALESCE($1, name),
         points = COALESCE($2, points),
         proof_required = COALESCE($3, proof_required),
         active = COALESCE($4, active),
         sort = COALESCE($5, sort),
         daily_limit = CASE WHEN $6 THEN $7::smallint ELSE daily_limit END
       WHERE id = $8 AND family_id = $9`,
      [b.name ?? null, b.points ?? null, b.proof_required ?? null,
       b.active ?? null, b.sort ?? null, hasDL, hasDL ? dl.value : null,
       req.params.id, req.user.family_id]);
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
    const { rows } = await q(
      `INSERT INTO spend_catalog (family_id, name, kind, unit_minutes, unit_label, price_points, sort)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [req.user.family_id, name, kind,
       kind === 'time_voucher' ? Number(unit_minutes) : null,
       unit_label || null, Number(price_points), Number(sort) || 0]);
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
         sort = COALESCE($6, sort)
       WHERE id = $7 AND family_id = $8`,
      [b.name ?? null, b.unit_minutes ?? null, b.unit_label ?? null,
       b.price_points ?? null, b.active ?? null, b.sort ?? null,
       req.params.id, req.user.family_id]);
    if (!rowCount) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });
}
