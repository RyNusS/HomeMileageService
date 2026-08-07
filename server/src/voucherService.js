// 사용권 사용 신청(voucher_use_request) 승인/거절 — 웹(부모 승인 탭)과 텔레그램 버튼이 공유한다.
// 휴대폰/게임기처럼 서버가 강제로 막을 수 없는 기기는 부모가 실제로 시간을 넣어준 뒤
// 승인을 누르고, 그 시점에 사용권이 차감된다(= 장부와 현실을 맞춘다).
import { q, tx } from './db.js';
import { pushToUser } from './push.js';

export async function decideVoucherUseRequest({ requestId, familyId, deciderId, approve }, log) {
  const result = await tx(async (c) => {
    const { rows } = await c.query(
      `SELECT id, user_id, voucher_id FROM voucher_use_request
       WHERE id = $1 AND family_id = $2 AND status = 'pending' FOR UPDATE`,
      [requestId, familyId]);
    const r = rows[0];
    if (!r) return { code: 404, error: 'not_found_or_decided' };

    const { rows: vs } = await c.query(
      `SELECT id, label, remaining_minutes, status FROM voucher
       WHERE id = $1 AND family_id = $2 FOR UPDATE`,
      [r.voucher_id, familyId]);
    const v = vs[0];

    if (!approve) {
      await c.query(
        `UPDATE voucher_use_request SET status = 'rejected', decided_by = $1, decided_at = now()
         WHERE id = $2`, [deciderId, r.id]);
      return { ok: true, approve: false, userId: r.user_id, label: v ? v.label : '사용권', used: 0 };
    }

    // 승인 도중 사용권이 이미 소진된 경우(가드 프로그램 등) — 신청을 닫고 알린다
    if (!v || v.status !== 'active' || v.remaining_minutes <= 0) {
      await c.query(
        `UPDATE voucher_use_request SET status = 'rejected', decided_by = $1, decided_at = now()
         WHERE id = $2`, [deciderId, r.id]);
      return { code: 409, error: 'voucher_not_active' };
    }

    const used = v.remaining_minutes;
    await c.query(
      `UPDATE voucher SET remaining_minutes = 0, status = 'consumed' WHERE id = $1`, [v.id]);
    await c.query(
      `INSERT INTO voucher_usage (voucher_id, used_minutes) VALUES ($1, $2)`, [v.id, used]);
    await c.query(
      `UPDATE voucher_use_request
       SET status = 'approved', minutes = $1, decided_by = $2, decided_at = now()
       WHERE id = $3`, [used, deciderId, r.id]);
    return { ok: true, approve: true, userId: r.user_id, label: v.label, used };
  });

  if (result.error) return result;

  pushToUser(result.userId, result.approve
    ? { title: '사용권 사용 승인 ✅', body: `${result.label} ${result.used}분 — 지금부터 사용할 수 있어요` }
    : { title: '사용권 사용 거절 ❌', body: `${result.label} 사용 신청이 거절됐어요 (사용권은 그대로 있어요)` },
  log);

  return result;
}

// 부모/자녀 화면에서 쓰는 목록 조회 (자녀는 본인 것만)
export async function listVoucherUseRequests({ familyId, userId, status }) {
  const params = [familyId];
  let where = 'r.family_id = $1';
  if (userId) { params.push(userId); where += ` AND r.user_id = $${params.length}`; }
  if (status) { params.push(status); where += ` AND r.status = $${params.length}`; }
  params.push(50);
  const { rows } = await q(
    `SELECT r.id, r.user_id, u.name AS user_name, r.voucher_id, v.label,
            r.minutes, r.status, r.created_at, r.decided_at
     FROM voucher_use_request r
     JOIN app_user u ON u.id = r.user_id
     JOIN voucher v ON v.id = r.voucher_id
     WHERE ${where}
     ORDER BY r.id DESC LIMIT $${params.length}`, params);
  return rows.map((r) => ({
    ...r, id: Number(r.id), user_id: Number(r.user_id), voucher_id: Number(r.voucher_id),
  }));
}
