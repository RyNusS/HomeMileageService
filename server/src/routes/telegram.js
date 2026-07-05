// Telegram webhook: inline button callbacks (approve/reject earn requests)
import { q } from '../db.js';
import { tgCall } from '../telegram.js';
import { decideEarnRequest } from '../earnService.js';

export async function telegramRoutes(app) {
  const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';

  app.post('/telegram/webhook', async (req, reply) => {
    if (!SECRET) return reply.code(404).send();
    if (req.headers['x-telegram-bot-api-secret-token'] !== SECRET) {
      return reply.code(403).send();
    }
    const update = req.body || {};
    const cb = update.callback_query;
    if (!cb || !cb.data) return { ok: true };

    // 범용 질문 응답: ask:<질문ID>:<선택지> — 부모 채팅의 버튼 선택을 app_config에 저장.
    // (원격 작업 중 부모에게 의사결정을 물을 때 사용. 조회는 서버 내부에서.)
    const ask = /^ask:([A-Za-z0-9_-]{1,40}):([A-Za-z0-9_-]{1,40})$/.exec(cb.data);
    if (ask) {
      const chatId0 = cb.message && cb.message.chat && cb.message.chat.id;
      const { rows: lk } = await q(
        'SELECT family_id FROM telegram_link WHERE chat_id = $1 LIMIT 1', [String(chatId0)]);
      if (!lk[0]) {
        await tgCall('answerCallbackQuery', {
          callback_query_id: cb.id, text: '등록되지 않은 채팅이에요', show_alert: true,
        }, req.log);
        return { ok: true };
      }
      await q(
        `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
        [`ask_answer_${ask[1]}`, JSON.stringify({ choice: ask[2], at: new Date().toISOString() })]);
      await tgCall('answerCallbackQuery', { callback_query_id: cb.id, text: '선택을 저장했어요!' }, req.log);
      if (cb.message) {
        await tgCall('editMessageText', {
          chat_id: chatId0,
          message_id: cb.message.message_id,
          text: `${cb.message.text || ''}\n\n☑️ 선택: ${ask[2]}`,
        }, req.log);
      }
      return { ok: true };
    }

    const m = /^er_(ok|no):(\d+)$/.exec(cb.data);
    if (!m) {
      await tgCall('answerCallbackQuery', { callback_query_id: cb.id }, req.log);
      return { ok: true };
    }
    const approve = m[1] === 'ok';
    const requestId = Number(m[2]);
    const chatId = cb.message && cb.message.chat && cb.message.chat.id;

    // the chat must be a registered parent chat; use its family + parent for the decision
    const { rows } = await q(
      `SELECT tl.family_id,
              COALESCE(tl.parent_user_id,
                (SELECT id FROM app_user
                 WHERE family_id = tl.family_id AND role = 'parent' AND active
                 ORDER BY id LIMIT 1)) AS decider_id
       FROM telegram_link tl WHERE tl.chat_id = $1 LIMIT 1`, [String(chatId)]);
    const link = rows[0];
    if (!link || !link.decider_id) {
      await tgCall('answerCallbackQuery', {
        callback_query_id: cb.id, text: '등록되지 않은 채팅이에요', show_alert: true,
      }, req.log);
      return { ok: true };
    }

    const result = await decideEarnRequest({
      requestId, familyId: link.family_id, deciderId: link.decider_id, approve,
    }, req.log);

    let toastText;
    if (result.ok) toastText = approve ? '승인 완료!' : '거절 처리했어요';
    else if (result.error === 'already_decided') toastText = '이미 처리된 청구예요';
    else toastText = '청구를 찾을 수 없어요';

    await tgCall('answerCallbackQuery', { callback_query_id: cb.id, text: toastText }, req.log);

    // update the original message so the buttons disappear and the result is visible
    if (cb.message) {
      const suffix = result.ok
        ? (approve ? '\n\n✅ 승인 완료' : '\n\n❌ 거절 처리됨')
        : `\n\n(${toastText})`;
      await tgCall('editMessageText', {
        chat_id: chatId,
        message_id: cb.message.message_id,
        text: (cb.message.text || '') + suffix,
        ...(process.env.PUBLIC_URL
          ? { reply_markup: { inline_keyboard: [[{ text: '🏠 앱에서 보기', url: process.env.PUBLIC_URL }]] } }
          : {}),
      }, req.log);
    }
    return { ok: true };
  });
}
