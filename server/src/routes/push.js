// web push subscription endpoints
import { q } from '../db.js';
import { ensurePush, getVapidPublicKey } from '../push.js';

export async function pushRoutes(app) {
  app.get('/push/vapid-public-key', { onRequest: app.authRequired }, async (req, reply) => {
    await ensurePush(req.log);
    const key = await getVapidPublicKey();
    if (!key) return reply.code(503).send({ error: 'push_not_ready' });
    return { key };
  });

  app.post('/push/subscribe', { onRequest: app.authRequired }, async (req, reply) => {
    const s = req.body || {};
    const keys = s.keys || {};
    if (!s.endpoint || !keys.p256dh || !keys.auth) {
      return reply.code(400).send({ error: 'bad_subscription' });
    }
    await q(
      `INSERT INTO push_subscription (user_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = $1, p256dh = $3, auth = $4`,
      [req.user.sub, s.endpoint, keys.p256dh, keys.auth]);
    return { ok: true };
  });

  app.post('/push/unsubscribe', { onRequest: app.authRequired }, async (req) => {
    const endpoint = req.body && req.body.endpoint;
    if (endpoint) {
      await q('DELETE FROM push_subscription WHERE endpoint = $1 AND user_id = $2',
        [endpoint, req.user.sub]);
    }
    return { ok: true };
  });

  // ── FCM (native app) device token ──
  app.post('/push/fcm-token', { onRequest: app.authRequired }, async (req, reply) => {
    const token = req.body && req.body.token;
    if (!token || typeof token !== 'string' || token.length > 4096) {
      return reply.code(400).send({ error: 'bad_token' });
    }
    await q(
      `INSERT INTO fcm_token (user_id, token) VALUES ($1, $2)
       ON CONFLICT (token) DO UPDATE SET user_id = $1, updated_at = now()`,
      [req.user.sub, token]);
    return { ok: true };
  });

  app.post('/push/fcm-token/remove', { onRequest: app.authRequired }, async (req) => {
    const token = req.body && req.body.token;
    if (token) {
      await q('DELETE FROM fcm_token WHERE token = $1 AND user_id = $2',
        [token, req.user.sub]);
    }
    return { ok: true };
  });
}
