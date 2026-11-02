/**
 * Call signalling over Firestore + call UI.
 *
 * Document: calls/{callId}
 *   callerId, calleeId, participants[2], type ('audio'|'video'),
 *   status: ringing → accepted → ended | failed
 *           ringing → rejected | busy | cancelled | missed      (terminal)
 *   offer {type,sdp}, answer {type,sdp}, createdAt, updatedAt, acceptedAt, endedAt, endedBy, endReason
 * Subcollections: callerCandidates/{0..99}, calleeCandidates/{0..99}
 *
 * firestore.rules enforce who may perform each transition and that terminal states
 * can never change, so a stale or malicious client cannot "revive" or hijack a call.
 *
 * Robustness rules implemented here:
 *  - Only ONE call object exists locally at a time (`active`). Every async step
 *    re-checks `isActive(c)` so late results from an abandoned call are discarded.
 *  - Glare (both users press call at the same moment): the user with the
 *    lexicographically smaller UID keeps their call; the other cancels theirs and
 *    sees the incoming call instead. Both sides compute the same answer.
 *  - Ringing calls older than STALE_RING_MS (by server-corrected time) are ignored
 *    and marked missed, so a crashed tab can never leave a "ghost" call ringing.
 *  - Local state alone decides "busy"; stale `accepted` docs never block new calls.
 *  - Network changes during a connected call trigger an ICE restart (the caller sends
 *    a numbered restartOffer, the callee a restartAnswer) before the call is given up.
 *  - OS notifications for calls only show the coded text (notify-config.js); names and
 *    call types stay inside the app.
 */
