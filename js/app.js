/**
 * Application entry point: boot checks, public pages, auth-driven session lifecycle,
 * single active session and tab, peer presence UI and mobile navigation. Feature
 * logic lives in chat.js / calls.js.
 *
 * Authorization gate (startSession): the private modules (presence, chat, calls,
 * WebRTC) are loaded and started only after
 *   1. Firebase reports a signed-in account on the allowlist,
 *   2. this tab holds the one-active-tab lock, and
 *   3. the server accepted this sign-in as the account's session (claimSession is a
 *      write the security rules allow only for the two members with a current
 *      sign-in, so its success is the server's confirmation of membership).
 * Visitors, failed sign-ins and other accounts never load or run them.
 */
import { isConfigured, initAppCheck } from './firebase.js';
import { ALLOWED_UIDS, APP_VERSION } from './firebase-config.js';
import {
  initLoginForm, watchAuth, logout, getPeerUid, showLoginError, wasSignedInHere, currentUser,
  verifyPassword, isWrongCredentials,
} from './auth.js';
import { initSettings, applyTheme, getPrefs, setPref, hasStoredPrefs } from './settings.js';
import {
  initAudioUnlock, resetNotifications, notifyPrivate, NOTIFICATION_OPENED_EVENT,
} from './notifications.js';
import { migrateNotifyConfig } from './notify-config.js';
import {
  getAuthTime, claimSession, watchSession, claimTab, SessionSupersededError, SUPERSEDED_MESSAGE,
  startAliveMarker, stopAliveMarker, isStaleRestore, rememberSuperseded, takeSupersededNotice,
  announceLogout, onLogoutElsewhere,
} from './session.js';
import { initPwa, isIos, isStandalone } from './pwa.js';
import { enablePush, disablePush, pushConfigured, isPushActive, pushResyncDue } from './push.js';
import { requestNotificationPermission } from './permissions.js';
import { initPublicPages, showHome, openLogin, showDecoy, isDecoyShown, clearPageHistory } from './decoy.js';
import {
  $, showScreen, isScreenShown, setBootMessage, toast, confirmDialog, choiceDialog, closeModal,
  paintAvatar, formatLastSeen, friendlyError, setButtonLoading,
} from './ui.js';

// Tapping a notification while the app is open shows the password screen instead of
// the conversation (decision D-3). Set to false to just bring the app to the front.
const LOCK_ON_NOTIFICATION_TAP = true;
const PRESENCE_REFRESH_MS = 15_000;
const TRANSIENT_ERRORS = new Set(['unavailable', 'deadline-exceeded', 'auth/network-request-failed']);
const mobileQuery = window.matchMedia('(max-width: 820px)');

let session = null;   // { user, authTime, peerUid, myData, peerData, markers, wipe, unsubs: [], timers: [], releaseTab }
let priv = null;      // { presence, chat, calls, webrtc } once loaded by the gate
let globalBound = false;

