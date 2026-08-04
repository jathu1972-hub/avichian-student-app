import {
  Mic,
  MicOff,
  PhoneOff,
  Signal,
  SwitchCamera,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { Room, RoomEvent, Track, createLocalTracks, type LocalTrack } from 'livekit-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import {
  fetchCallIceConfig,
  fetchLiveKitToken,
  type CallIceConfig,
  updateCallStatus,
} from '../../lib/calls';
import { connectSocket } from '../../lib/socket';

type SignalPayload =
  | { type: 'ready' }
  | { type: 'accepted'; callId?: string }
  | {
      type: 'invite';
      callId: string;
      callType: string;
      fromUserId: string;
      fromName?: string;
      roomName?: string;
    }
  | { type: 'offer'; sdp: RTCSessionDescriptionInit }
  | { type: 'answer'; sdp: RTCSessionDescriptionInit }
  | { type: 'ice'; candidate: RTCIceCandidateInit }
  | { type: 'hangup'; reason?: string }
  | { type: 'reject' };

const RING_TIMEOUT_MS = 50_000;

function qualityFromStats(rttMs: number | null, packetLoss: number | null): string {
  if (rttMs == null && packetLoss == null) return '—';
  if ((rttMs != null && rttMs > 400) || (packetLoss != null && packetLoss > 0.08)) return 'Weak';
  if ((rttMs != null && rttMs > 200) || (packetLoss != null && packetLoss > 0.03)) return 'Fair';
  return 'Good';
}

/**
 * Production-ready 1:1 call page.
 * - LiveKit SFU when server provides LIVEKIT_URL
 * - Otherwise mesh WebRTC with server ICE/TURN config
 * Signaling always via authenticated Socket.IO.
 */
