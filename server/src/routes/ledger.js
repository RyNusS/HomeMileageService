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
