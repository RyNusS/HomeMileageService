// Browser-side web push subscription helper
import { api } from './api.js';

function b64ToUint8(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export async function getSubscriptionState() {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return sub ? 'subscribed' : 'ready';
}

export async function enablePush() {
  if (!pushSupported()) throw new Error('push_unsupported');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('push_permission_denied');
  const { key } = await api('GET', '/api/push/vapid-public-key');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64ToUint8(key),
    });
  }
  await api('POST', '/api/push/subscribe', sub.toJSON());
  return true;
}
