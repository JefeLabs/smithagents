/**
 * One-shot preset authoring against a LIVE broker. For each PRESET_AGENTS
 * seed this asks the persona generator for reactions + quickAnswers in the
 * seed's voice, and picks a first-match ElevenLabs voice. Output is JSON on
 * stdout for HAND-CURATION into personas.ts — never pasted blind. Identity
 * fields (id, name, role, hook, backstory, persona) are pinned by the seed;
 * the generator only deepens them.
 *
 * Usage: cd swarm && BROKER=127.0.0.1:7790 node --import tsx scripts/author-presets.ts > /tmp/presets.json
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PRESET_AGENTS } from "../src/personas.js";

const BROKER = process.env.BROKER ?? "127.0.0.1:7790";

/** SMITH_BROKER_TOKEN, else the broker-generated ~/.smith/broker-bridge-token (read-only, never created here). */
function bridgeAuthHeaders(): Record<string, string> {
  let token = process.env.SMITH_BROKER_TOKEN?.trim();
  if (!token) {
    try {
      token = readFileSync(join(homedir(), ".smith", "broker-bridge-token"), "utf8").trim();
    } catch {
      token = undefined;
    }
  }
  return token ? { authorization: `Bearer ${token}` } : {};
}
const AUTH = bridgeAuthHeaders();

const authored: unknown[] = [];
for (const p of PRESET_AGENTS) {
  const draft = (await fetch(`http://${BROKER}/agents/generate`, {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH },
    body: JSON.stringify({
      stereotype: p.stereotype,
      jobRole: p.jobRole,
      gender: p.gender,
      language: p.language,
      hint: `${p.name}, ${p.role}. ${p.hook} ${p.backstory}`,
    }),
  }).then((r) => r.json())) as {
    error?: string;
    reactions?: Array<{ level: string; line: string }>;
    quickAnswers?: Array<{ id: string; answer: string }>;
  };
  if (draft.error) throw new Error(`${p.id}: ${draft.error}`);
  const voices = (await fetch(
    `http://${BROKER}/voices?search=${encodeURIComponent("dominican spanish latin")}&gender=${p.gender}`,
    { headers: AUTH },
  ).then((r) => r.json())) as { voices?: Array<{ voiceId: string; name: string }>; error?: string };
  authored.push({
    ...p,
    voiceId: p.voiceId || voices.voices?.[0]?.voiceId || "",
    reactions: Object.fromEntries((draft.reactions ?? []).map((r) => [r.level, [r.line]])),
    quickAnswers: Object.fromEntries((draft.quickAnswers ?? []).map((a) => [a.id, a.answer])),
  });
  console.error(`authored ${p.id}${voices.error ? ` (no voice: ${voices.error})` : ""}`);
}
console.log(JSON.stringify(authored, null, 2));