const peerName = () => session?.peerData?.displayName || 'Your contact';
const myName = () => session?.myData?.displayName || session?.user?.email?.split('@')[0] || 'Me';
const toDate = (ts) => ts?.toDate?.() || null;
// The page's own address without query or fragment: nothing is ever encoded in the URL.
const homeUrl = () => location.href.split(/[?#]/)[0];

async function loadPrivateModules() {
  if (!priv) {
    const [presence, chat, calls, webrtc] = await Promise.all([
      import('./presence.js'), import('./chat.js'), import('./calls.js'), import('./webrtc.js'),
    ]);
    priv = { presence, chat, calls, webrtc };
  }
  return priv;
}

/* ---------- Boot ---------- */

async function main() {
  applyTheme();
  showScreen('boot');
  initAudioUnlock();
  initPwa();
  initPublicPages();
  // A page restored from the back/forward cache could show a stale view: start over.
  window.addEventListener('pageshow', (e) => { if (e.persisted) location.reload(); });
  // A notification was tapped (sw.js, or the page's own fallback notification). Bound
  // before any await: a window that sw.js has just opened gets the message right away.
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if (e.data?.t === 'opened-from-notification') onNotificationOpened();
  });
  navigator.serviceWorker?.startMessages?.();
  window.addEventListener(NOTIFICATION_OPENED_EVENT, onNotificationOpened);

  if (!isConfigured() || ALLOWED_UIDS.length !== 2 || ALLOWED_UIDS.some((u) => u.startsWith('REPLACE_WITH'))) {
    console.error('Configuration missing: see js/firebase-config.js.');
    document.querySelector('#boot-screen .spinner').hidden = true;
    setBootMessage('Service temporarily unavailable. Please try again later.');
    return;
  }

  let supersededNotice = takeSupersededNotice();
  migrateNotifyConfig().catch(() => {});
  await initAppCheck();
  initLoginForm();
  bindGlobal();

  $('cover-use').addEventListener('click', () => {
    const user = currentUser();
    if (user) startSession(user, { steal: true });
    else showHome();
  });
  onLogoutElsewhere(async (uid) => {
    if (currentUser()?.uid !== uid) return;
    teardownSession();
    await logout().catch(() => {});
    location.replace(homeUrl());
  });

  bindLockScreen();

  watchAuth(async (user, { rejected }) => {
    if (!user) {
      teardownSession();
      if (rejected) {
        showDecoy();   // an account that is not allowed: same page as a wrong password
      } else if (supersededNotice && !isDecoyShown()) {
        supersededNotice = false;
        openLogin();
        showLoginError(SUPERSEDED_MESSAGE);
      } else if (!isScreenShown('login') && !isDecoyShown()) {
        showHome();
      }
      return;
    }
    if (session?.user.uid === user.uid) return;
    // A sign-in the browser restored after being closed (not one made in this page and
    // not one in use a moment ago, e.g. a reload) requires the password again.
    if (!wasSignedInHere() && isStaleRestore()) {
      await logout().catch(() => {});
      return;
    }
    await startSession(user);
  });
}

/* ---------- Session lifecycle ---------- */

