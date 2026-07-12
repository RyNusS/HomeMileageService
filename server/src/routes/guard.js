// guard client events: report abnormal guard termination -> parent Telegram
import { q } from '../db.js';
import { notifyFamily } from '../telegram.js';

export async function guardRoutes(app) {
  // child guard reports it restarted after an unclean exit (suspected force-kill)
  app.post('/guard/event', { onRequest: app.authRequired }, async (req) => {
    if (req.user.role !== 'child') return { ok: false };
    const type = String((req.body && req.body.type) || '').slice(0, 40);
    if (type !== 'abnormal_exit') return { ok: true };

    const { rows } = await q(
      'SELECT name FROM app_user WHERE id = $1 AND family_id = $2',
      [req.user.sub, req.user.family_id]);
    const name = rows[0]?.name || '자녀';
    const when = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    const text = `⚠️ ${name} PC의 사용시간 가드가 비정상 종료된 흔적이 있어요.\n`
      + `강제로 종료됐거나 비정상 재부팅일 수 있어요. 확인해 주세요. (${when})`;
    await notifyFamily(req.user.family_id, text, req.log);
    return { ok: true };
  });
}
