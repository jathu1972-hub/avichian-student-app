/**
 * Global incoming-call ringtone (single instance, loop until stop).
 * Asset: public/audio/incoming-call.mp3 (Universfield Incoming Call)
 */

const STORAGE_ENABLED = 'avichian_ringtone_enabled';
const STORAGE_VIBRATE = 'avichian_ringtone_vibrate';

const RINGTONE_NAME = 'Universfield Incoming Call';

function assetUrl(): string {
  const base = import.meta.env.BASE_URL || '/';
  return `${base}audio/incoming-call.mp3`;
}

let audio: HTMLAudioElement | null = null;
let vibrateTimer: number | null = null;
let playing = false;
let unlockBound = false;

/** Warm the audio element after a user gesture so autoplay works on the next ring. */
export function unlockIncomingRingtone(): void {
  if (typeof window === 'undefined') return;
  const el = ensureAudio();
  try {
    el.muted = true;
    void el
      .play()
      .then(() => {
        el.pause();
        el.currentTime = 0;
        el.muted = false;
      })
      .catch(() => {
        el.muted = false;
      });
  } catch {
    el.muted = false;
  }
}

function bindUnlockOnce() {
  if (unlockBound || typeof window === 'undefined') return;
  unlockBound = true;
  const once = () => {
    unlockIncomingRingtone();
    window.removeEventListener('pointerdown', once);
    window.removeEventListener('keydown', once);
    window.removeEventListener('touchstart', once);
  };
  window.addEventListener('pointerdown', once, { passive: true });
  window.addEventListener('keydown', once);
  window.addEventListener('touchstart', once, { passive: true });
}

if (typeof window !== 'undefined') {
  bindUnlockOnce();
}

function readBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return fallback;
    return v === '1' || v === 'true';
  } catch {
    return fallback;
  }
}

export function isRingtoneEnabled(): boolean {
  return readBool(STORAGE_ENABLED, true);
}

export function setRingtoneEnabled(on: boolean) {
  localStorage.setItem(STORAGE_ENABLED, on ? '1' : '0');
  if (!on) stopIncomingRingtone();
}

export function isVibrateEnabled(): boolean {
  return readBool(STORAGE_VIBRATE, true);
}

export function setVibrateEnabled(on: boolean) {
  localStorage.setItem(STORAGE_VIBRATE, on ? '1' : '0');
  if (!on && vibrateTimer) {
    window.clearInterval(vibrateTimer);
    vibrateTimer = null;
  }
}

export function getRingtoneDisplayName(): string {
  return RINGTONE_NAME;
}

function ensureAudio(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio(assetUrl());
    audio.loop = true;
    audio.preload = 'auto';
    // Device volume controls loudness; keep full element volume
    audio.volume = 1;
  }
  return audio;
}

function startVibrate() {
  if (!isVibrateEnabled()) return;
  if (typeof navigator === 'undefined' || !navigator.vibrate) return;
  if (vibrateTimer) window.clearInterval(vibrateTimer);
  // Pattern: vibrate 400ms, pause 200ms, repeat
  navigator.vibrate([400, 200, 400, 600]);
  vibrateTimer = window.setInterval(() => {
    try {
      navigator.vibrate?.([400, 200, 400, 600]);
    } catch {
      /* ignore */
    }
  }, 1600);
}

function stopVibrate() {
  if (vibrateTimer) {
    window.clearInterval(vibrateTimer);
    vibrateTimer = null;
  }
  try {
    navigator.vibrate?.(0);
  } catch {
    /* ignore */
  }
}

/** Start (or restart) the global incoming ringtone. Only one instance. */
export async function startIncomingRingtone(): Promise<void> {
  // Always clear any prior instance first (no overlapping audio)
  stopIncomingRingtone();

  if (!isRingtoneEnabled()) {
    startVibrate();
    return;
  }

  const el = ensureAudio();
  el.muted = false;
  el.currentTime = 0;
  el.loop = true;
  el.volume = 1;
  playing = true;

  try {
    await el.play();
  } catch (err) {
    // Autoplay blocked until user gesture — vibrate still helps on mobile
    console.warn('[ringtone] play blocked until gesture:', err);
    playing = false;
    bindUnlockOnce();
  }

  startVibrate();
}

export function stopIncomingRingtone(): void {
  playing = false;
  stopVibrate();
  if (!audio) return;
  try {
    audio.pause();
    audio.currentTime = 0;
  } catch {
    /* ignore */
  }
}

export function pauseIncomingRingtone(): void {
  if (!audio || !playing) return;
  try {
    audio.pause();
  } catch {
    /* ignore */
  }
  stopVibrate();
}

export async function resumeIncomingRingtone(): Promise<void> {
  if (!isRingtoneEnabled() || !audio) return;
  playing = true;
  try {
    await audio.play();
  } catch (err) {
    console.warn('[ringtone] resume failed:', err);
  }
  startVibrate();
}

/** Play once for Settings “Test ringtone” (does not loop). */
export async function testIncomingRingtone(durationMs = 2500): Promise<void> {
  stopIncomingRingtone();
  const el = ensureAudio();
  el.loop = false;
  el.currentTime = 0;
  try {
    await el.play();
  } catch (err) {
    console.warn('[ringtone] test play failed:', err);
    throw new Error('Could not play ringtone — tap again after interacting with the page');
  }
  window.setTimeout(() => {
    try {
      el.pause();
      el.currentTime = 0;
      el.loop = true;
    } catch {
      /* ignore */
    }
  }, durationMs);
}

export function isRingtonePlaying(): boolean {
  return playing && Boolean(audio && !audio.paused);
}
