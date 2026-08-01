// family notice board: all roles write, text + images, delete by author or parent
import path from 'node:path';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { q } from '../db.js';
import { pushToFamily } from '../push.js';

const MAX_IMAGES = 5;

export async function noticeRoutes(app, opts) {
  const uploadDir = opts.uploadDir;

  // list (default 20/page, offset paging)
  app.get('/notices', { onRequest: app.authRequired }, async (req) => {
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const { rows } = await q(
      `SELECT n.id, n.title, n.user_id, u.name AS user_name, n.created_at
       FROM notice n JOIN app_user u ON u.id = n.user_id
       WHERE n.family_id = $1
       ORDER BY n.id DESC LIMIT $2 OFFSET $3`,
      [req.user.family_id, limit + 1, offset]);
    const hasMore = rows.length > limit;
    return {
      rows: rows.slice(0, limit).map((r) => ({
        ...r, id: Number(r.id), user_id: Number(r.user_id),
      })),
      has_more: hasMore,
    };
  });

  // latest one (한 줄 공지 표시용)
  app.get('/notices/latest', { onRequest: app.authRequired }, async (req) => {
    const { rows } = await q(
      `SELECT n.id, n.title, n.user_id, u.name AS user_name, n.created_at
       FROM notice n JOIN app_user u ON u.id = n.user_id
       WHERE n.family_id = $1
       ORDER BY n.id DESC LIMIT 1`, [req.user.family_id]);
    if (!rows[0]) return { notice: null };
    const r = rows[0];
    return { notice: { ...r, id: Number(r.id), user_id: Number(r.user_id) } };
  });

  // detail
  app.get('/notices/:id', { onRequest: app.authRequired }, async (req, reply) => {
    const { rows } = await q(
      `SELECT n.id, n.title, n.content, n.images, n.user_id, u.name AS user_name, n.created_at
       FROM notice n JOIN app_user u ON u.id = n.user_id
       WHERE n.id = $1 AND n.family_id = $2`,
      [req.params.id, req.user.family_id]);
    if (!rows[0]) return reply.code(404).send({ error: 'not_found' });
    const r = rows[0];
    return { ...r, id: Number(r.id), user_id: Number(r.user_id) };
  });

  // create (모든 계정 작성 가능) - multipart(사진 첨부) 또는 JSON
  app.post('/notices', { onRequest: app.authRequired }, async (req, reply) => {
    let title = ''; let content = ''; const images = [];

    if (req.isMultipart()) {
      const parts = req.parts();
      for await (const part of parts) {
        if (part.type === 'file' && part.fieldname === 'photos') {
          if (images.length >= MAX_IMAGES) { await part.toBuffer(); continue; }
          const ext = (path.extname(part.filename || '') || '.jpg').toLowerCase().slice(0, 8);
          const fname = `${Date.now()}_${randomBytes(6).toString('hex')}${ext}`;
          await fs.promises.writeFile(path.join(uploadDir, fname), await part.toBuffer());
          images.push(fname);
        } else if (part.type === 'field') {
          if (part.fieldname === 'title') title = String(part.value).trim().slice(0, 100);
          if (part.fieldname === 'content') content = String(part.value).slice(0, 5000);
        }
      }
    } else {
      const b = req.body || {};
      title = String(b.title || '').trim().slice(0, 100);
      content = String(b.content || '').slice(0, 5000);
    }
    if (!title) return reply.code(400).send({ error: 'title_required' });

    const { rows } = await q(
      `INSERT INTO notice (family_id, user_id, title, content, images)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [req.user.family_id, req.user.sub, title, content, images]);

    const who = await q('SELECT name FROM app_user WHERE id = $1', [req.user.sub]);
    pushToFamily(req.user.family_id, {
      title: '공지사항 등록 📢',
      body: `${who.rows[0].name} · ${title}`,
    }, req.log, req.user.sub);

    return { id: Number(rows[0].id) };
  });

  // delete (작성자 본인 또는 부모)
  app.delete('/notices/:id', { onRequest: app.authRequired }, async (req, reply) => {
    const { rows } = await q(
      `SELECT id, user_id, images FROM notice WHERE id = $1 AND family_id = $2`,
      [req.params.id, req.user.family_id]);
    if (!rows[0]) return reply.code(404).send({ error: 'not_found' });
    const isAuthor = Number(rows[0].user_id) === Number(req.user.sub);
    const isParent = req.user.role === 'parent' || req.user.role === 'super_admin';
    if (!isAuthor && !isParent) return reply.code(403).send({ error: 'forbidden' });

    await q('DELETE FROM notice WHERE id = $1', [rows[0].id]);
    for (const img of rows[0].images || []) {
      fs.promises.unlink(path.join(uploadDir, img)).catch(() => {});
    }
    return { ok: true };
  });
}
