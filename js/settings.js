/**
 * User preferences (theme, notifications, media devices) persisted in localStorage.
 * Nothing secret is stored here — Firebase Auth manages its own session storage.
 */
import { $, openModal, bindModalDismiss, toast } from './ui.js';
import { isIos, isStandalone } from './pwa.js';
import {
  getNotifyConfig, setNotifyConfig, NOTIFY_KINDS, CODE_PATTERN,
} from './notify-config.js';

const STORAGE_KEY = 'mo.prefs';
const LEGACY_STORAGE_KEY = 'privatechat.prefs';   // name used up to v2.2; read once, then removed

const DEFAULTS = {
  theme: 'system',          // 'system' | 'light' | 'dark'
  messageSound: true,
  ringtone: true,
  browserNotify: false,     // private (coded) notifications
  micId: '',
  cameraId: '',
  speakerId: '',
};

let prefs = load();
const listeners = new Set();

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY) || '{}');
    const merged = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) {
      if (typeof raw[key] === typeof DEFAULTS[key]) merged[key] = raw[key];
    }
    return merged;
  } catch {
    return { ...DEFAULTS };
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch { /* quota or private mode */ }
}

export const getPrefs = () => ({ ...prefs });

/** False when no preferences were ever saved here (new device, or site data cleared). */
export function hasStoredPrefs() {
  try {
    return localStorage.getItem(STORAGE_KEY) !== null || localStorage.getItem(LEGACY_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

export function setPref(key, value) {
  if (!(key in DEFAULTS) || prefs[key] === value) return;
  prefs[key] = value;
  save();
  if (key === 'theme') applyTheme();
  listeners.forEach((fn) => fn(key, value));
}

export function onPrefChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/* ---------- Theme ---------- */
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

export function applyTheme() {
  const dark = prefs.theme === 'dark' || (prefs.theme === 'system' && darkQuery.matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#141722' : '#5b5ef0');
}
darkQuery.addEventListener?.('change', () => { if (prefs.theme === 'system') applyTheme(); });

export function toggleTheme() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  setPref('theme', isDark ? 'light' : 'dark');
  syncSettingsForm();
}

/* ---------- Media devices ---------- */
export const supportsSinkId = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

export async function listDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return { mics: [], cameras: [], speakers: [] };
  const devices = await navigator.mediaDevices.enumerateDevices();
  return {
    mics: devices.filter((d) => d.kind === 'audioinput'),
    cameras: devices.filter((d) => d.kind === 'videoinput'),
    speakers: devices.filter((d) => d.kind === 'audiooutput'),
  };
}

function fillSelect(select, devices, selectedId, fallbackLabel) {
  select.replaceChildren();
  const def = document.createElement('option');
  def.value = '';
  def.textContent = 'System default';
  select.append(def);
  devices.forEach((d, i) => {
    if (!d.deviceId || d.deviceId === 'default') return;
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `${fallbackLabel} ${i + 1}`;
    select.append(opt);
  });
  select.value = [...select.options].some((o) => o.value === selectedId) ? selectedId : '';
}

async function refreshDeviceLists() {
  try {
    const { mics, cameras, speakers } = await listDevices();
    fillSelect($('pref-mic'), mics, prefs.micId, 'Microphone');
    fillSelect($('pref-camera'), cameras, prefs.cameraId, 'Camera');
    fillSelect($('pref-speaker'), speakers, prefs.speakerId, 'Speaker');
    $('speaker-field').hidden = !supportsSinkId || speakers.length === 0;
    const labelled = [...mics, ...cameras].some((d) => d.label);
    $('devices-note').textContent = labelled
      ? 'Changes apply to the next call.'
      : 'Device names appear after you grant camera/microphone permission once (e.g. during a call or via “Detect devices”).';
  } catch {
    $('devices-note').textContent = 'This browser does not allow listing media devices.';
  }
}

/** Requests temporary permission so device labels become visible, then releases it. */
async function detectDevices() {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('Camera/microphone access requires HTTPS and a modern browser.', { type: 'error' });
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true })
      .catch(() => navigator.mediaDevices.getUserMedia({ audio: true }));
    stream.getTracks().forEach((t) => t.stop());
  } catch {
    toast('Permission was not granted, so device names cannot be shown.', { type: 'warning' });
  }
  await refreshDeviceLists();
}

/* ---------- Settings modal ---------- */
function updateNotifyNote() {
  const note = $('notify-permission-note');
  if (isIos() && !isStandalone()) {
    note.textContent = 'On iPhone/iPad, notifications only work in the Home Screen app: tap Share → Add to Home Screen, open it from there and turn this on (iOS 16.4 or later).';
    $('pref-browser-notify').disabled = !('Notification' in window);
    return;
  }
  if (!('Notification' in window)) {
    note.textContent = 'This browser does not support notifications (on iPhone/iPad, add the app to your Home Screen first, iOS 16.4+).';
    $('pref-browser-notify').disabled = true;
    return;
  }
  const map = {
    granted: 'Notification permission: granted.',
    denied: 'Notifications are blocked for this site. Turn the switch on to see how to re-enable them.',
    default: 'You will be asked for permission when you turn this on.',
  };
  note.textContent = map[Notification.permission] || '';
}

