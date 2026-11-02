/**
 * Service worker: app-shell cache (installability, start without network) and private
 * push notifications.
 *
 * Privacy:
 *  - It never sees or caches chat data. Firestore and Firebase Auth traffic passes
 *    straight through; only this site's own static files (HTML/CSS/JS/icons) and the
 *    version-pinned Firebase SDK files are cached.
 *  - A push carries only an event kind ({k:'m'|'a'|'v'|'mc'}). It is shown with the
 *    coded title/text configured on this device — never names, message text or call
 *    details — and nothing about it is logged.
 *  - This worker is the ONLY place notifications are shown: pushes arrive here, and
 *    the open app sends its own events here too ({t:'show'}), so one set of rules
 *    (focus check, collapsing bursts) applies to both and tabs cannot double up.
 *  - Tapping a notification opens or focuses the app at its plain start address (no
 *    query, fragment or deep link). The app then asks for the email and password
 *    (an open, signed-in app locks itself first) before showing the conversation.
 */
'use strict';

const VERSION = '2.4.1';
const SHELL_CACHE = `shell-${VERSION}`;
// The SDK URLs contain the exact version (10.12.2) and never change, so cache-first is safe.
const SDK_CACHE = 'firebase-sdk-10.12.2';
const SDK_PREFIX = 'https://www.gstatic.com/firebasejs/10.12.2/';
// The private modules (presence, chat, calls, webrtc) are not pre-cached: they are only
// requested after a successful sign-in and then cached by the fetch handler below.
const SHELL = [
  './', 'index.html', 'manifest.json',
  'css/style.css', 'css/chat.css', 'css/calls.css', 'css/responsive.css',
  'js/theme-boot.js', 'js/app.js', 'js/auth.js', 'js/firebase-config.js',
  'js/firebase.js', 'js/notifications.js', 'js/notify-config.js', 'js/permissions.js',
  'js/push.js', 'js/pwa.js', 'js/session.js', 'js/settings.js', 'js/ui.js', 'js/decoy.js',
  'assets/icons/app-icon.svg', 'assets/icons/icon-192.png', 'assets/icons/badge-96.png',
];

self.addEventListener('install', (event) => {
  // One missing file must not break installation, so files are cached individually.
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((k) => (k.startsWith('shell-') && k !== SHELL_CACHE) || (k.startsWith('firebase-sdk-') && k !== SDK_CACHE))
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network first, so newly published updates arrive immediately; the cache
// is only a fallback while offline.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  // Firebase SDK modules: from cache when available, so the app can start offline.
  if (req.url.startsWith(SDK_PREFIX)) {
    event.respondWith(caches.open(SDK_CACHE).then(async (cache) => {
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone()).catch(() => {});
      return res;
    }));
    return;
  }
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(async () => (await caches.match(req, { ignoreSearch: true }))
        || (req.mode === 'navigate' ? caches.match('index.html') : Response.error())),
  );
});

/* ---------- Coded notification config (keep in sync with js/notify-config.js) ---------- */

const KINDS = ['m', 'a', 'v', 'mc'];
const TAGS = { m: 'mo-m', a: 'mo-c', v: 'mo-c', mc: 'mo-mc' };
const DEFAULTS = {
  title: 'Special Offer Update',
  body: 'Your code {code} is available',
  codes: { m: 'M101', a: 'C101', v: 'V101', mc: 'MC101' },
  silent: false,
};

function readConfig() {
  return new Promise((resolve) => {
    let req;
    try { req = indexedDB.open('mo-config', 1); } catch { resolve(null); return; }
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onerror = () => resolve(null);
    req.onsuccess = () => {
      const dbh = req.result;
      try {
        const get = dbh.transaction('kv').objectStore('kv').get('config');
        get.onsuccess = () => { dbh.close(); resolve(get.result || null); };
        get.onerror = () => { dbh.close(); resolve(null); };
      } catch {
        dbh.close();
        resolve(null);
      }
    };
  });
}

function codedText(cfg, kind) {
  const pick = (v, max, d) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : d);
  const rawCode = cfg?.codes?.[kind];
  const code = typeof rawCode === 'string' && /^[A-Za-z0-9-]{1,12}$/.test(rawCode) ? rawCode : DEFAULTS.codes[kind];
  return {
    title: pick(cfg?.title, 40, DEFAULTS.title),
    body: pick(cfg?.body, 80, DEFAULTS.body).split('{code}').join(code),
    silent: cfg?.silent === true,
  };
}

// Safari (iPhone, iPad, Mac) withdraws push permission from sites whose pushes do not
// show a notification, so there every push is shown, even while the app is on screen.
const MUST_SHOW_EVERY_PUSH = /AppleWebKit/.test(self.navigator.userAgent)
  && !/Android|Chrome\/|Chromium|Edg\//.test(self.navigator.userAgent);

// Events of the same kind arriving while the previous notification is still showing
// replace it silently instead of alerting (sound/vibration) once per message.
const COLLAPSE_MS = 30_000;

/**
 * `force`   : "Send test" from Settings - show even while the app is in focus.
 * `mustShow`: Safari pushes must always produce a notification.
 */
async function showCoded(kind, { force = false, mustShow = false } = {}) {
  // An app window that is on screen AND in focus shows the event itself. A visible but
  // unfocused window (e.g. behind another window on a desktop) still gets one.
  if (!force && !mustShow) {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (windows.some((w) => w.visibilityState === 'visible' && w.focused)) return;
  }
  const { title, body, silent } = codedText(await readConfig(), kind);
  const tag = TAGS[kind];
  const now = Date.now();
  const showing = await self.registration.getNotifications({ tag });
  const recent = showing.some((n) => now - (n.data?.at || 0) < COLLAPSE_MS);
  await self.registration.showNotification(title, {
    body,
    tag,
    renotify: !recent,   // a newer event alerts again, unless it is part of a burst
    icon: 'assets/icons/icon-192.png',
    badge: 'assets/icons/badge-96.png',
    silent,
    data: { at: now },   // local only: when it was shown, nothing else
  });
  // The call is over: the missed-call notification replaces the incoming-call one.
  if (kind === 'mc') {
    (await self.registration.getNotifications({ tag: TAGS.a })).forEach((n) => n.close());
  }
}

self.addEventListener('push', (event) => {
  let kind = 'm';
  try {
    const payload = event.data ? event.data.json() : {};
    const k = payload?.data?.k ?? payload?.k;   // FCM wraps data fields in `data`
    if (KINDS.includes(k)) kind = k;
  } catch { /* unreadable payload: still show the generic message code */ }
  event.waitUntil(showCoded(kind, { mustShow: MUST_SHOW_EVERY_PUSH }));
});

// Events detected by the open app (when background push is not active on this device).
self.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg?.t !== 'show' || !KINDS.includes(msg.k)) return;
  event.waitUntil(showCoded(msg.k, { force: msg.force === true }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(openApp());
});

/**
 * Focuses an open app window or opens the app at its plain start address, then tells
 * the page so it asks for the email and password before anything else (see app.js
 * onNotificationOpened). Never a deep link: nothing about the event is passed on.
 */
async function openApp() {
  const start = self.registration.scope;
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const open = windows.find((w) => w.url.startsWith(start));
  if (open) {
    open.postMessage({ t: 'opened-from-notification' });   // lock before it comes to the front
    await open.focus().catch(() => {});
    return;
  }
  const opened = await self.clients.openWindow(start);
  opened?.postMessage({ t: 'opened-from-notification' });   // straight to the sign-in form
}
