# PrivateChat

A private web app for exactly **two people** with real-time chat, audio calls and video calls.
It can be installed to the home screen as an app (PWA). Notifications are coded: they never show who wrote, what was written, or who is calling.

The site itself is static (GitHub Pages, no build step). Server-side logic lives in Firebase: security rules, plus three small Cloud Functions that send content-free push notifications.

| Layer | Technology |
|---|---|
| UI | HTML5, CSS3, vanilla JavaScript ES modules (no framework) |
| App install | Web App Manifest + service worker (PWA) |
| Auth | Firebase Authentication (email/password, two allowlisted UIDs), session-only sign-in, one active session per account |
| Data & signalling | Cloud Firestore (real-time listeners), enforced by `firestore.rules` |
| Calls | WebRTC (`RTCPeerConnection`, `getUserMedia`), STUN, optional TURN, ICE restart on network change |
| Background push | Firebase Cloud Messaging + Cloud Functions (Node 22, **Blaze plan**) |
| SDK | Firebase JS SDK **10.12.2** from `https://www.gstatic.com/firebasejs/` (one pinned version) |
| Hosting | GitHub Pages (works under a sub-path such as `/PrivateChat/`), HTTPS |

---

## Contents

1. [Features](#1-features)
2. [Project structure](#2-project-structure)
3. [Setup and deployment (step by step)](#3-setup-and-deployment-step-by-step)
4. [TURN server (for networks where calls fail)](#4-turn-server-for-networks-where-calls-fail)
5. [Firestore data model](#5-firestore-data-model)
6. [Security and privacy model](#6-security-and-privacy-model)
7. [Testing](#7-testing)
8. [Platform limitations (read this)](#8-platform-limitations-read-this)
9. [Cost and Firestore usage](#9-cost-and-firestore-usage)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Features

**Install as an app (PWA)**
- An "Install App" button appears on the login screen, in the sidebar header and in Settings → App whenever the browser can install the app: Chrome, Edge or Samsung Internet on Android, Windows, macOS and ChromeOS.
- On iPhone and iPad the button shows the manual steps (Share → Add to Home Screen).
- The installed app opens standalone, without the browser address bar. Its name is the neutral **"My Offers"** with a generic price-tag icon, because Android shows the app name and icon above every notification. Inside the app nothing else changes.
- The service worker caches only the site's own HTML, CSS, JS and icons, never chat data.

**Private (coded) notifications**
- Notifications never contain names, phone numbers, profile pictures, message text or the call type. They only show a coded text you choose, for example *Special Offer Update — Your code M101 is available*.
- You set a separate code per event in Settings → Notifications. The title, the text template (`{code}` is replaced) and the silent mode are configurable too.

  | Event | Default title | Default text |
  |---|---|---|
  | New message | Special Offer Update | Your code M101 is available |
  | Audio call | Special Offer Update | Your code C101 is available |
  | Video call | Special Offer Update | Your code V101 is available |
  | Missed call | Special Offer Update | Your code MC101 is available |

- The codes are stored **only on the device** (IndexedDB). The push payload sent through Google carries just an event kind (`m`, `a`, `v` or `mc`), and the service worker turns it into your text.
- **Tapping a notification** opens or focuses the app at its plain start address (no deep link, query or fragment) and goes straight to a sign-in form. The conversation shows only after the correct **email and password**. A wrong entry shows the same member page as a wrong main sign-in. If the app was already open and signed in, it locks first: call screens, dialogs and toasts stay hidden, and a wrong entry also ends that session. (Set `LOCK_ON_NOTIFICATION_TAP` in `js/app.js` to `false` to only bring an open app to the front.) This second sign-in is checked with a separate, temporary sign-in, so the running session is not affected.
- Notifications are delivered in two ways. While the app is open but not on screen (for example a background tab), the page reports events to the service worker. With background push (Blaze + Cloud Functions) they also arrive while the app or browser is closed, wherever the OS allows. **The service worker is the only place notifications are shown**, so both paths follow the same rules: none while the app is on screen and in focus (Safari must show every push), one per event kind, and a burst of messages replaces the notification silently instead of alerting once per message.
- **Devices.** Every device where notifications were turned on keeps receiving them **whether or not anyone is signed in on it**: after closing the app, after logging out, and after a sign-in elsewhere (for example a phone when the laptop signs in). Only the Settings switch stops them on a device. Registrations are refreshed at each sign-in and daily while the app is open; ones not refreshed for 270 days are removed by the Cloud Function. A device must have signed in and turned notifications on once to be registered.
- The silent option uses the OS default with no app-specific ringtone. The in-app ringtone only plays while the app is open.

**Messaging**
- Real-time chat bubbles with sent/received styling, day separators and timestamps.
- Delivery ticks: 🕓 sending → ✓ sent → ✓✓ delivered → ✓✓ (cyan) read.
- Typing indicator and online / "last seen" status.
- Auto-scroll at the bottom, with a "new messages" button otherwise.
- Multiline input. On desktop, Enter sends and Shift+Enter adds a new line.
- Empty messages and messages over 4000 characters are blocked. Duplicate sends are prevented.
- Long messages collapse behind "Show more". Older messages load as you scroll up.
- Unread counter on the contact, in the tab title and as the app badge where supported.

**Deleting history** (every deletion asks for confirmation first)

| What | Delete for me | Delete for everyone |
|---|---|---|
| One message (tap it, then 🗑) | Hidden from your view on every device you sign in to | Your own messages only: replaced by "This message was deleted" for both |
| Whole conversation (🗑 in the chat header) | Every message is hidden from your view | **Every message is permanently erased for both people** |
| All chat history (Settings → Chat history) | Messages and call history hidden from your view | All messages and all finished calls permanently erased for both |

Deletions are stored in Firestore, so they survive refresh, logout and logging in on another device. The rules ensure only the two members can delete anything. "For everyone" on the whole conversation is allowed to either person, by design.

**Audio and video calls**
- Start, ring, accept, decline, cancel and end calls. A no-answer timeout records a missed call, and busy and glare (both call at once) are handled.
- States shown in the app: Calling → Ringing → Connecting → Connected (with a timer) → Reconnecting → ended, declined, missed or disconnected. Call history includes missed calls.
- **Reconnection:** if the network changes mid-call (for example Wi-Fi to mobile data), the caller restarts ICE. The call only ends if it can't recover within 30 s.
- Mute, camera on/off, camera switching and a draggable self-view. The screen stays awake during calls.
- **Audio privacy notice:** the call screen shows "Headphones detected", or a warning that audio may play on the loudspeaker. The app never switches to the loudspeaker itself. See §8 for why it can't force the earpiece.

**Permissions**
- Notifications, microphone and camera are each requested only after a related tap: notifications from the Settings switch, the microphone when starting or answering a call, the camera only for video calls.
- The current state is checked first. If the browser is about to ask, a short explanation appears beforehand.
- If access is blocked, the app never re-triggers the browser prompt. It shows platform-specific steps (Android, iPhone, desktop) to re-enable access.

**Sign-in and sessions**
- **Public homepage.** Opening the site shows a generic "My Offers" deals page with a **Sign in** button. Nothing on it, in the page title or in the metadata refers to chat or calls.
- **Wrong login → member page.** A wrong email or password (or a valid account that is not one of the two) opens a static "Welcome back" member page (points, saved offers, orders) instead of an error. It names no real company, collects nothing, loads no data and never signs anyone in. Its ordinary **Sign out** link (or the Back button) returns to the homepage. Network and "too many attempts" errors still show normally. It is camouflage only: Firebase still rate-limits attempts and the rules still protect the data.
- **Authorization gate.** The chat, presence and call modules are loaded only after the server has accepted the sign-in as one of the two members (the `sessions/` write), so visitors and other accounts never load or run them. The files themselves are still downloadable by anyone who knows their URLs.
- **One active tab per browser.** A duplicated tab (which shares the sign-in) shows "My Offers is open in another tab or window" with a **Use here** button instead of running a second copy. Logging out in one tab signs out the browser's other tabs.
- **Session-only sign-in.** The password is required again after the browser tab, the browser or the installed app has been closed. The sign-in token lives in sessionStorage, never in localStorage, and passwords are never stored. If a browser restores a closed session ("continue where you left off"), the app signs it out unless it was in use within the last 10 minutes.
- **One active session per account, enforced by the server.** A new login on another device takes over immediately. The rules reject every request from the old sign-in, even with an unexpired token. The old device is notified in real time, ends any call, drops all chat data from memory and shows *"Your account was logged in on another device."*
- Chat data is cached **in memory only**, so nothing is left on the device after closing or signing out.
- Logout asks for confirmation and reloads the page. Notifications stay on for that device; turn them off in Settings first to stop them.

**Settings:** theme, sounds, private notifications and codes, microphone, camera and (desktop) speaker selection, chat history deletion, app install, display name, app info and logout.

---

## 2. Project structure

```
PrivateChat/                 # repository root = GitHub Pages site root
├── index.html               # single page: login, chat, call UI, modals, inline SVG icon sprite
├── manifest.json            # PWA manifest (neutral name "My Offers")            [new]
├── sw.js                    # service worker: app-shell cache + coded push        [new]
├── README.md
├── .gitignore
├── .nojekyll                # tells GitHub Pages to serve files as-is
├── firestore.rules          # ⚠ put your two UIDs here
├── firestore.indexes.json   # composite index + TTL policies
├── firebase.json            # Firebase CLI: rules, indexes, functions, emulator
├── css/
│   ├── style.css            # design tokens (light/dark), base, login, modals, toasts
│   ├── chat.css             # layout, sidebar, messages, composer
│   ├── calls.css            # incoming call + in-call screen
│   └── responsive.css       # mobile / landscape rules
├── js/
│   ├── firebase-config.js   # ⚠ your Firebase config, the two UIDs, VAPID key, STUN/TURN
│   ├── firebase.js          # SDK initialisation (session-only auth, memory cache, App Check)
│   ├── theme-boot.js        # applies theme before first paint; anti-clickjacking
│   ├── app.js               # entry point, session lifecycle, presence UI, mobile navigation
│   ├── auth.js              # login form, allowlist check, logout, password reset
│   ├── session.js           # single active session + restored-session guard     [new]
│   ├── chat.js              # messages, pagination, receipts, composer, deletion
│   ├── presence.js          # online/typing/read/clear markers, server clock offset
│   ├── calls.js             # call signalling state machine, ICE restart, call UI, history
│   ├── webrtc.js            # media capture, ICE servers, RTCPeerConnection wrapper
│   ├── notifications.js     # tones, coded notifications, unread/title
│   ├── notify-config.js     # coded notification texts (stored on the device)    [new]
│   ├── push.js              # FCM token registration for background push         [new]
│   ├── pwa.js               # service worker registration + Install App buttons  [new]
│   ├── permissions.js       # permission checks, explanations, re-enable help   [new]
│   ├── settings.js          # preferences, theme, devices, settings modal
│   └── ui.js                # DOM helpers, toasts, dialogs, formatting
├── assets/icons/            # app-icon.svg, icon-192/512.png, icon-maskable-512.png,
│                            # apple-touch-icon.png, badge-96.png (+ old favicon.svg)
├── functions/               # Cloud Functions (Blaze plan) — not served by GitHub Pages [new]
│   ├── package.json
│   └── index.js             # ⚠ REGION + the two UIDs
└── tests/                   # Firestore rules tests (Node + emulator)
    ├── package.json
    └── rules.test.mjs
```

---

## 3. Setup and deployment (step by step)

> **Upgrading an existing installation?** Do Steps 6, 7b, 7c and 14 (rules, plan, push, functions), then deploy the site. Publish the **rules first** and the **site right after**: the new app needs the new rules (`sessions/`), and old open tabs simply need a reload. Everyone signs in once more after the upgrade.

### Step 1: Create a Firebase project
1. Open <https://console.firebase.google.com> and click **Create a project**.
2. Choose a name. Google Analytics is not needed.

### Step 2: Register a web app and copy its config
1. In **Project settings → General → Your apps**, click the **Web** icon (`</>`).
2. Give it a nickname. You do **not** need Firebase Hosting.
3. Copy the `firebaseConfig` values into `js/firebase-config.js` → `FIREBASE_CONFIG`. These values are public identifiers, not secrets.

### Step 3: Enable email/password sign-in and block self-registration
1. **Authentication → Get started → Sign-in method → Email/Password → Enable** (leave "Email link" off).
2. **Authentication → Settings → User actions**: **untick "Enable create (sign-up)"** and **untick "Enable deletion"**.
3. Leave **Email enumeration protection** enabled (the default).

### Step 4: Create exactly two users and get their UIDs
1. **Authentication → Users → Add user**: enter the email and a strong password for person 1, then repeat for person 2.
2. Copy each user's **User UID** from the Users table.

### Step 5: Put the UIDs in ALL THREE places
- `js/firebase-config.js` → `ALLOWED_UIDS`
- `firestore.rules` → `user1Uid()` / `user2Uid()`
- `functions/index.js` → `ALLOWED_UIDS`

The rules are the real security boundary. The JavaScript list only shows a friendly error.

### Step 6: Create the Firestore database and publish the rules
1. **Firestore Database → Create database** → choose **Production mode** and a location near you. Note the location: the Cloud Functions must use the matching region (Step 14).
2. Open the **Rules** tab, replace everything with your edited `firestore.rules`, and click **Publish**. Or run `firebase deploy --only firestore` (Step 14).

### Step 7: Create the index and TTL policies
**Composite index (required for call history).** Go to **Firestore → Indexes → Composite → Create index**:
- Collection ID: `calls`
- Fields: `participants` → **Arrays**, then `createdAt` → **Descending**
- Query scope: Collection

This one index also serves the "call history deleted for me" query. The message queries only need automatic single-field indexes.

**TTL policies (recommended)** delete old ICE-candidate documents automatically. Go to **Firestore → Time-to-live → Create policy** twice:
- Collection group `callerCandidates`, timestamp field `expiresAt`
- Collection group `calleeCandidates`, timestamp field `expiresAt`

### Step 7b: Upgrade to the Blaze plan (needed for background push)
Background notifications need a server to send them, and Firebase only runs Cloud Functions on the pay-as-you-go **Blaze** plan.
1. In the Firebase console, open **Usage and billing → Details & settings → Modify plan → Blaze**, then link a billing account.
2. **Set a budget alert** (Google Cloud → Billing → Budgets & alerts), for example at 1 USD/month.

Two users normally stay inside the free quotas (see §9). This is likely but not guaranteed.

If you skip this step, everything else still works. Coded notifications then appear only while the app is open, for example in a background tab.

### Step 7c: Create the Web Push key (VAPID)
1. **Project settings → Cloud Messaging → Web configuration → Web Push certificates → Generate key pair.**
2. Copy the **public** key into `js/firebase-config.js` → `FCM_VAPID_KEY`. It is public by design.
3. If you restricted the browser API key by **API** (Google Cloud → Credentials), also allow **Firebase Installations API** and **FCM Registration API**.

### Step 8 (recommended): Firebase Hosting on a neutral custom domain
Keep the repository **private** and publish only the web files with Firebase Hosting. `firebase.json` already excludes `README.md`, `functions/`, `tests/`, the rules files and `*.txt`, and sends real security headers (CSP with `frame-ancestors 'none'`, HSTS, `nosniff`, Referrer-Policy, Permissions-Policy).
1. **Hosting → Get started**, then `firebase deploy --only hosting`.
2. **Hosting → Add custom domain** with a neutral name. Do not share the default `<project-id>.web.app` address: the project ID is visible in it.
3. Add the domain to **Authentication → Authorized domains** and to the API key's website restrictions (Step 11).
4. If you set `TURN_CREDENTIALS_URL`, add its origin to `connect-src` in the `Content-Security-Policy` header in `firebase.json`.
5. After switching, retire the old GitHub Pages site so it stops serving the old files.

Steps 8b–10 below describe the older GitHub Pages setup; with Firebase Hosting, skip them.

### Step 8b: Create the GitHub repository
1. Create a **private** repository with a neutral name. A public repository exposes this README, the rules (with both UIDs) and the functions to anyone.
2. Upload the **contents** of this folder so that `index.html`, `manifest.json` and `sw.js` sit at the repository root.

### Step 9: Enable GitHub Pages (HTTPS)
1. **Settings → Pages → Build and deployment**: Source **Deploy from a branch**, Branch **main**, folder **/ (root)** → **Save**.
2. Tick **Enforce HTTPS**. PWAs, service workers, push, the camera and the microphone all require HTTPS. GitHub Pages provides it for `*.github.io`.
3. After a minute the site is live at `https://<user>.github.io/PrivateChat/`. All paths are relative, so the sub-path works, including the service worker scope.

### Step 10: Authorize the GitHub Pages domain in Firebase
**Authentication → Settings → Authorized domains → Add domain** → `<user>.github.io`, without a path or `https://`.

### Step 11: Harden the API key (recommended)
In **Google Cloud Console → APIs & Services → Credentials**, open the "Browser key". Under **Application restrictions → Websites**, add `https://<user>.github.io/*` (and `http://localhost/*` for local tests).

### Step 12 (optional): App Check
Create a reCAPTCHA v3 key for your domain, register it in **Firebase → App Check**, put the **site key** in `APP_CHECK_SITE_KEY`, and enforce App Check once its metrics look clean. App Check raises the bar, but it is not authentication. The UID allowlist rules remain the protection.

### Step 13: First run and two-device test
Open the site on two devices, sign in as each person, and follow the [testing guide](#7-testing).

### Step 14: Deploy the Cloud Functions (background push)
Do this on a computer with **Node.js 22+**:
```bash
npm install -g firebase-tools
firebase login
firebase use --add            # choose your project
cd functions && npm install && cd ..
# ⚠ first set REGION and ALLOWED_UIDS in functions/index.js
firebase deploy --only functions,firestore
```
The first deploy enables the Cloud Functions, Eventarc and Artifact Registry APIs. Accept the prompts.

`REGION` must match the Firestore location: `nam5` → `us-central1`, `eur3` → `europe-west1`, otherwise the same region name, for example `asia-south1`.

The functions are:
- `notifyNewMessage`: new message → `{k:'m'}`
- `notifyIncomingCall`: new ringing call → `{k:'a'}` or `{k:'v'}`, with a 40 s TTL
- `notifyMissedCall`: unanswered or cancelled call → `{k:'mc'}`

To update the site later, push to GitHub. Pages republishes and the service worker fetches new files network-first. After changing `firestore.rules` or `functions/`, deploy them again.

---

## 4. TURN server (for networks where calls fail)

WebRTC first tries a **direct peer-to-peer** connection, using free Google STUN servers. This works on most home Wi-Fi and many mobile networks, but **not all**. Symmetric NATs, some carrier-grade NATs, strict corporate or school firewalls, and some hotel networks block it. The call then shows *"Could not connect … a TURN relay is needed"*.

A **TURN server** relays the still end-to-end encrypted media (DTLS-SRTP). Relaying uses bandwidth, so TURN services usually charge. **Never put a TURN shared secret in this repo.** Two safe options are supported in `js/firebase-config.js`:
1. **`TURN_CREDENTIALS_URL`**: a provider endpoint returning short-lived credentials (`[{urls, username, credential}]` or `{iceServers:[…]}`).
2. **A static entry in `ICE_SERVERS`**, only with restricted, rotatable credentials.

TURN also makes ICE restarts after network changes far more reliable.

---

## 5. Firestore data model

```
sessions/{uid}
  authTime (int, = auth_time of the account's newest sign-in), updatedAt

users/{uid}
  uid, displayName, state ('online'|'offline'), lastActive,
  typing (bool), typingAt, lastReadAt, lastDeliveredAt,
  [clearedAt], [callsClearedAt]   legacy (v2.0) location of the "deleted for me" markers, still read
  [wipedAt]          this user erased the conversation for everyone (other app reloads)

users/{uid}/private/markers              clearedAt, callsClearedAt   ("deleted for me" up to here; owner only)
users/{uid}/hiddenMessages/{messageId}   createdAt            (single messages deleted for me)
users/{uid}/pushTokens/{sha256(token)}   token, authTime, updatedAt   (owner + Cloud Functions only)

conversations/main/messages/{messageId}
  senderId, text (≤4000), createdAt (server time), deleted (bool), [deletedAt]

calls/{callId}
  callerId, calleeId, participants [caller, callee], type ('audio'|'video'),
  status, offer {type,sdp}, [answer {type,sdp}],
  createdAt, updatedAt, [acceptedAt, endedAt, endedBy, endReason],
  [restartN, restartOffer {type,sdp}, restartAnswerN, restartAnswer {type,sdp}]   (ICE restarts)

calls/{callId}/callerCandidates/{"0".."99"}   candidate, sdpMid, sdpMLineIndex, usernameFragment, createdAt, expiresAt
calls/{callId}/calleeCandidates/{"0".."99"}   (same)
```

Design choices:
- **Single active session.** `auth_time` is set by Google at sign-in and signed into every ID token of that sign-in. On sign-in the app writes it to `sessions/{uid}`. The rules allow that only when it is not older than the stored value, so the newest login always wins a race. Every other rule requires `request.auth.token.auth_time == sessions/{uid}.authTime`.
- **Deletion markers are server-side and private.** Queries ask only for messages and calls after `clearedAt` / `callsClearedAt`, so cleared history never comes back after a refresh or a new login. The markers live in an owner-only document, so the other person cannot see when you cleared your history.
- **Read receipts and typing cost no per-message writes** (`lastReadAt` / `lastDeliveredAt` markers).
- **Bounded listeners.** One live listener covers the newest 30 messages, with pagination for older ones, and call history shows the last 15 calls.
- **No duplicates.** Message ids are generated by the client, and the rules are create-only.
- **Server time everywhere** (`createdAt == request.time`), plus a per-session clock-offset estimate.
- **Bounded ICE.** Candidate ids are `0..99` per side per call. A TTL policy cleans them up.

### Call state machine (enforced by rules)

```
             callee: accepted (+answer)              either: ended | failed
 ringing ───────────────────────────────▶ accepted ─────────────────────────▶ (terminal)
    │ callee: rejected | busy | missed      ↺ caller: restartOffer n+1 / callee: restartAnswer n
    │ caller: cancelled | missed
    ▼
 (terminal)
```
Terminal calls can be deleted by a participant ("clear history for everyone"). Ringing and accepted calls can't be deleted, except an accepted call abandoned for more than a day.

---

## 6. Security and privacy model

**Enforced server-side (`firestore.rules`, tested in `tests/rules.test.mjs`):**
- Every read and write requires one of the two allowlisted UIDs **and** the account's current session (`auth_time` check). Old sessions are rejected immediately, even with unexpired tokens.
- Only known paths exist, and everything else is denied.
- Users write only their own profile, deletion markers, hidden list and push tokens. Push tokens are never readable by the other member.
- Messages: no impersonation, validated text, server time, no edits. Only the sender can blank a message. Either member may erase messages (the whole-conversation wipe, by the owners' decision).
- Calls: only the participants, with every transition following the state machine above, including ICE restarts.

**Cloud Functions (`functions/index.js`)** run with admin rights but only read and clean up `pushTokens`. They send `{k: kind}` and nothing else, to the recipient's devices that refreshed their registration within 270 days. Their logs contain the event kind and counts only.

**Client-side measures:**
- All user text is rendered with `textContent`. A strict Content-Security-Policy meta tag and frame-busting are in place.
- No passwords anywhere in storage. The auth token is in sessionStorage. Chat data is held in memory only, and old IndexedDB caches from v1 are deleted on start.
- After logout or session takeover, the page reloads so no copy of the conversation remains.
- Notifications use only the on-device codes. Notification content, codes and tokens are never logged. Console logs contain error codes only.
- The service worker never caches Firebase traffic.

**Limitations a static site cannot remove:**
- The Firebase config and API key are public by design. Protection comes from the rules, plus optional App Check and API-key restrictions.
- If either account's password is compromised, the attacker sees what that user sees. Logging in also signs the real user out, which at least makes it visible.
- Messages are encrypted in transit and at rest by Google, but they are **not end-to-end encrypted**: project admins can read them. Calls are end-to-end encrypted (DTLS-SRTP).
- Peer-to-peer calls reveal each person's IP address to the other. Use TURN with `ICE_TRANSPORT_POLICY = 'relay'` to hide it.
- GitHub Pages cannot send security headers, so the CSP is a `<meta>` tag.

---

## 7. Testing

### 7.1 Automated Firestore rules tests (emulator)
Requires Node.js 18+ and Java 11+.
```bash
cd tests
npm install
npm test        # starts the Firestore emulator and runs node --test rules.test.mjs
```
Covers: the allowlist, single active session (claim, take-over, stale tokens rejected, forged `auth_time`), messages, delete-for-me markers, push-token privacy, conversation wipe (in 20-document batches), call state machine, ICE restarts, call deletion and ICE candidates.

### 7.2 Android (Chrome), browser tab
1. Open `https://<user>.github.io/PrivateChat/`. The login screen shows **Install App** after a few seconds, once Chrome decides the app is installable.
2. Sign in, then send messages both ways.
3. Open **Settings → Notifications → Private notifications**. An explanation appears, then Chrome's prompt; allow it. Save your codes and tap **Send test**: you should see your coded title and text.
4. Switch to another app and send a message from the other device. The notification shows only your coded text. Tapping it brings the app back behind the sign-in form (email and password).
5. Start an audio call. The microphone explanation appears, then Chrome's prompt. While connected, the call screen shows the audio-route pill. Without headphones it says *May play on loudspeaker — use headphones*.
6. Toggle Wi-Fi off and on during a call: the screen shows "Reconnecting…", then the call continues (or ends after about 30 s if no network returns).
7. Close Chrome completely (swipe it away) and reopen the page. The password is required.

### 7.3 Android, installed app (PWA)
1. Tap **Install App** → Install. "My Offers" appears on the home screen and opens without the address bar.
2. Sign in, turn on private notifications and confirm Settings shows *"Background notifications are active on this device"*.
3. Close the app (swipe it away). From the other device, send a message, place a call and let it go unanswered. Expected: coded notifications for M, C (or V) and MC. Tapping one opens the app at the homepage.
4. Open the app within 40 s of a call push. It asks for the password (session-only), and once you sign in the call is still ringing and can be answered.
5. Device check: Android Settings → Apps → My Offers → Notifications must be allowed, and battery optimisation set to "unrestricted" for reliable push on Xiaomi, Oppo, Vivo, Samsung and similar.

### 7.4 Desktop (Chrome / Edge)
1. Click the install icon in the address bar or the **Install App** button. The app opens in its own window.
2. Notifications, calls, deletion and session tests work the same as on Android. In Settings → Audio & video devices, choose a headset as the speaker. The call pill then shows "Headphones detected".

### 7.5 iPhone / iPad (Safari, iOS 16.4+)
1. Tap **Install App** to see the steps: Share → Add to Home Screen → Add. Open the app from the Home Screen.
2. Notifications only work in the Home Screen app: turn them on in Settings inside the app.

### 7.6 Single session and deletion
1. Sign in as person 1 on phone A, then as person 1 on laptop B. Phone A immediately ends any call and shows *"Your account was logged in on another device."*
2. Delete a received message **for me**: it disappears on this device, stays for the other person, and stays gone after a reload and a new login.
3. Delete your own message **for everyone**: both see "This message was deleted".
4. Chat header 🗑 → **Delete for everyone**: both conversations become empty, also after a refresh.
5. Settings → **Clear all chat history → Delete for me**: messages and call history are empty for you only.

### 7.7 Requirement checklist

| # | Requirement | How it is met | Status |
|---|---|---|---|
| 1 | PWA install, standalone, Android + desktop, iOS instructions, HTTPS | `manifest.json`, `sw.js`, `pwa.js`, GitHub Pages HTTPS | Implemented, needs device test |
| 2 | Coded notifications, configurable title and codes, no content in payload, tap opens the start page (open app locks) | `notify-config.js`, `sw.js`, `functions/index.js` (`{k}` only) | Implemented. Background push needs Blaze + deploy |
| 3 | Delete message / conversation / all; for me / for everyone; confirmation; persistent; authorized | `chat.js`, `calls.js`, `app.js`, rules + tests | Implemented, rules tests written |
| 4 | Permissions: check state, explain, ask on action, help after denial, never re-prompt | `permissions.js`, `calls.js`, `settings.js` | Implemented |
| 5 | Audio calling with accept, reject, cancel, end, states, reconnection, private call push | `calls.js`, `webrtc.js`, `notifyIncomingCall` / `notifyMissedCall` | Implemented, with browser limits in §8 |
| 6 | Earpiece or headphones only | Never routes to the loudspeaker; honest indicator and warning | **Cannot be enforced in a browser**, see §8 |
| 7 | Separate codes per event, generic text, no call type or name, silent option | `notify-config.js`, Settings | Implemented |
| 8 | Session-only login, no passwords stored, restore guard, single active session enforced by server | `firebase.js`, `session.js`, rules | Implemented, rules tests written |
| 9 | Existing stack kept, no frameworks | Firebase + vanilla JS | Done |
| 10 | Security: HTTPS, auth, authorization, no sensitive payloads or logs | Rules, CSP, functions | Implemented |

The manual tests above need your Firebase project and real devices. They could not be run in the build environment.

---

## 8. Platform limitations (read this)

**Background notifications and calls.** These limits come from the browsers and operating systems, not from this app.
- **A web app cannot ring like a phone call when it is closed.** A push can only show a normal notification. There is no full-screen incoming-call screen, no ringtone loop, and no answering from the notification. Tapping the notification opens the app at its homepage. A call keeps ringing for 40 s, and the app still shows it if you sign in within that time.
- **Android:** push works for installed apps and Chrome while the app or browser is closed, unless the user force-stops Chrome or battery optimisation is aggressive. Some vendors delay pushes, especially Xiaomi, Oppo, Vivo, Huawei and some Samsung modes. The notification header always shows the app name ("My Offers") or, in a browser tab, the website address. That can't be hidden.
- **iPhone/iPad:** push works only for apps added to the Home Screen, on iOS 16.4+. iOS may group or delay notifications.
- **Desktop:** push arrives while the browser is running, even with no tab open. Nothing arrives if the browser is fully closed.
- **Sound:** "Silent" asks the OS for no sound. Otherwise the OS or browser default sound is used. Web apps can't set a custom notification ringtone, and Android lets the user change it per app.
- **For reliable ringing calls in the background**, you would need a native Android app using `ConnectionService` / `TelecomManager` (or a self-managed `ConnectionService`) with FCM high-priority data messages and a full-screen-intent notification. A WebView wrapper (for example Capacitor) can reuse this web UI for everything else.

**Earpiece-only call audio.**
- No web API can select the phone earpiece versus the loudspeaker, or block the loudspeaker. `setSinkId()` only picks among devices the browser lists, and on Android Chrome that is usually just "default".
- On many Android phones, Chrome plays WebRTC call audio on the **loudspeaker** unless wired or Bluetooth headphones are connected. Headphones, when connected, are normally preferred by the OS.
- Headphone detection is only possible where the browser exposes device names (mostly desktop). The app therefore never claims audio is private. It shows "Headphones detected" only when the browser reports a headset as the output, and otherwise warns *"May play on loudspeaker — use headphones"*.
- **Strict earpiece-only** needs a native Android app (a WebView or Capacitor wrapper; a TWA is not enough because it is still Chrome). It would use `AudioManager.setMode(MODE_IN_COMMUNICATION)` with `setCommunicationDevice(TYPE_BUILTIN_EARPIECE)` on Android 12+ (or `setSpeakerphoneOn(false)` on older versions), and switch to `TYPE_WIRED_HEADSET` / `TYPE_BLUETOOTH_SCO` when connected.

**Sessions.**
- Two logins in the **same second** on two devices get the same `auth_time`, so both stay valid until one of them signs in again. This is a theoretical edge case.
- Every new browser tab is a new sign-in (session-only storage), and it takes over from the previous tab or device.
- Browser tab vs installed app: both require the password after being closed. Push keeps working for both, because the token belongs to the device and the session, not to an open page. Closing is not logging out, and neither closing nor **Log out** stops push to that device; only the Settings switch does.
- "Continue where you left off" can restore session storage. The 10-minute restore guard catches a real browser restart, but a restart within 10 minutes keeps you signed in.
- Firestore checks rules when a listener starts. A *modified* old client might keep receiving an already-open real-time stream until its connection is re-established. The unmodified app disconnects itself immediately, and every new read or write is rejected. Verify this with the emulator if it matters to you.

**Other.**
- **Presence is approximate** (60 s heartbeat, about 2.5 min to "last seen").
- **Autoplay:** sound starts only after one interaction. If remote audio is blocked, "Tap to enable sound" appears.
- **ICE restart** needs a working path. Without TURN, some network changes still end the call after 30 s.
- **Audio and video calls are separate.** There is no switching mid-call.
- **No message editing, attachments or group chats.**
- **Firestore TTL deletion** happens within about 24 h of expiry.

---

## 9. Cost and Firestore usage

Firestore quotas: 50k reads, 20k writes and 20k deletes per day free. Cloud Functions on Blaze include 2M invocations per month free. FCM is free. Rough figures while the app is open:

| Activity | Writes | Reads |
|---|---|---|
| Presence heartbeat | 1 per minute per open device | about 2 per heartbeat (+1 for the session check) |
| Sign-in | 2–3 (session, presence, push token) | 2–3 |
| Sending a message | 1 + occasional receipt | 1 per listener + 1 session check, plus 2 in the push function |
| A call | 1 create + 2–4 updates + about 10–40 candidates | similar, plus 2 in the push function |
| App load | 1–2 | up to about 30 messages + 15 calls (memory cache, so every load reads again) |
| Delete for everyone | 1 delete per message / call | 1 read per document |

The session check (`get(sessions/{uid})` in the rules) adds about one billed read per request or listener start. Two people stay far inside the free quotas, but set a budget alert anyway (Step 7b). The first functions deploy may store a few cents of container images in Artifact Registry each month.

---

## 10. Troubleshooting

| Symptom | Fix |
|---|---|
| "Setup required" screen | Fill in `FIREBASE_CONFIG` and both `ALLOWED_UIDS` in `js/firebase-config.js`. |
| "Signed in, but the database denied access" | UIDs in `firestore.rules` don't match, or the **new** rules (with `sessions/`) were not published. |
| Immediately "logged in on another device" | Another device or tab signed in later, so sign in again here. If it happens without any other login, check the device clock and that the rules were published together with the site. |
| No **Install App** button | Use HTTPS and Chrome/Edge. The app may already be installed, or Chrome may need a few seconds and some interaction. On iPhone, use Safari. |
| Settings says background push "not set up" | `FCM_VAPID_KEY` is empty, the browser lacks push support, or an API-key restriction blocks FCM (Step 7c). |
| Push enabled but nothing arrives when closed | Functions not deployed or wrong `REGION` (check Firebase → Functions → Logs), app notifications disabled in Android settings, or battery optimisation. |
| `auth/unauthorized-domain` | Add your `github.io` domain under Authentication → Authorized domains. |
| "Call history needs a Firestore index" | Create the composite index (Step 7). |
| Calls ring but never connect | Configure TURN (§4) or test on another network. |
| No camera/mic prompt, or "requires HTTPS" | Use the `https://` URL. `localhost` is allowed. |
| "… blocked" dialog | Follow the steps shown. The browser won't ask again until you change the site setting. |
| Changes don't show after uploading | Wait a minute and reload twice (the service worker updates in the background). |
| Blank page | Open DevTools → Console. A 404 usually means a file or folder was not uploaded. |

### Local testing (optional)
ES modules and service workers don't work from `file://`. Serve the folder with `npx serve .` or `python -m http.server 8080` and open `http://localhost:8080` (localhost counts as secure).
