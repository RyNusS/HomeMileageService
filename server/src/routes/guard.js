// PC 가드(자녀 PC 잠금 프로그램) 관련 API
//   - 가드 이벤트 신고 → 부모 텔레그램
//   - PC 설정(가족 단위, v1.28.0): 사용 가능 시간대·1회 최대·오프라인 유예·요일별 자유 이용 시간
//   - 가드 자동 업데이트(v1.28.0): 최신 버전 정보·실행 파일 내려받기
import fs from 'node:fs';
import path from 'node:path';
import { q } from '../db.js';
import { notifyFamily } from '../telegram.js';
import { pushToParents } from '../push.js';
import { getPcSettings, savePcSettings, validatePcSettings, normHHMM } from '../pcSettings.js';

const EXE_NAME = /^[A-Za-z0-9._-]{1,80}\.exe$/;
const VERSION = /^v?\d+\.\d+\.\d+$/;

// 서버에 올려둔 최신 가드 정보 (UPLOAD_DIR/guard/latest.json). 없거나 잘못됐으면 null.
function readLatest(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'latest.json'), 'utf8'));
    if (!VERSION.test(String(j.version || '')) || !EXE_NAME.test(String(j.file || ''))
        || !/^[0-9a-f]{64}$/i.test(String(j.sha256 || ''))) return null;
    const st = fs.statSync(path.join(dir, j.file));
    return { version: j.version, file: j.file, sha256: j.sha256.toLowerCase(), size: st.size };
  } catch {
    return null;
  }
}

export async function guardRoutes(app, opts) {
  const releaseDir = path.join(opts.uploadDir || '/data/uploads', 'guard');

  // child guard reports events
  //   abnormal_exit : 비정상 종료 흔적 (강제 종료 의심)
  //   free_start    : 자유 이용 시간에 PC 사용 시작 (until: 'HH:MM')
  app.post('/guard/event', { onRequest: app.authRequired }, async (req) => {
    if (req.user.role !== 'child') return { ok: false };
    const type = String((req.body && req.body.type) || '').slice(0, 40);
    if (type !== 'abnormal_exit' && type !== 'free_start') return { ok: true };

    const { rows } = await q(
      'SELECT name FROM app_user WHERE id = $1 AND family_id = $2',
      [req.user.sub, req.user.family_id]);
    const name = rows[0]?.name || '자녀';
    if (type === 'free_start') {
      const until = normHHMM(req.body && req.body.until, { allow24: true });
      const tail = until ? ` (~${until})` : '';
      notifyFamily(req.user.family_id,
        `[HMS] 🖥️ ${name} 자유 시간에 PC 사용 시작${tail} — 사용권은 차감되지 않아요`, req.log);
      pushToParents(req.user.family_id, {
        title: '자유 시간 PC 사용 🖥️',
        body: `${name} · 자유 시간에 PC 사용 시작${tail}`,
      }, req.log);
      return { ok: true };
    }
    const when = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    const text = `⚠️ ${name} PC의 사용시간 가드가 비정상 종료된 흔적이 있어요.\n`
      + `강제로 종료됐거나 비정상 재부팅일 수 있어요. 확인해 주세요. (${when})`;
    await notifyFamily(req.user.family_id, text, req.log);
    return { ok: true };
  });

  // PC 설정 조회 — 가족 구성원 누구나 (가드는 자녀 토큰으로 읽는다)
  app.get('/pc-settings', { onRequest: app.authRequired }, async (req) => getPcSettings(req.user.family_id));

  // PC 설정 저장 — 부모만. 가족의 모든 자녀·모든 PC에 적용된다.
  app.put('/pc-settings', { onRequest: app.parentOnly }, async (req, reply) => {
    let s;
    try {
      s = validatePcSettings(req.body || {});
    } catch (err) {
      if (err.hms) return reply.code(400).send({ error: err.hms });
      throw err;
    }
    return savePcSettings(req.user.family_id, req.user.sub, s);
  });

  // 가드 자동 업데이트: 최신 버전 정보 (로그인 전에도 확인할 수 있게 인증 없음)
  app.get('/guard/update', async () => {
    const latest = readLatest(releaseDir);
    if (!latest) return { version: null };
    return { ...latest, url: `/api/guard/download/${encodeURIComponent(latest.file)}` };
  });

  // 가드 실행 파일 내려받기 — 최신 파일만 제공
  app.get('/guard/download/:file', async (req, reply) => {
    const latest = readLatest(releaseDir);
    if (!latest || req.params.file !== latest.file) return reply.code(404).send({ error: 'not_found' });
    reply.header('content-type', 'application/octet-stream');
    reply.header('content-length', latest.size);
    reply.header('content-disposition', `attachment; filename="${latest.file}"`);
    reply.header('cache-control', 'no-store');
    return reply.send(fs.createReadStream(path.join(releaseDir, latest.file)));
  });
}
