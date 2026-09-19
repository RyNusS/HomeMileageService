// PC 설정 화면용 순수 함수 (v1.28.0) — 표시 문구·충돌 검사·자동 맞춤
export const DAY_KO = ['일', '월', '화', '수', '목', '금', '토'];
// 월요일부터 보여준다
export const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

export const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
export const fromMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
export const fmtLen = (m) => (m % 60 === 0 ? `${m / 60}시간` : m >= 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${m}분`);

// 요일 목록 → '토·일' (월요일부터)
export function fmtDays(days) {
  const set = new Set(days);
  if (set.size === 7) return '매일';
  if (set.size === 5 && [1, 2, 3, 4, 5].every((d) => set.has(d))) return '평일';
  if (set.size === 2 && set.has(0) && set.has(6)) return '토·일';
  return DAY_ORDER.filter((d) => set.has(d)).map((d) => DAY_KO[d]).join('·');
}

// 같은 시간대끼리 묶는다: [{days:[6,0], start, end}]
export function groupWindows(wins) {
  const map = new Map();
  for (const w of wins || []) {
    const k = `${w.start}-${w.end}`;
    if (!map.has(k)) map.set(k, { days: [], start: w.start, end: w.end });
    map.get(k).days.push(w.day);
  }
  return [...map.values()].sort((a, b) => toMin(a.start) - toMin(b.start));
}

export function summarizeFree(wins) {
  const g = groupWindows(wins);
  if (!g.length) return '자유 시간 없음';
  return g.map((x) => `${fmtDays(x.days)} ${x.start}~${x.end}`).join(', ');
}

// 자유 시간과 다른 설정이 맞지 않는 곳을 찾는다.
//  - range : 자유 시간 일부가 '사용권 사용 가능 시간대' 밖
//  - max   : 자유 시간 길이가 '1회 최대 시간'보다 김
// 어느 쪽이든 자유 시간이 우선 적용되므로 동작에는 문제가 없지만, 설정을 맞춰 두면 헷갈리지 않는다.
export function findConflicts(s) {
  const as = toMin(s.allowed_start); const ae = toMin(s.allowed_end);
  const out = [];
  for (const g of groupWindows(s.free_windows)) {
    const ws = toMin(g.start); const we = toMin(g.end);
    const label = `${fmtDays(g.days)} ${g.start}~${g.end}`;
    const outside = [];
    if (ws < as) outside.push(`${g.start}~${fromMin(Math.min(we, as))}`);
    if (we > ae) outside.push(`${fromMin(Math.max(ws, ae))}~${g.end}`);
    if (outside.length) {
      out.push({ type: 'range', text: `${label} 자유 시간 중 ${outside.join(', ')}은(는) 사용 가능 시간대(${s.allowed_start}~${s.allowed_end}) 밖이에요.` });
    }
    if (we - ws > Number(s.max_session_min)) {
      out.push({ type: 'max', text: `${label} 자유 시간(${fmtLen(we - ws)})이 1회 최대 시간(${fmtLen(Number(s.max_session_min))})보다 길어요.` });
    }
  }
  return out;
}

// 충돌이 없도록 사용 가능 시간대·1회 최대 시간을 넓힌 설정
export function fixConflicts(s) {
  let as = toMin(s.allowed_start); let ae = toMin(s.allowed_end);
  let max = Number(s.max_session_min);
  for (const w of s.free_windows || []) {
    as = Math.min(as, toMin(w.start));
    ae = Math.max(ae, toMin(w.end));
    max = Math.max(max, toMin(w.end) - toMin(w.start));
  }
  return { ...s, allowed_start: fromMin(as), allowed_end: fromMin(ae), max_session_min: Math.min(1440, max) };
}
