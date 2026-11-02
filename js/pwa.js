/**
 * Progressive Web App: service worker registration and the "Install App" buttons.
 *
 *  - Chrome, Edge and Samsung Internet (Android, Windows, macOS, ChromeOS) fire
 *    `beforeinstallprompt`; the buttons then open the browser's own install dialog.
 *  - iPhone/iPad have no install prompt: the buttons explain "Add to Home Screen".
 *  - The buttons stay hidden inside the installed app and in browsers that cannot
 *    install (e.g. Firefox desktop).
 */
import { $, toast, infoDialog } from './ui.js';

const INSTALL_BUTTONS = ['install-btn-login', 'install-btn', 'install-btn-settings'];

let deferredPrompt = null;
let registration = Promise.resolve(null);

export const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

export const isIos = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function initPwa() {
  if ('serviceWorker' in navigator && window.isSecureContext) {
    // Relative URL: scope is the app folder, so it also works when hosted under a sub-path.
    registration = navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('Service worker registration failed.', err?.name || '');
      return null;
    });
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    updateInstallUi();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    updateInstallUi();
    toast('App installed. Open it from your home screen.', { type: 'success' });
  });
  window.matchMedia('(display-mode: standalone)').addEventListener?.('change', updateInstallUi);
  INSTALL_BUTTONS.forEach((id) => $(id)?.addEventListener('click', install));
  updateInstallUi();
}

function updateInstallUi() {
  const show = !isStandalone() && (!!deferredPrompt || isIos());
  INSTALL_BUTTONS.forEach((id) => { const btn = $(id); if (btn) btn.hidden = !show; });
  const note = $('install-note');
  if (!note) return;
  if (isStandalone()) note.textContent = 'Running as an installed app.';
  else if (show) note.textContent = 'Install the app to open it from your home screen without the browser address bar.';
  else note.textContent = 'This browser does not offer installation here. Use Chrome or Edge (Android, Windows, macOS) or Safari on iPhone/iPad. HTTPS is required.';
}

async function install() {
  if (deferredPrompt) {
    const prompt = deferredPrompt;
    deferredPrompt = null;   // a prompt event can only be used once
    prompt.prompt();
    await prompt.userChoice.catch(() => null);
    updateInstallUi();
    return;
  }
  if (isIos()) {
    await infoDialog({
      title: 'Install on iPhone or iPad',
      text: '1. Open this page in Safari.\n2. Tap the Share button (square with an arrow).\n3. Choose “Add to Home Screen”, then “Add”.\n\nOpen the app from your Home Screen. On iPhone, notifications only work in the Home Screen app (iOS 16.4 or later).',
    });
  }
}

/** The active service worker registration, or null where unsupported. */
export async function getServiceWorker() {
  const reg = await registration;
  if (!reg) return null;
  return navigator.serviceWorker.ready;
}
