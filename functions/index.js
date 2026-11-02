/**
 * Cloud Functions: private push notifications (requires the Blaze plan).
 *
 * Privacy rules this file follows:
 *  - A push carries ONLY an event kind: { k: 'm' | 'a' | 'v' | 'mc' } (new message,
 *    audio call, video call, missed call). Never a name, phone number, message text,
 *    caller, call id or anything else from the database. The service worker on the
 *    device turns the kind into the coded title/text the user configured there.
 *  - Pushes go to EVERY device of the recipient that turned notifications on and
 *    refreshed its registration within TOKEN_MAX_AGE_DAYS (the app refreshes it at each
 *    sign-in and daily while open). A device keeps notifying after a sign-in elsewhere;
 *    logging out or switching notifications off on a device removes it. Older
 *    registrations are deleted here (FCM tokens of unused installs go stale).
 *  - Logs contain the event kind and counts only — no uids, tokens or content.
 *
 * Deploy: see README → "Background push".
 */
'use strict';

const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { setGlobalOptions } = require('firebase-functions/v2');
const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const logger = require('firebase-functions/logger');

// ⚠ Must match your Firestore database location (Firebase console → Firestore → the
// location shown above the data): nam5 → 'us-central1', eur3 → 'europe-west1',
// otherwise the same region name, e.g. 'asia-south1'.
const REGION = 'us-central1';

// ⚠ The same two UIDs as js/firebase-config.js and firestore.rules.
const ALLOWED_UIDS = ['wxC2B1XFgtaoIFOVTUjhBOAxoKi1', 'Ce6xiyk5gJenhC3eRNcVnnCJr6t1'];

const MESSAGE_TTL_S = 24 * 3600;
const CALL_TTL_S = 40;            // a call push arriving after the ringing window is useless
const TOKEN_MAX_AGE_DAYS = 60;
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

setGlobalOptions({ region: REGION, maxInstances: 2 });
initializeApp();
const db = getFirestore();

const otherOf = (uid) => (ALLOWED_UIDS.includes(uid) ? ALLOWED_UIDS.find((u) => u !== uid) : null);

async function pushTo(uid, kind, ttlSeconds) {
  if (!uid || !ALLOWED_UIDS.includes(uid)) return;
  const tokens = await db.collection(`users/${uid}/pushTokens`).get();
  const oldest = Date.now() - TOKEN_MAX_AGE_DAYS * 24 * 3600_000;
  const isFresh = (d) => (d.get('updatedAt')?.toMillis?.() ?? 0) >= oldest;
  const targets = tokens.docs.filter(isFresh);
  const stale = tokens.docs.filter((d) => !isFresh(d));
  await Promise.all(stale.map((d) => d.ref.delete()));
  if (!targets.length) {
    logger.info('push', { kind, sent: 0, stale: stale.length });
    return;
  }

  // While a device is offline, pushes wait at the push service for up to TTL seconds
  // and are delivered when it reconnects. `Topic` makes a newer push of the same kind
  // replace one still waiting, so reconnecting shows one notification, not a burst.
  // On the device, sw.js also collapses bursts into one alert.
  const result = await getMessaging().sendEach(targets.map((d) => ({
    token: d.get('token'),
    data: { k: kind },   // data-only: the service worker decides what is displayed
    webpush: { headers: { Urgency: 'high', TTL: String(ttlSeconds), Topic: `mo-${kind}` } },
  })));

  await Promise.all(result.responses.map((r, i) => (
    DEAD_TOKEN_CODES.has(r.error?.code) ? targets[i].ref.delete() : null
  )));
  logger.info('push', { kind, sent: result.successCount, failed: result.failureCount, stale: stale.length });
}

exports.notifyNewMessage = onDocumentCreated('conversations/{conversationId}/messages/{messageId}', async (event) => {
  const msg = event.data?.data();
  if (!msg || msg.deleted) return;
  await pushTo(otherOf(msg.senderId), 'm', MESSAGE_TTL_S);
});

exports.notifyIncomingCall = onDocumentCreated('calls/{callId}', async (event) => {
  const call = event.data?.data();
  if (!call || call.status !== 'ringing') return;
  await pushTo(call.calleeId, call.type === 'video' ? 'v' : 'a', CALL_TTL_S);
});

exports.notifyMissedCall = onDocumentUpdated('calls/{callId}', async (event) => {
  const before = event.data?.before.data();
  const after = event.data?.after.data();
  if (!before || !after || before.status !== 'ringing') return;
  if (!['missed', 'cancelled'].includes(after.status) || after.acceptedAt) return;
  // 'collision' = both called at once (not missed); 'stale' = noticed by the callee's own app.
  if (['collision', 'stale'].includes(after.endReason)) return;
  await pushTo(after.calleeId, 'mc', MESSAGE_TTL_S);
});
