/**
 * One-shot preset portraits against a LIVE broker with GEMINI_API_KEY set.
 * Writes swarm/assets/avatars/<id>.png for every preset — these files are
 * COMMITTED; runtime never regenerates them.
 *
 * Usage: cd swarm && BROKER=127.0.0.1:7790 node --import tsx scripts/generate-preset-avatars.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { PRESET_AGENTS } from "../src/personas.js";

const BROKER = process.env.BROKER ?? "127.0.0.1:7790";
const outDir = new URL("../assets/avatars/", import.meta.url);
await mkdir(outDir, { recursive: true });

for (const p of PRESET_AGENTS) {
  const res = (await fetch(`http://${BROKER}/avatars/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: p.name,
      gender: p.gender,
      role: p.role,
      backstory: p.backstory,
      stereotype: p.stereotype,
    }),
  }).then((r) => r.json())) as { imageData?: string; error?: string };
  if (!res.imageData) throw new Error(`${p.id}: ${res.error ?? "no image"}`);
  await writeFile(new URL(`${p.id}.png`, outDir), Buffer.from(res.imageData, "base64"));
  console.error(`painted ${p.id}`);
}
