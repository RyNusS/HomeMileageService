// PC 가드 설정 (가족 단위) — 검증·정규화·조회 (v1.28.0)
import { q } from './db.js';

export const PC_DEFAULTS = {
  max_session_min: 60,
  allowed_start: '08:00',
  allowed_end: '21:30',
  offline_grace_min: 15,
  free_windows: [],
};

// 'H:MM' / 'HH:MM' → 'HH:MM'. 종료 시각으로는 '24:00'(자정)까지 허용한다.
export function normHHMM(v, { allow24 = false } = {}) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]); const mi = Number(m[2]);
  if (mi > 59) return null;
  if (h > 23 && !(allow24 && h === 24 && mi === 0)) return null;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

export const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

function bad(code) { return Object.assign(new Error(code), { hms: code }); }

// 부모가 보낸 설정 전체를 검증해 저장 가능한 형태로 돌려준다. 문제가 있으면 hms 코드를 가진 에러.
export function validatePcSettings(b) {
  const max = Number(b.max_session_min);
  if (!Number.isInteger(max) || max < 5 || max > 1440) throw bad('bad_pc_max_session');
  const grace = Number(b.offline_grace_min);
  if (!Number.isInteger(grace) || grace < 1 || grace > 120) throw bad('bad_pc_offline_grace');
  const as = normHHMM(b.allowed_start);
  const ae = normHHMM(b.allowed_end, { allow24: true });
  if (!as || !ae || toMin(as) >= toMin(ae)) throw bad('bad_pc_allowed_range');

  const raw = Array.isArray(b.free_windows) ? b.free_windows : [];
  if (raw.length > 50) throw bad('bad_free_window');
  const wins = raw.map((w) => {
    const day = Number(w && w.day);
    const s = normHHMM(w && w.start);
    const e = normHHMM(w && w.end, { allow24: true });
    if (!Number.isInteger(day) || day < 0 || day > 6 || !s || !e || toMin(s) >= toMin(e)) {
      throw bad('bad_free_window');
    }
    return { day, start: s, end: e };
  }).sort((x, y) => x.day - y.day || toMin(x.start) - toMin(y.start));
  for (let i = 1; i < wins.length; i += 1) {
    const p = wins[i - 1]; const c = wins[i];
    if (p.day === c.day && toMin(c.start) < toMin(p.end)) throw bad('bad_free_overlap');
  }
  return {
    max_session_min: max, allowed_start: as, allowed_end: ae,
    offline_grace_min: grace, free_windows: wins,
  };
}

export async function getPcSettings(familyId) {
  const { rows } = await q(
    `SELECT max_session_min, allowed_start, allowed_end, offline_grace_min, free_windows, updated_at
       FROM pc_settings WHERE family_id = $1`, [familyId]);
  if (!rows[0]) return { configured: false, ...PC_DEFAULTS, updated_at: null };
  const r = rows[0];
  return {
    configured: true,
    max_session_min: r.max_session_min,
    allowed_start: r.allowed_start,
    allowed_end: r.allowed_end,
    offline_grace_min: r.offline_grace_min,
    free_windows: r.free_windows || [],
    updated_at: r.updated_at,
  };
}

export async function savePcSettings(familyId, userId, s) {
  await q(
    `INSERT INTO pc_settings (family_id, max_session_min, allowed_start, allowed_end,
                              offline_grace_min, free_windows, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, now())
     ON CONFLICT (family_id) DO UPDATE SET
       max_session_min = EXCLUDED.max_session_min,
       allowed_start = EXCLUDED.allowed_start,
       allowed_end = EXCLUDED.allowed_end,
       offline_grace_min = EXCLUDED.offline_grace_min,
       free_windows = EXCLUDED.free_windows,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()`,
    [familyId, s.max_session_min, s.allowed_start, s.allowed_end,
      s.offline_grace_min, JSON.stringify(s.free_windows), userId]);
  return getPcSettings(familyId);
}
