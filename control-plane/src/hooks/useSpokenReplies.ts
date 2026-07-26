import { useEffect, useRef, useState } from "react";
import type { AudioFrame, ChatMessage, RosterAgent, SpeechProfile } from "./useBrokerChat";

const STORE_KEY = "smith.sound";
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

/**
 * Voices broker replies with Zoom-like turn taking (a longer pause whenever a
 * different agent takes the floor). Two delivery paths share one mute state:
 *
 * - `playAudioFrame` — ElevenLabs mp3 frames streamed by the broker, decoded
 *   and played through Web Audio. Preferred whenever the broker offers audio.
 * - Web Speech fallback (`webSpeechEnabled`) — per-agent system voices from
 *   the roster speech profiles, used when the broker has no TTS key.
 *
 * Playback is serialized through explicit queues (WebKit's built-in speech
 * queue overlaps utterances with different voices). The consumed-message
 * pointer advances even while muted, so unmuting never replays a backlog.
 */
export function useSpokenReplies(messages: ChatMessage[], roster: RosterAgent[], webSpeechEnabled: boolean) {
  const [soundOn, setSoundOn] = useState(() => localStorage.getItem(STORE_KEY) !== "off");
  const soundOnRef = useRef(soundOn);
  soundOnRef.current = soundOn;
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

  const pumpAudio = () => {
    if (speaking.current || !ctx.current) return;
    const next = audioQueue.current.shift();
    if (!next) return;
    speaking.current = true;
    const gap = gapFor(next.speaker, lastSpeaker.current);
    lastSpeaker.current = next.speaker ?? lastSpeaker.current;
    gapTimer.current = setTimeout(() => {
      gapTimer.current = null;
      const audioCtx = ctx.current;
      if (!audioCtx) {
        speaking.current = false;
        return;
      }
      const source = audioCtx.createBufferSource();
      source.buffer = next.buffer;
      source.connect(audioCtx.destination);
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
    if (!soundOnRef.current) return;
    ctx.current ??= new AudioContext();
    void ctx.current.resume();
    const bytes = Uint8Array.from(atob(frame.dataB64), (c) => c.charCodeAt(0));
    try {
      const buffer = await ctx.current.decodeAudioData(bytes.buffer);
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

  const toggleSound = () => {
    setSoundOn((on) => {
      const next = !on;
      localStorage.setItem(STORE_KEY, next ? "on" : "off");
      if (!next) {
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
      }
      return next;
    });
  };

  return { soundOn, toggleSound, playAudioFrame };
}
