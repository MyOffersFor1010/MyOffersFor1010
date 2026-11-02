/**
 * Email/password authentication. There is intentionally no sign-up flow:
 * the two accounts are created manually in the Firebase console.
 *
 * The client-side allowlist check below is only for a friendly error message.
 * The real enforcement is the UID allowlist in firestore.rules.
 */
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { auth } from './firebase.js';
import { ALLOWED_UIDS } from './firebase-config.js';
import { $, friendlyError, setButtonLoading, toast } from './ui.js';
import { showDecoy } from './decoy.js';

// Errors that mean "wrong email or password" (network/rate-limit errors still show text).
const WRONG_CREDENTIALS = new Set([
  'auth/invalid-credential', 'auth/invalid-login-credentials', 'auth/wrong-password',
  'auth/user-not-found', 'auth/user-disabled',
]);

export const isAllowedUid = (uid) => ALLOWED_UIDS.includes(uid);

export function getPeerUid(myUid) {
  return ALLOWED_UIDS.find((uid) => uid !== myUid) || null;
}

export function showLoginError(message) {
  const el = $('login-error');
  el.textContent = message;
  el.hidden = !message;
}

let formBound = false;
let signedInHere = false;

/** True when the password was entered in this page load (not a restored sign-in). */
export const wasSignedInHere = () => signedInHere;

export function initLoginForm() {
  if (formBound) return;
  formBound = true;

  const form = $('login-form');
  const submit = $('login-submit');
  let submitting = false;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submitting) return;
    const email = $('login-email').value.trim();
    const password = $('login-password').value;
    if (!email || !password) {
      showLoginError('Please enter your email and password.');
      return;
    }
    submitting = true;
    showLoginError('');
    setButtonLoading(submit, true);
    try {
      // Set before signing in: the auth listener in app.js can fire before this resolves.
      signedInHere = true;
      const cred = await signInWithEmailAndPassword(auth, email, password);
      if (!isAllowedUid(cred.user.uid)) {
        // A real account that is not allowed here: same member page as a wrong password.
        signedInHere = false;
        await signOut(auth).catch(() => {});
        $('login-password').value = '';
        showDecoy();
        return;
      }
      $('login-password').value = '';
    } catch (err) {
      signedInHere = false;
      if (WRONG_CREDENTIALS.has(err?.code)) {
        // Wrong email/password: show the decoy offers page instead of an error.
        $('login-password').value = '';
        showDecoy();
        return;
      }
      // Not a wrong password (that path stays silent): keep the code for troubleshooting.
      console.warn('Sign-in failed:', err?.code || err?.name || '');
      showLoginError(friendlyError(err, 'Sign-in failed. Please try again.'));
    } finally {
      submitting = false;
      setButtonLoading(submit, false);
    }
  });

  $('toggle-password').addEventListener('click', () => {
    const input = $('login-password');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('toggle-password').setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });

  $('forgot-password').addEventListener('click', async () => {
    const email = $('login-email').value.trim();
    if (!email) {
      showLoginError('Enter your email above, then tap “Forgot password?” again.');
      $('login-email').focus();
      return;
    }
    try {
      await sendPasswordResetEmail(auth, email);
    } catch (err) {
      // Do not reveal whether the account exists; only surface config/network problems.
      if (['auth/invalid-email', 'auth/network-request-failed', 'auth/too-many-requests'].includes(err?.code)) {
        showLoginError(friendlyError(err));
        return;
      }
    }
    showLoginError('');
    toast('If that email belongs to an account, a reset link has been sent.', { type: 'success', duration: 6000 });
  });
}

/**
 * Calls back with (user | null). Accounts that are not allowed are signed out
 * immediately and reported as `rejected: true`; no message ever says why.
 */
export function watchAuth(callback) {
  return onAuthStateChanged(auth, async (user) => {
    if (user && !isAllowedUid(user.uid)) {
      await signOut(auth).catch(() => {});
      callback(null, { rejected: true });
      return;
    }
    callback(user, { rejected: false });
  });
}

export async function logout() {
  await signOut(auth);
}

export const currentUser = () => auth.currentUser;
