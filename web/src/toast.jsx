// Global toast notifications - success/error popups for every action
import React, { useEffect, useState } from 'react';

let pushToast = null;

export function toast(message, type = 'success') {
  if (pushToast) pushToast({ id: Date.now() + Math.random(), message, type });
}

export function ToastHost() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    pushToast = (t) => {
      setItems((prev) => [...prev.slice(-2), t]);
      setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== t.id)), 2600);
    };
    return () => { pushToast = null; };
  }, []);
  return (
    <div className="toast-wrap">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.type}`}>
          <span className="toast-ico">{t.type === 'error' ? '⚠️' : '✅'}</span>
          {t.message}
        </div>
      ))}
    </div>
  );
}
