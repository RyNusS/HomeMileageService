import React, { useEffect, useState, useCallback } from 'react';
import { api, getToken, setToken } from './api.js';
import Login from './pages/Login.jsx';
import ChildHome from './pages/ChildHome.jsx';
import ParentHome from './pages/ParentHome.jsx';

export default function App() {
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(Boolean(getToken()));

  const refreshMe = useCallback(async () => {
    if (!getToken()) { setMe(null); setLoading(false); return; }
    try {
      const u = await api('GET', '/api/me');
      setMe(u);
    } catch {
      setToken(null); setMe(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => { refreshMe(); }, [refreshMe]);

  const logout = () => { setToken(null); setMe(null); };

  if (loading) return <div className="notice">불러오는 중...</div>;
  if (!me) return <Login onLogin={refreshMe} />;
  return me.role === 'child'
    ? <ChildHome me={me} refreshMe={refreshMe} logout={logout} />
    : <ParentHome me={me} refreshMe={refreshMe} logout={logout} />;
}
