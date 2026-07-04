// Web Push (VAPID) - keys stored in DB config, subscriptions per user
import webpush from 'web-push';
import { q } from './db.js';

let ready = false;

export async function initPush() {
  let pub = null; let priv = null;
  const { rows } = await q(
    `SELECT key, value FROM app_config WHERE key IN ('vapid_public','vapid_private')`);
  for (const r of rows) {
    if (r.key === 'vapid_public') pub = r.value;
    if (r.key === 'vapid_private') priv = r.value;
  }
  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys();
    pub = keys.publicKey; priv = keys.privateKey;
    await q(
      `INSERT INTO app_config (key, value) VALUES ('vapid_public',$1), ('vapid_private',$2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [pub, priv]);
  }
  const subject = process.env.PUBLIC_URL || 'mailto:admin@example.com';
  webpush.setVapidDetails(subject, pub, priv);
  ready = true;
  return pub;
}

export async function getVapidPublicKey() {
  const { rows } = await q(`SELECT value FROM app_config WHERE key = 'vapid_public'`);
  return rows[0] ? rows[0].value : null;
}

// fire-and-forget push to all subscriptions of a user
export async function pushToUser(userId, payload, log) {
  if (!ready) return;
  try {
    const { rows } = await q(
      `SELECT id, endpoint, p256dh, auth FROM push_subscription WHERE user_id = $1`, [userId]);
    await Promise.all(rows.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(payload), { TTL: 3600 });
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await q('DELETE FROM push_subscription WHERE id = $1', [s.id]);
        } else if (log) {
          log.warn({ err: err.message }, 'web push failed');
        }
      }
    }));
  } catch (err) {
    if (log) log.warn({ err: err.message }, 'web push error');
  }
}
