/**
 * Public pages: the generic "My Offers" homepage, the sign-in screen navigation and
 * the member page shown after ANY unsuccessful sign-in (wrong password, unknown email,
 * an account that is not allowed). They name no real company, collect nothing and
 * link nowhere; offer buttons only show a toast.
 *
 * The member page is camouflage, not security. It is fully static: it never signs
 * anyone in, never talks to Firebase and never stores anything. Firebase still
 * rate-limits sign-in attempts and the security rules still protect the data.
 *
 * History: the sign-in and member pages each get one history entry, so the Back
 * button (and "Sign out" / "Back to offers") returns to the homepage.
 */
import { $, showScreen, toast, isScreenShown } from './ui.js';

let bound = false;

export function initPublicPages() {
  if (bound) return;
  bound = true;

  for (const id of ['home-screen', 'decoy-screen']) {
    $(id).addEventListener('click', (e) => {
      if (e.target.closest('.decoy-offer-btn')) toast('This offer is no longer available.');
    });
  }
  $('home-signin').addEventListener('click', openLogin);
  $('login-back').addEventListener('click', leavePage);
  $('decoy-signout').addEventListener('click', leavePage);
  window.addEventListener('popstate', () => {
    if (isScreenShown('login') || isScreenShown('decoy')) showHome();
  });
}

/** Back to the homepage, through the browser history when there is an entry for it. */
function leavePage() {
  if (history.state?.page) history.back();
  else showHome();
}

export function showHome() {
  showScreen('home');
}

export function openLogin() {
  showScreen('login');
  if (history.state?.page !== 'login') history.pushState({ page: 'login' }, '');
  $('login-email').focus();
}

export function showDecoy() {
  showScreen('decoy');
  // Replaces the sign-in entry, so Back goes to the homepage, not to the form.
  if (history.state?.page) history.replaceState({ page: 'decoy' }, '');
  else history.pushState({ page: 'decoy' }, '');
  $('decoy-screen').scrollTop = 0;
}

export const isDecoyShown = () => isScreenShown('decoy');

/** Drops the sign-in history entry once the real app has opened. */
export function clearPageHistory() {
  if (history.state?.page) history.replaceState(null, '');
}