async function startSession(user, { steal = false } = {}) {
  teardownSession();
  showScreen('boot');
  // Starting a session needs the server; offline it waits until the connection is back.
  const bootText = () => setBootMessage(navigator.onLine
    ? 'Loading…'
    : 'You are offline. Waiting for an internet connection…');
  bootText();
  window.addEventListener('online', bootText);
  window.addEventListener('offline', bootText);
  const stopBootText = () => {
    window.removeEventListener('online', bootText);
    window.removeEventListener('offline', bootText);
  };

  const peerUid = getPeerUid(user.uid);
  const s = {
    user, authTime: 0, peerUid, myData: null, peerData: null, markers: {}, wipe: {},
    unsubs: [], timers: [], releaseTab: null,
  };
  session = s;

  let previous;
  let step = 'tab';
  try {
    // 1. One active tab per browser. A duplicated tab shows the cover instead; a
    //    password typed in this tab takes over from any other tab.
    const tab = await claimTab(user.uid, { steal: steal || wasSignedInHere(), onLost: () => lostTab(s) });
    if (session !== s) { tab?.release(); return; }
    if (!tab) {
      session = null;
      showScreen('cover');
      return;
    }
    s.releaseTab = tab.release;

    // 2. Become the account's only active session BEFORE touching any data: the rules
    //    reject every request from a sign-in that is not the recorded one.
    step = 'session';
    s.authTime = await getAuthTime(user);
    await claimSession(user.uid, s.authTime);
    if (session !== s) return;

    // 3. Membership confirmed by the server: load and start the private modules.
    step = 'modules';
    await loadPrivateModules();
    if (session !== s) return;
    step = 'profile';
    previous = await priv.presence.startPresence(user);
    s.markers = { pub: previous, priv: await priv.presence.getPrivateMarkers(user.uid) };
  } catch (err) {
    if (session !== s) return;
    if (err instanceof SessionSupersededError) { endSuperseded(s); return; }
    teardownSession();
    // A network hiccup must not sign the user out: keep the sign-in and try again.
    if (TRANSIENT_ERRORS.has(err?.code) || !navigator.onLine || step === 'modules') {
      console.warn('Session start will be retried:', step, err?.code || err?.name || '');
      setBootMessage('Connection problem. Retrying…');
      setTimeout(() => {
        if (!session && currentUser()?.uid === user.uid) startSession(user);
      }, 3000);
      return;
    }
    // Details go to the console only; the screen shows what any website would show.
    console.error('Session start failed:', step, err?.code || err?.name || '');
    await logout().catch(() => {});
    openLogin();
    showLoginError('Something went wrong. Please try again.');
    return;
  } finally {
    stopBootText();
  }
  if (session !== s) return;

  const { presence, chat, calls, webrtc } = priv;
  clearPageHistory();
  startAliveMarker();
  s.unsubs.push(watchSession(user.uid, s.authTime, () => endSuperseded(s)));

  s.myData = previous;
  s.unsubs.push(presence.watchUser(user.uid, (data) => {
    s.myData = data;
    renderMe();
    s.markers.pub = data;   // legacy location of the "deleted for me" markers
    applyMarkers(s);
    noteWipe(s, 'me', data);
  }));
  s.unsubs.push(presence.watchPrivateMarkers(user.uid, (data) => {
    s.markers.priv = data;
    applyMarkers(s);
  }));
  s.unsubs.push(presence.watchUser(peerUid, (data) => {
    s.peerData = data;
    renderPeer();
    chat.setPeerMarkers({ lastReadAt: data?.lastReadAt, lastDeliveredAt: data?.lastDeliveredAt });
    noteWipe(s, 'peer', data);
  }, (err) => toast(friendlyError(err, 'Could not load contact status.'), { type: 'error' })));

  initSettings({
    onSaveDisplayName: async (name) => {
      try { await priv.presence.updateDisplayName(name); }
      catch (err) { toast(friendlyError(err, 'Could not save display name.'), { type: 'error' }); throw err; }
    },
    onLogout: handleLogout,
    getDisplayName: myName,
    // Settings UI is bound once per page load, so read the *current* session lazily.
    getEmail: () => session?.user.email || '',
    turnStatus: () => (webrtc.hasTurnConfigured() ? 'Configured' : 'Not configured — STUN only (some networks will fail)'),
    version: APP_VERSION,
    onNotificationsToggle: handleNotificationsToggle,
    onTestNotification: () => notifyPrivate('m', { force: true }),
    onClearHistory: handleClearHistory,
    pushStatus,
  });

  chat.initChat({
    myUid: user.uid, peerUid, getPeerName: peerName,
    myLastReadAt: toDate(previous?.lastReadAt), myClearedAt: latestMarker(s, 'clearedAt'),
  });
  calls.initCalls({
    myUid: user.uid, peerUid, getPeerName: peerName,
    previousLastActive: previous?.lastActive || null, myCallsClearedAt: latestMarker(s, 'callsClearedAt'),
  });

  // Permission still granted but every saved setting gone (site data cleared): the user
  // had notifications on, so turn them back on instead of silently losing them.
  if (!getPrefs().browserNotify && !hasStoredPrefs() && 'Notification' in window && Notification.permission === 'granted') {
    setPref('browserNotify', true);
  }
  // Refresh this device's push registration under the new session (no prompt here).
  if (getPrefs().browserNotify) syncPush(s);

  // "online" ages out without any new snapshot, so re-evaluate periodically.
  s.timers.push(setInterval(renderPeer, PRESENCE_REFRESH_MS));
  s.timers.push(setInterval(chat.refreshRelativeLabels, 60_000));

  renderMe();
  renderPeer();
  showScreen('app');
  if (mobileQuery.matches) showChat(false);
  else chat.setChatShown(true);
}

