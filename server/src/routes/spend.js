// spend: buy (auto-deduct) -> vouchers (stock) or cash payout; consume vouchers FIFO
import { q, tx } from '../db.js';
import { notifyFamily, voucherUseKeyboard } from '../telegram.js';
import { pushToUser, pushToParents } from '../push.js';
import { decideVoucherUseRequest, listVoucherUseRequests } from '../voucherService.js';

export async function spendRoutes(app) {
  // purchase
  app.post('/orders', { onRequest: app.authRequired }, async (req, reply) => {
    const catalogId = Number(req.body && req.body.catalog_id);
    const qty = Number(req.body && req.body.qty) || 1;
    if (!catalogId || !Number.isInteger(qty) || qty < 1 || qty > 20) {
      return reply.code(400).send({ error: 'bad_fields' });
    }

    const result = await tx(async (c) => {
      const cat = await c.query(
        `SELECT id, name, kind, unit_minutes, unit_label, price_points
         FROM spend_catalog WHERE id = $1 AND family_id = $2 AND active`,
        [catalogId, req.user.family_id]);
      const item = cat.rows[0];
      if (!item) return { code: 404, error: 'catalog_not_found' };

      const total = item.price_points * qty;
      const u = await c.query(
        `SELECT balance_cache FROM app_user WHERE id = $1 FOR UPDATE`, [req.user.sub]);
      if (u.rows[0].balance_cache < total) return { code: 400, error: 'insufficient_balance' };

      const status = item.kind === 'cash' ? 'payout_pending' : 'fulfilled';
      const ord = await c.query(
        `INSERT INTO spend_order (family_id, user_id, catalog_id, kind, qty, total_points, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [req.user.family_id, req.user.sub, item.id, item.kind, qty, total, status]);
      const orderId = ord.rows[0].id;

      await c.query(
        `INSERT INTO ledger_entry (family_id, user_id, amount, source_type, source_id, memo)
         VALUES ($1, $2, $3, 'spend', $4, $5)`,
        [req.user.family_id, req.user.sub, -total, orderId, `${item.name} x${qty}`]);
      await c.query(
        `UPDATE app_user SET balance_cache = balance_cache - $1 WHERE id = $2`,
        [total, req.user.sub]);

      if (item.kind === 'time_voucher') {
        for (let i = 0; i < qty; i += 1) {
          await c.query(
            `INSERT INTO voucher (family_id, order_id, user_id, catalog_id, label, total_minutes, remaining_minutes)
             VALUES ($1, $2, $3, $4, $5, $6, $6)`,
            [req.user.family_id, orderId, req.user.sub, item.id, item.name, item.unit_minutes]);
        }
      }
      return { orderId: Number(orderId), status, total, name: item.name, kind: item.kind };
    });

    if (result.error) return reply.code(result.code).send({ error: result.error });
    if (result.kind === 'cash') {
      const who = await q('SELECT name FROM app_user WHERE id = $1', [req.user.sub]);
      notifyFamily(req.user.family_id,
        `[HMS] ${who.rows[0].name} 용돈 교환 신청: ${result.name} (-${result.total}P) — 현금 지급 후 정산완료 처리해 주세요`,
        req.log);
      pushToParents(req.user.family_id, {
        title: '용돈 교환 신청 💰',
        body: `${who.rows[0].name} · ${result.name} (-${result.total}P) — 현금 지급 후 정산해 주세요`,
      }, req.log);
    }
    return result;
  });

  // list orders (child: own, parent: family)
  app.get('/orders', { onRequest: app.authRequired }, async (req) => {
    const mineOnly = req.user.role === 'child';
    const params = [req.user.family_id];
    let where = 'o.family_id = $1';
    if (mineOnly) { params.push(req.user.sub); where += ` AND o.user_id = $${params.length}`; }
    if (req.query.status) { params.push(req.query.status); where += ` AND o.status = $${params.length}`; }
    params.push(100);
    const { rows } = await q(
      `SELECT o.id, o.user_id, u.name AS user_name, c.name AS item_name,
              o.kind, o.qty, o.total_points, o.status, o.created_at, o.settled_at
       FROM spend_order o
       JOIN app_user u ON u.id = o.user_id
       JOIN spend_catalog c ON c.id = o.catalog_id
       WHERE ${where}
       ORDER BY o.id DESC LIMIT $${params.length}`, params);
    return rows.map((r) => ({ ...r, id: Number(r.id), user_id: Number(r.user_id) }));
  });

  // parent settles cash payout
  app.post('/orders/:id/settle', { onRequest: app.parentOnly }, async (req, reply) => {
    const { rows } = await q(
      `UPDATE spend_order SET status = 'settled', settled_by = $1, settled_at = now()
       WHERE id = $2 AND family_id = $3 AND status = 'payout_pending'
       RETURNING user_id`,
      [req.user.sub, req.params.id, req.user.family_id]);
    if (!rows[0]) return reply.code(404).send({ error: 'not_found_or_not_pending' });
    pushToUser(rows[0].user_id, {
      title: '용돈 정산 완료 💰',
      body: '용돈이 현금으로 지급되었어요',
    }, req.log);
    return { ok: true };
  });

  // my vouchers (+ total remaining)
  app.get('/vouchers', { onRequest: app.authRequired }, async (req) => {
    const userId = req.user.role === 'child' ? req.user.sub : (req.query.user_id || req.user.sub);
    const { rows } = await q(
      `SELECT v.id, v.label, v.total_minutes, v.remaining_minutes, v.status, v.created_at,
              COALESCE(sc.use_approval, TRUE) AS use_approval
       FROM voucher v
       LEFT JOIN spend_catalog sc ON sc.id = v.catalog_id
       WHERE v.user_id = $1 AND v.family_id = $2
       ORDER BY v.status = 'active' DESC, v.id DESC LIMIT 200`,
      [userId, req.user.family_id]);
    const remaining = rows
      .filter((r) => r.status === 'active')
      .reduce((s, r) => s + r.remaining_minutes, 0);
    return {
      remaining_minutes: remaining,
      vouchers: rows.map((r) => ({ ...r, id: Number(r.id) })),
    };
  });

  // voucher usage history — 사용권을 언제 몇 분 썼는지 (최근 30일)
  // 분 단위 FIFO 차감(/vouchers/consume)은 1분짜리 기록이 많이 쌓이므로
  // 사용권×날짜(Asia/Seoul) 단위로 묶어 합산해서 돌려준다.
  app.get('/vouchers/usage', { onRequest: app.authRequired }, async (req) => {
    const userId = req.user.role === 'child' ? req.user.sub : (req.query.user_id || req.user.sub);
    const { rows } = await q(
      `SELECT v.id AS voucher_id, v.label, v.total_minutes,
              (vu.used_at AT TIME ZONE 'Asia/Seoul')::date AS used_date,
              MIN(vu.used_at) AS first_used_at,
              SUM(vu.used_minutes)::int AS used_minutes
       FROM voucher_usage vu
       JOIN voucher v ON v.id = vu.voucher_id
       WHERE v.user_id = $1 AND v.family_id = $2
         AND vu.used_at >= now() - interval '30 days'
       GROUP BY v.id, v.label, v.total_minutes, used_date
       ORDER BY first_used_at DESC LIMIT 100`,
      [userId, req.user.family_id]);
    return rows.map((r) => ({ ...r, voucher_id: Number(r.voucher_id) }));
  });

  // use one voucher entirely (consume its remaining minutes)
  // 상점 항목이 use_approval이면 바로 소진하지 않고 '사용 신청'을 만들어 부모 승인 대기로 보낸다.
  // (휴대폰/게임기는 서버가 강제할 수 없어 부모가 패밀리링크 등에서 시간을 넣어준 뒤 승인)
  app.post('/vouchers/:id/use', { onRequest: app.authRequired }, async (req, reply) => {
    const result = await tx(async (c) => {
      const { rows } = await c.query(
        `SELECT v.id, v.label, v.remaining_minutes,
                COALESCE(sc.use_approval, TRUE) AS use_approval
         FROM voucher v
         LEFT JOIN spend_catalog sc ON sc.id = v.catalog_id
         WHERE v.id = $1 AND v.user_id = $2 AND v.family_id = $3 AND v.status = 'active'
         FOR UPDATE OF v`,
        [req.params.id, req.user.sub, req.user.family_id]);
      const v = rows[0];
      if (!v) return { code: 404, error: 'not_found' };

      if (v.use_approval) {
        const dup = await c.query(
          `SELECT id FROM voucher_use_request WHERE voucher_id = $1 AND status = 'pending'`,
          [v.id]);
        if (dup.rows[0]) return { code: 409, error: 'already_requested' };
        const ins = await c.query(
          `INSERT INTO voucher_use_request (family_id, user_id, voucher_id, minutes)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [req.user.family_id, req.user.sub, v.id, v.remaining_minutes]);
        return {
          pending: true, requestId: Number(ins.rows[0].id),
          used: v.remaining_minutes, label: v.label,
        };
      }

      await c.query(
        `UPDATE voucher SET remaining_minutes = 0, status = 'consumed' WHERE id = $1`, [v.id]);
      await c.query(
        `INSERT INTO voucher_usage (voucher_id, used_minutes) VALUES ($1, $2)`,
        [v.id, v.remaining_minutes]);
      return { used: v.remaining_minutes, label: v.label };
    });
    if (result.error) return reply.code(result.code).send(result);

    const who = await q('SELECT name FROM app_user WHERE id = $1', [req.user.sub]);
    if (result.pending) {
      notifyFamily(req.user.family_id,
        `[HMS] 🎟️ ${who.rows[0].name} 사용권 사용 신청\n${result.label} ${result.used}분 — 시간을 넣어준 뒤 승인해 주세요`,
        req.log, voucherUseKeyboard(result.requestId));
      pushToParents(req.user.family_id, {
        title: '사용권 사용 신청 🎟️',
        body: `${who.rows[0].name} · ${result.label} ${result.used}분 — 시간을 넣어준 뒤 승인해 주세요`,
      }, req.log);
      return { pending: true, id: result.requestId, minutes: result.used };
    }

    notifyFamily(req.user.family_id,
      `[HMS] 🎟️ ${who.rows[0].name} 사용권 사용\n${result.label} ${result.used}분 (지금부터)`,
      req.log);
    pushToParents(req.user.family_id, {
      title: '사용권 사용 🎟️',
      body: `${who.rows[0].name} · ${result.label} ${result.used}분 (지금부터)`,
    }, req.log);
    return { used: result.used };
  });

  // 사용권 사용 신청 목록 (자녀: 본인 것, 부모: 가족 전체)
  app.get('/voucher-requests', { onRequest: app.authRequired }, async (req) => (
    listVoucherUseRequests({
      familyId: req.user.family_id,
      userId: req.user.role === 'child' ? req.user.sub : null,
      status: req.query.status,
    })
  ));

  // 자녀가 대기 중인 신청을 취소
  app.delete('/voucher-requests/:id', { onRequest: app.authRequired }, async (req, reply) => {
    const { rowCount } = await q(
      `DELETE FROM voucher_use_request
       WHERE id = $1 AND user_id = $2 AND family_id = $3 AND status = 'pending'`,
      [req.params.id, req.user.sub, req.user.family_id]);
    if (!rowCount) return reply.code(404).send({ error: 'not_found_or_decided' });
    return { ok: true };
  });

  async function decideUse(req, reply, approve) {
    const result = await decideVoucherUseRequest({
      requestId: req.params.id,
      familyId: req.user.family_id,
      deciderId: req.user.sub,
      approve,
    }, req.log);
    if (result.error) return reply.code(result.code).send({ error: result.error });
    return { ok: true, minutes: result.used };
  }
  app.post('/voucher-requests/:id/approve', { onRequest: app.parentOnly },
    (req, reply) => decideUse(req, reply, true));
  app.post('/voucher-requests/:id/reject', { onRequest: app.parentOnly },
    (req, reply) => decideUse(req, reply, false));

  // consume minutes FIFO across active vouchers (partial use / batch use)
  // 옵션(외부 세션 클라이언트용):
  //   silent=true — 부모 알림 생략 (세션 중 분 단위 차감 시 알림 폭주 방지)
  //   note        — 알림 문구 커스텀 (예: "PC 사용 시작 — 30분 예약"). note가 있으면 silent보다 우선.
  app.post('/vouchers/consume', { onRequest: app.authRequired }, async (req, reply) => {
    const minutes = Number(req.body && req.body.minutes);
    const silent = !!(req.body && req.body.silent);
    const note = req.body && req.body.note ? String(req.body.note).slice(0, 120) : null;
    if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 24 * 60) {
      return reply.code(400).send({ error: 'bad_minutes' });
    }
    const result = await tx(async (c) => {
      const { rows } = await c.query(
        `SELECT id, remaining_minutes FROM voucher
         WHERE user_id = $1 AND family_id = $2 AND status = 'active'
         ORDER BY id FOR UPDATE`,
        [req.user.sub, req.user.family_id]);
      const available = rows.reduce((s, r) => s + r.remaining_minutes, 0);
      if (available < minutes) return { code: 400, error: 'insufficient_vouchers', available };

      let left = minutes;
      for (const v of rows) {
        if (left <= 0) break;
        const use = Math.min(v.remaining_minutes, left);
        left -= use;
        const rem = v.remaining_minutes - use;
        await c.query(
          `UPDATE voucher SET remaining_minutes = $1, status = $2 WHERE id = $3`,
          [rem, rem === 0 ? 'consumed' : 'active', v.id]);
        await c.query(
          `INSERT INTO voucher_usage (voucher_id, used_minutes) VALUES ($1, $2)`,
          [v.id, use]);
      }
      return { used: minutes, remaining: available - minutes };
    });
    if (result.error) return reply.code(result.code).send(result);
    if (note || !silent) {
      const who2 = await q('SELECT name FROM app_user WHERE id = $1', [req.user.sub]);
      const text = note
        ? `[HMS] 🖥️ ${who2.rows[0].name} ${note} (잔여 ${result.remaining}분)`
        : `[HMS] 🎟️ ${who2.rows[0].name} 사용권 사용\n${result.used}분 (지금부터, 잔여 ${result.remaining}분)`;
      notifyFamily(req.user.family_id, text, req.log);
      pushToParents(req.user.family_id, {
        title: '사용권 사용 🎟️',
        body: note
          ? `${who2.rows[0].name} · ${note} (잔여 ${result.remaining}분)`
          : `${who2.rows[0].name} · ${result.used}분 사용 (잔여 ${result.remaining}분)`,
      }, req.log);
    }
    return result;
  });
}
