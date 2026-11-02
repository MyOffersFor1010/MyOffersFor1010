/**
 * Presence, typing and read/delivery markers, all stored in users/{uid}.
 * Each user may only write their own document (enforced by firestore.rules).
 *
 * LIMITATION: Firestore has no server-side "on disconnect" hook. "Online" therefore
 * means "sent a heartbeat within the last ONLINE_WINDOW_MS". When a tab closes
 * abruptly the other user sees "online" for up to that window, then "last seen".
 */
import {
  doc,
  getDoc,
  getDocFromServer,
  setDoc,
  updateDoc,
  onSnapshot,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { db } from './firebase.js';

const HEARTBEAT_MS = 60_000;
export const ONLINE_WINDOW_MS = 150_000;
export const TYPING_WINDOW_MS = 6_000;
const TYPING_THROTTLE_MS = 3_000;
const TYPING_IDLE_MS = 4_000;

let myUid = null;
let heartbeatTimer = null;
let typingIdleTimer = null;
let lastTypingWrite = 0;
let isTyping = false;
let pageListenersBound = false;

const userRef = (uid) => doc(db, 'users', uid);

/** Ignores benign failures (offline, signed out mid-write) without noisy logs. */
const quiet = (p) => p.catch((err) => { if (err?.code !== 'unavailable') console.debug('presence write skipped:', err?.code); });

/**
 * Ensures users/{uid} exists and marks the user online.
 * Returns the profile as it was BEFORE this session (used for "missed calls since last visit").
 */
export async function startPresence(user) {
  myUid = user.uid;
  const ref = userRef(myUid);
  const snap = await getDoc(ref);
  const previous = snap.exists() ? snap.data() : null;

  const t0 = Date.now();
  if (!previous) {
    const fallbackName = (user.email || 'User').split('@')[0].slice(0, 40) || 'User';
    await setDoc(ref, {
      uid: myUid,
      displayName: fallbackName,
      state: 'online',
      lastActive: serverTimestamp(),
      typing: false,
    });
  } else {
    await updateDoc(ref, { state: 'online', lastActive: serverTimestamp(), typing: false });
  }
  const t1 = Date.now();
  // Awaited: stale-call checks right after sign-in must use the corrected clock.
  await estimateClockOffset(ref, (t0 + t1) / 2);

  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (document.visibilityState === 'visible') beat('online');
  }, HEARTBEAT_MS);

  if (!pageListenersBound) {
    pageListenersBound = true;
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
  }
  return previous;
}

/**
 * Device clocks can be minutes off. Comparing our own just-written server timestamp
 * with the local send time gives an offset (accurate to about one round trip), used
 * by serverNow() for "online", "typing" and stale-call decisions. One read per session.
 */
let clockOffsetMs = 0;
async function estimateClockOffset(ref, localMidpoint) {
  try {
    const snap = await getDocFromServer(ref);
    const serverMs = snap.data()?.lastActive?.toMillis?.();
    if (serverMs) clockOffsetMs = serverMs - localMidpoint;
  } catch { /* offline: assume clocks agree */ }
}
export const serverNow = () => Date.now() + clockOffsetMs;

function beat(state) {
  if (!myUid) return Promise.resolve();
  return quiet(updateDoc(userRef(myUid), { state, lastActive: serverTimestamp() }));
}

function onVisibility() {
  if (!myUid) return;
  // A hidden tab still receives messages and calls, so we keep "online" but stop
  // the heartbeat; it will naturally age out to "last seen" if the tab stays hidden.
  if (document.visibilityState === 'visible') beat('online');
}

function onPageHide() {
  if (!myUid) return;
  // Best effort only: the browser may kill the page before this write is sent.
  updateDoc(userRef(myUid), { state: 'offline', lastActive: serverTimestamp(), typing: false }).catch(() => {});
}

export async function stopPresence({ markOffline = true } = {}) {
  clearInterval(heartbeatTimer);
  clearTimeout(typingIdleTimer);
  heartbeatTimer = null;
  if (myUid && markOffline) {
    await quiet(updateDoc(userRef(myUid), { state: 'offline', lastActive: serverTimestamp(), typing: false }));
  }
  myUid = null;
  isTyping = false;
}