export function CallPage({ mode }: { mode: 'voice' | 'video' }) {
  const { userId: peerId } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const callId = params.get('callId');
  const role = (params.get('role') === 'callee' ? 'callee' : 'caller') as 'caller' | 'callee';
  const peerName = params.get('name') || `Peer ${(peerId ?? '').slice(0, 8)}`;
  const roomFromQuery = params.get('room') || '';

  const [muted, setMuted] = useState(false);
  const [camOff, setCamOff] = useState(false);
  const [speakerOn, setSpeakerOn] = useState(true);
  const [seconds, setSeconds] = useState(0);
  const [status, setStatus] = useState(role === 'caller' ? 'Calling…' : 'Connecting…');
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const [quality, setQuality] = useState('—');
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
  const [mediaMode, setMediaMode] = useState<'livekit' | 'webrtc'>('webrtc');

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const roomRef = useRef<Room | null>(null);
  const localTracksRef = useRef<LocalTrack[]>([]);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const endedRef = useRef(false);
  const makingOfferRef = useRef(false);
  const ignoreOfferRef = useRef(false);
  const secondsRef = useRef(0);
  const connectedRef = useRef(false);
  const pendingIce = useRef<RTCIceCandidateInit[]>([]);
  const pendingSignals = useRef<SignalPayload[]>([]);
  const pcReadyRef = useRef(false);
  const peerAcceptedRef = useRef(role === 'callee'); // callee is already accepted
  const iceConfigRef = useRef<CallIceConfig | null>(null);

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
      } else if (signal.type === 'accepted') {
        socket.emit('callAccepted', { toUserId: peerId, callId });
      }
    },
    [peerId, mode, callId],
  );

  const cleanupMedia = useCallback(() => {
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    remoteStreamRef.current?.getTracks().forEach((t) => t.stop());
    remoteStreamRef.current = null;
    localTracksRef.current.forEach((t) => {
      try {
        t.stop();
      } catch {
        /* ignore */
      }
    });
    localTracksRef.current = [];
    if (roomRef.current) {
      try {
        void roomRef.current.disconnect();
      } catch {
        /* ignore */
      }
      roomRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.onicecandidate = null;
      pcRef.current.ontrack = null;
      pcRef.current.onconnectionstatechange = null;
      pcRef.current.oniceconnectionstatechange = null;
      pcRef.current.onnegotiationneeded = null;
      pcRef.current.close();
      pcRef.current = null;
    }
    pcReadyRef.current = false;
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
    // polite peer = callee (avoids glare); caller is impolite
    const isPolite = role === 'callee';

    async function createAndSendOffer() {
      const pc = pcRef.current;
      if (!pc || !pcReadyRef.current) return;
      if (makingOfferRef.current) return;
      if (pc.signalingState !== 'stable') return;
      makingOfferRef.current = true;
      try {
        const offer = await pc.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: mode === 'video',
        });
        await pc.setLocalDescription(offer);
        emitSignal({ type: 'offer', sdp: pc.localDescription ?? offer });
        setStatus('Ringing…');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create offer');
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

    async function processSignal(signal: SignalPayload) {
      if (signal.type === 'ready' || signal.type === 'accepted') {
        peerAcceptedRef.current = true;
        setStatus('Answered — connecting…');
        if (role === 'caller' && iceConfigRef.current?.mediaMode !== 'livekit') {
          await createAndSendOffer();
        }
        return;
      }
      if (signal.type === 'hangup' || signal.type === 'reject') {
        void endCall(signal.type === 'reject' ? 'REJECTED' : 'COMPLETED', false);
        return;
      }

      // LiveKit path ignores SDP/ICE
      if (iceConfigRef.current?.mediaMode === 'livekit') return;

      if (!pcReadyRef.current || !pcRef.current) {
        pendingSignals.current.push(signal);
        return;
      }
      const pc = pcRef.current;

      try {
        if (signal.type === 'offer' && signal.sdp) {
          const offerCollision =
            makingOfferRef.current || pc.signalingState !== 'stable';
          ignoreOfferRef.current = !isPolite && offerCollision;
          if (ignoreOfferRef.current) return;

          await pc.setRemoteDescription(signal.sdp);
          await flushIce();
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          emitSignal({ type: 'answer', sdp: pc.localDescription ?? answer });
          setStatus('Connecting…');
        } else if (signal.type === 'answer' && signal.sdp) {
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
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Signaling error');
      }
    }

    async function drainPendingSignals() {
      const batch = pendingSignals.current.splice(0);
      for (const s of batch) {
        await processSignal(s);
      }
    }

    async function setupLiveKit(roomName: string) {
      if (!callId) throw new Error('Missing call id for LiveKit');
      setStatus('Joining room…');
      const { token, url } = await fetchLiveKitToken(callId);
      if (!url) throw new Error('LiveKit URL missing');

      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true },
        videoCaptureDefaults:
          mode === 'video'
            ? { resolution: { width: 1280, height: 720 }, facingMode: 'user' }
            : undefined,
      });
      roomRef.current = room;

      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Audio) {
          const el = remoteAudioRef.current;
          if (el) {
            track.attach(el);
            void el.play().catch(() => undefined);
          }
        }
        if (track.kind === Track.Kind.Video && mode === 'video') {
          const el = remoteVideoRef.current;
          if (el) {
            track.attach(el);
            void el.play().catch(() => undefined);
          }
        }
        connectedRef.current = true;
        setConnected(true);
        setStatus('Connected');
      });

      room.on(RoomEvent.Disconnected, () => {
        if (!endedRef.current) {
          setStatus('Disconnected');
          void endCall('COMPLETED', false);
        }
      });

      room.on(RoomEvent.Reconnecting, () => setStatus('Reconnecting…'));
      room.on(RoomEvent.Reconnected, () => setStatus('Connected'));

      await room.connect(url, token);

      const tracks = await createLocalTracks({
        audio: true,
        video: mode === 'video' ? { facingMode: 'user' } : false,
      });
      localTracksRef.current = tracks;
      for (const track of tracks) {
        if (track.kind === Track.Kind.Video && localVideoRef.current) {
          track.attach(localVideoRef.current);
        }
        await room.localParticipant.publishTrack(track);
      }

      if (role === 'callee') {
        emitSignal({ type: 'accepted', callId: callId ?? undefined });
        emitSignal({ type: 'ready' });
      }
      setStatus(role === 'caller' ? 'Waiting for peer…' : 'In room…');
      // If remote already published
      for (const p of room.remoteParticipants.values()) {
        p.trackPublications.forEach((pub) => {
          if (pub.track) {
            if (pub.track.kind === Track.Kind.Audio && remoteAudioRef.current) {
              pub.track.attach(remoteAudioRef.current);
            }
            if (pub.track.kind === Track.Kind.Video && remoteVideoRef.current && mode === 'video') {
              pub.track.attach(remoteVideoRef.current);
            }
            connectedRef.current = true;
            setConnected(true);
            setStatus('Connected');
          }
        });
      }
      void roomName;
    }

    async function setupWebRtc(ice: CallIceConfig) {
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
        iceServers: ice.iceServers,
        iceCandidatePoolSize: 8,
        bundlePolicy: 'max-bundle',
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
        for (const track of ev.streams[0]?.getTracks() ?? [ev.track]) {
          if (!remoteStream.getTracks().some((t) => t.id === track.id)) {
            remoteStream.addTrack(track);
          }
        }
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
        } else if (state === 'connecting') {
          setStatus('Connecting…');
        } else if (state === 'disconnected') {
          setStatus('Reconnecting…');
        } else if (state === 'failed') {
          setError('Connection failed. TURN may be required on this network.');
          try {
            pc.restartIce();
          } catch {
            void endCall('FAILED', true);
          }
        }
      };

      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'failed') {
          try {
            pc.restartIce();
            setStatus('Reconnecting ICE…');
          } catch {
            /* ignore */
          }
        } else if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
          setStatus('Connected');
          connectedRef.current = true;
          setConnected(true);
        } else if (pc.iceConnectionState === 'checking') {
          setStatus('Checking network…');
        }
      };

      pcReadyRef.current = true;
      await drainPendingSignals();

      if (role === 'callee') {
        setStatus('Connecting…');
        emitSignal({ type: 'accepted', callId: callId ?? undefined });
        emitSignal({ type: 'ready' });
      } else {
        setStatus('Calling…');
        // Wait for peer accepted/ready — do not offer early (main production fix)
        if (peerAcceptedRef.current) {
          await createAndSendOffer();
        }
      }
    }

    async function setup() {
      try {
        const ice = await fetchCallIceConfig();
        if (cancelled) return;
        iceConfigRef.current = ice;
        setMediaMode(ice.mediaMode);

        if (ice.mediaMode === 'livekit' && ice.livekitUrl && callId) {
          await setupLiveKit(roomFromQuery || `call-${callId}`);
        } else {
          await setupWebRtc(ice);
        }
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : 'Camera/microphone permission denied or media unavailable',
        );
        setStatus('Media error');
      }
    }

    void setup();

    function onSignal(payload: {
      fromUserId: string;
      signal: SignalPayload;
      callId?: string;
    }) {
      if (payload.fromUserId !== peerId) return;
      if (payload.callId && callId && payload.callId !== callId) return;
      void processSignal(payload.signal);
    }

    function onOffer(payload: {
      fromUserId: string;
      callId?: string;
      sdp: RTCSessionDescriptionInit;
    }) {
      if (payload.fromUserId !== peerId) return;
      void processSignal({ type: 'offer', sdp: payload.sdp });
    }

    function onAnswer(payload: {
      fromUserId: string;
      callId?: string;
      sdp: RTCSessionDescriptionInit;
    }) {
      if (payload.fromUserId !== peerId) return;
      void processSignal({ type: 'answer', sdp: payload.sdp });
    }

    function onIce(payload: {
      fromUserId: string;
      callId?: string;
      candidate: RTCIceCandidateInit;
    }) {
      if (payload.fromUserId !== peerId) return;
      void processSignal({ type: 'ice', candidate: payload.candidate });
    }

    function onAccepted(payload: { fromUserId: string; callId?: string }) {
      if (payload.fromUserId !== peerId) return;
      void processSignal({ type: 'accepted', callId: payload.callId });
    }

    function onEnded(payload: { fromUserId: string; callId?: string }) {
      if (payload.fromUserId !== peerId) return;
      void processSignal({ type: 'hangup' });
    }

    function onRejected(payload: { fromUserId: string }) {
      if (payload.fromUserId !== peerId) return;
      void processSignal({ type: 'reject' });
    }

    socket.on('call:signal', onSignal);
    socket.on('offer', onOffer);
    socket.on('answer', onAnswer);
    socket.on('iceCandidate', onIce);
    socket.on('callAccepted', onAccepted);
    socket.on('callEnded', onEnded);
    socket.on('callRejected', onRejected);

    const ringTimer =
      role === 'caller'
        ? window.setTimeout(() => {
            if (!endedRef.current && !connectedRef.current) {
              void endCall('MISSED', true);
            }
          }, RING_TIMEOUT_MS)
        : 0;

    const statsTimer = window.setInterval(async () => {
      const pc = pcRef.current;
      if (!pc || pc.connectionState !== 'connected') return;
      try {
        const stats = await pc.getStats();
        let rtt: number | null = null;
        let loss: number | null = null;
        stats.forEach((r) => {
          if (r.type === 'candidate-pair' && (r as RTCIceCandidatePairStats).state === 'succeeded') {
            const pair = r as RTCIceCandidatePairStats;
            if (typeof pair.currentRoundTripTime === 'number') {
              rtt = pair.currentRoundTripTime * 1000;
            }
          }
          if (r.type === 'inbound-rtp') {
            const inbound = r as RTCInboundRtpStreamStats;
            if (
              inbound.kind === 'audio' ||
              inbound.kind === 'video' ||
              (inbound as { mediaType?: string }).mediaType
            ) {
              if (inbound.packetsLost != null && inbound.packetsReceived != null) {
                const total = inbound.packetsLost + inbound.packetsReceived;
                if (total > 0) loss = inbound.packetsLost / total;
              }
            }
          }
        });
        setQuality(qualityFromStats(rtt, loss));
      } catch {
        /* ignore */
      }
    }, 3000);

    return () => {
      cancelled = true;
      if (ringTimer) window.clearTimeout(ringTimer);
      window.clearInterval(statsTimer);
      socket.off('call:signal', onSignal);
      socket.off('offer', onOffer);
      socket.off('answer', onAnswer);
      socket.off('iceCandidate', onIce);
      socket.off('callAccepted', onAccepted);
      socket.off('callEnded', onEnded);
      socket.off('callRejected', onRejected);
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
    localTracksRef.current.forEach((t) => {
      if (t.kind === Track.Kind.Audio) {
        if (muted) t.mute();
        else t.unmute();
      }
    });
  }, [muted]);

  useEffect(() => {
    if (mode !== 'video') return;
    localStreamRef.current?.getVideoTracks().forEach((t) => {
      t.enabled = !camOff;
    });
    localTracksRef.current.forEach((t) => {
      if (t.kind === Track.Kind.Video) {
        if (camOff) t.mute();
        else t.unmute();
      }
    });
  }, [camOff, mode]);

  useEffect(() => {
    if (remoteAudioRef.current) {
      remoteAudioRef.current.muted = !speakerOn;
      remoteAudioRef.current.volume = speakerOn ? 1 : 0;
    }
  }, [speakerOn]);

  async function switchCamera() {
    if (mode !== 'video') return;
    const next: 'user' | 'environment' = facingMode === 'user' ? 'environment' : 'user';
    try {
      if (roomRef.current) {
        // LiveKit: republish with new facing mode
        const old = localTracksRef.current.find((t) => t.kind === Track.Kind.Video);
        if (old) {
          await roomRef.current.localParticipant.unpublishTrack(old);
          old.stop();
        }
        const tracks = await createLocalTracks({ video: { facingMode: next }, audio: false });
        const video = tracks.find((t) => t.kind === Track.Kind.Video);
        if (video) {
          localTracksRef.current = localTracksRef.current.filter((t) => t.kind !== Track.Kind.Video);
          localTracksRef.current.push(video);
          if (localVideoRef.current) video.attach(localVideoRef.current);
          await roomRef.current.localParticipant.publishTrack(video);
        }
        setFacingMode(next);
        return;
      }
      if (!localStreamRef.current || !pcRef.current) return;
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: next },
        audio: false,
      });
      const newTrack = newStream.getVideoTracks()[0];
      const oldTrack = localStreamRef.current.getVideoTracks()[0];
      const sender = pcRef.current.getSenders().find((s) => s.track?.kind === 'video');
      if (sender && newTrack) await sender.replaceTrack(newTrack);
      if (oldTrack) {
        localStreamRef.current.removeTrack(oldTrack);
        oldTrack.stop();
      }
      if (newTrack) localStreamRef.current.addTrack(newTrack);
      if (localVideoRef.current) localVideoRef.current.srcObject = localStreamRef.current;
      setFacingMode(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not switch camera');
    }
  }

  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');

  return (
    <div className="flex min-h-[75dvh] flex-col items-center justify-between rounded-[28px] bg-gradient-to-b from-slate-900 to-slate-800 p-6 text-white shadow-float">
      <div className="w-full text-center">
        <p className="text-xs uppercase tracking-wide text-white/50">
          {mode === 'video' ? 'Video call' : 'Voice call'} ·{' '}
          {mediaMode === 'livekit' ? 'LiveKit' : 'WebRTC'} · friends only
        </p>
        <h1 className="mt-2 font-display text-2xl font-bold">{peerName}</h1>
        <p className="mt-2 text-sm text-white/60">{status}</p>
        <p className="mt-1 font-mono text-lg">
          {mm}:{ss}
        </p>
        <p className="mt-1 inline-flex items-center gap-1 text-xs text-white/50">
          <Signal size={12} /> {quality}
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
