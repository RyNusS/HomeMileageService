// family member management (parent) + balance adjust
import { q, tx } from '../db.js';
import { hashSecret } from '../hash.js';
import { pushToUser } from '../push.js';

export async function userRoutes(app) {
  // list family members with balances
  app.get('/users', { onRequest: app.authRequired }, async (req) => {
    const { rows } = await q(
      `SELECT id, login_id, name, role, balance_cache, active
       FROM app_user WHERE family_id = $1 AND active ORDER BY role DESC, id`,
      [req.user.family_id]);
    return rows.map((r) => ({
      id: Number(r.id), login_id: r.login_id, name: r.name, role: r.role,
      balance: r.balance_cache, active: r.active,
    }));
  });

  // create child account
  app.post('/users', { onRequest: app.parentOnly }, async (req, reply) => {
    const { login_id, name, pin } = req.body || {};
    if (!login_id || !name || !pin) return reply.code(400).send({ error: 'missing_fields' });
    if (!/^[0-9]{4,6}$/.test(String(pin))) return reply.code(400).send({ error: 'pin_must_be_4_6_digits' });
    const lid = String(login_id).trim().toLowerCase();
    if (!/^[a-z0-9_-]{2,20}$/.test(lid)) return reply.code(400).send({ error: 'bad_login_id' });

    const hash = await hashSecret(pin);
    try {
      const { rows } = await q(
        `INSERT INTO app_user (family_id, login_id, name, role, secret_hash)
         VALUES ($1, $2, $3, 'child', $4) RETURNING id`,
        [req.user.family_id, lid, name, hash]);
      return { id: Number(rows[0].id) };
    } catch (err) {
      if (err.code === '23505') return reply.code(409).send({ error: 'login_id_taken' });
      throw err;
    }
  });

  // reset child PIN
  app.post('/users/:id/reset-pin', { onRequest: app.parentOnly }, async (req, reply) => {
    const { pin } = req.body || {};
    if (!/^[0-9]{4,6}$/.test(String(pin))) return reply.code(400).send({ error: 'pin_must_be_4_6_digits' });
    const hash = await hashSecret(pin);
    const { rowCount } = await q(
      `UPDATE app_user SET secret_hash = $1
       WHERE id = $2 AND family_id = $3 AND role = 'child'`,
      [hash, req.params.id, req.user.family_id]);
    if (!rowCount) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  // deactivate (soft-delete) a child account
  app.delete('/users/:id', { onRequest: app.parentOnly }, async (req, reply) => {
    const { rowCount } = await q(
      `UPDATE app_user SET active = FALSE
       WHERE id = $1 AND family_id = $2 AND role = 'child'`,
      [req.params.id, req.user.family_id]);
    if (!rowCount) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  // manual adjust (bonus / correction) - ledger immutable, so adjust entry
  // 잔액이 마이너스가 되어도 허용한다 (부모 차감은 제한 없음, v1.15.0)
  app.post('/users/:id/adjust', { onRequest: app.parentOnly }, async (req, reply) => {
    const amount = Number(req.body && req.body.amount);
    const memo = (req.body && req.body.memo) || '';
    if (!Number.isInteger(amount) || amount === 0) return reply.code(400).send({ error: 'bad_amount' });

    const result = await tx(async (c) => {
      const { rows } = await c.query(
        `SELECT id, balance_cache FROM app_user
         WHERE id = $1 AND family_id = $2 FOR UPDATE`,
        [req.params.id, req.user.family_id]);
      if (!rows[0]) return null;
      await c.query(
        `INSERT INTO ledger_entry (family_id, user_id, amount, source_type, memo)
         VALUES ($1, $2, $3, 'adjust', $4)`,
        [req.user.family_id, req.params.id, amount, memo]);
      const upd = await c.query(
        `UPDATE app_user SET balance_cache = balance_cache + $1
         WHERE id = $2 RETURNING balance_cache`, [amount, req.params.id]);
      return { balance: upd.rows[0].balance_cache };
    });
    if (!result) return reply.code(404).send({ error: 'not_found' });
    if (result.error) return reply.code(400).send({ error: result.error });

    // 부모가 지급/차감하면 해당 자녀에게도 알림 (v1.16.0)
    pushToUser(req.params.id, amount > 0
      ? {
        title: '마일리지 지급 🎁',
        body: `+${amount}P${memo ? ` · ${memo}` : ''} (잔액 ${result.balance.toLocaleString()}P)`,
      }
      : {
        title: '마일리지 차감 ⚠️',
        body: `${amount}P${memo ? ` · ${memo}` : ''} (잔액 ${result.balance.toLocaleString()}P)`,
      }, req.log);

    return result;
  });
}