/** Throttled: writes typing=true at most every 3s, and typing=false after 4s idle. */
export function notifyTyping() {
  if (!myUid) return;
  const now = Date.now();
  if (!isTyping || now - lastTypingWrite > TYPING_THROTTLE_MS) {
    isTyping = true;
    lastTypingWrite = now;
    quiet(updateDoc(userRef(myUid), { typing: true, typingAt: serverTimestamp() }));
  }
  clearTimeout(typingIdleTimer);
  typingIdleTimer = setTimeout(stopTyping, TYPING_IDLE_MS);
}

export function stopTyping() {
  clearTimeout(typingIdleTimer);
  if (!myUid || !isTyping) return;
  isTyping = false;
  quiet(updateDoc(userRef(myUid), { typing: false }));
}

/**
 * Trailing throttle: at most one write per `ms`, and a call made during the quiet
 * period is deferred (not dropped) so the final receipt always reaches the server.
 */
function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  return () => {
    const wait = last + ms - Date.now();
    if (wait <= 0) {
      last = Date.now();
      fn();
    } else if (!timer) {
      timer = setTimeout(() => { timer = null; last = Date.now(); fn(); }, wait);
    }
  };
}

/** Records that I have read everything up to now (also implies delivered). */
export const markRead = throttle(() => {
  if (!myUid) return;
  quiet(updateDoc(userRef(myUid), { lastReadAt: serverTimestamp(), lastDeliveredAt: serverTimestamp() }));
}, 2000);

/** Records that messages reached this device. */
export const markDelivered = throttle(() => {
  if (!myUid) return;
  quiet(updateDoc(userRef(myUid), { lastDeliveredAt: serverTimestamp() }));
}, 2000);

export async function updateDisplayName(name) {
  await updateDoc(userRef(myUid), { displayName: name });
}

/**
 * Sets markers on my (public) profile to the server time. Only used for wipedAt
 * ("I erased the conversation for everyone"), which the other app must see.
 */
export async function stampUserFields(fields) {
  await updateDoc(userRef(myUid), Object.fromEntries(fields.map((f) => [f, serverTimestamp()])));
}

/*
 * "Deleted for me" markers (clearedAt / callsClearedAt) live in an owner-only document,
 * so the other person cannot see when I cleared my history. Older versions stored them
 * on the public profile; app.js still reads those as a fallback.
 */
const markersRef = (uid) => doc(db, 'users', uid, 'private', 'markers');

export async function stampPrivateMarkers(fields) {
  await setDoc(markersRef(myUid), Object.fromEntries(fields.map((f) => [f, serverTimestamp()])), { merge: true });
}

export async function getPrivateMarkers(uid) {
  const snap = await getDoc(markersRef(uid));
  return snap.exists() ? snap.data() : null;
}

/**
 * Only server-confirmed values are reported: a marker I just set first arrives as a
 * local estimate (device clock) and then as the server time, which would reload the
 * conversation twice and briefly filter with the wrong time.
 */
export function watchPrivateMarkers(uid, callback) {
  return onSnapshot(markersRef(uid), { includeMetadataChanges: true }, (snap) => {
    if (snap.metadata.hasPendingWrites) return;
    callback(snap.exists() ? snap.data() : null);
  }, (err) => console.error('Markers listener error:', err?.code));
}

export function watchUser(uid, callback, onError) {
  // 'estimate': a marker I just set is visible immediately instead of as null.
  return onSnapshot(userRef(uid), (snap) => callback(snap.exists() ? snap.data({ serverTimestamps: 'estimate' }) : null), onError);
}

/** Derives a human status from a user document. */
export function describePresence(data) {
  if (!data) return { online: false, typing: false, lastActive: null };
  const lastActive = data.lastActive?.toDate?.() || null;
  const now = serverNow();
  const fresh = lastActive && now - lastActive.getTime() < ONLINE_WINDOW_MS;
  const online = data.state === 'online' && !!fresh;
  const typingAt = data.typingAt?.toDate?.();
  const typing = online && data.typing === true && typingAt && now - typingAt.getTime() < TYPING_WINDOW_MS;
  return { online, typing: !!typing, lastActive };
}
