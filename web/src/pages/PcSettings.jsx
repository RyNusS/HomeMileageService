// 부모: PC 사용 설정 (가족 전체 자녀·모든 PC에 적용, v1.28.0)
//  - 사용권으로 쓸 때: 사용 가능 시간대 · 1회 최대 시간 · 오프라인 유예
//  - 요일별 자유 이용 시간: 로그인만 하면 사용권 차감 없이 사용 (위 제한보다 우선)
import React, { useCallback, useEffect, useState } from 'react';
import { api, t } from '../api.js';
import { toast } from '../toast.jsx';
import {
  DAY_KO, DAY_ORDER, fmtDays, fmtLen, groupWindows, summarizeFree,
  findConflicts, fixConflicts, toMin,
} from '../pcSettingsLogic.js';

// <input type="time"> 는 24:00을 못 쓰므로 종료 00:00 = 자정(24:00)으로 취급
const endIn = (v) => (v === '00:00' ? '24:00' : v);
const endOut = (v) => (v === '24:00' ? '00:00' : v);

export function PcSettingsCard() {
  const [s, setS] = useState(null);
  const [open, setOpen] = useState(false);
  const load = useCallback(async () => {
    try { setS(await api('GET', '/api/pc-settings')); } catch { /* 카드만 비움 */ }
  }, []);
  useEffect(() => { load(); }, [load]);
  if (!s) return null;
  return (<>
    <div className="card">
      <h3>💻 PC 사용 설정</h3>
      <div className="row tappable" onClick={() => setOpen(true)}>
        <div className="main">
          <div className="name">🎉 {summarizeFree(s.free_windows)}</div>
          <div className="meta">
            사용권: {s.allowed_start}~{s.allowed_end} · 1회 최대 {fmtLen(s.max_session_min)}
            {!s.configured && ' · 아직 저장 전'}
          </div>
        </div>
        <span className="chev">›</span>
      </div>
      <div className="hint" style={{ marginTop: 6, marginBottom: 0 }}>
        모든 자녀 계정과 모든 PC에 똑같이 적용돼요.
      </div>
    </div>
    {open && <PcSettingsModal initial={s} onClose={() => setOpen(false)} onSaved={(ns) => { setS(ns); setOpen(false); }} />}
  </>);
}

