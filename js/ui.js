/**
 * Small DOM/UI helpers shared by all modules. User-generated text is ALWAYS
 * written with textContent — never innerHTML — to rule out XSS.
 */

export const $ = (id) => document.getElementById(id);

// boot = splash, home = public homepage, decoy = member page after a failed sign-in,
// cover = the app is in use in another tab, lock = password needed after a
// notification tap, app = the real application.
const SCREENS = ['boot', 'home', 'login', 'decoy', 'cover', 'lock', 'app'];

export function showScreen(name) {
  for (const s of SCREENS) $(`${s}-screen`).hidden = s !== name;
}

export const isScreenShown = (name) => !$(`${name}-screen`).hidden;

export function setBootMessage(text) {
  $('boot-message').textContent = text;
}

/* ---------- Toasts ---------- */
export function toast(message, { type = 'info', duration = 4000 } = {}) {
  const region = $('toast-region');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');

  const dot = document.createElement('span');
  dot.className = 'toast-icon';
  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = message;
  const close = document.createElement('button');
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '✕';

  el.append(dot, text, close);
  region.append(el);
  while (region.children.length > 4) region.firstElementChild.remove();

  const dismiss = () => {
    if (!el.isConnected) return;
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 200);
  };
  close.addEventListener('click', dismiss);
  if (duration > 0) setTimeout(dismiss, duration);
  return dismiss;
}

/* ---------- Modals ---------- */
// Dialogs can open on top of each other (a confirmation over Settings), so each one
// remembers where focus was and Escape always closes the topmost one.
const modalStack = [];   // [{ modal, lastFocus }]

export function openModal(id) {
  const modal = $(id);
  if (!modal.hidden) return;
  modalStack.push({ modal, lastFocus: document.activeElement });
  modal.hidden = false;
  const focusable = modal.querySelector('input, select, button:not([data-close]):not([data-cancel])');
  focusable?.focus({ preventScroll: true });
}

export function closeModal(id) {
  const modal = $(id);
  if (modal.hidden) return;
  modal.hidden = true;
  const i = modalStack.findIndex((m) => m.modal === modal);
  if (i < 0) return;
  const [{ lastFocus }] = modalStack.splice(i, 1);
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
}

export function bindModalDismiss(id) {
  const modal = $(id);
  modal.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', () => closeModal(id)));
}

document.addEventListener('keydown', (e) => {
  const top = modalStack[modalStack.length - 1]?.modal;
  // The confirm and choice dialogs handle Escape themselves (they must resolve their promise).
  if (e.key === 'Escape' && top && top.id !== 'confirm-modal' && top.id !== 'choice-modal') closeModal(top.id);
});

/** Promise-based confirmation dialog. Resolves true/false. */
export function confirmDialog({ title, text, okLabel = 'Confirm', danger = true }) {
  return new Promise((resolve) => {
    const modal = $('confirm-modal');
    $('confirm-title').textContent = title;
    $('confirm-text').textContent = text;
    const ok = $('confirm-ok');
    ok.textContent = okLabel;
    ok.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;

    const cancelEls = modal.querySelectorAll('[data-cancel]');
    const finish = (result) => {
      ok.removeEventListener('click', onOk);
      cancelEls.forEach((el) => el.removeEventListener('click', onCancel));
      document.removeEventListener('keydown', onKey);
      closeModal('confirm-modal');
      resolve(result);
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    const onKey = (e) => { if (e.key === 'Escape') finish(false); };

    ok.addEventListener('click', onOk);
    cancelEls.forEach((el) => el.addEventListener('click', onCancel));
    document.addEventListener('keydown', onKey);
    openModal('confirm-modal');
    ok.focus();
  });
}

/**
 * Dialog with several choices, e.g. "Delete for me" / "Delete for everyone".
 * Resolves the chosen value, or null when cancelled.
 * choices: [{ value, label, danger? }]
 */
export function choiceDialog({ title, text, choices, cancelLabel = 'Cancel' }) {
  return new Promise((resolve) => {
    const modal = $('choice-modal');
    $('choice-title').textContent = title;
    $('choice-text').textContent = text;
    const actions = $('choice-actions');
    actions.replaceChildren();
    actions.classList.toggle('stack', choices.length > 1);

    const finish = (result) => {
      modal.querySelectorAll('[data-cancel]').forEach((el) => el.removeEventListener('click', onCancel));
      document.removeEventListener('keydown', onKey);
      closeModal('choice-modal');
      resolve(result);
    };
    const onCancel = () => finish(null);
    const onKey = (e) => { if (e.key === 'Escape') finish(null); };

    for (const choice of choices) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `btn ${choice.danger ? 'btn-danger' : choices.length > 1 ? 'btn-secondary' : 'btn-primary'}`;
      btn.textContent = choice.label;
      btn.addEventListener('click', () => finish(choice.value));
      actions.append(btn);
    }
    if (cancelLabel) {
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'btn btn-secondary';
      cancel.textContent = cancelLabel;
      cancel.dataset.cancel = '';
      actions.append(cancel);
    }
    modal.querySelectorAll('[data-cancel]').forEach((el) => el.addEventListener('click', onCancel));
    document.addEventListener('keydown', onKey);
    openModal('choice-modal');
    actions.firstElementChild?.focus();
  });
}

