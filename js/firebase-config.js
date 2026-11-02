/**
 * ============================================================================
 *  App configuration — EDIT THIS FILE BEFORE DEPLOYING
 * ============================================================================
 *
 *  1. FIREBASE_CONFIG: paste the web-app config from
 *     Firebase console → Project settings → General → Your apps → SDK setup (Config).
 *     These values are PUBLIC identifiers, not secrets. Security comes from
 *     firestore.rules (UID allowlist), not from hiding this object.
 *
 *  2. ALLOWED_UIDS: the Firebase Auth UIDs of the two people allowed to use the app.
 *     The SAME two UIDs must also be written into firestore.rules — the rules are
 *     what actually enforce access. This list only gives a friendly client-side error.
 *
 *  3. ICE_SERVERS / TURN: see README → "TURN server". Never put a TURN *shared secret*
 *     here. Only use short-lived credentials or a credentials URL from your provider.
 */

export const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyCUhUcf2mjaEJK3UOqUXMZ4RoZemrIO5jo',
  authDomain: 'privatechat-4f011.firebaseapp.com',
  projectId: 'privatechat-4f011',
  storageBucket: 'privatechat-4f011.firebasestorage.app',
  messagingSenderId: '56735281511',
  appId: '1:56735281511:web:0b6ff8aa9d5c5395693fc2',
};

/** Exactly two Firebase Authentication UIDs. Must match firestore.rules and functions/index.js. */
export const ALLOWED_UIDS = [
  'wxC2B1XFgtaoIFOVTUjhBOAxoKi1', // person 1
  'Ce6xiyk5gJenhC3eRNcVnnCJr6t1', // person 2
];

/**
 * Background push (Firebase Cloud Messaging). Paste the PUBLIC key from
 * Firebase console → Project settings → Cloud Messaging → Web Push certificates.
 * It is public by design. Leave empty to disable background push; coded
 * notifications then only appear while the app is open (e.g. in a background tab).
 * Background push also needs the Cloud Functions in functions/ (Blaze plan) — see README.
 */
export const FCM_VAPID_KEY = '';

/**
 * Optional Firebase App Check (reCAPTCHA v3) site key. Leave empty to disable.
 * If you enable App Check *enforcement* for Firestore in the console, this must be set.
 */
export const APP_CHECK_SITE_KEY = '';

/**
 * STUN servers are free and help most home/mobile networks connect peer-to-peer.
 * They do NOT work for every network (symmetric NAT, strict corporate firewalls,
 * some mobile carriers). For those you need a TURN relay — see below.
 */
export const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  // Optional static TURN entry (only if your provider issues restricted, rotatable credentials):
  // { urls: ['turn:turn.example.com:3478', 'turns:turn.example.com:5349'], username: 'user', credential: 'short-lived-password' },
];

/**
 * Optional URL that returns fresh TURN credentials as JSON at call time, either
 * `[{ urls, username, credential }, ...]` or `{ iceServers: [...] }`.
 * Many TURN providers offer such an endpoint. Leave empty to use only ICE_SERVERS.
 */
export const TURN_CREDENTIALS_URL = '';

/**
 * 'all'   — try direct peer-to-peer first, use TURN only when needed (default).
 * 'relay' — always go through TURN, hiding each person's IP address from the other.
 *           Only works when a TURN server is configured above.
 */
export const ICE_TRANSPORT_POLICY = 'all';

/** The single shared conversation document id. Must match firestore.rules. */
export const CONVERSATION_ID = 'main';

export const APP_VERSION = '2.4.1';