/** `otherTabActive`: another tab of this browser took over, so it is still in use. */
function teardownSession({ otherTabActive = false } = {}) {
  if (!session) return;
  const s = session;
  session = null;
  s.unsubs.forEach((u) => { try { u(); } catch { /* ignore */ } });
  s.timers.forEach(clearInterval);
  // Stop the heartbeat and the "in use" marker too: the sign-in may have ended without
  // a reload (e.g. revoked after a password reset). Logout marks offline itself.
  if (priv) {
    priv.presence.stopPresence({ markOffline: false });
    priv.calls.destroyCalls();
    priv.chat.destroyChat();
  }
  stopAliveMarker({ forget: !otherTabActive });
  resetNotifications();
  closeModal('settings-modal');
  document.body.classList.remove('locked');
  s.releaseTab?.();
}

/** Another tab of this browser pressed "Use here": stop everything here and show the cover. */
function lostTab(s) {
  if (session !== s) return;
  teardownSession({ otherTabActive: true });
  showScreen('cover');
}

/**
 * A newer sign-in on another device took over this account. The server already
 * refuses this session's requests; end any call, sign out and reload so no copy of
 * the conversation stays in memory, then show the notice on the sign-in screen.
 */
async function endSuperseded(s) {
  if (session !== s) return;
  if (priv?.calls.isInCall()) priv.calls.hangUp();
  teardownSession();
  rememberSuperseded();
  await logout().catch(() => {});
  location.replace(homeUrl());
}

async function handleLogout() {
  const inCall = priv?.calls.isInCall();
  const ok = await confirmDialog({
    title: 'Log out?',
    text: inCall
      ? 'Your current call will end. Notifications stay on for this device (turn them off in Settings first if you do not want them).'
      : 'You will need your password to sign in again. Notifications stay on for this device (turn them off in Settings first if you do not want them).',
    okLabel: 'Log out',
  });
  if (!ok) return;
  await performLogout();
}

async function performLogout() {
  if (priv?.calls.isInCall()) priv.calls.hangUp();
  closeModal('settings-modal');
  const uid = session?.user.uid;
  // This device stays registered for notifications: they keep arriving after logout
  // (only the Settings switch turns them off). Mark offline while still authenticated
  // (the rules reject writes after sign-out).
  await priv?.presence.stopPresence();
  stopAliveMarker();
  try {
    await logout();
    if (uid) announceLogout(uid);
    // Reload so nothing from the conversation stays in this page's memory; the page
    // starts again on the homepage.
    location.replace(homeUrl());
  } catch (err) {
    toast(friendlyError(err, 'Could not sign out.'), { type: 'error' });
  }
}

/* ---------- Notifications & push ---------- */

async function syncPush(s) {
  try {
    await enablePush(s.user.uid, s.authTime);
  } catch (err) {
    console.warn('Background push unavailable:', err?.code || err?.name || '');
  }
}

/** From the Settings switch. Returns whether private notifications are now on. */
async function handleNotificationsToggle(enable) {
  const s = session;
  if (!enable) {
    if (s) await disablePush(s.user.uid).catch(() => {});
    return false;
  }
  const result = await requestNotificationPermission();
  if (result !== 'granted') return false;
  if (s && pushConfigured()) {
    await syncPush(s);
    if (!isPushActive()) toast('Notifications are on, but background push could not be set up on this device. They will appear while the app is open.', { type: 'warning', duration: 7000 });
  }
  return true;
}

function pushStatus() {
  if (isIos() && !isStandalone()) return '';   // the permission note explains Home Screen install
  if (!getPrefs().browserNotify) return '';
  if (isPushActive()) return 'Background notifications are active on this device, also while the app is closed (where the OS allows).';
  if (!pushConfigured()) return 'Background push is not set up for this site, so notifications only appear while the app is open (e.g. in a background tab).';
  return 'Background push is not available in this browser; notifications appear while the app is open.';
}

/* ---------- Sign-in again after a notification tap ---------- */

/**
 * Signed in here: lock the app behind a second sign-in (same email and password).
 * Not signed in (e.g. a window sw.js has just opened): go straight to the sign-in form.
 * Either way the conversation shows only after a correct sign-in.
 */