/** Message with a single OK button. */
export function infoDialog({ title, text, okLabel = 'OK' }) {
  return choiceDialog({ title, text, choices: [{ value: true, label: okLabel }], cancelLabel: '' });
}

/* ---------- Avatars ---------- */
const AVATAR_GRADIENTS = [
  ['#5b5ef0', '#8b5cf6'], ['#0ea5e9', '#6366f1'], ['#f43f5e', '#f97316'],
  ['#10b981', '#0ea5e9'], ['#d946ef', '#8b5cf6'], ['#f59e0b', '#ef4444'],
];

export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const chars = parts.length === 1 ? [...parts[0]].slice(0, 2) : [[...parts[0]][0], [...parts[parts.length - 1]][0]];
  return chars.join('').toUpperCase();
}

export function paintAvatar(el, name, seed = name) {
  el.textContent = initials(name);
  let hash = 0;
  for (const ch of String(seed || '')) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  const [a, b] = AVATAR_GRADIENTS[hash % AVATAR_GRADIENTS.length];
  el.style.setProperty('--avatar-a', a);
  el.style.setProperty('--avatar-b', b);
}

/* ---------- Time formatting ---------- */
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
const dateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const shortDateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

export const formatTime = (date) => timeFmt.format(date);

function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }

export function dayKey(date) { return startOfDay(date).getTime(); }

export function formatDayLabel(date) {
  const diffDays = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return dayFmt.format(date);
  return dateFmt.format(date);
}

/** Compact time for lists: "14:05", "Yesterday", "12 Mar". */
export function formatListTime(date) {
  const diffDays = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86400000);
  if (diffDays === 0) return formatTime(date);
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return dayFmt.format(date).slice(0, 3);
  return shortDateFmt.format(date);
}

/** `now` should be the server-corrected time, so a wrong device clock does not skew it. */
export function formatLastSeen(date, now = Date.now()) {
  const diffMin = Math.floor((now - date.getTime()) / 60000);
  if (diffMin < 1) return 'last seen just now';
  if (diffMin < 60) return `last seen ${diffMin} min ago`;
  const label = formatDayLabel(date);
  return `last seen ${label === 'Today' ? 'today' : label === 'Yesterday' ? 'yesterday' : label} at ${formatTime(date)}`;
}

export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${String(m).padStart(2, '0')}:${sec}`;
}

/** Creates <svg><use href="#id"/></svg> safely. */
export function icon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  svg.setAttribute('aria-hidden', 'true');
  return svg;
}

export function setButtonLoading(btn, loading) {
  btn.disabled = loading;
  btn.classList.toggle('loading', loading);
}

/**
 * Maps error codes to ordinary messages any website might show. Nothing here may
 * mention Firebase, rules, configuration or how access is restricted; callers log
 * the code to the console when it is needed for troubleshooting.
 */
export function friendlyError(err, fallback = 'Something went wrong. Please try again.') {
  const code = err?.code || '';
  const map = {
    'auth/invalid-email': 'Enter a valid email address.',
    'auth/missing-password': 'Please enter your password.',
    'auth/invalid-credential': 'Incorrect email or password.',
    'auth/invalid-login-credentials': 'Incorrect email or password.',
    'auth/wrong-password': 'Incorrect email or password.',
    'auth/user-not-found': 'Incorrect email or password.',
    'auth/too-many-requests': 'Too many attempts. Please wait a few minutes and try again.',
    'auth/network-request-failed': 'You’re offline. Check your connection.',
    'permission-denied': 'Not allowed. Please sign in again.',
    'unavailable': 'Service temporarily unavailable. You may be offline.',
    'resource-exhausted': 'The service is busy. Please try again later.',
    'unauthenticated': 'Your session has expired. Please sign in again.',
  };
  return map[code] || fallback;
}
