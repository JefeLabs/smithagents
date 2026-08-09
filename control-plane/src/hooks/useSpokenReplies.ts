import { useEffect, useRef } from "react";
import type { AudioFrame, ChatMessage, RosterAgent, SpeechProfile } from "../api/types";
import { useRoster, useTranscript } from "../queries/pushed";
import { useAudioStore } from "../stores/audioStore";
import { useSocketStore } from "../stores/socketStore";

const SPEAKER_RE = /^([A-Z][\w-]{1,24}):\s+(.*)$/s;
/** Breathing room between turns: a real pause when the speaker changes. */
const SPEAKER_CHANGE_GAP_MS = 850;
const SAME_SPEAKER_GAP_MS = 250;

/** Deterministic per-speaker pitch fallback so unprofiled agents still sound distinct. */
function pitchFor(name: string): number {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) | 0;
  return 0.85 + (Math.abs(h) % 40) / 100; // 0.85 – 1.24
}

/** Pick a system voice by name + language from the agent's speech profile. */
function voiceFor(profile: SpeechProfile | undefined): SpeechSynthesisVoice | null {
  if (!profile) return null;
  const voices = speechSynthesis.getVoices();
  const langMatch = profile.lang
    ? voices.filter((v) => v.lang.replace("_", "-").startsWith(profile.lang as string))
    : voices;
  if (profile.voiceName) {
    const byName = langMatch.find((v) => v.name.includes(profile.voiceName as string));
    if (byName) return byName;
  }
  return langMatch[0] ?? null;
}

function gapFor(speaker: string | undefined, last: string | undefined): number {
  return speaker && speaker !== last ? SPEAKER_CHANGE_GAP_MS : SAME_SPEAKER_GAP_MS;
}

// Stable empties: a fresh `[]` while a pushed query is still pending would
// re-run the transcript pass on every render.
const NO_MESSAGES: ChatMessage[] = [];
const NO_ROSTER: RosterAgent[] = [];

/**
 * Voices broker replies with Zoom-like turn taking (a longer pause whenever a
 * different agent takes the floor). Two delivery paths share one mute state:
 *
 * - broker audio — ElevenLabs mp3 frames, decoded and played through Web
 *   Audio. Preferred whenever the broker offers audio. Frames arrive by
 *   subscribing to the socket store, not through the query cache: audio is a
 *   stream that plays once and is gone, never cached state.
 * - Web Speech fallback — per-agent system voices from the roster speech
 *   profiles, used only when the broker has no TTS of its own. The socket
 *   store's `audioMode` says which, and getting it wrong means every reply is
 *   spoken twice rather than not at all.
 *
 * Takes no data arguments: it reads the transcript and roster it voices, so
 * there is no way to mount it against a different transcript than the one on
 * screen. Mounted once at app scope — below the router, `/board` would go
 * silent.
 *
 * Playback is serialized through explicit queues (WebKit's built-in speech
 * queue overlaps utterances with different voices). The consumed-message
 * pointer advances even while muted, so unmuting never replays a backlog.
 */