function PcSettingsModal({ initial, onClose, onSaved }) {
  const [f, setF] = useState({
    allowed_start: initial.allowed_start,
    allowed_end: initial.allowed_end,
    max_session_min: String(initial.max_session_min),
    offline_grace_min: String(initial.offline_grace_min),
    free_windows: initial.free_windows || [],
  });
  const [add, setAdd] = useState({ days: [6, 0], start: '07:00', end: '09:00' });
  const [conflicts, setConflicts] = useState(null);
  const [busy, setBusy] = useState(false);

  const body = (x) => ({
    allowed_start: x.allowed_start,
    allowed_end: x.allowed_end,
    max_session_min: Number(x.max_session_min),
    offline_grace_min: Number(x.offline_grace_min),
    free_windows: x.free_windows,
  });

  const addWindow = () => {
    const end = endIn(add.end);
    if (!add.days.length) { toast('요일을 하나 이상 골라 주세요', 'error'); return; }
    if (!add.start || !add.end || toMin(add.start) >= toMin(end)) {
      toast('끝나는 시각이 시작 시각보다 늦어야 해요', 'error'); return;
    }
    const clash = add.days.find((d) => f.free_windows.some((w) => w.day === d
      && toMin(add.start) < toMin(w.end) && toMin(w.start) < toMin(end)));
    if (clash !== undefined) {
      toast(`${DAY_KO[clash]}요일에 이미 겹치는 자유 시간이 있어요`, 'error'); return;
    }
    setF({ ...f, free_windows: [...f.free_windows, ...add.days.map((d) => ({ day: d, start: add.start, end }))] });
  };

  const removeGroup = (g) => setF({
    ...f,
    free_windows: f.free_windows.filter((w) => !(w.start === g.start && w.end === g.end && g.days.includes(w.day))),
  });

  const doSave = async (x) => {
    setBusy(true);
    try {
      const saved = await api('PUT', '/api/pc-settings', body(x));
      toast('PC 사용 설정을 저장했어요. 각 PC에 곧 적용돼요');
      onSaved(saved);
    } catch (ex) { toast(t(ex.message), 'error'); }
    setBusy(false);
  };

  const trySave = () => {
    const x = body(f);
    if (!Number.isInteger(x.max_session_min) || x.max_session_min < 5 || x.max_session_min > 1440) {
      toast(t('bad_pc_max_session'), 'error'); return;
    }
    if (!x.allowed_start || !x.allowed_end || toMin(x.allowed_start) >= toMin(endIn(x.allowed_end))) {
      toast(t('bad_pc_allowed_range'), 'error'); return;
    }
    const c = findConflicts({ ...x, allowed_end: endIn(x.allowed_end) });
    if (c.length) { setConflicts(c); return; }
    doSave({ ...f, allowed_end: endIn(f.allowed_end) });
  };

  const fixed = conflicts ? fixConflicts({ ...body(f), allowed_end: endIn(f.allowed_end) }) : null;

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" style={{ maxHeight: '90vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>💻 PC 사용 설정</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        {conflicts ? (<>
          <div className="pc-warn">
            <div className="pc-warn-title">⚠️ 설정끼리 맞지 않는 부분이 있어요</div>
            <ul>{conflicts.map((c, i) => <li key={i}>{c.text}</li>)}</ul>
            <div>
              그대로 저장해도 <b>자유 시간이 우선</b> 적용돼서 그 시간엔 문제없이 쓸 수 있어요.
              다만 설정을 맞춰 두면 나중에 헷갈리지 않아요.
            </div>
          </div>
          <div className="pc-fix">
            <b>설정 맞추기</b>를 누르면 이렇게 바뀌어요
            <ul>
              {fixed.allowed_start !== f.allowed_start || fixed.allowed_end !== endIn(f.allowed_end) ? (
                <li>사용 가능 시간대 {f.allowed_start}~{endIn(f.allowed_end)} → <b>{fixed.allowed_start}~{fixed.allowed_end}</b>
                  <div className="hint" style={{ margin: '2px 0 0' }}>
                    다른 요일에도 사용권으로 이 시간대에 쓸 수 있게 돼요.
                  </div>
                </li>
              ) : null}
              {fixed.max_session_min !== Number(f.max_session_min) ? (
                <li>1회 최대 시간 {fmtLen(Number(f.max_session_min))} → <b>{fmtLen(fixed.max_session_min)}</b></li>
              ) : null}
            </ul>
          </div>
          <div className="btn-row" style={{ flexDirection: 'column' }}>
            <button className="primary" disabled={busy} onClick={() => doSave(fixed)}>설정 맞추고 저장</button>
            <button className="cancel" disabled={busy} onClick={() => doSave({ ...f, allowed_end: endIn(f.allowed_end) })}>
              그대로 저장 (자유 시간 우선)
            </button>
            <button className="cancel" disabled={busy} onClick={() => setConflicts(null)}>돌아가서 직접 고치기</button>
          </div>
        </>) : (<>
          <div className="section-title" style={{ marginTop: 0 }}>🎉 요일별 자유 시간</div>
          <div className="hint">
            이 시간에는 PC에 로그인만 하면 사용권 없이 쓸 수 있어요. 보유한 사용권 시간은 줄어들지 않아요.
            끝나기 10·5·1분 전에 알려 주고, 끝나면 PC가 잠겨요.
          </div>
          {groupWindows(f.free_windows).map((g) => (
            <div className="row" key={`${g.start}-${g.end}`}>
              <div className="main">
                <div className="name">{fmtDays(g.days)} {g.start}~{g.end}</div>
                <div className="meta">{fmtLen(toMin(g.end) - toMin(g.start))}</div>
              </div>
              <button className="small danger" onClick={() => removeGroup(g)}>삭제</button>
            </div>
          ))}
          {!f.free_windows.length && <div className="hint">아직 자유 시간이 없어요.</div>}
          <div className="pc-add">
            <div className="day-picker">
              {DAY_ORDER.map((d) => (
                <label className="day-chip" key={d}>
                  <input type="checkbox" checked={add.days.includes(d)}
                    onChange={(e) => {
                      const cur = new Set(add.days);
                      e.target.checked ? cur.add(d) : cur.delete(d);
                      setAdd({ ...add, days: [...cur] });
                    }} /> {DAY_KO[d]}
                </label>
              ))}
            </div>
            <div className="pc-time-row">
              <input type="time" value={add.start} onChange={(e) => setAdd({ ...add, start: e.target.value })} />
              <span>~</span>
              <input type="time" value={add.end} onChange={(e) => setAdd({ ...add, end: e.target.value })} />
            </div>
            <div className="hint">끝나는 시각을 00:00으로 두면 자정까지예요.</div>
            <button className="small" onClick={addWindow}>+ 자유 시간 추가</button>
          </div>

          <div className="section-title">🎟️ 사용권으로 쓸 때</div>
          <label className="fld">사용 가능 시간대</label>
          <div className="pc-time-row">
            <input type="time" value={f.allowed_start} onChange={(e) => setF({ ...f, allowed_start: e.target.value })} />
            <span>~</span>
            <input type="time" value={endOut(f.allowed_end)} onChange={(e) => setF({ ...f, allowed_end: e.target.value })} />
          </div>
          <label className="fld">1회 최대 시간 (분)</label>
          <input inputMode="numeric" value={f.max_session_min}
            onChange={(e) => setF({ ...f, max_session_min: e.target.value.replace(/[^0-9]/g, '') })} />
          <label className="fld">인터넷 끊김 허용 (분)</label>
          <input inputMode="numeric" value={f.offline_grace_min}
            onChange={(e) => setF({ ...f, offline_grace_min: e.target.value.replace(/[^0-9]/g, '') })} />
          <div className="hint">사용권으로 쓰는 중 서버 연결이 이 시간보다 오래 끊기면 PC가 잠겨요 (우회 방지).</div>

          <div className="btn-row">
            <button className="primary" disabled={busy} onClick={trySave}>저장</button>
            <button className="cancel" onClick={onClose}>취소</button>
          </div>
        </>)}
      </div>
    </div>
  );
}
