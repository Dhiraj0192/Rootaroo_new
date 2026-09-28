import { io } from 'socket.io-client';
import apiClient from './api/client';
import { useFeedStore } from './store/feedStore';
import { usePingStore } from './store/pingStore';
import { useEngagementStore } from './store/engagementStore';

let socket = null;
let listenersAttached = false;
let currentToken = null;

function getBaseURL() {
  const base = apiClient.defaults.baseURL || 'http://localhost:3000/api/v1';
  return base.replace(/\/api\/v1\/?$/, '');
}

/**
 * Connect to WebSocket with the given auth token.
 * Safe to call multiple times — reconnects with a new token if it changes.
 */
export function connectSocket(token) {
  // Same token and the socket is connected or still retrying on its own
  // (`active`) — reuse it rather than opening a second connection.
  if (socket && currentToken === token && (socket.connected || socket.active)) {
    return socket;
  }

  // Tear down any previous socket, connected or not. Checking only
  // `connected` orphaned a socket still retrying with an expired token
  // (the usual cold start) — it kept reconnecting 10x in the background.
  if (socket) {
    listenersAttached = false;
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }

  currentToken = token;

  socket = io(getBaseURL(), {
    auth: { token },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 2000,
  });

  socket.on('connect', () => {
    console.log('[WS] connected:', socket.id);
  });

  socket.on('disconnect', (reason) => {
    console.log('[WS] disconnected:', reason);
  });

  socket.on('connect_error', (err) => {
    console.warn('[WS] connection error:', err.message);
  });

  attachListeners();
  return socket;
}

function attachListeners() {
  if (listenersAttached || !socket) return;
  listenersAttached = true;

  socket.on('feed:new-post', (post) => {
    useFeedStore.getState().prependPost(post);
    useEngagementStore.getState().bump();
  });

  socket.on('ping:request', (request) => {
    usePingStore.getState().addIncoming(request);
    useEngagementStore.getState().bump();
  });

  socket.on('ping:response', (request) => {
    usePingStore.getState().upsertOutgoing(request);
    useEngagementStore.getState().bump();
  });

  // Live location ticks + early-stop during an active timed share — same
  // shape as ping:response (full PingRequestResponse), so the same
  // upsertOutgoing keeps the requester's copy of the request current.
  socket.on('ping:location-update', (request) => {
    usePingStore.getState().upsertOutgoing(request);
  });

  socket.on('ping:share-ended', (request) => {
    usePingStore.getState().upsertOutgoing(request);
  });

  // Streak/activity/leaderboard-relevant completions — no per-event UI to
  // update yet, just bump so the Dashboard knows to refetch.
  socket.on('task:completed', () => useEngagementStore.getState().bump());
  socket.on('todo:completed', () => useEngagementStore.getState().bump());
  socket.on('grocery:bought', () => useEngagementStore.getState().bump());
  socket.on('checkin:created', () => useEngagementStore.getState().bump());
  socket.on('calendar:event-created', () => useEngagementStore.getState().bump());
}

/**
 * Disconnect socket. Call on logout.
 */
export function disconnectSocket() {
  if (socket) {
    listenersAttached = false;
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
}

export function getSocket() {
  return socket;
}
