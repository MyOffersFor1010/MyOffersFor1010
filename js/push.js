/**
 * Background push through Firebase Cloud Messaging (needs FCM_VAPID_KEY and the
 * Cloud Functions in functions/, which run on the Blaze plan).
 *
 *  - This device's FCM token is stored in users/{uid}/pushTokens/{sha256(token)}
 *    (with the auth_time of the sign-in that registered it). The Cloud Function pushes
 *    to EVERY device of the account that turned notifications on, whether or not it is
 *    signed in right now: after closing the app, after logging out, and after a
 *    sign-in elsewhere. The payload is content-free, so such a device learns only that
 *    something happened; seeing it still needs the email and password.
 *  - Only switching notifications off in Settings removes this device. Registrations
 *    not refreshed for 270 days are removed by the Cloud Function.
 *  - Pushes carry only an event kind ({k:'m'|'a'|'v'|'mc'}); sw.js turns it into the
 *    coded text configured on this device.
 */
import {
  doc,
  setDoc,
  deleteDoc,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { app, db } from './firebase.js';
import { FCM_VAPID_KEY } from './firebase-config.js';
import { getServiceWorker } from './pwa.js';

const TOKEN_ID_KEY = 'mo.device';
const LEGACY_TOKEN_ID_KEY = 'privatechat.pushTokenId';   // name used up to v2.2
const SYNCED_AT_KEY = 'mo.deviceSync';
// Registrations are refreshed at every sign-in and, while the app stays open, once a
// day. The Cloud Function drops registrations not refreshed for 270 days (stale tokens).
const RESYNC_AFTER_MS = 24 * 3600_000;

let messagingPromise = null;

/** Loads the messaging SDK lazily; resolves null when push cannot work here. */
function loadMessaging() {
  if (!FCM_VAPID_KEY) return Promise.resolve(null);
  messagingPromise ||= import('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js')
    .then(async (mod) => ((await mod.isSupported()) ? { mod, messaging: mod.getMessaging(app) } : null))
    .catch(() => null);
  return messagingPromise;
}

export const pushConfigured = () => !!FCM_VAPID_KEY;

export async function pushSupported() {
  return !!(await loadMessaging()) && !!(await getServiceWorker());
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const tokenRef = (uid, id) => doc(db, 'users', uid, 'pushTokens', id);

let active = false;
export const isPushActive = () => active;

/**
 * Registers (or refreshes) this device for background push under the current session.
 * Only call after notification permission was granted. Returns true on success.
 */
export async function enablePush(uid, authTime) {
  active = false;
  if (!('Notification' in window) || Notification.permission !== 'granted') return false;
  const m = await loadMessaging();
  const reg = m && await getServiceWorker();
  if (!reg) return false;
  const token = await m.mod.getToken(m.messaging, { vapidKey: FCM_VAPID_KEY, serviceWorkerRegistration: reg });
  if (!token) return false;
  const id = await sha256Hex(token);
  await setDoc(tokenRef(uid, id), { token, authTime, updatedAt: serverTimestamp() });
  try {
    localStorage.setItem(TOKEN_ID_KEY, id);
    localStorage.setItem(SYNCED_AT_KEY, String(Date.now()));
    localStorage.removeItem(LEGACY_TOKEN_ID_KEY);
  } catch { /* only used to remove it later */ }
  active = true;
  return true;
}

/** True when this device's registration should be refreshed (see RESYNC_AFTER_MS). */
export function pushResyncDue() {
  let last = 0;
  try { last = Number(localStorage.getItem(SYNCED_AT_KEY)) || 0; } catch { /* storage unavailable */ }
  return Date.now() - last > RESYNC_AFTER_MS;
}

/** Stops background push for this device (notifications switched off in Settings). */
export async function disablePush(uid) {
  active = false;
  let id = null;
  try {
    id = localStorage.getItem(TOKEN_ID_KEY) ?? localStorage.getItem(LEGACY_TOKEN_ID_KEY);
    localStorage.removeItem(TOKEN_ID_KEY);
    localStorage.removeItem(LEGACY_TOKEN_ID_KEY);
    localStorage.removeItem(SYNCED_AT_KEY);
  } catch { /* ignore */ }
  if (id && uid) await deleteDoc(tokenRef(uid, id)).catch(() => {});
  const m = await loadMessaging();
  if (m) await m.mod.deleteToken(m.messaging).catch(() => {});
}