function syncSettingsForm() {
  document.querySelectorAll('input[name="theme"]').forEach((r) => { r.checked = r.value === prefs.theme; });
  $('pref-message-sound').checked = prefs.messageSound;
  $('pref-ringtone').checked = prefs.ringtone;
  $('pref-browser-notify').checked = prefs.browserNotify && 'Notification' in window && Notification.permission === 'granted';
  updateNotifyNote();
}

/* ---------- Coded notification texts ---------- */
async function fillCodeForm() {
  const cfg = await getNotifyConfig();
  $('code-title').value = cfg.title;
  $('code-body').value = cfg.body;
  for (const k of NOTIFY_KINDS) $(`code-${k}`).value = cfg.codes[k];
  $('code-silent').checked = cfg.silent;
}

async function saveCodeForm(e) {
  e.preventDefault();
  const codes = {};
  for (const k of NOTIFY_KINDS) codes[k] = $(`code-${k}`).value.trim();
  const title = $('code-title').value.trim();
  const body = $('code-body').value.trim();
  if (!title || !body) { toast('Title and text cannot be empty.', { type: 'warning' }); return; }
  if (!Object.values(codes).every((c) => CODE_PATTERN.test(c))) {
    toast('Codes may only use letters, digits and “-” (1–12 characters).', { type: 'warning' });
    return;
  }
  try {
    await setNotifyConfig({ title, body, codes, silent: $('code-silent').checked });
    toast('Notification codes saved on this device.', { type: 'success' });
  } catch {
    toast('Could not save the codes in this browser (storage blocked?).', { type: 'error' });
  }
}

let settingsBound = false;

/**
 * Wires the settings modal once. Firebase-dependent actions (profile, logout,
 * notification/push setup, history deletion) are passed in by app.js so this
 * module stays free of Firebase dependencies.
 */
export function initSettings({
  onSaveDisplayName, onLogout, getDisplayName, getEmail, turnStatus, version,
  onNotificationsToggle, onTestNotification, onClearHistory, pushStatus,
}) {
  applyTheme();
  if (settingsBound) return;
  settingsBound = true;

  bindModalDismiss('settings-modal');

  const open = () => {
    syncSettingsForm();
    fillCodeForm();
    $('display-name-input').value = getDisplayName() || '';
    $('me-email').textContent = getEmail() ? `Signed in as ${getEmail()}` : '';
    $('turn-status').textContent = turnStatus();
    $('push-note').textContent = pushStatus();
    $('app-version').textContent = `v${version}`;
    refreshDeviceLists();
    openModal('settings-modal');
  };
  $('open-settings').addEventListener('click', open);
  $('open-settings-2').addEventListener('click', open);
  $('theme-toggle').addEventListener('click', toggleTheme);

  document.querySelectorAll('input[name="theme"]').forEach((radio) => {
    radio.addEventListener('change', () => { if (radio.checked) setPref('theme', radio.value); });
  });
  $('pref-message-sound').addEventListener('change', (e) => setPref('messageSound', e.target.checked));
  $('pref-ringtone').addEventListener('change', (e) => setPref('ringtone', e.target.checked));
  $('pref-browser-notify').addEventListener('change', async (e) => {
    const toggle = e.target;
    toggle.disabled = true;
    try {
      // app.js explains + requests permission (never re-prompting after a denial) and
      // registers or removes this device for background push.
      const enabled = await onNotificationsToggle(toggle.checked);
      toggle.checked = enabled;
      setPref('browserNotify', enabled);
    } finally {
      toggle.disabled = false;
      updateNotifyNote();
      $('push-note').textContent = pushStatus();
    }
  });
  $('notify-code-form').addEventListener('submit', saveCodeForm);
  $('code-test').addEventListener('click', async () => {
    if (!(await onTestNotification())) toast('Turn on private notifications first.', { type: 'warning' });
  });
  $('clear-history-btn').addEventListener('click', onClearHistory);

  $('pref-mic').addEventListener('change', (e) => setPref('micId', e.target.value));
  $('pref-camera').addEventListener('change', (e) => setPref('cameraId', e.target.value));
  $('pref-speaker').addEventListener('change', (e) => setPref('speakerId', e.target.value));
  $('refresh-devices').addEventListener('click', detectDevices);
  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    if (!$('settings-modal').hidden) refreshDeviceLists();
  });

  $('profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('display-name-input').value.trim().replace(/\s+/g, ' ');
    if (!name || name.length > 40) {
      toast('Display name must be 1–40 characters.', { type: 'warning' });
      return;
    }
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      await onSaveDisplayName(name);
      toast('Display name updated.', { type: 'success' });
    } finally {
      btn.disabled = false;
    }
  });

  $('logout-btn').addEventListener('click', onLogout);
}
