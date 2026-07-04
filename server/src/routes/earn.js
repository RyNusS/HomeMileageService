// earn requests: child claims -> parent approves/rejects (ledger credit)
import path from 'node:path';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { q, tx } from '../db.js';
import { notifyFamily } from '../telegram.js';

export async function earnRoutes(app, opts) {
  const uploadDir = opts.uploadDir;

  // child submits a claim (multipart with optional photo, or plain JSON)
  app.post('/earn-requests', { onRequest: app.authRequired }, async (req, reply) => {
    let catalogId; let comment = ''; let proofPath = null;

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
    }
    if (!catalogId) return reply.code(400).send({ error: 'catalog_id_required' });

    const { rows } = await q(
      `SELECT id, name, points, proof_required FROM earn_catalog
       WHERE id = $1 AND family_id = $2 AND active`,
      [catalogId, req.user.family_id]);
    const item = rows[0];
    if (!item) return reply.code(404).send({ error: 'catalog_not_found' });
    if (item.proof_required && !proofPath) return reply.code(400).send({ error: 'proof_required' });

    const ins = await q(
      `INSERT INTO earn_request (family_id, user_id, catalog_id, points, comment, proof_path)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [req.user.family_id, req.user.sub, item.id, item.points, comment, proofPath]);

    const who = await q('SELECT name FROM app_user WHERE id = $1', [req.user.sub]);
    notifyFamily(req.user.family_id,
      `[HMS] ${who.rows[0].name} 적립 청구: ${item.name} +${item.points}P${comment ? ` (${comment})` : ''} — 앱에서 승인해 주세요`,
      req.log);

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

  async function decide(req, reply, approve) {
    const result = await tx(async (c) => {
      const { rows } = await c.query(
        `SELECT id, user_id, points, status FROM earn_request
         WHERE id = $1 AND family_id = $2 FOR UPDATE`,
        [req.params.id, req.user.family_id]);
      const r = rows[0];
      if (!r) return { code: 404, error: 'not_found' };
      if (r.status !== 'pending') return { code: 409, error: 'already_decided' };

      await c.query(
        `UPDATE earn_request SET status = $1, decided_by = $2, decided_at = now()
         WHERE id = $3`, [approve ? 'approved' : 'rejected', req.user.sub, r.id]);

      if (approve) {
        await c.query(
          `INSERT INTO ledger_entry (family_id, user_id, amount, source_type, source_id)
           VALUES ($1, $2, $3, 'earn', $4)`,
          [req.user.family_id, r.user_id, r.points, r.id]);
        await c.query(
          `UPDATE app_user SET balance_cache = balance_cache + $1 WHERE id = $2`,
          [r.points, r.user_id]);
      }
      return { ok: true };
    });
    if (result.error) return reply.code(result.code).send({ error: result.error });
    return result;
  }

  app.post('/earn-requests/:id/approve', { onRequest: app.parentOnly },
    (req, reply) => decide(req, reply, true));
  app.post('/earn-requests/:id/reject', { onRequest: app.parentOnly },
    (req, reply) => decide(req, reply, false));
}
