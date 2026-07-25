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

export class DeepgramSttStream {
  private live: LiveLike | null = null;
  private segments: string[] = [];

  constructor(private readonly liveFactory: LiveFactory) {}

  start(onUtterance: (text: string) => void): void {
    this.live = this.liveFactory();
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
    this.live?.send(pcm);
  }

  stop(): void {
    this.live?.requestClose();
    this.live = null;
    this.segments = [];
  }
}
