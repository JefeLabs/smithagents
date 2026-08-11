/**
 * VoiceCatalog — browse the ElevenLabs voice library and pre-synthesize an
 * agent's fixed lines.
 *
 * Two jobs:
 *  1. Catalog navigation for the creation wizard (search, gender, language),
 *     with per-voice previews the user can audition before committing.
 *  2. A disk cache of every line an agent says the same way every time —
 *     reactions and quick answers. Those play instantly, with no model call
 *     and no TTS round-trip, which is what makes a reaction feel like a
 *     reaction instead of a request.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface CatalogVoice {
  voiceId: string;
  name: string;
  gender?: string;
  accent?: string;
  language?: string;
  description?: string;
  previewUrl?: string;
  category?: string;
}

export interface VoiceQuery {
  search?: string;
  gender?: string;
  language?: string;
  page?: number;
  pageSize?: number;
}

interface SharedVoice {
  voice_id: string;
  name: string;
  gender?: string;
  accent?: string;
  language?: string;
  description?: string;
  preview_url?: string;
  category?: string;
}

export class VoiceCatalog {
  constructor(
    private readonly apiKey: string,
    private readonly cacheDir: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = "https://api.elevenlabs.io",
  ) {}

  /**
   * Browse the shared voice library. Falls back to the account's own voices
   * when the library endpoint is unavailable (older keys / plan limits), so
   * the wizard always has something to show.
   */
  async browse(query: VoiceQuery): Promise<{ voices: CatalogVoice[]; hasMore: boolean }> {
    const params = new URLSearchParams({
      page_size: String(query.pageSize ?? 24),
      page: String(query.page ?? 0),
    });
    if (query.search) params.set("search", query.search);
    if (query.gender) params.set("gender", query.gender);
    if (query.language) params.set("language", query.language);

    const shared = await this.fetchImpl(`${this.baseUrl}/v1/shared-voices?${params}`, {
      headers: { "xi-api-key": this.apiKey },
    }).catch(() => null);

    if (shared?.ok) {
      const body = (await shared.json()) as { voices?: SharedVoice[]; has_more?: boolean };
      return { voices: (body.voices ?? []).map(toCatalogVoice), hasMore: Boolean(body.has_more) };
    }

    const own = await this.fetchImpl(`${this.baseUrl}/v1/voices`, { headers: { "xi-api-key": this.apiKey } });
    if (!own.ok) {
      // A 401 here is almost always key SCOPE, not a bad key: browsing needs
      // the voices_read permission that TTS-only keys lack. Say so plainly —
      // the wizard shows this text to the user.
      const detail = await own.text().catch(() => "");
      if (own.status === 401 && /voices_read|missing_permissions/.test(detail)) {
        throw new Error(
          'This ElevenLabs API key cannot browse voices — it is missing the "voices_read" permission. ' +
            "Enable Voices → Read on the key (or create a new one) at elevenlabs.io → Profile → API Keys. " +
            "Speech still works; only the catalog is blocked.",
        );
      }
      throw new Error(`ElevenLabs voice list failed: ${own.status}`);
    }
    const body = (await own.json()) as { voices?: SharedVoice[] };
    const term = query.search?.toLowerCase();
    const voices = (body.voices ?? []).map(toCatalogVoice).filter((v) => !term || v.name.toLowerCase().includes(term));
    return { voices, hasMore: false };
  }

  /** Synthesize one line, cached by (voice, text) so repeats are free. */
  async synthesize(voiceId: string, text: string): Promise<Buffer> {
    const key = createHash("sha256").update(`${voiceId}:${text}`).digest("hex").slice(0, 32);
    const file = join(this.cacheDir, `${key}.mp3`);
    if (existsSync(file)) return readFileSync(file);

    const res = await this.fetchImpl(`${this.baseUrl}/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": this.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ text, model_id: "eleven_flash_v2_5" }),
    });
    if (!res.ok) throw new Error(`ElevenLabs TTS failed: ${res.status} ${await res.text().catch(() => "")}`);
    const audio = Buffer.from(await res.arrayBuffer());
    mkdirSync(this.cacheDir, { recursive: true });
    writeFileSync(file, audio);
    return audio;
  }

  /**
   * Pre-synthesize every fixed line an agent owns. Returns how many were
   * cached and any that failed — a partial cache is fine (missing lines
   * fall back to live synthesis), so failures never block agent creation.
   */
  async warmAgent(
    voiceId: string,
    lines: string[],
  ): Promise<{ cached: number; failed: Array<{ text: string; error: string }> }> {
    let cached = 0;
    const failed: Array<{ text: string; error: string }> = [];
    for (const text of lines.filter((l) => l.trim())) {
      try {
        await this.synthesize(voiceId, text);
        cached += 1;
      } catch (err) {
        failed.push({ text, error: String((err as Error).message) });
      }
    }
    return { cached, failed };
  }
}

function toCatalogVoice(v: SharedVoice): CatalogVoice {
  return {
    voiceId: v.voice_id,
    name: v.name,
    gender: v.gender,
    accent: v.accent,
    language: v.language,
    description: v.description,
    previewUrl: v.preview_url,
    category: v.category,
  };
}
