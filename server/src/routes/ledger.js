// ledger history
import { q } from '../db.js';

export async function ledgerRoutes(app) {
  // family-wide ledger (parent) - includes user names, optional source_type filter
  app.get('/ledger/family', { onRequest: app.parentOnly }, async (req) => {
    const params = [req.user.family_id];
    let where = 'l.family_id = $1';
    if (req.query.source_type) {
      params.push(req.query.source_type);
      where += ` AND l.source_type = $${params.length}`;
    }
    params.push(Math.min(Number(req.query.limit) || 50, 200));
    const { rows } = await q(
      `SELECT l.id, l.user_id, u.name AS user_name, l.amount, l.source_type, l.memo, l.created_at
       FROM ledger_entry l JOIN app_user u ON u.id = l.user_id
       WHERE ${where}
       ORDER BY l.id DESC LIMIT $${params.length}`, params);
    return rows.map((r) => ({ ...r, id: Number(r.id), user_id: Number(r.user_id) }));
  });

  // family-wide unified history (parent) — ledger(적립/구매/보정) + 사용권 사용을 합쳐
  // 시간 역순으로 돌려준다. 최근 1년, offset 페이징(기본 100개씩).
  // 사용권 사용은 자녀 화면과 동일하게 사용권×날짜(Asia/Seoul) 단위로 합산.
  app.get('/history/family', { onRequest: app.parentOnly }, async (req) => {
    const limit = Math.min(Number(req.query.limit) || 100, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const { rows } = await q(
      `SELECT * FROM (
         SELECT 'ledger'::text AS kind,
                'l' || l.id::text AS key,
                l.created_at AS at,
                u.name AS user_name,
                l.amount, l.source_type, l.memo,
                NULL::text AS label, NULL::int AS used_minutes, NULL::int AS total_minutes
         FROM ledger_entry l
         JOIN app_user u ON u.id = l.user_id
         WHERE l.family_id = $1 AND l.created_at >= now() - interval '1 year'
         UNION ALL
         SELECT 'voucher_use',
                'u' || d.voucher_id::text || ':' || d.used_date::text,
                d.first_used_at,
                u.name,
                NULL, 'use', NULL,
                v.label, d.used_minutes, v.total_minutes
         FROM (
           SELECT vu.voucher_id,
                  (vu.used_at AT TIME ZONE 'Asia/Seoul')::date AS used_date,
                  MIN(vu.used_at) AS first_used_at,
                  SUM(vu.used_minutes)::int AS used_minutes
           FROM voucher_usage vu
           JOIN voucher v2 ON v2.id = vu.voucher_id
           WHERE v2.family_id = $1 AND vu.used_at >= now() - interval '1 year'
           GROUP BY vu.voucher_id, used_date
         ) d
         JOIN voucher v ON v.id = d.voucher_id
         JOIN app_user u ON u.id = v.user_id
       ) t
       ORDER BY t.at DESC
       LIMIT $2 OFFSET $3`,
      [req.user.family_id, limit + 1, offset]);
    const hasMore = rows.length > limit;
    return { rows: rows.slice(0, limit), has_more: hasMore };
  });

  app.get('/ledger', { onRequest: app.authRequired }, async (req) => {
    const userId = req.user.role === 'child' ? req.user.sub : (req.query.user_id || req.user.sub);
    // children only see the last 30 days; full history stays in DB for parents
    const recentOnly = req.user.role === 'child'
      ? ` AND created_at >= now() - interval '30 days'` : '';
    const { rows } = await q(
      `SELECT id, amount, source_type, source_id, memo, created_at
       FROM ledger_entry
       WHERE user_id = $1 AND family_id = $2${recentOnly}
       ORDER BY id DESC LIMIT $3`,
      [userId, req.user.family_id, Math.min(Number(req.query.limit) || 50, 200)]);
    return rows.map((r) => ({ ...r, id: Number(r.id) }));
  });
}
