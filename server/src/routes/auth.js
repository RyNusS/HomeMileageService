// login + me
import { q } from '../db.js';
import { hashSecret, verifySecret } from '../hash.js';

export async function authRoutes(app) {
  app.post('/auth/login', async (req, reply) => {
    const { login_id, secret } = req.body || {};
    if (!login_id || !secret) return reply.code(400).send({ error: 'missing_fields' });

    const { rows } = await q(
      `SELECT id, family_id, login_id, name, role, secret_hash, balance_cache, active
       FROM app_user WHERE login_id = $1`, [String(login_id).trim().toLowerCase()]);
    const user = rows[0];
    if (!user || !user.active || !(await verifySecret(secret, user.secret_hash))) {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    const token = app.jwt.sign({
      sub: String(user.id), family_id: Number(user.family_id), role: user.role,
    });
    return {
      token,
      user: {
        id: Number(user.id), login_id: user.login_id, name: user.name,
        role: user.role, balance: user.balance_cache,
      },
    };
  });

  // change own password/PIN
  app.post('/auth/change-secret', { onRequest: app.authRequired }, async (req, reply) => {
    const { old_secret, new_secret } = req.body || {};
    if (!old_secret || !new_secret || String(new_secret).length < 4) {
      return reply.code(400).send({ error: 'bad_fields' });
    }
    const { rows } = await q('SELECT secret_hash FROM app_user WHERE id = $1', [req.user.sub]);
    if (!(await verifySecret(old_secret, rows[0].secret_hash))) {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    await q('UPDATE app_user SET secret_hash = $1 WHERE id = $2',
      [await hashSecret(new_secret), req.user.sub]);
    return { ok: true };
  });

  app.get('/me', { onRequest: app.authRequired }, async (req) => {
    const { rows } = await q(
      `SELECT u.id, u.login_id, u.name, u.role, u.balance_cache, f.name AS family_name
       FROM app_user u JOIN family f ON f.id = u.family_id
       WHERE u.id = $1`, [req.user.sub]);
    const u = rows[0];
    return {
      id: Number(u.id), login_id: u.login_id, name: u.name, role: u.role,
      balance: u.balance_cache, family_name: u.family_name,
    };
  });
}