function onNotificationOpened() {
  if (session) {
    if (LOCK_ON_NOTIFICATION_TAP) lockApp();
    return;
  }
  if (isScreenShown('home') || isScreenShown('boot') || isDecoyShown()) openLogin();
}

/**
 * Hides the app behind the sign-in screen. The session keeps running underneath
 * (messages, calls and receipts stay live), but nothing is shown and nothing is marked
 * as read until the email and password are entered again.
 */
function lockApp() {
  if (!session || session.locked || !isScreenShown('app')) return;
  session.locked = true;
  document.body.classList.add('locked');
  priv.chat.setChatShown(false);
  showLockError('');
  $('lock-email').value = '';
  $('lock-password').value = '';
  showScreen('lock');
  $('lock-email').focus();
}

function unlockApp() {
  if (!session?.locked) return;
  session.locked = false;
  document.body.classList.remove('locked');
  showScreen('app');
  priv.chat.setChatShown(!mobileQuery.matches || $('app-screen').classList.contains('show-chat'));
}

function showLockError(message) {
  const el = $('lock-error');
  el.textContent = message;
  el.hidden = !message;
}

/**
 * Wrong email or password on the lock screen: exactly like a wrong main sign-in, the
 * member page appears. Behind it this session ends completely (offline, listeners
 * stopped, the conversation removed from the page, signed out here and in this
 * browser's other tabs). Notifications stay on for the device.
 */
async function lockFailed() {
  const s = session;
  if (!s) return;
  showDecoy();
  if (priv?.calls.isInCall()) priv.calls.hangUp();
  await priv?.presence.stopPresence();
  teardownSession();
  await logout().catch(() => {});
  announceLogout(s.user.uid);
}

function bindLockScreen() {
  const submit = $('lock-submit');
  $('lock-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const typedEmail = $('lock-email').value.trim();
    const password = $('lock-password').value;
    const accountEmail = session?.user.email;
    if (!session?.locked || !accountEmail) return;
    if (!typedEmail || !password) { showLockError('Please enter your email and password.'); return; }
    showLockError('');
    // Only the account signed in here can unlock it (not, e.g., the other member's login).
    if (typedEmail.toLowerCase() !== accountEmail.toLowerCase()) { await lockFailed(); return; }
    setButtonLoading(submit, true);
    try {
      await verifyPassword(accountEmail, password);
      $('lock-email').value = '';
      $('lock-password').value = '';
      unlockApp();
    } catch (err) {
      if (isWrongCredentials(err)) await lockFailed();
      else showLockError(friendlyError(err));   // offline, too many attempts: ordinary messages
    } finally {
      setButtonLoading(submit, false);
    }
  });
  // Leaving the lock screen signs out completely and returns to the homepage.
  $('lock-signout').addEventListener('click', () => { if (session) performLogout(); });
}

/* ---------- History deletion ---------- */

/** Newest "deleted for me" marker from the private document or the legacy profile field. */
function latestMarker(s, field) {
  const dates = [toDate(s.markers?.priv?.[field]), toDate(s.markers?.pub?.[field])].filter(Boolean);
  return dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null;
}

function applyMarkers(s) {
  priv.chat.setClearedAt(latestMarker(s, 'clearedAt'));
  priv.calls.setCallsClearedAt(latestMarker(s, 'callsClearedAt'));
}

/** A "delete for everyone" by either person: reload the conversation view. */
function noteWipe(s, who, data) {
  const t = data?.wipedAt?.toMillis?.() ?? 0;
  const prev = s.wipe[who];
  s.wipe[who] = t;
  if (prev !== undefined && t > prev) priv.chat.reloadChat();
}

