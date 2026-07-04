// Shared earn-request decision logic (used by web UI route and telegram webhook)
import { tx } from './db.js';
import { pushToUser } from './push.js';

export async function decideEarnRequest({ requestId, familyId, deciderId, approve }, log) {
  const result = await tx(async (c) => {
    const { rows } = await c.query(
      `SELECT r.id, r.user_id, r.points, r.status, ec.name AS item_name
       FROM earn_request r JOIN earn_catalog ec ON ec.id = r.catalog_id
       WHERE r.id = $1 AND r.family_id = $2 FOR UPDATE OF r`,
      [requestId, familyId]);
    const r = rows[0];
    if (!r) return { code: 404, error: 'not_found' };
    if (r.status !== 'pending') return { code: 409, error: 'already_decided' };

    await c.query(
      `UPDATE earn_request SET status = $1, decided_by = $2, decided_at = now()
       WHERE id = $3`, [approve ? 'approved' : 'rejected', deciderId, r.id]);

    if (approve) {
      await c.query(
        `INSERT INTO ledger_entry (family_id, user_id, amount, source_type, source_id)
         VALUES ($1, $2, $3, 'earn', $4)`,
        [familyId, r.user_id, r.points, r.id]);
      await c.query(
        `UPDATE app_user SET balance_cache = balance_cache + $1 WHERE id = $2`,
        [r.points, r.user_id]);
    }
    return { ok: true, userId: r.user_id, points: r.points, itemName: r.item_name };
  });

  if (result.ok) {
    pushToUser(result.userId, {
      title: approve ? '적립 승인! 🎉' : '적립 거절',
      body: approve
        ? `${result.itemName} +${result.points}P가 적립되었어요`
        : `${result.itemName} 청구가 거절되었어요`,
    }, log);
  }
  return result;
}
