// Account settings modal: change display name + password/PIN
import React, { useState } from 'react';
import { api, t } from './api.js';
import { toast } from './toast.jsx';

export default function SettingsModal({ me, refreshMe, onClose }) {
  const [name, setName] = useState(me.name);
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [busy, setBusy] = useState(false);

  const saveName = async () => {
    if (!name.trim() || name.trim() === me.name) return;
    setBusy(true);
    try {
      await api('PATCH', '/api/me', { name: name.trim() });
      toast('이름이 변경되었어요');
      await refreshMe();
    } catch (ex) { toast(t(ex.message), 'error'); }
    setBusy(false);
  };

  const savePw = async () => {
    if (!oldPw || !newPw) return;
    setBusy(true);
    try {
      await api('POST', '/api/auth/change-secret', { old_secret: oldPw, new_secret: newPw });
      toast(me.role === 'child' ? 'PIN이 변경되었어요' : '비밀번호가 변경되었어요');
      setOldPw(''); setNewPw('');
    } catch (ex) { toast(t(ex.message), 'error'); }
    setBusy(false);
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>내 계정 설정</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <label className="fld">이름</label>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={30} />
        <div style={{ height: 8 }} />
        <button className="small" disabled={busy || !name.trim() || name.trim() === me.name} onClick={saveName}>
          이름 변경
        </button>
        <label className="fld" style={{ marginTop: 18 }}>
          {me.role === 'child' ? '현재 PIN' : '현재 비밀번호'}
        </label>
        <input type="password" inputMode={me.role === 'child' ? 'numeric' : 'text'}
          value={oldPw} onChange={(e) => setOldPw(e.target.value)} />
        <label className="fld">{me.role === 'child' ? '새 PIN (숫자 4~6자리)' : '새 비밀번호'}</label>
        <input type="password" inputMode={me.role === 'child' ? 'numeric' : 'text'}
          value={newPw} onChange={(e) => setNewPw(e.target.value)} />
        <div style={{ height: 8 }} />
        <button className="small" disabled={busy || !oldPw || !newPw} onClick={savePw}>
          {me.role === 'child' ? 'PIN 변경' : '비밀번호 변경'}
        </button>
      </div>
    </div>
  );
}
