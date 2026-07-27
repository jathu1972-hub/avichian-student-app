import {
  Mic,
  MicOff,
  PhoneOff,
  SwitchCamera,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { updateCallStatus } from '../../lib/social';
import { connectSocket } from '../../lib/socket';

type SignalPayload =
  | { type: 'ready' }
  | { type: 'accepted'; callId?: string }
  | { type: 'invite'; callId: string; callType: string; fromUserId: string; fromName?: string }
  | { type: 'offer'; sdp: RTCSessionDescriptionInit }
  | { type: 'answer'; sdp: RTCSessionDescriptionInit }
  | { type: 'ice'; candidate: RTCIceCandidateInit }
  | { type: 'hangup'; reason?: string }
  | { type: 'reject' };

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

function buildIceServers(): RTCIceServer[] {
  const servers = [...ICE_SERVERS];
  const turnUrl = import.meta.env.VITE_TURN_URL as string | undefined;
  const turnUser = import.meta.env.VITE_TURN_USERNAME as string | undefined;
  const turnPass = import.meta.env.VITE_TURN_PASSWORD as string | undefined;
  if (turnUrl) {
    servers.push({
      urls: turnUrl,
      username: turnUser,
      credential: turnPass,
    });
  }
  return servers;
}

const RING_TIMEOUT_MS = 45_000;

export function CallPage({ mode }: { mode: 'voice' | 'video' }) {
  const { userId: peerId } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const callId = params.get('callId');
  const role = (params.get('role') === 'callee' ? 'callee' : 'caller') as 'caller' | 'callee';
  const peerName = params.get('name') || `Peer ${(peerId ?? '').slice(0, 8)}`;

  const [muted, setMuted] = useState(false);
  const [camOff, setCamOff] = useState(false);
  const [speakerOn, setSpeakerOn] = useState(true);
  const [seconds, setSeconds] = useState(0);
  const [status, setStatus] = useState(role === 'caller' ? 'Ringing…' : 'Connecting…');
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const endedRef = useRef(false);
  const makingOfferRef = useRef(false);
  const secondsRef = useRef(0);
  const connectedRef = useRef(false);
  const pendingIce = useRef<RTCIceCandidateInit[]>([]);

  const emitSignal = useCallback(
    (signal: SignalPayload) => {
      if (!peerId) return;
      const socket = connectSocket();
      socket.emit('call:signal', {
        toUserId: peerId,
        type: mode === 'video' ? 'VIDEO' : 'VOICE',
        callId,
        signal,
      });
      // Named events for clearer protocol
      if (signal.type === 'offer') {
        socket.emit('offer', { toUserId: peerId, callId, sdp: signal.sdp });
      } else if (signal.type === 'answer') {
        socket.emit('answer', { toUserId: peerId, callId, sdp: signal.sdp });
      } else if (signal.type === 'ice') {
        socket.emit('iceCandidate', { toUserId: peerId, callId, candidate: signal.candidate });
      } else if (signal.type === 'hangup') {
        socket.emit('callEnded', { toUserId: peerId, callId, reason: signal.reason });
      } else if (signal.type === 'reject') {
        socket.emit('callRejected', { toUserId: peerId, callId });
      }
    },
    [peerId, mode, callId],
  );

  const cleanupMedia = useCallback(() => {
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    remoteStreamRef.current?.getTracks().forEach((t) => t.stop());
    remoteStreamRef.current = null;
    if (pcRef.current) {
      pcRef.current.onicecandidate = null;
      pcRef.current.ontrack = null;
      pcRef.current.onconnectionstatechange = null;
      pcRef.current.oniceconnectionstatechange = null;
      pcRef.current.close();
      pcRef.current = null;
    }
  }, []);

  const endCall = useCallback(
    async (final: 'COMPLETED' | 'REJECTED' | 'MISSED' | 'FAILED' = 'COMPLETED', notifyPeer = true) => {
      if (endedRef.current) return;
      endedRef.current = true;
      if (notifyPeer) {
        emitSignal({ type: 'hangup', reason: final });
      }
      cleanupMedia();
      if (callId) {
        try {
          await updateCallStatus(callId, final, secondsRef.current);
        } catch {
          /* ignore */
        }
      }
      navigate('/home/chat', { replace: true });
    },
    [callId, cleanupMedia, emitSignal, navigate],
  );

  useEffect(() => {
    if (!peerId) {
      setError('Missing peer for call');
      return;
    }

    let cancelled = false;
    const socket = connectSocket();

    async function createAndSendOffer() {
      const pc = pcRef.current;
      if (!pc || makingOfferRef.current || pc.signalingState !== 'stable') return;
      makingOfferRef.current = true;
      try {
        const offer = await pc.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: mode === 'video',
        });
        await pc.setLocalDescription(offer);
        emitSignal({ type: 'offer', sdp: offer });
        setStatus('Ringing…');
      } finally {
        makingOfferRef.current = false;
      }
    }

    async function flushIce() {
      const pc = pcRef.current;
      if (!pc?.remoteDescription) return;
      const queued = pendingIce.current.splice(0);
      for (const c of queued) {
        try {
          await pc.addIceCandidate(c);
        } catch {
          /* ignore */
        }
      }
    }

    async function setup() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video:
            mode === 'video'
              ? {
                  facingMode,
                  width: { ideal: 1280 },
                  height: { ideal: 720 },
                }
              : false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        localStreamRef.current = stream;
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
          void localVideoRef.current.play().catch(() => undefined);
        }

        const pc = new RTCPeerConnection({
          iceServers: buildIceServers(),
          iceCandidatePoolSize: 4,
        });
        pcRef.current = pc;

        const remoteStream = new MediaStream();
        remoteStreamRef.current = remoteStream;
        if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStream;
        if (remoteAudioRef.current) remoteAudioRef.current.srcObject = remoteStream;

        stream.getTracks().forEach((track) => pc.addTrack(track, stream));

        pc.onicecandidate = (ev) => {
          if (ev.candidate) {
            emitSignal({ type: 'ice', candidate: ev.candidate.toJSON() });
          }
        };

        pc.ontrack = (ev) => {
          ev.streams[0]?.getTracks().forEach((track) => {
            if (!remoteStream.getTracks().some((t) => t.id === track.id)) {
              remoteStream.addTrack(track);
            }
          });
          if (remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = remoteStream;
            void remoteVideoRef.current.play().catch(() => undefined);
          }
          if (remoteAudioRef.current) {
            remoteAudioRef.current.srcObject = remoteStream;
            void remoteAudioRef.current.play().catch(() => undefined);
          }
        };

        pc.onconnectionstatechange = () => {
          const state = pc.connectionState;
          if (state === 'connected') {
            connectedRef.current = true;
            setConnected(true);
            setStatus('Connected');
            if (role === 'callee') {
              socket.emit('callAccepted', { toUserId: peerId, callId });
            }
          } else if (state === 'connecting') {
            setStatus('Connecting…');
          } else if (state === 'disconnected') {
            setStatus('Reconnecting…');
          } else if (state === 'failed') {
            setError('Connection failed. Check network / TURN settings.');
            void endCall('FAILED', true);
          } else if (state === 'closed') {
            setStatus('Ended');
          }
        };

        pc.oniceconnectionstatechange = () => {
          if (pc.iceConnectionState === 'failed') {
            try {
              pc.restartIce();
            } catch {
              /* ignore */
            }
          }
        };

        if (role === 'caller') {
          setStatus('Ringing…');
          await createAndSendOffer();
        } else {
          setStatus('Connecting…');
          emitSignal({ type: 'ready' });
          socket.emit('callAccepted', { toUserId: peerId, callId });
        }
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : 'Camera/microphone permission denied or unavailable',
        );
        setStatus('Media error');
      }
    }

    void setup();

    async function handleRemoteSignal(signal: SignalPayload) {
      const pc = pcRef.current;
      try {
        if (signal.type === 'ready' && role === 'caller') {
          await createAndSendOffer();
          return;
        }
        if (signal.type === 'accepted' && role === 'caller') {
          setStatus('Answered — connecting…');
          return;
        }
        if (!pc) return;

        if (signal.type === 'offer') {
          await pc.setRemoteDescription(signal.sdp);
          await flushIce();
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          emitSignal({ type: 'answer', sdp: answer });
          setStatus('Connecting…');
        } else if (signal.type === 'answer') {
          if (pc.signalingState === 'have-local-offer') {
            await pc.setRemoteDescription(signal.sdp);
            await flushIce();
            setStatus('Connecting…');
          }
        } else if (signal.type === 'ice' && signal.candidate) {
          if (pc.remoteDescription) {
            try {
              await pc.addIceCandidate(signal.candidate);
            } catch {
              /* ignore */
            }
          } else {
            pendingIce.current.push(signal.candidate);
          }
        } else if (signal.type === 'hangup' || signal.type === 'reject') {
          void endCall(signal.type === 'reject' ? 'REJECTED' : 'COMPLETED', false);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Signaling error');
      }
    }

    function onSignal(payload: {
      fromUserId: string;
      signal: SignalPayload;
      callId?: string;
    }) {
      if (payload.fromUserId !== peerId) return;
      if (payload.callId && callId && payload.callId !== callId) return;
      void handleRemoteSignal(payload.signal);
    }

    socket.on('call:signal', onSignal);

    const ringTimer =
      role === 'caller'
        ? window.setTimeout(() => {
            if (!endedRef.current && !connectedRef.current) {
              void endCall('MISSED', true);
            }
          }, RING_TIMEOUT_MS)
        : 0;

    return () => {
      cancelled = true;
      if (ringTimer) window.clearTimeout(ringTimer);
      socket.off('call:signal', onSignal);
      if (!endedRef.current) {
        emitSignal({ type: 'hangup', reason: 'left' });
        cleanupMedia();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peerId, mode, callId, role]);

  useEffect(() => {
    if (!connected) return;
    const timer = window.setInterval(() => {
      setSeconds((s) => {
        const next = s + 1;
        secondsRef.current = next;
        return next;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [connected]);

  useEffect(() => {
    localStreamRef.current?.getAudioTracks().forEach((t) => {
      t.enabled = !muted;
    });
  }, [muted]);

  useEffect(() => {
    if (mode !== 'video') return;
    localStreamRef.current?.getVideoTracks().forEach((t) => {
      t.enabled = !camOff;
    });
  }, [camOff, mode]);

  useEffect(() => {
    if (remoteAudioRef.current) {
      remoteAudioRef.current.muted = !speakerOn;
      remoteAudioRef.current.volume = speakerOn ? 1 : 0;
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.muted = mode === 'video' ? false : !speakerOn;
    }
  }, [speakerOn, mode]);

  async function switchCamera() {
    if (mode !== 'video' || !localStreamRef.current || !pcRef.current) return;
    const next: 'user' | 'environment' = facingMode === 'user' ? 'environment' : 'user';
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: next },
        audio: false,
      });
      const newTrack = newStream.getVideoTracks()[0];
      const oldTrack = localStreamRef.current.getVideoTracks()[0];
      const sender = pcRef.current.getSenders().find((s) => s.track?.kind === 'video');
      if (sender && newTrack) {
        await sender.replaceTrack(newTrack);
      }
      if (oldTrack) {
        localStreamRef.current.removeTrack(oldTrack);
        oldTrack.stop();
      }
      if (newTrack) localStreamRef.current.addTrack(newTrack);
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = localStreamRef.current;
      }
      setFacingMode(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not switch camera');
    }
  }

  async function toggleFullscreen() {
    const el = remoteVideoRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await el.requestFullscreen();
      }
    } catch {
      /* ignore */
    }
  }

  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');

  return (
    <div className="flex min-h-[75dvh] flex-col items-center justify-between rounded-[28px] bg-gradient-to-b from-slate-900 to-slate-800 p-6 text-white shadow-float">
      <div className="w-full text-center">
        <p className="text-xs uppercase tracking-wide text-white/50">
          {mode === 'video' ? 'Video call' : 'Voice call'} · WebRTC · friends only
        </p>
        <h1 className="mt-2 font-display text-2xl font-bold">{peerName}</h1>
        <p className="mt-2 text-sm text-white/60">{status}</p>
        <p className="mt-1 font-mono text-lg">
          {mm}:{ss}
        </p>
        {error ? <p className="mt-2 text-sm text-red-300">{error}</p> : null}
      </div>

      <div
        className={`relative flex w-full max-w-sm flex-col items-center justify-center overflow-hidden rounded-[24px] ${
          mode === 'video' ? 'aspect-[9/14] bg-slate-900' : 'h-40'
        }`}
      >
        {mode === 'video' ? (
          <>
            <video
              ref={remoteVideoRef}
              className="absolute inset-0 h-full w-full object-cover"
              playsInline
              autoPlay
              onDoubleClick={() => void toggleFullscreen()}
            />
            <video
              ref={localVideoRef}
              className="absolute bottom-3 right-3 h-28 w-20 rounded-xl border border-white/20 object-cover shadow-lg"
              playsInline
              autoPlay
              muted
            />
            {camOff ? (
              <div className="absolute inset-0 flex items-center justify-center bg-slate-800/80 text-white/60">
                <VideoOff size={40} />
              </div>
            ) : null}
          </>
        ) : (
          <>
            <audio ref={remoteAudioRef} autoPlay playsInline />
            <div className="flex h-24 w-24 items-center justify-center rounded-full bg-primary/30 text-3xl font-bold">
              {peerName.slice(0, 1).toUpperCase()}
            </div>
          </>
        )}
      </div>

      <div className="flex w-full max-w-sm flex-col gap-4">
        <div className="flex flex-wrap justify-center gap-3">
          <button
            type="button"
            onClick={() => setMuted((v) => !v)}
            className="rounded-full bg-white/10 p-4"
            aria-label={muted ? 'Unmute' : 'Mute'}
          >
            {muted ? <MicOff size={22} /> : <Mic size={22} />}
          </button>
          <button
            type="button"
            onClick={() => setSpeakerOn((v) => !v)}
            className="rounded-full bg-white/10 p-4"
            aria-label={speakerOn ? 'Speaker off' : 'Speaker on'}
          >
            {speakerOn ? <Volume2 size={22} /> : <VolumeX size={22} />}
          </button>
          {mode === 'video' ? (
            <>
              <button
                type="button"
                onClick={() => setCamOff((v) => !v)}
                className="rounded-full bg-white/10 p-4"
                aria-label={camOff ? 'Camera on' : 'Camera off'}
              >
                {camOff ? <VideoOff size={22} /> : <Video size={22} />}
              </button>
              <button
                type="button"
                onClick={() => void switchCamera()}
                className="rounded-full bg-white/10 p-4"
                aria-label="Switch camera"
              >
                <SwitchCamera size={22} />
              </button>
            </>
          ) : null}
          <button
            type="button"
            onClick={() => void endCall(connected ? 'COMPLETED' : 'REJECTED')}
            className="rounded-full bg-error p-4"
            aria-label="End call"
          >
            <PhoneOff size={22} />
          </button>
        </div>
        <Button
          type="button"
          variant="secondary"
          className="!border-white/20 !bg-white/10 !text-white"
          onClick={() => void endCall(connected ? 'COMPLETED' : 'MISSED')}
        >
          End call
        </Button>
      </div>
    </div>
  );
}
