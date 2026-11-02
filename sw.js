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
 *  - Tapping a notification only dismisses it; it does not open a conversation.
 */
'use strict';

const VERSION = '2.3.0';
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

async function showCoded(kind) {
  // If the app is on screen it shows the event itself; no notification needed.
  if (!MUST_SHOW_EVERY_PUSH) {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (windows.some((w) => w.visibilityState === 'visible')) return;
  }
  const { title, body, silent } = codedText(await readConfig(), kind);
  await self.registration.showNotification(title, {
    body,
    tag: TAGS[kind],
    renotify: true,   // a newer event replacing an older notification still alerts
    icon: 'assets/icons/icon-192.png',
    badge: 'assets/icons/badge-96.png',
    silent,
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
  event.waitUntil(showCoded(kind));
});

self.addEventListener('notificationclick', (event) => {
  // Dismiss only: never open a conversation or reveal anything from a notification.
  event.notification.close();
});
