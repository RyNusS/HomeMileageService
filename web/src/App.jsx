import React, { useEffect, useState, useCallback } from 'react';
import { api, getToken, setToken } from './api.js';
import Login from './pages/Login.jsx';
import ChildHome from './pages/ChildHome.jsx';
import ParentHome from './pages/ParentHome.jsx';
import AdminHome from './pages/AdminHome.jsx';
import { ToastHost } from './toast.jsx';
import { initNativePush } from './pushClient.js';

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
  useEffect(() => { if (me) initNativePush(); }, [me]);

  const logout = () => { setToken(null); setMe(null); };

  if (loading) return <div className="notice">불러오는 중...</div>;
  let body;
  if (!me) body = <Login onLogin={refreshMe} />;
  else if (me.role === 'child') body = <ChildHome me={me} refreshMe={refreshMe} logout={logout} />;
  else if (me.role === 'super_admin') body = <AdminHome me={me} refreshMe={refreshMe} logout={logout} />;
  else body = <ParentHome me={me} refreshMe={refreshMe} logout={logout} />;
  return (<>
    <ToastHost />
    {body}
  </>);
}
