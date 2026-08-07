// Per-request avatar engine selection (spec §Avatar generation):
// verified google key → Gemini API (~3–5s); agy active per the CLI
// registry → AgyImagesClient (~60–90s); neither → null, caller shows the
// two remedies. Subscription-first: the key is the accelerator, not the
// requirement.
import { GoogleGenAI } from '@google/genai';
import { AgyImagesClient } from './agy-images-client.ts';
import type { ImagesClient } from './avatar-generator.ts';

export interface AvatarEngineDeps {
  /** google credential (api-keys store via swarm, or legacy env) — null on any failure. */
  getGoogleKey(): Promise<string | null>;
  /** agy row of the swarm's /cli-tools listing — active means launchable. */
  isAgyActive(): Promise<boolean>;
  makeApiClient?(key: string): ImagesClient;
  makeAgyClient?(): ImagesClient;
}

export type AvatarEngine = { kind: 'api' | 'agy'; client: ImagesClient } | null;

export async function resolveAvatarEngine(deps: AvatarEngineDeps): Promise<AvatarEngine> {
  const key = await deps.getGoogleKey();
  if (key) {
    const make = deps.makeApiClient ?? ((k: string) => new GoogleGenAI({ apiKey: k }) as unknown as ImagesClient);
    return { kind: 'api', client: make(key) };
  }
  if (await deps.isAgyActive()) {
    const make = deps.makeAgyClient ?? (() => new AgyImagesClient());
    return { kind: 'agy', client: make() };
  }
  return null;
}