async function handleClearHistory() {
  if (!session) return;
  const { chat, calls } = priv;
  const choice = await choiceDialog({
    title: 'Clear all chat history?',
    text: 'Delete for me: all messages and call history disappear from your view, on every device you sign in to. The other person keeps theirs.\n\nDelete for everyone: all messages and finished calls are permanently erased for both of you. This cannot be undone.',
    choices: [
      { value: 'me', label: 'Delete for me' },
      { value: 'everyone', label: 'Delete for everyone', danger: true },
    ],
  });
  if (choice === 'me') {
    await chat.runDeletion(() => chat.clearMessagesForMe(['callsClearedAt']), 'Chat history deleted for you.');
  } else if (choice === 'everyone') {
    await chat.runDeletion(async () => {
      // Messages first: if erasing call history fails, the messages are still gone.
      await chat.eraseMessagesForEveryone();
      await calls.eraseCallHistory();
    }, 'Chat history deleted for everyone.');
  }
}

/* ---------- Rendering ---------- */

function renderMe() {
  if (!session) return;
  $('me-name').textContent = myName();
  paintAvatar($('me-avatar'), myName(), session.user.uid);
}

function renderPeer() {
  if (!session) return;
  const { presence, chat, calls } = priv;
  const name = peerName();
  const { online, typing, lastActive } = presence.describePresence(session.peerData);

  for (const id of ['peer-name', 'contact-name']) $(id).textContent = name;
  for (const id of ['peer-avatar', 'contact-avatar']) paintAvatar($(id), name, session.peerUid);
  for (const id of ['peer-status-dot', 'contact-status-dot']) $(id).classList.toggle('online', online);

  const status = $('peer-status');
  status.classList.toggle('online', online && !typing);
  status.classList.toggle('typing', typing);
  status.textContent = typing ? 'typing…'
    : online ? 'online'
    : lastActive ? formatLastSeen(lastActive, presence.serverNow())
    : session.peerData ? 'offline' : 'has not signed in yet';
  status.title = 'Presence is based on a once-a-minute heartbeat, so “online” can lag by up to ~2 minutes after the other person leaves.';

  chat.setPeerTyping(typing);
  chat.setSidebarTyping(typing);
  calls.refreshCallPeer();
}

/* ---------- Mobile navigation ---------- */

function showChat(pushHistory = true) {
  $('app-screen').classList.add('show-chat');
  $('contact-item').classList.add('active');
  priv?.chat.setChatShown(true);
  if (pushHistory && mobileQuery.matches && !history.state?.chat) history.pushState({ chat: true }, '');
}

function showSidebar() {
  $('app-screen').classList.remove('show-chat');
  $('contact-item').classList.remove('active');
  priv?.chat.setChatShown(!mobileQuery.matches);
}

function bindGlobal() {
  if (globalBound) return;
  globalBound = true;

  $('contact-item').addEventListener('click', () => {
    showChat();
    if (!mobileQuery.matches) $('message-input').focus();
  });
  $('back-to-sidebar').addEventListener('click', () => {
    if (history.state?.chat) history.back();
    else showSidebar();
  });
  window.addEventListener('popstate', () => {
    if (mobileQuery.matches && $('app-screen').classList.contains('show-chat')) showSidebar();
  });
  mobileQuery.addEventListener?.('change', (e) => {
    if (!e.matches) { $('app-screen').classList.add('show-chat'); priv?.chat.setChatShown(true); }
  });

  const attention = () => { if (!session?.locked) priv?.chat.onChatAttention(); };
  window.addEventListener('focus', attention);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    attention();
    // Keep this device's push registration fresh while the app stays open for days.
    if (session && getPrefs().browserNotify && pushResyncDue()) syncPush(session);
  });

  const updateNetwork = () => {
    $('network-banner').hidden = navigator.onLine;
    if (!navigator.onLine && session) toast('You are offline.', { type: 'warning' });
  };
  window.addEventListener('online', () => { updateNetwork(); if (session) toast('Back online.', { type: 'success' }); });
  window.addEventListener('offline', updateNetwork);
  updateNetwork();
}

main().catch((err) => {
  console.error('Startup failed', err?.message || err);
  document.querySelector('#boot-screen .spinner').hidden = true;
  setBootMessage('Something went wrong. Please reload the page.');
  showScreen('boot');
});
