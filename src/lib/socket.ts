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
  const url = getSocketUrl(); // undefined in local dev → current host (Vite proxy)

  if (socket && lastToken === token && socket.connected) {
    return socket;
  }

  if (socket && lastToken !== token) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
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
    transports: ['websocket', 'polling'],
    autoConnect: true,
    withCredentials: true,
    reconnection: true,
    reconnectionAttempts: 20,
    reconnectionDelay: 800,
    reconnectionDelayMax: 5000,
  });

  socket.on('connect_error', (err) => {
    console.warn('[socket] connect_error', err.message);
  });

  return socket;
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
