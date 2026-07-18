// FCM (native app push) - service account key from file path in env, optional.
// If the key file is absent the module quietly disables itself so web push
// and telegram keep working without any FCM setup.
import { readFileSync, existsSync } from 'node:fs';
import { q } from './db.js';

let messaging = null;   // firebase-admin messaging instance
let disabled = false;   // true = init failed or no key file; never retried
let initing = null;

async function initFcm(log) {
  const file = process.env.FCM_CREDENTIALS_FILE || '';
  if (!file || !existsSync(file)) {
    disabled = true;
    if (log) log.info('fcm disabled (no credentials file)');
    return;
  }
  try {
    const admin = await import('firebase-admin');
    const cred = JSON.parse(readFileSync(file, 'utf8'));
    const app = admin.default.initializeApp({
      credential: admin.default.credential.cert(cred),
    });
    messaging = app.messaging();
    if (log) log.info('fcm ready');
  } catch (err) {
    disabled = true;
    if (log) log.warn({ err: err.message }, 'fcm init failed');
  }
}

async function ensureFcm(log) {
  if (messaging) return true;
  if (disabled) return false;
  if (!initing) initing = initFcm(log).finally(() => { initing = null; });
  await initing;
  return !!messaging;
}

const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

// fire-and-forget FCM push to all registered devices of a user
export async function fcmToUser(userId, payload, log) {
  if (!(await ensureFcm(log))) return;
  try {
    const { rows } = await q(
      'SELECT id, token FROM fcm_token WHERE user_id = $1', [userId]);
    if (!rows.length) return;
    const res = await messaging.sendEachForMulticast({
      tokens: rows.map((r) => r.token),
      notification: { title: payload.title || '', body: payload.body || '' },
      data: { url: String(payload.url || '/') },
      android: {
        priority: 'high',
        notification: {
          channelId: 'hms_default',
          icon: 'ic_stat_hms',
          color: '#4f7cf7',
        },
      },
    });
    await Promise.all(res.responses.map(async (r, i) => {
      if (!r.success && r.error && DEAD_TOKEN_CODES.has(r.error.code)) {
        await q('DELETE FROM fcm_token WHERE id = $1', [rows[i].id]);
      } else if (!r.success && log) {
        log.warn({ err: r.error && r.error.message }, 'fcm send failed');
      }
    }));
  } catch (err) {
    if (log) log.warn({ err: err.message }, 'fcm error');
  }
}
