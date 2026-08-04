import { io, type Socket } from 'socket.io-client';
import { getAccessToken } from './api';
import { getSocketUrl } from './config';

let socket: Socket | null = null;
let lastToken: string | null = null;

export function getSocket(): Socket | null {
  return socket;
}

/**
 * Connect (or reconnect) Socket.IO with the current JWT.
 * Dev: connects to same origin so Vite proxies /socket.io → :4000.
 * Prod: VITE_API_URL origin.
 */
export function connectSocket(): Socket {
  const token = getAccessToken();
  // Prefer explicit API origin (production / tunnel). Dev: same origin → Vite proxy.
  const url = getSocketUrl();

  if (socket && lastToken === token && socket.connected) {
    return socket;
  }

  // Token refresh: update auth only — do NOT removeAllListeners (would drop
  // IncomingCallBanner / CallPage / Friends socket handlers).
  if (socket && lastToken !== token) {
    socket.auth = { token };
    lastToken = token;
    if (!socket.connected) {
      socket.connect();
    } else {
      // Force reconnect with new JWT so server re-joins user room
      socket.disconnect();
      socket.connect();
    }
    return socket;
  }

  if (socket && !socket.connected) {
    socket.auth = { token };
    lastToken = token;
    socket.connect();
    return socket;
  }

  lastToken = token;
  socket = io(url ?? window.location.origin, {
    path: '/socket.io',
    auth: { token },
    // Prefer websocket; fall back to polling through proxies/tunnels
    transports: ['websocket', 'polling'],
    autoConnect: true,
    withCredentials: true,
    reconnection: true,
    reconnectionAttempts: 30,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
    timeout: 20000,
  });

  socket.on('connect_error', (err) => {
    console.warn('[socket] connect_error', err.message, 'url=', url ?? window.location.origin);
  });

  return socket;
}

/** Wait until socket is connected (call invite / WebRTC signaling). */
export function whenSocketConnected(timeoutMs = 8000): Promise<Socket> {
  const s = connectSocket();
  if (s.connected) return Promise.resolve(s);
  return new Promise((resolve, reject) => {
    const t = window.setTimeout(() => {
      s.off('connect', onConnect);
      reject(new Error('Unable to connect to the server. Please try again later.'));
    }, timeoutMs);
    function onConnect() {
      window.clearTimeout(t);
      resolve(s);
    }
    s.once('connect', onConnect);
  });
}

export function disconnectSocket() {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
  lastToken = null;
}

export function joinConversation(conversationId: string) {
  const s = connectSocket();
  s.emit('joinConversation', conversationId);
  s.emit('chat:join', conversationId);
}

export function leaveConversation(conversationId: string) {
  const s = getSocket();
  s?.emit('leaveConversation', conversationId);
  s?.emit('chat:leave', conversationId);
}

export function emitTyping(conversationId: string, typing: boolean) {
  const s = connectSocket();
  s.emit('chat:typing', { conversationId, typing });
  s.emit('typing', { conversationId, typing });
}

export function markChatSeen(conversationId: string) {
  const s = connectSocket();
  s.emit('messageSeen', { conversationId });
  s.emit('chat:read', { conversationId });
}
