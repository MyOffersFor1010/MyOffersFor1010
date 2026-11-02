/**
 * Coded notification texts ("Special Offer Update — Your code M101 is available").
 *
 * Stored on THIS device only, in IndexedDB so the service worker can read them while
 * the app is closed. They are never sent to Firebase: a push only carries the event
 * kind, and the device turns it into this text. Keep DEFAULT_NOTIFY_CONFIG and the
 * database names in sync with sw.js.
 */

const DB_NAME = 'mo-config';
const LEGACY_DB_NAME = 'privatechat-notify';   // name used up to v2.2; moved by migrateNotifyConfig()
const STORE = 'kv';
const KEY = 'config';

/** Event kinds: m = new message, a = audio call, v = video call, mc = missed call. */
export const NOTIFY_KINDS = ['m', 'a', 'v', 'mc'];

/**
 * One notification per tag: a newer event of the same tag replaces the older one and
 * alerts again (renotify). Audio and video calls share 'mo-c'; when a missed-call
 * notification is shown, the incoming-call one is closed.
 */
export const NOTIFY_TAGS = { m: 'mo-m', a: 'mo-c', v: 'mo-c', mc: 'mo-mc' };

export const DEFAULT_NOTIFY_CONFIG = {
  title: 'Special Offer Update',
  body: 'Your code {code} is available',
  codes: { m: 'M101', a: 'C101', v: 'V101', mc: 'MC101' },
  silent: false,
};

export const CODE_PATTERN = /^[A-Za-z0-9-]{1,12}$/;

const clean = (value, max, fallback) => {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
  return text || fallback;
};

/** Fills gaps with defaults and enforces lengths/charset, whatever was stored. */
export function normalizeConfig(raw) {
  const d = DEFAULT_NOTIFY_CONFIG;
  const codes = {};
  for (const k of NOTIFY_KINDS) {
    const code = typeof raw?.codes?.[k] === 'string' ? raw.codes[k].trim() : '';
    codes[k] = CODE_PATTERN.test(code) ? code : d.codes[k];
  }
  return {
    title: clean(raw?.title, 40, d.title),
    body: clean(raw?.body, 80, d.body),
    codes,
    silent: raw?.silent === true,
  };
}

export function renderNotification(config, kind) {
  const cfg = normalizeConfig(config);
  return { title: cfg.title, body: cfg.body.split('{code}').join(cfg.codes[kind] || cfg.codes.m) };
}

function openDb(name = DB_NAME, { createIfMissing = true } = {}) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      if (createIfMissing) req.result.createObjectStore(STORE);
      else req.transaction.abort();   // it does not exist: do not create an empty one
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function readRaw(dbh) {
  return new Promise((resolve, reject) => {
    const req = dbh.transaction(STORE).objectStore(STORE).get(KEY);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let cached = null;

/** Moves codes saved by earlier versions under the old database name, then deletes it. */
export async function migrateNotifyConfig() {
  let legacy;
  try {
    const old = await openDb(LEGACY_DB_NAME, { createIfMissing: false });
    legacy = await readRaw(old).catch(() => null);
    old.close();
  } catch {
    return;   // nothing to migrate
  }
  if (legacy) {
    const dbh = await openDb();
    const current = await readRaw(dbh).catch(() => null);
    dbh.close();
    if (!current) await setNotifyConfig(legacy);
  }
  indexedDB.deleteDatabase(LEGACY_DB_NAME);
}

export async function getNotifyConfig() {
  if (cached) return cached;
  try {
    const dbh = await openDb();
    const raw = await readRaw(dbh);
    dbh.close();
    cached = normalizeConfig(raw);
  } catch {
    cached = normalizeConfig(null);   // private mode / storage blocked: defaults still work
  }
  return cached;
}

export async function setNotifyConfig(config) {
  const value = normalizeConfig(config);
  const dbh = await openDb();
  await new Promise((resolve, reject) => {
    const tx = dbh.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, KEY);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  dbh.close();
  cached = value;
  return value;
}
