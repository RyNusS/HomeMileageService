// super_admin: family group management
import React, { useEffect, useState, useCallback } from 'react';
import { api, t } from '../api.js';
import { toast } from '../toast.jsx';
import SettingsModal from '../settings.jsx';

export default function AdminHome({ me, refreshMe, logout }) {
  const [families, setFamilies] = useState([]);
  const [open, setOpen] = useState(null);       // family id expanded
  const [members, setMembers] = useState({});   // familyId -> users
  const [mode, setMode] = useState(null);       // {type:'newFam'|'renameFam'|'newUser'|'resetPw', ...}
  const [f, setF] = useState({});
  const [busy, setBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const load = useCallback(async () => {
    setFamilies(await api('GET', '/api/admin/families'));
  }, []);
  useEffect(() => { load(); }, [load]);

  const loadMembers = async (fid) => {
    const users = await api('GET', `/api/admin/families/${fid}/users`);
    setMembers((m) => ({ ...m, [fid]: users }));
  };

  const toggleOpen = async (fid) => {
    if (open === fid) { setOpen(null); return; }
    setOpen(fid);
    await loadMembers(fid);
  };

  const close = () => { setMode(null); setF({}); };

  const removeFamily = async (fam) => {
    if (!window.confirm(`'${fam.name}' 가족을 삭제할까요?\n구성원 계정과 모든 기록이 함께 삭제되며 되돌릴 수 없어요.`)) return;
    if (!window.confirm('정말 삭제할까요? 이 작업은 취소할 수 없어요.')) return;
    try {
      await api('DELETE', `/api/admin/families/${fam.id}`);
      toast(`'${fam.name}' 가족을 삭제했어요`);
      if (open === fam.id) setOpen(null);
      await load();
    } catch (ex) { toast(t(ex.message), 'error'); }
  };

  const removeUser = async (fid, u) => {
    if (!window.confirm(`'${u.name}' 계정을 비활성화할까요?`)) return;
    try {
      await api('DELETE', `/api/admin/users/${u.id}`);
      toast(`${u.name} 계정을 비활성화했어요`);
      await loadMembers(fid); await load();
    } catch (ex) { toast(t(ex.message), 'error'); }
  };

  const run = async () => {
    setBusy(true);
    try {
      if (mode.type === 'newFam') {
        await api('POST', '/api/admin/families', { name: f.name });
        toast(`'${f.name}' 가족을 추가했어요`);
      } else if (mode.type === 'renameFam') {
        await api('PATCH', `/api/admin/families/${mode.fam.id}`, { name: f.name });
        toast('가족 이름을 변경했어요');
      } else if (mode.type === 'newUser') {
        await api('POST', `/api/admin/families/${mode.fam.id}/users`, {
          login_id: f.login_id, name: f.name, role: f.role || 'parent', secret: f.secret,
        });
        toast(`${f.name} 계정을 만들었어요`);
        await loadMembers(mode.fam.id);
      } else if (mode.type === 'resetPw') {
        await api('POST', `/api/admin/users/${mode.user.id}/reset-secret`, { secret: f.secret });
        toast(`${mode.user.name}의 비밀번호를 재설정했어요`);
      }
      close(); await load();
    } catch (ex) { toast(t(ex.message), 'error'); }
    setBusy(false);
  };

  const roleLabel = { parent: '부모', child: '자녀', super_admin: '관리자' };

  return (
    <>
      <div className="topbar">
        <div>
          <h1>가족그룹 관리 🛠️</h1>
          <div className="who">{me.name} (관리자)</div>
        </div>
        <div className="actions">
          <button onClick={() => setShowSettings(true)}>⚙️ 설정</button>
          <button onClick={logout}>로그아웃</button>
        </div>
      </div>
      <div className="content">
        <div className="section-title">가족 그룹 {families.length}개</div>
        {families.map((fam) => (
          <div className="card" key={fam.id}>
            <div className="row" style={{ borderBottom: open === fam.id ? '1px solid var(--line)' : 'none' }}>
              <div className="main" onClick={() => toggleOpen(fam.id)} style={{ cursor: 'pointer' }}>
                <div className="name">{open === fam.id ? '▾' : '▸'} {fam.name}</div>
                <div className="meta">구성원 {fam.member_count}명</div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="small ghost" onClick={() => { setMode({ type: 'renameFam', fam }); setF({ name: fam.name }); }}>이름</button>
                <button className="small ghost" onClick={() => { setMode({ type: 'newUser', fam }); setF({ role: 'parent' }); }}>+계정</button>
                <button className="small danger" onClick={() => removeFamily(fam)}>삭제</button>
              </div>
            </div>
            {open === fam.id && (members[fam.id] || []).map((u) => (
              <div className="row" key={u.id}>
                <div className="main">
                  <div className="name" style={{ opacity: u.active ? 1 : 0.4 }}>
                    {u.role === 'parent' ? '👤' : '🧒'} {u.name}
                  </div>
                  <div className="meta">
                    @{u.login_id} · {roleLabel[u.role]} · {u.balance.toLocaleString()}P{u.active ? '' : ' · 비활성'}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="small ghost" onClick={() => { setMode({ type: 'resetPw', user: u }); setF({}); }}>비밀번호</button>
                  {u.active && <button className="small danger" onClick={() => removeUser(fam.id, u)}>비활성</button>}
                </div>
              </div>
            ))}
          </div>
        ))}
        <button className="primary" onClick={() => { setMode({ type: 'newFam' }); setF({}); }}>+ 가족 추가</button>
      </div>
      {showSettings && <SettingsModal me={me} refreshMe={refreshMe} onClose={() => setShowSettings(false)} />}
      {mode && (
        <div className="modal-bg" onClick={close}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>{mode.type === 'newFam' ? '가족 추가'
                : mode.type === 'renameFam' ? '가족 이름 변경'
                : mode.type === 'newUser' ? `${mode.fam.name}에 계정 추가`
                : `${mode.user.name} 비밀번호 재설정`}</h3>
              <button className="modal-close" onClick={close}>✕</button>
            </div>
            {(mode.type === 'newFam' || mode.type === 'renameFam') && (<>
              <label className="fld">가족 이름</label>
              <input value={f.name || ''} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="예: A가족" />
            </>)}
            {mode.type === 'newUser' && (<>
              <label className="fld">역할</label>
              <select value={f.role || 'parent'} onChange={(e) => setF({ ...f, role: e.target.value })}>
                <option value="parent">부모</option>
                <option value="child">자녀</option>
              </select>
              <label className="fld">이름</label>
              <input value={f.name || ''} onChange={(e) => setF({ ...f, name: e.target.value })} />
              <label className="fld">아이디 (영문/숫자)</label>
              <input value={f.login_id || ''} autoCapitalize="none" onChange={(e) => setF({ ...f, login_id: e.target.value })} />
              <label className="fld">{f.role === 'child' ? 'PIN (숫자 4~6자리)' : '비밀번호 (6자 이상)'}</label>
              <input type="password" value={f.secret || ''} onChange={(e) => setF({ ...f, secret: e.target.value })} />
            </>)}
            {mode.type === 'resetPw' && (<>
              <label className="fld">새 비밀번호/PIN</label>
              <input type="password" value={f.secret || ''} onChange={(e) => setF({ ...f, secret: e.target.value })} />
            </>)}
            <div className="btn-row">
              <button className="primary" disabled={busy} onClick={run}>확인</button>
              <button className="cancel" onClick={close}>취소</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
