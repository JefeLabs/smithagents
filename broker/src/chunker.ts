/**
 * SpeechChunker — turns a token stream into speakable ~200-char chunks.
 *
 * Flush rules, in priority order:
 *   0. Newline: hard boundary regardless of minChars — the brain separates
 *      speakers ("Octavio: …\nGabriel: …") by line, and a merged chunk would
 *      voice one agent's words with another's voice.
 *   1. Sentence boundary (. ! ? followed by whitespace) AND buffer >= minChars.
 *   2. Buffer exceeds maxChars: split at the last word boundary before the cap.
 *   3. flush(): emit whatever remains (trimmed), if non-empty.
 *
 * Feeding TTS sentence-sized pieces is what makes streamed speech start fast:
 * ElevenLabs synthesizes chunk 1 while the brain is still writing chunk 3.
 */
export interface ChunkerOptions {
  maxChars?: number;
  minChars?: number;
}

export class SpeechChunker {
  private buf = "";
  private readonly maxChars: number;
  private readonly minChars: number;

  constructor(
    private readonly onChunk: (text: string) => void,
    opts?: ChunkerOptions,
  ) {
    this.maxChars = opts?.maxChars ?? 200;
    this.minChars = opts?.minChars ?? 40;
  }

  push(delta: string): void {
    this.buf += delta;
    this.drain();
  }

  flush(): void {
    const text = this.buf.trim();
    this.buf = "";
    if (text.length > 0) this.onChunk(text);
  }

  private drain(): void {
    for (;;) {
      // Rule 0 — newline is a hard boundary (speaker/paragraph separator).
      const nl = this.buf.indexOf("\n");
      if (nl >= 0) {
        this.emit(this.buf.slice(0, nl));
        this.buf = this.buf.slice(nl + 1);
        continue;
      }
      // Rule 1 — first sentence boundary at or past minChars (not merely the
      // first boundary: "Short. " below the minimum must not block emission),
      // as long as the resulting chunk stays within the cap.
      const re = /[.!?]["')\]]?\s/g;
      let cut = -1;
      let m: RegExpExecArray | null;
      // biome-ignore lint/suspicious/noAssignInExpressions: canonical regex exec loop
      while ((m = re.exec(this.buf)) !== null) {
        const end = m.index + m[0].length;
        if (end >= this.minChars) {
          cut = end;
          break;
        }
      }
      if (cut > 0 && cut <= this.maxChars + 1) {
        this.emit(this.buf.slice(0, cut));
        this.buf = this.buf.slice(cut);
        continue;
      }
      // Rule 2 — hard cap at a word boundary.
      if (this.buf.length > this.maxChars) {
        const window = this.buf.slice(0, this.maxChars + 1);
        const lastSpace = window.lastIndexOf(" ");
        const cut = lastSpace > 0 ? lastSpace : this.maxChars;
        this.emit(this.buf.slice(0, cut));
        this.buf = this.buf.slice(cut);
        continue;
      }
      return;
    }
  }

  private emit(raw: string): void {
    const text = raw.trim();
    if (text.length > 0) this.onChunk(text);
  }
}
