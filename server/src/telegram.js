// Parent notifications via Telegram Bot API.
// Token lives ONLY in server env. chat_id per family in telegram_link.
import { q } from './db.js';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

export function tgEnabled() { return Boolean(TOKEN); }

export async function tgCall(method, payload, log) {
  if (!TOKEN) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    const json = await res.json().catch(() => ({}));
    if (!json.ok && log) log.warn({ method, desc: json.description }, 'telegram call failed');
    return json;
  } catch (err) {
    if (log) log.warn({ method, err: err.message }, 'telegram call error');
    return null;
  }
}

export async function notifyFamily(familyId, text, log, replyMarkup) {
  if (!TOKEN) return;
  try {
    const { rows } = await q(
      'SELECT chat_id FROM telegram_link WHERE family_id = $1', [familyId]);
    await Promise.all(rows.map((r) => tgCall('sendMessage', {
      chat_id: r.chat_id, text,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    }, log)));
  } catch (err) {
    if (log) log.warn({ err: err.message }, 'telegram notify error');
  }
}

// inline keyboard for an earn request: approve / reject / open app
export function earnRequestKeyboard(requestId) {
  const rows = [[
    { text: '✅ 승인', callback_data: `er_ok:${requestId}` },
    { text: '❌ 거절', callback_data: `er_no:${requestId}` },
  ]];
  if (process.env.PUBLIC_URL) {
    rows.push([{ text: '🏠 앱에서 보기', url: process.env.PUBLIC_URL }]);
  }
  return { inline_keyboard: rows };
}
