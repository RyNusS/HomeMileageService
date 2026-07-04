// web push subscription endpoints
import { q } from '../db.js';
import { getVapidPublicKey } from '../push.js';

export async function pushRoutes(app) {
  app.get('/push/vapid-public-key', { onRequest: app.authRequired }, async (req, reply) => {
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
}