export function useSpokenReplies() {
  const { data: messages = NO_MESSAGES } = useTranscript();
  const { data: rosterFrame } = useRoster();
  const roster = rosterFrame?.agents ?? NO_ROSTER;
  // True when the BROKER produces the audio itself, which is exactly when the
  // browser's own speech synthesis must stay quiet.
  const webSpeechEnabled = !useSocketStore((s) => s.audioMode);
  const soundOn = useAudioStore((s) => s.soundOn);
  const setAudioBlocked = useAudioStore((s) => s.setAudioBlocked);
  const gestureArmed = useRef(false);
  const lastConsumed = useRef(-1);
  const profiles = useRef(new Map<string, SpeechProfile>());
  const lastSpeaker = useRef<string | undefined>(undefined);
  const gapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Web Speech queue (fallback path).
  const speechQueue = useRef<Array<{ utterance: SpeechSynthesisUtterance; speaker?: string }>>([]);
  const speaking = useRef(false);

  // Web Audio queue (ElevenLabs path).
  const ctx = useRef<AudioContext | null>(null);
  const audioQueue = useRef<Array<{ buffer: AudioBuffer; speaker?: string }>>([]);
  const currentSource = useRef<AudioBufferSourceNode | null>(null);

  useEffect(() => {
    profiles.current = new Map(roster.filter((a) => a.speech).map((a) => [a.name, a.speech as SpeechProfile]));
  }, [roster]);

  /** One-shot: the next click/key resumes the blocked context and drains the queue. */
  const armGestureResume = () => {
    if (gestureArmed.current) return;
    gestureArmed.current = true;
    const onGesture = () => {
      gestureArmed.current = false;
      window.removeEventListener("pointerdown", onGesture, true);
      window.removeEventListener("keydown", onGesture, true);
      const audioCtx = ctx.current;
      if (!audioCtx) return;
      audioCtx.resume().then(
        () => {
          setAudioBlocked(false);
          pumpAudio();
        },
        // Still not allowed — re-arm and wait for the next gesture.
        () => armGestureResume(),
      );
    };
    window.addEventListener("pointerdown", onGesture, true);
    window.addEventListener("keydown", onGesture, true);
  };

  const pumpAudio = () => {
    const audioCtx = ctx.current;
    if (speaking.current || !audioCtx) return;
    // A non-running context can't fire onended — a source started on it would
    // wedge this queue forever (speaking stuck true). Hold frames instead and
    // let a user gesture resume playback.
    if (audioCtx.state !== "running") {
      if (audioQueue.current.length > 0) {
        setAudioBlocked(true);
        armGestureResume();
      }
      return;
    }
    const next = audioQueue.current.shift();
    if (!next) return;
    speaking.current = true;
    const gap = gapFor(next.speaker, lastSpeaker.current);
    lastSpeaker.current = next.speaker ?? lastSpeaker.current;
    gapTimer.current = setTimeout(() => {
      gapTimer.current = null;
      const liveCtx = ctx.current;
      if (!liveCtx) {
        speaking.current = false;
        return;
      }
      if (liveCtx.state !== "running") {
        // Context got suspended during the gap — put the frame back and hold.
        audioQueue.current.unshift(next);
        speaking.current = false;
        setAudioBlocked(true);
        armGestureResume();
        return;
      }
      const source = liveCtx.createBufferSource();
      source.buffer = next.buffer;
      source.connect(liveCtx.destination);
      source.onended = () => {
        currentSource.current = null;
        speaking.current = false;
        pumpAudio();
      };
      currentSource.current = source;
      source.start();
    }, gap);
  };

  const playAudioFrame = async (frame: AudioFrame) => {
    // Read through, never off a captured render value: frames arrive from a
    // socket subscription registered once, so a closed-over `soundOn` would be
    // whatever it was the moment this hook first mounted.
    if (!useAudioStore.getState().soundOn) return;
    ctx.current ??= new AudioContext();
    const audioCtx = ctx.current;
    if (audioCtx.state !== "running") {
      audioCtx.resume().then(
        () => {
          setAudioBlocked(false);
          pumpAudio();
        },
        () => {
          setAudioBlocked(true);
          armGestureResume();
        },
      );
    }
    const bytes = Uint8Array.from(atob(frame.dataB64), (c) => c.charCodeAt(0));
    try {
      const buffer = await audioCtx.decodeAudioData(bytes.buffer);
      audioQueue.current.push({ buffer, speaker: frame.speaker });
      pumpAudio();
    } catch {
      // Undecodable frame — drop it; the transcript already carries the text.
    }
  };

  useEffect(() => {
    const pumpSpeech = () => {
      if (speaking.current) return;
      const next = speechQueue.current.shift();
      if (!next) return;
      speaking.current = true;
      const gap = gapFor(next.speaker, lastSpeaker.current);
      lastSpeaker.current = next.speaker ?? lastSpeaker.current;
      const advance = () => {
        speaking.current = false;
        pumpSpeech();
      };
      next.utterance.onend = advance;
      next.utterance.onerror = advance;
      gapTimer.current = setTimeout(() => {
        gapTimer.current = null;
        speechSynthesis.speak(next.utterance);
      }, gap);
    };
    for (const m of messages) {
      if (m.id <= lastConsumed.current) continue;
      lastConsumed.current = m.id;
      if (!webSpeechEnabled || !soundOn || m.role !== "broker" || !("speechSynthesis" in window)) continue;
      const parsed = SPEAKER_RE.exec(m.text);
      const speaker = parsed?.[1];
      const profile = speaker ? profiles.current.get(speaker) : undefined;
      const utterance = new SpeechSynthesisUtterance(parsed ? parsed[2] : m.text);
      const voice = voiceFor(profile);
      if (voice) utterance.voice = voice;
      utterance.rate = profile?.rate ?? 1.05;
      utterance.pitch = profile?.pitch ?? (speaker ? pitchFor(speaker) : 1);
      speechQueue.current.push({ utterance, speaker });
    }
    pumpSpeech();
  }, [messages, soundOn, webSpeechEnabled]);

  /**
   * Muting silences what is already in flight, not just what comes next.
   * Driven off the store's `soundOn` rather than living inside a toggle
   * callback: the mute button is in a stage route now and calls
   * `audioStore.toggleSound` directly, so a flush attached to one particular
   * caller would be skipped by every other one.
   */
  const wasSoundOn = useRef(soundOn);
  useEffect(() => {
    const muting = wasSoundOn.current && !soundOn;
    wasSoundOn.current = soundOn;
    if (!muting) return;
    speechQueue.current = [];
    audioQueue.current = [];
    speaking.current = false;
    if (gapTimer.current) {
      clearTimeout(gapTimer.current);
      gapTimer.current = null;
    }
    currentSource.current?.stop();
    currentSource.current = null;
    if ("speechSynthesis" in window) speechSynthesis.cancel();
  }, [soundOn]);

  /**
   * Audio frames bypass the query cache entirely — the socket store fans them
   * out to subscribers. Going through a ref keeps this effect off
   * `playAudioFrame`'s identity, which changes on every render.
   */
  const sink = useRef<(frame: AudioFrame) => void>(() => {});
  sink.current = (frame) => void playAudioFrame(frame);
  useEffect(() => useSocketStore.getState().onAudioFrame((frame) => sink.current(frame)), []);

  // `playAudioFrame` is returned for the subscription's sake only — nothing in
  // the app calls it, but a test that drives it directly can assert the decode
  // and queue behaviour without standing up a socket.
  return { playAudioFrame };
}
