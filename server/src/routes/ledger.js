// ledger history
import { q } from '../db.js';

export async function ledgerRoutes(app) {
  app.get('/ledger', { onRequest: app.authRequired }, async (req) => {
    const userId = req.user.role === 'child' ? req.user.sub : (req.query.user_id || req.user.sub);
    const { rows } = await q(
      `SELECT id, amount, source_type, source_id, memo, created_at
       FROM ledger_entry
       WHERE user_id = $1 AND family_id = $2
       ORDER BY id DESC LIMIT $3`,
      [userId, req.user.family_id, Math.min(Number(req.query.limit) || 50, 200)]);
    return rows.map((r) => ({ ...r, id: Number(r.id) }));
  });
}
