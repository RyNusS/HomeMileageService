// earn requests: child claims -> parent approves/rejects (ledger credit)
import path from 'node:path';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { q } from '../db.js';
import { notifyFamily, earnRequestKeyboard } from '../telegram.js';
import { decideEarnRequest } from '../earnService.js';

export async function earnRoutes(app, opts) {
  const uploadDir = opts.uploadDir;

  // child submits a claim (multipart with optional photo, or plain JSON)
  app.post('/earn-requests', { onRequest: app.authRequired }, async (req, reply) => {
    let catalogId; let comment = ''; let proofPath = null;
    let sourceKind = null; let extRef = null; let meta = null;

    if (req.isMultipart()) {
      const parts = req.parts();
      for await (const part of parts) {
        if (part.type === 'file' && part.fieldname === 'photo') {
          const ext = (path.extname(part.filename || '') || '.jpg').toLowerCase().slice(0, 8);
          const fname = `${Date.now()}_${randomBytes(6).toString('hex')}${ext}`;
          const dest = path.join(uploadDir, fname);
          await fs.promises.writeFile(dest, await part.toBuffer());
          proofPath = fname;
        } else if (part.type === 'field') {
          if (part.fieldname === 'catalog_id') catalogId = Number(part.value);
          if (part.fieldname === 'comment') comment = String(part.value).slice(0, 500);
        }
      }
    } else {
      const b = req.body || {};
      catalogId = Number(b.catalog_id);
      comment = String(b.comment || '').slice(0, 500);
      // 외부 앱 청구 메타(선택): 학습 앱 등이 중복 차단용 참조를 함께 보낸다
      if (b.source_kind) sourceKind = String(b.source_kind).slice(0, 30);
      if (b.ext_ref) extRef = String(b.ext_ref).slice(0, 100);
      if (b.meta && typeof b.meta === 'object') meta = JSON.stringify(b.meta).slice(0, 2000);
    }
    if (!catalogId) return reply.code(400).send({ error: 'catalog_id_required' });

    const { rows } = await q(
      `SELECT id, name, points, proof_required FROM earn_catalog
       WHERE id = $1 AND family_id = $2 AND active`,
      [catalogId, req.user.family_id]);
    const item = rows[0];
    if (!item) return reply.code(404).send({ error: 'catalog_not_found' });
    if (item.proof_required && !proofPath) return reply.code(400).send({ error: 'proof_required' });

    let ins;
    try {
      ins = await q(
        `INSERT INTO earn_request (family_id, user_id, catalog_id, points, comment, proof_path,
                                   source_kind, ext_ref, meta)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [req.user.family_id, req.user.sub, item.id, item.points, comment, proofPath,
          sourceKind, extRef, meta]);
    } catch (err) {
      // 같은 ext_ref(학습 세트)로 이미 청구한 경우
      if (err.code === '23505') return reply.code(409).send({ error: 'duplicate_claim' });
      throw err;
    }

    const reqId = Number(ins.rows[0].id);
    const who = await q('SELECT name FROM app_user WHERE id = $1', [req.user.sub]);
    notifyFamily(req.user.family_id,
      `[HMS] ${who.rows[0].name} 적립 청구\n${item.name} +${item.points}P${comment ? `\n"${comment}"` : ''}`,
      req.log, earnRequestKeyboard(reqId));

    return { id: Number(ins.rows[0].id), status: 'pending' };
  });

  // list requests (child: own, parent: family; filter by status)
  app.get('/earn-requests', { onRequest: app.authRequired }, async (req) => {
    const status = req.query.status;
    const mineOnly = req.user.role === 'child';
    const params = [req.user.family_id];
    let where = 'r.family_id = $1';
    if (mineOnly) { params.push(req.user.sub); where += ` AND r.user_id = $${params.length}`; }
    if (status) { params.push(status); where += ` AND r.status = $${params.length}`; }
    params.push(100);
    const { rows } = await q(
      `SELECT r.id, r.user_id, u.name AS user_name, c.name AS item_name,
              r.points, r.comment, r.proof_path, r.status, r.created_at, r.decided_at
       FROM earn_request r
       JOIN app_user u ON u.id = r.user_id
       JOIN earn_catalog c ON c.id = r.catalog_id
       WHERE ${where}
       ORDER BY r.id DESC LIMIT $${params.length}`, params);
    return rows.map((r) => ({ ...r, id: Number(r.id), user_id: Number(r.user_id) }));
  });

  // child cancels own pending claim
  app.delete('/earn-requests/:id', { onRequest: app.authRequired }, async (req, reply) => {
    const { rowCount } = await q(
      `DELETE FROM earn_request
       WHERE id = $1 AND user_id = $2 AND family_id = $3 AND status = 'pending'`,
      [req.params.id, req.user.sub, req.user.family_id]);
    if (!rowCount) return reply.code(404).send({ error: 'not_found_or_decided' });
    return { ok: true };
  });

  async function decide(req, reply, approve) {
    const result = await decideEarnRequest({
      requestId: req.params.id,
      familyId: req.user.family_id,
      deciderId: req.user.sub,
      approve,
    }, req.log);
    if (result.error) return reply.code(result.code).send({ error: result.error });
    return { ok: true };
  }

  app.post('/earn-requests/:id/approve', { onRequest: app.parentOnly },
    (req, reply) => decide(req, reply, true));
  app.post('/earn-requests/:id/reject', { onRequest: app.parentOnly },
    (req, reply) => decide(req, reply, false));
}