import {
  collection,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  getDoc,
  getDocs,
  writeBatch,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  serverTimestamp,
  Timestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { db } from './firebase.js';
import { $, toast, paintAvatar, formatDuration, formatListTime, icon, friendlyError } from './ui.js';
import { PeerSession, getLocalMedia, getIceServers, callSupportError, MediaAccessError } from './webrtc.js';
import {
  startRinging, stopRinging, playEndSound, notifyPrivate, closeNotification, setTitleOverride,
} from './notifications.js';
import { serverNow } from './presence.js';
import { getPrefs, supportsSinkId } from './settings.js';
import { ensureMediaPermission, showPermissionHelp } from './permissions.js';

const RING_TIMEOUT_MS = 40_000;        // caller gives up → "missed"
const STALE_RING_MS = 50_000;          // callee ignores ringing docs older than this
const CONNECT_TIMEOUT_MS = 30_000;     // accepted but ICE never connected
const DISCONNECT_GRACE_MS = 12_000;    // before first connect: brief blips often recover by themselves
const RECONNECT_GRACE_MS = 30_000;     // after a drop mid-call: time allowed for ICE restarts
const RESTART_AFTER_MS = 3_000;        // wait this long in "disconnected" before restarting ICE
const MAX_RESTARTS = 5;
const RESTART_ANSWER_TIMEOUT_MS = 8_000;   // give up waiting for a restart answer and retry
const MAX_CANDIDATES = 100;            // matches the ^[0-9]{1,2}$ id rule
const CANDIDATE_TTL_MS = 24 * 3600_000;
const DELETE_BATCH = 20;            // rules allow at most 20 document lookups per batch
const HEADSET_LABEL = /head(set|phone)|earphone|earbud|airpods|buds|bluetooth|hands-?free/i;

let ctx = null;                        // { myUid, peerUid, getPeerName }
let active = null;                     // the current call (see newCall)
let unsubIncoming = null;
let unsubHistory = null;
let uiBound = false;
let wakeLock = null;
let preparingCall = false;             // permission explanation is open for an outgoing call
let callsClearedAt = null;             // Date: call history up to here is deleted for me
let deferredIncoming = null;           // peer's call we ignored after winning a glare tie-break

const isActive = (c) => c !== null && active === c;

function newCall({ id, ref, role, type, offer = null }) {
  return {
    id, ref, role, type, offer,
    status: role === 'caller' ? 'starting' : 'ringing', // local UI status
    remoteStatus: role === 'caller' ? null : 'ringing', // last known Firestore status
    peer: null,
    localStream: null,
    docReady: role === 'callee',     // may we write candidates yet?
    pendingLocal: [],
    candidateCount: 0,
    writtenCandidates: [],
    answerApplied: false,
    accepting: false,
    restartN: 0,                     // caller: last ICE restart offer sent
    restartPending: false,           // caller: waiting for that restart's answer
    restartHandled: 0,               // callee: last ICE restart offer answered
    connectedAt: 0,
    timers: {},
    unsubs: [],
    micOn: true,
    cameraOn: type === 'video',
  };
}

/* ======================================================================
   Public API
   ====================================================================== */

export function initCalls({ myUid, peerUid, getPeerName, previousLastActive, myCallsClearedAt }) {
  destroyCalls();
  ctx = { myUid, peerUid, getPeerName };
  callsClearedAt = myCallsClearedAt || null;
  bindUi();
  watchIncoming();
  watchHistory(previousLastActive);
}

export function destroyCalls() {
  if (active) hangUp();
  unsubIncoming?.();
  unsubHistory?.();
  unsubIncoming = unsubHistory = null;
  deferredIncoming = null;
  ctx = null;
  $('call-history').replaceChildren();
}

export const isInCall = () => active !== null;

/** Updates names/avatars on visible call UI when the peer renames themselves. */
export function refreshCallPeer() {
  if (!ctx) return;
  const name = ctx.getPeerName();
  $('incoming-name').textContent = name;
  $('call-peer-name').textContent = name;
  paintAvatar($('incoming-avatar'), name, ctx.peerUid);
  paintAvatar($('call-avatar'), name, ctx.peerUid);
}

/* ======================================================================
   Outgoing calls
   ====================================================================== */

export async function startCall(type) {
  if (!ctx || preparingCall) return;
  if (active) { toast('You are already in a call.', { type: 'warning' }); return; }
  const unsupported = callSupportError();
  if (unsupported) { toast(unsupported, { type: 'error', duration: 7000 }); return; }
  if (!navigator.onLine) { toast('You are offline.', { type: 'error' }); return; }

  // Microphone (+ camera) permission: explain first, never re-prompt after a denial.
  preparingCall = true;
  let allowed;
  try { allowed = await ensureMediaPermission(type); } finally { preparingCall = false; }
  if (!allowed || !ctx || active) return;

  const ref = doc(collection(db, 'calls'));
  const c = newCall({ id: ref.id, ref, role: 'caller', type });
  active = c;
  showCallScreen(c);
  setCallStatus(c, type === 'video' ? 'Starting camera…' : 'Starting microphone…');

  try {
    const stream = await getLocalMedia(type);
    if (!isActive(c)) { stream.getTracks().forEach((t) => t.stop()); return; }
    c.localStream = stream;
    attachLocalPreview(c);

    const iceServers = await getIceServers();
    if (!isActive(c)) return;
    createPeer(c, iceServers);

    setCallStatus(c, 'Calling…');
    const offer = await c.peer.createOffer();
    if (!isActive(c)) return;

    await setDoc(ref, {
      callerId: ctx.myUid,
      calleeId: ctx.peerUid,
      participants: [ctx.myUid, ctx.peerUid],
      type,
      status: 'ringing',
      offer,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    c.remoteStatus = 'ringing';
    if (!isActive(c)) {
      // Ended (e.g. glare resolution) while the write was in flight.
      updateCall(c, { status: 'cancelled', endedAt: serverTimestamp(), endReason: c.abortReason || 'cancelled' });
      return;
    }
    c.status = 'ringing';
    c.docReady = true;
    flushLocalCandidates(c);
    setCallStatus(c, 'Ringing…');
    startRinging('outgoing');
    watchCallDoc(c);

    c.timers.ring = setTimeout(() => {
      if (!isActive(c) || c.remoteStatus !== 'ringing') return;
      endRinging(c, { status: 'missed', endedAt: serverTimestamp(), endReason: 'no-answer' });
      endLocal(c, `${ctx.getPeerName()} didn’t answer.`);
    }, RING_TIMEOUT_MS);
  } catch (err) {
    if (!isActive(c)) return;
    if (c.remoteStatus === 'ringing') endRinging(c, { status: 'cancelled', endedAt: serverTimestamp(), endReason: 'error' });
    const msg = err instanceof MediaAccessError ? err.message : friendlyError(err, 'Could not start the call.');
    endLocal(c, msg, 'error');
    if (isPermissionDenial(err)) showPermissionHelp(type === 'video' ? ['microphone', 'camera'] : ['microphone']);
  }
}

const isPermissionDenial = (err) => err instanceof MediaAccessError && ['NotAllowedError', 'SecurityError'].includes(err.cause);

/* ======================================================================
   Incoming calls
   ====================================================================== */

function watchIncoming() {
  const q = query(collection(db, 'calls'), where('calleeId', '==', ctx.myUid), where('status', '==', 'ringing'));
  unsubIncoming = onSnapshot(q, (snap) => {
    for (const change of snap.docChanges()) {
      if (change.type === 'added') handleIncomingDoc(change.doc);
    }
  }, (err) => {
    console.error('Incoming call listener error:', err?.code);
    toast(friendlyError(err, 'Incoming calls are unavailable. Reload the page.'), { type: 'error', duration: 8000 });
  });
}

async function handleIncomingDoc(snap) {
  const data = snap.data();
  if (!ctx || data.callerId !== ctx.peerUid) return;
  const createdMs = data.createdAt?.toMillis?.() ?? serverNow();
  const age = serverNow() - createdMs;

  if (age > STALE_RING_MS) {
    // A ringing call left behind by a crashed/closed tab: close it so history is correct.
    updateDoc(snap.ref, { status: 'missed', endedAt: serverTimestamp(), updatedAt: serverTimestamp(), endReason: 'stale' }).catch(() => {});
    return;
  }

  if (active) {
    if (active.id === snap.id) return;
    const glare = active.role === 'caller' && (active.status === 'starting' || active.status === 'ringing');
    if (glare && ctx.myUid < ctx.peerUid) {
      // We win the tie-break: keep our call. The peer cancels theirs on their side.
      // Remember their call in case ours fails before it reaches them (endLocal).
      deferredIncoming = snap.ref;
      return;
    }
    if (glare) {
      // We yield: cancel our outgoing call silently, then show theirs.
      const mine = active;
      mine.abortReason = 'collision';
      if (mine.remoteStatus === 'ringing') updateCall(mine, { status: 'cancelled', endedAt: serverTimestamp(), endReason: 'collision' });
      endLocal(mine, null);
    } else {
      updateDoc(snap.ref, { status: 'busy', endedAt: serverTimestamp(), updatedAt: serverTimestamp(), endReason: 'busy' }).catch(() => {});
      toast(`${ctx.getPeerName()} tried to call you.`, { type: 'warning' });
      return;
    }
  }

  const c = newCall({ id: snap.id, ref: snap.ref, role: 'callee', type: data.type === 'video' ? 'video' : 'audio', offer: data.offer });
  active = c;
  showIncoming(c);
  watchCallDoc(c);

  c.timers.ring = setTimeout(() => {
    if (!isActive(c) || c.status !== 'ringing') return;
    updateCall(c, { status: 'missed', endedAt: serverTimestamp(), endReason: 'no-answer' });
    endLocal(c, null);
    announceMissed(c);
  }, Math.max(5_000, RING_TIMEOUT_MS + 5_000 - age));
}

function showIncoming(c) {
  const name = ctx.getPeerName();
  $('incoming-name').textContent = name;
  paintAvatar($('incoming-avatar'), name, ctx.peerUid);
  $('incoming-type').textContent = c.type === 'video' ? 'Incoming video call' : 'Incoming audio call';
  $('accept-icon').firstElementChild.setAttribute('href', c.type === 'video' ? '#i-video' : '#i-phone');
  $('incoming-call').hidden = false;
  $('accept-call').focus({ preventScroll: true });
  startRinging('incoming');
  // The tab title can show in the task switcher, so it stays neutral too.
  setTitleOverride('•');
  notifyPrivate(c.type === 'video' ? 'v' : 'a');
}

function hideIncoming() {
  $('incoming-call').hidden = true;
  stopRinging();
  closeNotification('a');
  setTitleOverride('');
}

function announceMissed(c) {
  const name = ctx?.getPeerName() || 'Contact';
  const label = c.type === 'video' ? 'video call' : 'call';
  toast(`Missed ${label} from ${name}`, { type: 'warning', duration: 8000 });
  notifyPrivate('mc');
}

async function acceptCall() {
  const c = active;
  if (!c || c.role !== 'callee' || c.status !== 'ringing' || c.accepting) return;
  // Permission check while it keeps ringing; if refused, the user can still decline.
  c.accepting = true;
  let allowed;
  try { allowed = await ensureMediaPermission(c.type); } finally { c.accepting = false; }
  if (!allowed || !isActive(c) || c.status !== 'ringing') return;
  c.status = 'connecting';
  hideIncoming();
  showCallScreen(c);
  setCallStatus(c, 'Connecting…');

  const unsupported = callSupportError();
  if (unsupported) {
    updateCall(c, { status: 'rejected', endedAt: serverTimestamp(), endReason: 'unsupported' });
    endLocal(c, unsupported, 'error');
    return;
  }

  try {
    const stream = await getLocalMedia(c.type);
    if (!isActive(c)) { stream.getTracks().forEach((t) => t.stop()); return; }
    c.localStream = stream;
    attachLocalPreview(c);

    const iceServers = await getIceServers();
    if (!isActive(c)) return;
    createPeer(c, iceServers);
    const answer = await c.peer.acceptOffer(c.offer);
    if (!isActive(c)) return;

    // The rules only allow ringing → accepted, so this fails cleanly if the caller hung up meanwhile.
    await updateDoc(c.ref, { status: 'accepted', answer, acceptedAt: serverTimestamp(), updatedAt: serverTimestamp() });
    c.remoteStatus = 'accepted';
    if (!isActive(c)) {
      // The user hung up while the accept was in flight: end it properly for the caller.
      updateCall(c, { status: 'ended', endedAt: serverTimestamp(), endedBy: ctx.myUid, endReason: 'hangup' });
      return;
    }
    c.docReady = true;
    flushLocalCandidates(c);
    listenRemoteCandidates(c);
    startConnectTimeout(c);
  } catch (err) {
    if (!isActive(c)) return;
    if (err instanceof MediaAccessError) {
      updateCall(c, { status: 'rejected', endedAt: serverTimestamp(), endReason: 'media-error' });
      endLocal(c, err.message, 'error');
      if (isPermissionDenial(err)) showPermissionHelp(c.type === 'video' ? ['microphone', 'camera'] : ['microphone']);
    } else if (err?.code === 'permission-denied') {
      endLocal(c, 'This call is no longer available.', 'warning');
    } else {
      updateCall(c, { status: 'rejected', endedAt: serverTimestamp(), endReason: 'error' });
      endLocal(c, friendlyError(err, 'Could not answer the call.'), 'error');
    }
  }
}

function rejectCall() {
  const c = active;
  if (!c || c.role !== 'callee' || c.status !== 'ringing') return;
  updateCall(c, { status: 'rejected', endedAt: serverTimestamp(), endReason: 'declined' });
  endLocal(c, null);
}

/* ======================================================================
   Shared signalling
   ====================================================================== */

function watchCallDoc(c) {
  const unsub = onSnapshot(c.ref, (snap) => {
    if (!isActive(c) || !snap.exists()) return;
    const data = snap.data();
    const prev = c.remoteStatus;
    c.remoteStatus = data.status;
    const name = ctx.getPeerName();

    if (c.role === 'caller' && data.status === 'accepted' && data.answer && !c.answerApplied) {
      c.answerApplied = true;
      clearTimeout(c.timers.ring);
      stopRinging();
      c.status = 'connecting';
      setCallStatus(c, 'Connecting…');
      c.peer.applyAnswer(data.answer)
        .then(() => { if (isActive(c)) { listenRemoteCandidates(c); startConnectTimeout(c); } })
        .catch(() => failCall(c, 'Could not establish the call.'));
      return;
    }

    // ICE restart: callee answers each new numbered offer; caller applies the answer.
    if (data.status === 'accepted' && c.peer) {
      if (c.role === 'callee' && data.restartOffer && (data.restartN || 0) > c.restartHandled) {
        const n = data.restartN;
        c.restartHandled = n;
        c.peer.acceptRestartOffer(data.restartOffer)
          .then((answer) => (isActive(c)
            ? updateDoc(c.ref, { restartAnswerN: n, restartAnswer: answer, updatedAt: serverTimestamp() })
            : null))
          .catch((err) => {
            // Allow this offer to be handled again if the caller re-sends it.
            if (c.restartHandled === n) c.restartHandled = n - 1;
            console.debug('ICE restart answer skipped', err?.code || err?.name);
          });
      } else if (c.role === 'caller' && c.restartPending && data.restartAnswer && data.restartAnswerN === c.restartN) {
        c.restartPending = false;
        clearTimer(c, 'restartAnswer');
        c.peer.applyRestartAnswer(data.restartAnswer)
          .catch((err) => console.debug('ICE restart answer not applied', err?.name));
      }
    }

    switch (data.status) {
      case 'rejected':
        if (c.role === 'caller') endLocal(c, data.endReason === 'media-error' ? `${name} couldn’t access their microphone/camera.` : `${name} declined the call.`);
        break;
      case 'busy':
        if (c.role === 'caller') endLocal(c, `${name} is on another call.`);
        break;
      case 'cancelled':
      case 'missed':
        if (c.role === 'callee' && c.status === 'ringing') {
          endLocal(c, null);
          if (data.endReason !== 'collision') announceMissed(c);
        } else if (c.role === 'callee' && prev === 'ringing') {
          // Cancelled while we were still accepting (e.g. the camera prompt was open).
          endLocal(c, `${name} ended the call before it connected.`);
        } else if (c.role === 'caller' && prev === 'ringing') {
          endLocal(c, `${name} didn’t answer.`);
        }
        break;
      case 'accepted':
        // Answered in another tab/device of this same account.
        if (c.role === 'callee' && c.status === 'ringing') endLocal(c, 'Call answered on another device.');
        break;
      case 'ended':
        if (data.endedBy !== ctx.myUid) endLocal(c, 'Call ended.');
        break;
      case 'failed':
        endLocal(c, 'The call was disconnected.', 'warning');
        break;
      default:
        break;
    }
  }, (err) => {
    if (isActive(c)) endLocal(c, friendlyError(err, 'Lost connection to the call.'), 'error');
  });
  c.unsubs.push(unsub);
}

function createPeer(c, iceServers) {
  c.peer = new PeerSession({
    iceServers,
    localStream: c.localStream,
    isCaller: c.role === 'caller',
    onLocalCandidate: (cand) => {
      if (!isActive(c)) return;
      if (c.docReady) writeCandidate(c, cand);
      else c.pendingLocal.push(cand);
    },
    onRemoteStream: (stream) => { if (isActive(c)) attachRemote(c, stream); },
    onStateChange: (state) => { if (isActive(c)) onConnectionState(c, state); },
    onControlMessage: (msg) => { if (isActive(c)) onControl(c, msg); },
  });
}

function flushLocalCandidates(c) {
  const queued = c.pendingLocal.splice(0);
  queued.forEach((cand) => writeCandidate(c, cand));
}

/**
 * Candidate docs use ids "0".."99" and are create-only, so a call can never
 * produce more than 100 docs per side (enforced by rules, not just here).
 */
function writeCandidate(c, cand) {
  if (c.candidateCount >= MAX_CANDIDATES) return;
  const id = String(c.candidateCount++);
  const sub = c.role === 'caller' ? 'callerCandidates' : 'calleeCandidates';
  c.writtenCandidates.push(doc(c.ref, sub, id));
  setDoc(doc(c.ref, sub, id), {
    candidate: String(cand.candidate || ''),
    sdpMid: cand.sdpMid ?? null,
    sdpMLineIndex: Number.isInteger(cand.sdpMLineIndex) ? cand.sdpMLineIndex : null,
    usernameFragment: cand.usernameFragment ?? null,
    createdAt: serverTimestamp(),
    expiresAt: Timestamp.fromMillis(Date.now() + CANDIDATE_TTL_MS),
  }).catch((err) => console.debug('Candidate write skipped', err?.code));
}

function listenRemoteCandidates(c) {
  const sub = c.role === 'caller' ? 'calleeCandidates' : 'callerCandidates';
  const unsub = onSnapshot(collection(c.ref, sub), (snap) => {
    if (!isActive(c)) return;
    for (const change of snap.docChanges()) {
      if (change.type !== 'added') continue;
      const d = change.doc.data();
      c.peer?.addRemoteCandidate({
        candidate: d.candidate,
        sdpMid: d.sdpMid ?? null,
        sdpMLineIndex: d.sdpMLineIndex ?? null,
        ...(d.usernameFragment ? { usernameFragment: d.usernameFragment } : {}),
      });
    }
  }, () => { /* the call-doc listener handles fatal errors */ });
  c.unsubs.push(unsub);
}

function startConnectTimeout(c) {
  clearTimeout(c.timers.connect);
  c.timers.connect = setTimeout(() => {
    if (isActive(c) && !c.connectedAt) {
      failCall(c, 'Could not connect. The networks may block direct connections — a TURN relay is needed (see README).');
    }
  }, CONNECT_TIMEOUT_MS);
}

function clearTimer(c, name) {
  clearTimeout(c.timers[name]);
  c.timers[name] = null;
}

/**
 * The connection dropped. Before the first connect, wait briefly as before. Once the
 * call was connected, the caller restarts ICE (new network path) and the call is only
 * given up if nothing recovers within RECONNECT_GRACE_MS.
 */
function handleDrop(c, failedNow) {
  if (!c.connectedAt) {
    if (failedNow) {
      failCall(c, 'Could not connect. The networks may block direct connections — a TURN relay is needed (see README).');
      return;
    }
    if (!c.timers.disconnect) {
      c.timers.disconnect = setTimeout(() => { if (isActive(c)) failCall(c, 'Connection lost.'); }, DISCONNECT_GRACE_MS);
    }
    return;
  }
  $('call-quality').hidden = false;
  setCallStatus(c, 'Reconnecting…');
  if (!c.timers.disconnect) {
    c.timers.disconnect = setTimeout(() => { if (isActive(c)) failCall(c, 'Connection lost.'); }, RECONNECT_GRACE_MS);
  }
  if (c.role === 'caller' && !c.timers.restart) {
    c.timers.restart = setTimeout(() => { c.timers.restart = null; restartIce(c); }, failedNow ? 0 : RESTART_AFTER_MS);
  }
}

async function restartIce(c) {
  if (!isActive(c) || c.role !== 'caller' || c.restartPending || c.restartN >= MAX_RESTARTS) return;
  if (c.peer?.lastState === 'connected') return;
  c.restartPending = true;
  try {
    const offer = await c.peer.createRestartOffer();
    if (!offer || !isActive(c)) { c.restartPending = false; return; }
    c.restartN += 1;
    // While offline this write waits in the queue and is sent as soon as the network is back.
    await updateDoc(c.ref, { restartN: c.restartN, restartOffer: offer, updatedAt: serverTimestamp() });
    // If no answer comes back, undo the pending offer so another attempt is possible
    // (otherwise the connection stays in "have-local-offer" and every retry is skipped).
    clearTimer(c, 'restartAnswer');
    c.timers.restartAnswer = setTimeout(async () => {
      c.timers.restartAnswer = null;
      if (!isActive(c) || !c.restartPending) return;
      c.restartPending = false;
      await c.peer?.rollbackOffer().catch(() => {});
      restartIce(c);
    }, RESTART_ANSWER_TIMEOUT_MS);
  } catch (err) {
    c.restartPending = false;
    console.debug('ICE restart skipped', err?.code || err?.name);
  }
}

function onConnectionState(c, state) {
  if (state === 'connected') {
    clearTimer(c, 'connect');
    clearTimer(c, 'disconnect');
    clearTimer(c, 'restart');
    $('call-quality').hidden = true;
    if (!c.connectedAt) {
      c.connectedAt = Date.now();
      c.status = 'connected';
      startTimer(c);
      requestWakeLock(c);
    }
    setCallStatus(c, 'Connected');
    // Sync our current mic/camera state once the data channel is likely open.
    c.peer.sendControl({ type: 'mic', enabled: c.micOn });
    if (c.type === 'video') c.peer.sendControl({ type: 'camera', enabled: c.cameraOn });
  } else if (state === 'disconnected') {
    if (!c.connectedAt) {
      $('call-quality').hidden = false;
      setCallStatus(c, 'Reconnecting…');
    }
    handleDrop(c, false);
  } else if (state === 'failed') {
    handleDrop(c, true);
  }
}

function onControl(c, msg) {
  if (msg.type === 'channel-open') {
    c.peer.sendControl({ type: 'mic', enabled: c.micOn });
    if (c.type === 'video') c.peer.sendControl({ type: 'camera', enabled: c.cameraOn });
  } else if (msg.type === 'camera' && c.type === 'video') {
    c.remoteCameraOn = !!msg.enabled;
    updateRemoteVideoVisibility(c);
  } else if (msg.type === 'mic') {
    c.remoteMicOn = !!msg.enabled;
    if (c.connectedAt) setCallStatus(c, c.remoteMicOn ? 'Connected' : `${ctx.getPeerName()} is muted`);
  } else if (msg.type === 'hangup') {
    endLocal(c, 'Call ended.');
  }
}

/** Writes a status transition; failures (e.g. already terminal) are harmless. */
function updateCall(c, fields) {
  return updateDoc(c.ref, { ...fields, updatedAt: serverTimestamp() }).catch((err) => {
    console.debug('Call update skipped', err?.code);
  });
}

/**
 * Caller ends a call that is still ringing (cancel / no answer / error). If the callee
 * accepted at that same moment, the rules refuse ringing → cancelled|missed; the call
 * is then ended as an accepted call, so the callee is not left on "Connecting…".
 */
function endRinging(c, fields) {
  const uid = ctx?.myUid;
  return updateDoc(c.ref, { ...fields, updatedAt: serverTimestamp() }).catch((err) => {
    if (err?.code !== 'permission-denied' || !uid) return;
    return updateDoc(c.ref, {
      status: 'ended', endedAt: serverTimestamp(), endedBy: uid,
      endReason: fields.endReason || 'cancelled', updatedAt: serverTimestamp(),
    }).catch((e) => console.debug('Call update skipped', e?.code));
  });
}

function failCall(c, message) {
  if (!isActive(c)) return;
  if (c.remoteStatus === 'accepted') {
    updateCall(c, { status: 'failed', endedAt: serverTimestamp(), endedBy: ctx.myUid, endReason: 'connection' });
  }
  endLocal(c, message, 'error');
}

/** User pressed the red button (or the page is closing). */
export function hangUp() {
  const c = active;
  if (!c) return;
  if (c.role === 'callee' && c.status === 'ringing') { rejectCall(); return; }
  if (c.remoteStatus === 'ringing') {
    // Caller cancels; a callee who is still mid-accept declines instead (the rules
    // make whichever write lands second fail, so the doc always ends consistent).
    if (c.role === 'caller') endRinging(c, { status: 'cancelled', endedAt: serverTimestamp(), endReason: 'cancelled' });
    else updateCall(c, { status: 'rejected', endedAt: serverTimestamp(), endReason: 'declined' });
  } else if (c.remoteStatus === 'accepted') {
    c.peer?.sendControl({ type: 'hangup' });
    updateCall(c, { status: 'ended', endedAt: serverTimestamp(), endedBy: ctx.myUid, endReason: 'hangup' });
  }
  endLocal(c, null);
}

/**
 * Single cleanup path for every way a call can finish. Releases camera/mic,
 * closes the RTCPeerConnection, detaches listeners and timers, and resets the UI.
 */
function endLocal(c, message, toastType = 'info') {
  if (!isActive(c)) return;
  active = null;

  Object.values(c.timers).forEach((t) => { clearTimeout(t); clearInterval(t); });
  c.unsubs.forEach((u) => { try { u(); } catch { /* already detached */ } });
  c.unsubs = [];

  const wasLive = c.status !== 'ringing' || c.role === 'caller';
  hideIncoming();
  stopRinging();
  c.peer?.close();
  c.localStream?.getTracks().forEach((t) => t.stop());
  hideCallScreen();
  releaseWakeLock();
  if (wasLive) playEndSound();

  if (message) toast(c.connectedAt ? `${message} (${formatDuration((Date.now() - c.connectedAt) / 1000)})` : message, { type: toastType, duration: 6000 });

  // Best-effort cleanup of our own ICE candidate docs (TTL policy is the backstop).
  const written = c.writtenCandidates.splice(0);
  if (written.length) setTimeout(() => written.forEach((ref) => deleteDoc(ref).catch(() => {})), 2000);

  // We won a glare tie-break but our call ended: if the peer's call is still ringing
  // (they never saw ours), show it now instead of letting it ring into nothing.
  const deferred = deferredIncoming;
  deferredIncoming = null;
  if (deferred && c.role === 'caller' && ctx) {
    getDoc(deferred)
      .then((snap) => { if (ctx && !active && snap.exists() && snap.data().status === 'ringing') handleIncomingDoc(snap); })
      .catch(() => {});
  }
}

/* ======================================================================
   Call UI
   ====================================================================== */

function showCallScreen(c) {
  const screen = $('call-screen');
  const name = ctx.getPeerName();
  screen.dataset.callType = c.type;
  screen.classList.remove('has-remote-video');
  $('call-peer-name').textContent = name;
  paintAvatar($('call-avatar'), name, ctx.peerUid);
  $('call-avatar-ring').classList.remove('still');
  $('call-type-label').lastChild.textContent = c.type === 'video' ? ' Video call' : ' Audio call';
  $('call-timer').hidden = true;
  $('call-timer-small').hidden = true;
  $('call-quality').hidden = true;
  $('enable-audio').hidden = true;
  $('local-preview').hidden = c.type !== 'video';
  $('local-camera-off').hidden = true;
  $('switch-camera').hidden = true;
  setToggle($('toggle-mic'), false, 'Mute microphone', 'Unmute microphone');
  setToggle($('toggle-camera'), false, 'Turn camera off', 'Turn camera on');
  screen.hidden = false;
  $('end-call').focus({ preventScroll: true });
  updateAudioRoute();
}

/**
 * Honest audio-privacy indicator. Browsers cannot force the phone earpiece, block the
 * loudspeaker, or reliably tell which output a call uses. The app never selects the
 * loudspeaker itself; it shows "Headphones detected" only when the browser reports a
 * headset as the output in use (mostly desktop, where device names are exposed), and
 * otherwise warns that audio may play on the loudspeaker.
 */
async function updateAudioRoute() {
  const pill = $('call-audio-route');
  let headset = false;
  try {
    const outputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
    const chosenId = supportsSinkId ? getPrefs().speakerId : '';
    const inUse = outputs.find((d) => d.deviceId === (chosenId || 'default')) || (outputs.length === 1 ? outputs[0] : null);
    headset = !!inUse && HEADSET_LABEL.test(inUse.label);
  } catch { /* unknown → warn */ }
  if (!active) return;
  pill.hidden = false;
  pill.classList.toggle('warn', !headset);
  pill.title = 'Browsers cannot force the earpiece or block the loudspeaker. Use wired or Bluetooth headphones for private call audio.';
  pill.lastChild.textContent = headset ? ' Headphones detected' : ' May play on loudspeaker — use headphones';
}

function hideCallScreen() {
  const screen = $('call-screen');
  screen.hidden = true;
  screen.classList.remove('has-remote-video');
  $('call-audio-route').hidden = true;
  for (const id of ['remote-video', 'remote-audio', 'local-video']) {
    const el = $(id);
    el.pause?.();
    el.srcObject = null;
  }
}

function setCallStatus(c, text) {
  if (isActive(c)) $('call-status').textContent = text;
}

function setToggle(btn, pressed, labelOff, labelOn) {
  btn.setAttribute('aria-pressed', String(pressed));
  btn.setAttribute('aria-label', pressed ? labelOn : labelOff);
  btn.title = pressed ? labelOn : labelOff;
}

function attachLocalPreview(c) {
  if (c.type !== 'video') return;
  const video = $('local-video');
  video.srcObject = c.localStream;
  video.play().catch(() => {});
  const facing = c.localStream.getVideoTracks()[0]?.getSettings?.().facingMode;
  $('local-preview').classList.toggle('environment', facing === 'environment');
  navigator.mediaDevices.enumerateDevices().then((list) => {
    if (isActive(c)) $('switch-camera').hidden = list.filter((d) => d.kind === 'videoinput').length < 2;
  }).catch(() => {});
}

function attachRemote(c, stream) {
  const sinkId = getPrefs().speakerId;
  const el = c.type === 'video' ? $('remote-video') : $('remote-audio');
  if (el.srcObject !== stream) el.srcObject = stream;
  if (supportsSinkId && sinkId) el.setSinkId(sinkId).catch(() => {});
  playRemote(el);
  if (c.type === 'video') {
    const vt = stream.getVideoTracks()[0];
    if (vt) {
      vt.onunmute = () => updateRemoteVideoVisibility(c);
      vt.onmute = () => updateRemoteVideoVisibility(c);
    }
    updateRemoteVideoVisibility(c);
  }
}

/** Autoplay with sound can be blocked (notably iOS); offer a tap-to-play fallback. */
function playRemote(el) {
  const p = el.play?.();
  if (p && typeof p.catch === 'function') {
    p.then(() => { $('enable-audio').hidden = true; }).catch(() => { $('enable-audio').hidden = false; });
  }
}

function updateRemoteVideoVisibility(c) {
  if (!isActive(c) || c.type !== 'video') return;
  const track = c.peer?.remoteStream.getVideoTracks()[0];
  const showing = !!track && !track.muted && track.readyState === 'live' && c.remoteCameraOn !== false;
  $('call-screen').classList.toggle('has-remote-video', showing);
}

function startTimer(c) {
  $('call-avatar-ring').classList.add('still');
  const big = $('call-timer');
  const small = $('call-timer-small');
  const tick = () => {
    const text = formatDuration((Date.now() - c.connectedAt) / 1000);
    big.textContent = text;
    small.textContent = text;
  };
  tick();
  big.hidden = false;
  small.hidden = false;
  c.timers.clock = setInterval(tick, 1000);
}

async function requestWakeLock(c) {
  let lock = null;
  try { lock = await navigator.wakeLock?.request('screen'); } catch { return; }
  // The call may have ended while the request was pending: don't keep the screen on.
  if (!isActive(c)) { lock?.release().catch(() => {}); return; }
  wakeLock = lock;
}
function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

/** Lets the user drag the self-view out of the way; it stays inside the screen. */
function makeDraggable(el) {
  let start = null;
  el.addEventListener('pointerdown', (e) => {
    const rect = el.getBoundingClientRect();
    start = { x: e.clientX, y: e.clientY, left: rect.left, top: rect.top };
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (!start) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.min(Math.max(8, start.left + e.clientX - start.x), window.innerWidth - w - 8);
    const top = Math.min(Math.max(8, start.top + e.clientY - start.y), window.innerHeight - h - 8);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.right = 'auto';
  });
  const stop = () => { start = null; };
  el.addEventListener('pointerup', stop);
  el.addEventListener('pointercancel', stop);
  window.addEventListener('resize', () => { el.style.left = ''; el.style.top = ''; el.style.right = ''; });
}

function bindUi() {
  if (uiBound) return;
  uiBound = true;

  $('audio-call-btn').addEventListener('click', () => startCall('audio'));
  $('video-call-btn').addEventListener('click', () => startCall('video'));
  $('accept-call').addEventListener('click', acceptCall);
  $('reject-call').addEventListener('click', rejectCall);
  $('end-call').addEventListener('click', hangUp);

  $('toggle-mic').addEventListener('click', () => {
    const c = active;
    if (!c?.peer) return;
    c.micOn = !c.micOn;
    c.peer.setMicEnabled(c.micOn);
    setToggle($('toggle-mic'), !c.micOn, 'Mute microphone', 'Unmute microphone');
  });

  $('toggle-camera').addEventListener('click', () => {
    const c = active;
    if (!c?.peer || c.type !== 'video') return;
    c.cameraOn = !c.cameraOn;
    c.peer.setCameraEnabled(c.cameraOn);
    setToggle($('toggle-camera'), !c.cameraOn, 'Turn camera off', 'Turn camera on');
    $('local-camera-off').hidden = c.cameraOn;
  });

  $('switch-camera').addEventListener('click', async () => {
    const c = active;
    if (!c?.peer || c.type !== 'video') return;
    const btn = $('switch-camera');
    btn.disabled = true;
    try {
      const facing = await c.peer.switchCamera();
      if (!isActive(c)) return;
      $('local-video').srcObject = c.localStream;
      $('local-preview').classList.toggle('environment', facing === 'environment');
    } catch (err) {
      toast(err?.message === 'Only one camera available.' ? err.message : 'Could not switch camera.', { type: 'warning' });
    } finally {
      btn.disabled = false;
    }
  });

  $('enable-audio').addEventListener('click', () => {
    const c = active;
    if (!c) return;
    playRemote(c.type === 'video' ? $('remote-video') : $('remote-audio'));
  });

  makeDraggable($('local-preview'));

  // Headphones plugged in / Bluetooth connected during a call.
  navigator.mediaDevices?.addEventListener?.('devicechange', () => { if (active) updateAudioRoute(); });
  // Network is back: try a new path right away instead of waiting.
  window.addEventListener('online', () => {
    const c = active;
    if (c?.connectedAt && c.peer?.lastState !== 'connected') restartIce(c);
  });

  // Best effort: tell the other side we left if the tab is closed mid-call.
  window.addEventListener('pagehide', () => { if (active) hangUp(); });
  window.addEventListener('beforeunload', (e) => {
    if (active && active.status !== 'ringing') { e.preventDefault(); e.returnValue = ''; }
  });
  document.addEventListener('keydown', (e) => {
    // Not while the app is locked: the incoming-call screen is hidden then (app.js lockApp).
    if (e.key === 'Escape' && active?.role === 'callee' && active.status === 'ringing'
      && !document.body.classList.contains('locked')) rejectCall();
  });
}

/* ======================================================================
   Call history (last 15 calls)
   ====================================================================== */

function watchHistory(previousLastActive) {
  const q = query(
    collection(db, 'calls'),
    where('participants', 'array-contains', ctx.myUid),
    ...(callsClearedAt ? [where('createdAt', '>', Timestamp.fromDate(callsClearedAt))] : []),
    orderBy('createdAt', 'desc'),
    limit(15),
  );
  let first = true;
  unsubHistory = onSnapshot(q, (snap) => {
    renderHistory(snap.docs);
    if (first && !snap.metadata.fromCache) {
      first = false;
      reportMissedSince(snap.docs, previousLastActive);
    }
  }, (err) => {
    console.error('Call history error:', err?.code);
    const empty = $('call-history-empty');
    empty.hidden = false;
    empty.textContent = err?.code === 'failed-precondition'
      ? 'Call history needs a Firestore index (see README → Indexes).'
      : 'Call history is unavailable.';
  });
}

/** My profile's callsClearedAt changed: show only calls after it. */
export function setCallsClearedAt(date) {
  if (!ctx || !date || date.getTime() === callsClearedAt?.getTime()) return;
  callsClearedAt = date;
  unsubHistory?.();
  watchHistory(null);
}

/**
 * "Clear call history for everyone": deletes every finished call document of ours.
 * Ringing/active calls are kept (the rules refuse them too); their leftover ICE
 * candidate documents expire through the TTL policy.
 */
export async function eraseCallHistory() {
  const snap = await getDocs(query(collection(db, 'calls'), where('participants', 'array-contains', ctx.myUid)));
  // Server-corrected time plus an hour of margin: a borderline call the rules would
  // still refuse must not make the whole batch fail.
  const dayAgo = serverNow() - 86400_000 - 3600_000;
  const erasable = snap.docs.filter((s) => {
    const d = s.data();
    return s.id !== active?.id
      && (!['ringing', 'accepted'].includes(d.status) || (d.updatedAt?.toMillis?.() || 0) < dayAgo);
  });
  for (let i = 0; i < erasable.length; i += DELETE_BATCH) {
    const batch = writeBatch(db);
    erasable.slice(i, i + DELETE_BATCH).forEach((s) => batch.delete(s.ref));
    await batch.commit();
  }
}

function isMissedForMe(d) {
  return d.calleeId === ctx.myUid && !d.acceptedAt && ['missed', 'cancelled'].includes(d.status) && d.endReason !== 'collision';
}

function reportMissedSince(docs, since) {
  const sinceMs = since?.toMillis?.();
  if (!sinceMs) return;
  const missed = docs.filter((s) => {
    const d = s.data();
    return isMissedForMe(d) && (d.createdAt?.toMillis?.() || 0) > sinceMs;
  });
  if (missed.length) {
    toast(`You missed ${missed.length} call${missed.length > 1 ? 's' : ''} from ${ctx.getPeerName()} while you were away.`, { type: 'warning', duration: 8000 });
  }
}

function describeCall(d) {
  const outgoing = d.callerId === ctx.myUid;
  const duration = d.acceptedAt && d.endedAt ? (d.endedAt.toMillis() - d.acceptedAt.toMillis()) / 1000 : null;
  if (d.status === 'ended' || d.status === 'failed') {
    return { text: duration !== null ? formatDuration(duration) : 'Ended', missed: false };
  }
  if (d.status === 'accepted') return { text: 'In progress / interrupted', missed: false };
  if (d.status === 'ringing') return { text: 'Ringing', missed: false };
  if (outgoing) {
    return { text: { rejected: 'Declined', busy: 'Busy', missed: 'No answer', cancelled: d.endReason === 'collision' ? 'Simultaneous call' : 'Cancelled' }[d.status] || d.status, missed: false };
  }
  if (isMissedForMe(d)) return { text: 'Missed', missed: true };
  return { text: { rejected: 'Declined', busy: 'Missed (busy)' }[d.status] || d.status, missed: d.status === 'busy' };
}

function renderHistory(docs) {
  const list = $('call-history');
  const frag = document.createDocumentFragment();
  for (const snap of docs) {
    const d = snap.data({ serverTimestamps: 'estimate' });
    if (d.endReason === 'collision' && d.callerId === ctx.myUid) continue;
    const outgoing = d.callerId === ctx.myUid;
    const { text, missed } = describeCall(d);
    const created = d.createdAt?.toDate?.() || new Date();

    const li = document.createElement('li');
    li.className = `call-entry${missed ? ' missed' : ''}`;

    const ic = document.createElement('div');
    ic.className = 'call-icon';
    ic.append(icon(d.type === 'video' ? 'i-video' : 'i-phone'));

    const info = document.createElement('div');
    info.className = 'call-info';
    const title = document.createElement('strong');
    title.textContent = `${outgoing ? 'Outgoing' : 'Incoming'} ${d.type === 'video' ? 'video' : 'audio'} call`;
    const sub = document.createElement('span');
    sub.append(icon(outgoing ? 'i-call-out' : 'i-call-in'));
    sub.append(document.createTextNode(`${formatListTime(created)} · ${text}`));
    info.append(title, sub);

    const redial = document.createElement('button');
    redial.type = 'button';
    redial.className = 'icon-btn small redial';
    redial.setAttribute('aria-label', `Call back (${d.type})`);
    redial.title = 'Call back';
    redial.append(icon(d.type === 'video' ? 'i-video' : 'i-phone'));
    redial.addEventListener('click', () => startCall(d.type === 'video' ? 'video' : 'audio'));

    li.append(ic, info, redial);
    frag.append(li);
  }
  list.replaceChildren(frag);
  const empty = $('call-history-empty');
  empty.textContent = 'No calls yet.';
  empty.hidden = list.children.length > 0;
}
