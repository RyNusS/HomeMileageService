import React, { useState } from 'react';
import { api, setToken, t } from '../api.js';

export default function Login({ onLogin }) {
  const [loginId, setLoginId] = useState('');
  const [secret, setSecret] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      const r = await api('POST', '/api/auth/login', { login_id: loginId, secret });
      setToken(r.token);
      await onLogin();
    } catch (ex) {
      setErr(t(ex.message));
    }
    setBusy(false);
  };

  return (
    <div className="login-wrap">
      <div className="logo">
        <div className="mark">🏠</div>
        <h1>홈 마일리지</h1>
        <p>우리 가족 포인트 통장</p>
      </div>
      <form onSubmit={submit}>
        <label className="fld">아이디</label>
        <input value={loginId} onChange={(e) => setLoginId(e.target.value)}
          autoCapitalize="none" autoCorrect="off" placeholder="아이디" />
        <label className="fld">비밀번호 / PIN</label>
        <input type="password" inputMode="numeric" value={secret}
          onChange={(e) => setSecret(e.target.value)} placeholder="비밀번호 또는 PIN" />
        <div style={{ height: 18 }} />
        <button className="primary" disabled={busy || !loginId || !secret}>로그인</button>
        {err && <p className="error">{err}</p>}
      </form>
    </div>
  );
}
