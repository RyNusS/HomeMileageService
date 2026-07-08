// Ops bridge — authenticated endpoints so a remote operator's assistant can
// notify the owner via Telegram and read the owner's decision, WITHOUT a local
// long-polling receiver. The always-on server webhook records replies into
// app_config; these endpoints send questions and poll for the stored answer.
//
// Auth: OPS_TOKEN (server env). Prefer header `x-ops-token`; query `?token=` is
// a fallback for GET-only clients (do not log it). Target: OPS_CHAT_ID (owner's
// chat with the bot). Answers are stored by routes/telegram.js under keys
// ask_answer_<id> / ask_opts_<id> / ask_pending.
import { q } from '../db.js';
import { tgCall } from '../telegram.js';

const okId = (s) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);

export async function opsRoutes(app) {
  const TOKEN = process.env.OPS_TOKEN || '';
  const CHAT = process.env.OPS_CHAT_ID || '';

  const authed = (req) => {
    if (!TOKEN) return false;
    const t = req.headers['x-ops-token']
      || (req.query && req.query.token) || '';
    return t === TOKEN;
  };
  const src = (req) => (req.method === 'GET' ? (req.query || {}) : (req.body || {}));

  // plain notification: /api/ops/notify  { text }
  app.route({ method: ['GET', 'POST'], url: '/ops/notify', handler: async (req, reply) => {
    if (!authed(req)) return reply.code(403).send({ ok: false });
    const s = src(req);
    const text = String(s.text || '').slice(0, 3500);
    if (!CHAT || !text) return reply.code(400).send({ ok: false, error: 'missing text/chat' });
    await tgCall('sendMessage', { chat_id: CHAT, text }, req.log);
    return { ok: true };
  } });

  // decision question: /api/ops/ask  { id, text, choices:"a|b|c", custom:0|1 }
  // choices carry arbitrary (incl. Korean) labels; callback_data uses an index
  // (ask:<id>:<idx>) so it stays within the webhook's ASCII pattern.
  app.route({ method: ['GET', 'POST'], url: '/ops/ask', handler: async (req, reply) => {
    if (!authed(req)) return reply.code(403).send({ ok: false });
    const s = src(req);
    const id = okId(s.id);
    const text = String(s.text || '').slice(0, 3500);
    let choices = s.choices;
    if (typeof choices === 'string') choices = choices.split(/[|,]/);
    choices = (Array.isArray(choices) ? choices : []).map((c) => String(c).trim()).filter(Boolean).slice(0, 4);
    const custom = String(s.custom || '') === '1' || s.custom === true;
    if (!CHAT || !id || !text || (!choices.length && !custom)) {
      return reply.code(400).send({ ok: false, error: 'missing id/text/choices' });
    }
    // reset any stale state for this id, remember labels for readback
    await q('DELETE FROM app_config WHERE key IN ($1, $2)', [`ask_answer_${id}`, `ask_opts_${id}`]);
    await q(
      `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
      [`ask_opts_${id}`, JSON.stringify(choices)]);
    const rows = [];
    if (choices.length) {
      rows.push(choices.map((c, i) => ({ text: c, callback_data: `ask:${id}:${i}` })));
    }
    if (custom) rows.push([{ text: '✏️ 직접 입력', callback_data: `askc:${id}` }]);
    await tgCall('sendMessage', {
      chat_id: CHAT, text: `[결정 필요] ${text}`,
      reply_markup: { inline_keyboard: rows },
    }, req.log);
    return { ok: true, id };
  } });

  // poll answer: /api/ops/answer?id=<id>[&consume=1]  -> text/plain "PENDING" | "ANSWER\t<label>"
  app.route({ method: ['GET'], url: '/ops/answer', handler: async (req, reply) => {
    if (!authed(req)) return reply.code(403).type('text/plain').send('FORBIDDEN');
    const id = okId(req.query.id);
    const { rows } = await q('SELECT value FROM app_config WHERE key = $1', [`ask_answer_${id}`]);
    if (!rows[0]) return reply.type('text/plain; charset=utf-8').send('PENDING');
    let v = {};
    try { v = JSON.parse(rows[0].value); } catch { v = {}; }
    let label = '';
    if (v.text != null) {
      label = v.text; // free-text reply
    } else if (v.choice != null) {
      // choice is an index into ask_opts_<id>
      const { rows: o } = await q('SELECT value FROM app_config WHERE key = $1', [`ask_opts_${id}`]);
      let opts = [];
      try { opts = JSON.parse(o[0] ? o[0].value : '[]'); } catch { opts = []; }
      const idx = Number(v.choice);
      label = Number.isInteger(idx) && opts[idx] != null ? opts[idx] : String(v.choice);
    }
    if (String(req.query.consume || '') === '1') {
      await q('DELETE FROM app_config WHERE key IN ($1, $2)', [`ask_answer_${id}`, `ask_opts_${id}`]);
    }
    return reply.type('text/plain; charset=utf-8').send(`ANSWER\t${label}`);
  } });
}
