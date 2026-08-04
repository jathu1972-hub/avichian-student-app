import { Phone, PhoneOff, Video } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { updateCallStatus } from '../../lib/calls';
import { connectSocket } from '../../lib/socket';

interface IncomingInvite {
  callId: string;
  callType: 'VOICE' | 'VIDEO';
  fromUserId: string;
  fromName: string;
  fromPhoto?: string | null;
  roomName?: string;
}

const AUTO_MISS_MS = 45_000;

export function IncomingCallBanner() {
  const navigate = useNavigate();
  const [invite, setInvite] = useState<IncomingInvite | null>(null);
  const ringRef = useRef<number | null>(null);

  useEffect(() => {
    const socket = connectSocket();

    function clearRing() {
      if (ringRef.current) {
        window.clearTimeout(ringRef.current);
        ringRef.current = null;
      }
    }

    function presentInvite(next: IncomingInvite) {
      if (window.location.pathname.includes('/home/call/')) return;
      if (!next.callId || !next.fromUserId) return;

      setInvite(next);

      // Soft ring (Web Audio)
      try {
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = 440;
        gain.gain.value = 0.06;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        window.setTimeout(() => {
          try {
            osc.stop();
            void ctx.close();
          } catch {
            /* ignore */
          }
        }, 900);
      } catch {
        /* ignore */
      }

      if (ringRef.current) window.clearTimeout(ringRef.current);
      ringRef.current = window.setTimeout(() => {
        setInvite((cur) => {
          if (cur?.callId === next.callId) {
            void updateCallStatus(next.callId, 'MISSED', 0).catch(() => undefined);
            const s = connectSocket();
            s.emit('callEnded', {
              toUserId: next.fromUserId,
              callId: next.callId,
              reason: 'MISSED',
            });
            s.emit('call:signal', {
              toUserId: next.fromUserId,
              callId: next.callId,
              type: next.callType,
              signal: { type: 'hangup', reason: 'MISSED' },
            });
            clearRing();
            return null;
          }
          return cur;
        });
      }, AUTO_MISS_MS);
    }

    function onSignal(payload: {
      fromUserId: string;
      callId?: string;
      type?: string;
      signal: {
        type?: string;
        callId?: string;
        callType?: string;
        fromUserId?: string;
        fromName?: string;
        fromPhoto?: string | null;
        roomName?: string;
      };
    }) {
      const signal = payload.signal;
      if (signal?.type === 'hangup' || signal?.type === 'reject') {
        setInvite((cur) => {
          if (cur && (cur.callId === payload.callId || cur.fromUserId === payload.fromUserId)) {
            clearRing();
            return null;
          }
          return cur;
        });
        return;
      }
      if (signal?.type !== 'invite') return;

      presentInvite({
        callId: signal.callId || payload.callId || '',
        callType: (signal.callType || payload.type || 'VOICE') as 'VOICE' | 'VIDEO',
        fromUserId: signal.fromUserId || payload.fromUserId,
        fromName: signal.fromName || 'Friend',
        fromPhoto: signal.fromPhoto,
        roomName: signal.roomName,
      });
    }

    function onInvitation(payload: {
      fromUserId: string;
      callId: string;
      callType: string;
      fromName?: string;
      fromPhoto?: string | null;
      roomName?: string;
    }) {
      presentInvite({
        callId: payload.callId,
        callType: (payload.callType || 'VOICE') as 'VOICE' | 'VIDEO',
        fromUserId: payload.fromUserId,
        fromName: payload.fromName || 'Friend',
        fromPhoto: payload.fromPhoto,
        roomName: payload.roomName,
      });
    }

    socket.on('call:signal', onSignal);
    socket.on('callInvitation', onInvitation);

    // Re-bind after reconnect (token refresh)
    socket.on('connect', () => {
      /* listeners already attached */
    });

    return () => {
      clearRing();
      socket.off('call:signal', onSignal);
      socket.off('callInvitation', onInvitation);
    };
  }, []);

  if (!invite) return null;

  async function accept() {
    const i = invite;
    if (!i) return;
    setInvite(null);
    if (ringRef.current) window.clearTimeout(ringRef.current);
    const mode = i.callType === 'VIDEO' ? 'video' : 'voice';
    const socket = connectSocket();
    socket.emit('callAccepted', { toUserId: i.fromUserId, callId: i.callId });
    socket.emit('call:signal', {
      toUserId: i.fromUserId,
      callId: i.callId,
      type: i.callType,
      signal: { type: 'accepted', callId: i.callId },
    });
    const room = encodeURIComponent(i.roomName || '');
    navigate(
      `/home/call/${mode}/${i.fromUserId}?callId=${encodeURIComponent(i.callId)}&role=callee&name=${encodeURIComponent(i.fromName)}&room=${room}`,
    );
  }

  async function reject() {
    const i = invite;
    if (!i) return;
    setInvite(null);
    if (ringRef.current) window.clearTimeout(ringRef.current);
    const socket = connectSocket();
    socket.emit('callRejected', { toUserId: i.fromUserId, callId: i.callId });
    socket.emit('call:signal', {
      toUserId: i.fromUserId,
      callId: i.callId,
      type: i.callType,
      signal: { type: 'reject' },
    });
    if (i.callId) {
      try {
        await updateCallStatus(i.callId, 'REJECTED', 0);
      } catch {
        /* ignore */
      }
    }
  }

  return (
    <div className="fixed inset-x-0 top-0 z-[100] flex justify-center p-3 pt-safe">
      <div className="flex w-full max-w-md items-center gap-3 rounded-2xl bg-slate-900 px-4 py-3 text-white shadow-float">
        <div className="rounded-full bg-success/20 p-2 text-success">
          {invite.callType === 'VIDEO' ? <Video size={20} /> : <Phone size={20} />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{invite.fromName}</p>
          <p className="text-xs text-white/60">
            Incoming {invite.callType === 'VIDEO' ? 'video' : 'voice'} call
          </p>
        </div>
        <button
          type="button"
          onClick={() => void reject()}
          className="rounded-full bg-error p-2.5"
          aria-label="Decline"
        >
          <PhoneOff size={18} />
        </button>
        <button
          type="button"
          onClick={() => void accept()}
          className="rounded-full bg-success p-2.5"
          aria-label="Accept"
        >
          <Phone size={18} />
        </button>
      </div>
    </div>
  );
}
