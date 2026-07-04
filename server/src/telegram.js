// Parent notifications via Telegram Bot API.
// Token lives ONLY in server env. chat_id per family in telegram_link.
import { q } from './db.js';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

export async function notifyFamily(familyId, text, log) {
  if (!TOKEN) return;
  try {
    const { rows } = await q(
      'SELECT chat_id FROM telegram_link WHERE family_id = $1', [familyId]);
    await Promise.all(rows.map(async (r) => {
      const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: r.chat_id, text }),
      });
      if (!res.ok && log) log.warn({ status: res.status }, 'telegram send failed');
    }));
  } catch (err) {
    if (log) log.warn({ err: err.message }, 'telegram notify error');
  }
}
