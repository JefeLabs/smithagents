/**
 * DeepgramSttStream — live speech-to-text with utterance segmentation.
 * Deepgram does the hard part (endpointing): we accumulate `is_final`
 * transcript segments and emit one utterance when `speech_final` marks the
 * end of speech. The live connection is injected so tests run without the
 * service; production wires `createClient(key).listen.live({...})`.
 */
export interface LiveLike {
  on(event: string, cb: (data?: unknown) => void): void;
  send(data: Uint8Array): void;
  requestClose(): void;
}

export type LiveFactory = () => LiveLike;

interface ResultsEvent {
  is_final?: boolean;
  speech_final?: boolean;
  channel?: { alternatives?: Array<{ transcript?: string }> };
}

/** Cap on audio chunks buffered before the socket opens (~a few seconds). */
const PREOPEN_QUEUE_MAX = 256;

export class DeepgramSttStream {
  private live: LiveLike | null = null;
  private segments: string[] = [];
  // Audio can arrive before the Deepgram WS finishes opening — sending then
  // throws "Socket is not open". Optimistic `open` (true) keeps injected-fake
  // tests unchanged; a real early send throws, flips open false, and buffers
  // until the 'Open' event flushes the queue.
  private open = true;
  private preOpen: Uint8Array[] = [];

  constructor(private readonly liveFactory: LiveFactory) {}

  start(onUtterance: (text: string) => void): void {
    this.live = this.liveFactory();
    this.live.on('Open', () => {
      this.open = true;
      const queued = this.preOpen;
      this.preOpen = [];
      for (const pcm of queued) this.live?.send(pcm);
    });
    this.live.on('Close', () => {
      this.open = false;
    });
    this.live.on('Results', (data) => {
      const ev = data as ResultsEvent;
      const transcript = ev.channel?.alternatives?.[0]?.transcript?.trim() ?? '';
      if (ev.is_final && transcript.length > 0) this.segments.push(transcript);
      if (ev.speech_final) {
        const utterance = this.segments.join(' ').trim();
        this.segments = [];
        if (utterance.length > 0) onUtterance(utterance);
      }
    });
  }

  sendAudio(pcm: Uint8Array): void {
    if (!this.open) return this.buffer(pcm);
    try {
      this.live?.send(pcm);
    } catch {
      // Socket not open yet — buffer and flush on the 'Open' event.
      this.open = false;
      this.buffer(pcm);
    }
  }

  private buffer(pcm: Uint8Array): void {
    if (this.preOpen.length >= PREOPEN_QUEUE_MAX) this.preOpen.shift();
    this.preOpen.push(pcm);
  }

  stop(): void {
    this.live?.requestClose();
    this.live = null;
    this.segments = [];
    this.preOpen = [];
    this.open = true;
  }
}
