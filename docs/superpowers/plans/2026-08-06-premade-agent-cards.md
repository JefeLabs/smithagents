# Premade Agent Cards + AI Avatar Generator — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 12-card chooser (11 fully-formed preset agents + Create custom) to the add-agent flow, with one-click join or customize-via-wizard, and a broker-side Gemini avatar generator that gives custom agents flat-vector portraits.

**Architecture:** Preset data lives in the swarm catalog (`personas.ts`, "data, not code") and flows to the UI through the existing `/agents/catalog → /agent-catalog` broker proxy. Avatar files live in the swarm (`.smith/avatars/` for live agents, committed `assets/avatars/` for preset art) behind one `GET /avatars/:file` route the broker proxies. The broker owns the Gemini call (`POST /avatars/generate`) and returns base64 for in-wizard preview; nothing persists until the agent is saved.

**Tech Stack:** Fastify (swarm), raw node http (broker text channel), React 19 + Vite (control-plane), `@google/genai` + `sharp` (new, broker only), node:test via `node --import tsx --test` (swarm/broker), Vitest + Testing Library (control-plane).

**Spec:** `docs/superpowers/specs/2026-08-06-premade-agent-cards-design.md`

## Global Constraints

- Swarm tests NEVER construct `OrchestratorServer` or use Fastify `.inject` — no such harness exists (see the header comments in `swarm/src/server.test.ts:30-41`). Route glue is verified by extracting logic into exported, unit-tested helpers; keep new route bodies thin calls into `swarm/src/avatars.ts`.
- Broker route tests DO exist: use the `channelWith(...)` harness in `broker/src/text-channel.test.ts`.
- Import suffixes: swarm files import with `.js` suffix (`from './personas.js'`); broker files import with `.ts` suffix (`from './text-channel.ts'`); control-plane imports are extensionless.
- Test runners: `cd swarm && npm test` / `cd broker && npm test` (node:test, `assert/strict`); `cd control-plane && npm test` (vitest run). Lint is Biome (`npx biome check --write .` in the touched package).
- Control-plane styling is hand-written CSS in `control-plane/src/styles/components.css` — no Tailwind, no CSS modules. New class names follow the existing BEM-ish pattern (`.preset-card__hook`).
- The control-plane hardcodes the broker address as `const BASE = "127.0.0.1:7790"` (precedent: `AddAgentModal.tsx:5`). Follow that precedent where a component needs a URL.
- Gemini model default is exactly `gemini-2.5-flash-image`, overridable via `GEMINI_IMAGE_MODEL`. `GEMINI_API_KEY` is OPTIONAL — absent key must degrade (no Generate button, presets fully functional), mirroring how `ELEVENLABS_API_KEY` degrades voices.
- Avatar filenames match `/^[a-z0-9][a-z0-9-]{0,63}\.png$/` everywhere (same stem rule as agent ids in `swarm/src/agents.ts:96`). `avatarData` cap: 2 MB decoded, PNG only. `avatarData`/`avatarPreset` are transport-only — never persisted into agent JSON.
- Preset joins MUST send an explicit `id` — the server's name slugger dashes non-ASCII (`Radhamés` → `radham-s`) at `swarm/src/server.ts:871`, and `b.id` is honored there.
- Commit messages: conventional commits with package scope (`feat(swarm): …`, `feat(control-plane): …`), matching `git log`.
- Do not touch `swarm/.smith/agents/ignacio.json` / `wilkin.json` — they carry uncommitted local edits that are not part of this feature.

## File Structure

| File | Responsibility |
|---|---|
| `swarm/src/personas.ts` (modify) | + `PresetAgent` type, `PRESET_AGENTS` (11 entries), `findPreset()` |
| `swarm/src/personas.test.ts` (create) | Preset catalog invariants |
| `swarm/src/avatars.ts` (create) | All avatar file logic: filename rule, base64 decode/validate, stage (write/copy), read for serving |
| `swarm/src/avatars.test.ts` (create) | Unit tests for the above |
| `swarm/src/agents.ts` (modify) | + `avatar?: string` on `ComposedAgent` |
| `swarm/src/server.ts` (modify) | Catalog `presets`, POST/PUT avatar staging, `GET /avatars/:file`, reset archives avatars dir |
| `swarm/src/server-enrich.test.ts` (modify) | `buildAgentUpdate` preserves `avatar` |
| `broker/src/config.ts` + `config.test.ts` (modify) | + `geminiApiKey?`, `geminiImageModel` |
| `broker/src/avatar-generator.ts` (create) | House-style prompt + Gemini call + sharp 512×512 PNG normalize |
| `broker/src/avatar-generator.test.ts` (create) | Prompt/pipeline tests with a fake client |
| `broker/src/swarm-client.ts` (modify) | + `RegistryAgent.avatar`, `avatarFile()` binary GET |
| `broker/src/text-channel.ts` (modify) | + creation-interface members, `POST /avatars/generate`, `GET /avatars/:file` |
| `broker/src/text-channel.test.ts` (modify) | Route tests; extend `stubCreation` |
| `broker/src/main.ts` (modify) | Wire generator, `avatarGen` catalog flag, roster `avatar` field |
| `control-plane/src/hooks/useBrokerChat.ts` (modify) | + `RosterAgent.avatar` |
| `control-plane/src/atoms/Avatar.tsx` (modify) | `image` branch with onerror fallback |
| `control-plane/src/atoms/Avatar.test.tsx` (create) | Image/fallback tests |
| `control-plane/src/molecules/AgentAvatar.tsx` (modify) | + `avatar` prop → portrait URL |
| `control-plane/src/pages/HomePage.tsx` (modify) | Plumb `avatar` from roster |
| `control-plane/src/organisms/AddAgentChooser.tsx` (create) | The 12-card grid |
| `control-plane/src/molecules/AvatarGeneratorBlock.tsx` (create) | Generate/reroll portrait block |
| `control-plane/src/organisms/AddAgentModal.tsx` (modify) | Chooser mode, join/customize, avatar submit fields |
| `control-plane/src/organisms/AddAgentModal.test.tsx` (create) | Wizard + chooser + avatar tests (closes an existing gap) |
| `control-plane/src/styles/components.css` (modify) | `.preset-grid/.preset-card/.avatar-gen/.avatar__img` |
| `swarm/scripts/author-presets.ts` (create) | One-shot: persona-generator + voice pick per seed → curated content |
| `swarm/scripts/generate-preset-avatars.ts` (create) | One-shot: Gemini portrait per preset → `swarm/assets/avatars/*.png` |

---

### Task 1: Swarm preset catalog (`PRESET_AGENTS`)

**Files:**
- Modify: `swarm/src/personas.ts` (append after `findLanguage`, ~line 260)
- Create: `swarm/src/personas.test.ts`
- Modify: `swarm/src/server.ts:857-866` (catalog route)

**Interfaces:**
- Consumes: existing `findStereotype`, `findJobRole`, `findLanguage`, `Gender`, `Reactions` from `personas.ts`.
- Produces: `PresetAgent` type, `PRESET_AGENTS: PresetAgent[]`, `findPreset(id: string): PresetAgent | undefined` — imported by `server.ts` (Task 3) and the authoring scripts (Task 9). Catalog payload gains `presets: PRESET_AGENTS`.

- [ ] **Step 1: Write the failing test** — create `swarm/src/personas.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findJobRole, findLanguage, findPreset, findStereotype, PRESET_AGENTS } from './personas.js';

test('11 presets, unique ids, every catalog reference resolves, card content present', () => {
  assert.equal(PRESET_AGENTS.length, 11);
  assert.equal(new Set(PRESET_AGENTS.map((p) => p.id)).size, 11);
  for (const p of PRESET_AGENTS) {
    assert.match(p.id, /^[a-z0-9][a-z0-9-]{0,63}$/, p.id);
    assert.ok(findStereotype(p.stereotype), `${p.id}: stereotype ${p.stereotype}`);
    assert.ok(findJobRole(p.jobRole), `${p.id}: jobRole ${p.jobRole}`);
    assert.ok(findLanguage(p.language), `${p.id}: language ${p.language}`);
    assert.ok(p.hook.length > 0 && p.backstory.length > 0 && p.persona.style.length > 0, p.id);
    assert.match(p.ring, /^#[0-9a-fA-F]{6}$/, p.id);
    assert.equal(p.avatar, `${p.id}.png`, p.id);
    assert.equal(p.engine.cli, 'claude', p.id);
  }
});

test('findPreset resolves by id and misses cleanly', () => {
  assert.equal(findPreset('minerva')?.name, 'Minerva');
  assert.equal(findPreset('nope'), undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd swarm && node --import tsx --test src/personas.test.ts`
Expected: FAIL — `PRESET_AGENTS` / `findPreset` not exported.

- [ ] **Step 3: Implement** — append to `swarm/src/personas.ts`:

```ts
/**
 * Preset agents — the "premade cards" in the add-agent chooser. Each is a
 * complete character built FROM the catalog above (stereotype = how they
 * talk, jobRole = what they own), so one click can join them fully formed.
 * Data, not code, like everything else in this file: joining copies the
 * preset into a regular composed-agent record the user edits freely.
 *
 * `voiceId` and the deep persona fields (reactions, quickAnswers) are filled
 * by scripts/author-presets.ts against a live broker, then hand-curated —
 * empty values here mean "not yet authored", and the wizard/join flow
 * tolerates them (stereotype reactions seed on join, voice stays unset).
 */
export interface PresetAgent {
  id: string;
  name: string;
  gender: Gender;
  /** Display title on the card and the joined agent. */
  role: string;
  jobRole: string;
  stereotype: string;
  language: string;
  /** One-line card blurb. */
  hook: string;
  backstory: string;
  persona: { style: string };
  reactions?: Partial<Reactions>;
  quickAnswers?: Record<string, string>;
  /** ElevenLabs voice id; empty = not yet authored. */
  voiceId: string;
  /** Fixed ring color — presets never depend on roster order. */
  ring: string;
  /** Filename under swarm/assets/avatars/. */
  avatar: string;
  engine: { cli: string; model: string };
}

const preset = (p: PresetAgent): PresetAgent => p;
const ENGINE_DEFAULT = { cli: 'claude', model: 'claude-opus' };

export const PRESET_AGENTS: PresetAgent[] = [
  preset({
    id: 'yesenia', name: 'Yesenia', gender: 'female', role: 'Frontend Engineer',
    jobRole: 'frontend', stereotype: 'builder', language: 'en-do',
    hook: 'Ships pixels before the meeting ends.',
    backstory: "Cut her teeth rebuilding her tía's colmado POS screen in Santo Domingo until the buttons stopped lying. Believes a UI is finished when abuela can use it without asking.",
    persona: { style: "Fast, upbeat, concrete. Talks in shipped increments — 'dame una hora' — and shows a screenshot instead of an argument." },
    voiceId: '', ring: '#6f8dff', avatar: 'yesenia.png', engine: ENGINE_DEFAULT,
  }),
  preset({
    id: 'radhames', name: 'Radhamés', gender: 'male', role: 'Backend Engineer',
    jobRole: 'backend', stereotype: 'purist', language: 'en-do',
    hook: 'Your API contract is his moral code.',
    backstory: 'Spent six years at a Santiago telecom where a nullable field took down billing for a weekend. Now every contract is explicit, every error enumerated, and he sleeps fine.',
    persona: { style: "Measured and exact. Quotes the contract back at you word for word; a quiet 'no, señor' ends the discussion." },
    voiceId: '', ring: '#e0a15a', avatar: 'radhames.png', engine: ENGINE_DEFAULT,
  }),
  preset({
    id: 'bienvenido', name: 'Bienvenido', gender: 'male', role: 'DevOps / Platform',
    jobRole: 'devops', stereotype: 'skeptic', language: 'en-do',
    hook: 'Assumes every deploy is lying until the graphs agree.',
    backstory: "Ran infra for a Puerto Plata resort chain where 'it works on my machine' once stranded four hundred check-ins. He has rolled back more heroes than he can count.",
    persona: { style: "Dry, unhurried. Answers proposals with 'what does the rollback look like?' and means it every time." },
    voiceId: '', ring: '#d977c8', avatar: 'bienvenido.png', engine: ENGINE_DEFAULT,
  }),
  preset({
    id: 'minerva', name: 'Minerva', gender: 'female', role: 'Security Engineer',
    jobRole: 'security', stereotype: 'auditor', language: 'en-do',
    hook: 'Reads your diff like a border agent reads a passport.',
    backstory: 'Found her first injection hole at nineteen in a university enrollment portal and reported it; they fixed it and hired her. Treats every input as hostile because one always is.',
    persona: { style: 'Clipped, precise, zero small talk. States the exposure, states the fix, stops talking.' },
    voiceId: '', ring: '#5fd0b0', avatar: 'minerva.png', engine: ENGINE_DEFAULT,
  }),
  preset({
    id: 'altagracia', name: 'Altagracia', gender: 'female', role: 'QA Engineer',
    jobRole: 'qa', stereotype: 'skeptic', language: 'en-do',
    hook: "Breaks it on purpose so users can't by accident.",
    backstory: 'Grew up the eldest of five in La Vega, which is its own kind of chaos testing. She files reproductions so clean the fix writes itself.',
    persona: { style: "Warm but relentless. Asks 'and then what happens?' until somebody finally knows the answer." },
    voiceId: '', ring: '#f2778f', avatar: 'altagracia.png', engine: ENGINE_DEFAULT,
  }),
  preset({
    id: 'teofilo', name: 'Teófilo', gender: 'male', role: 'Data Engineer',
    jobRole: 'data', stereotype: 'purist', language: 'en-do',
    hook: "If the numbers drift, he loses sleep — so they don't.",
    backstory: "Reconciled remittance ledgers between Santo Domingo and New York where a missing cent was a family's phone call. His pipelines are boring, audited, and never surprised.",
    persona: { style: 'Careful, methodical, softly proud. Explains a schema the way other people describe a good meal.' },
    voiceId: '', ring: '#9b8cff', avatar: 'teofilo.png', engine: ENGINE_DEFAULT,
  }),
  preset({
    id: 'xiomara', name: 'Xiomara', gender: 'female', role: 'ML Engineer',
    jobRole: 'ml', stereotype: 'builder', language: 'en-do',
    hook: 'Ships the model, then tells you exactly where it will fail.',
    backstory: 'Trained her first model on hurricane data after Georges took the family roof. She distrusts benchmarks, trusts holdout sets, and ships anyway.',
    persona: { style: 'Quick, curious, honest about uncertainty — gives you the number and the caveat in the same breath.' },
    voiceId: '', ring: '#6f8dff', avatar: 'xiomara.png', engine: ENGINE_DEFAULT,
  }),
  preset({
    id: 'rafelito', name: 'Rafelito', gender: 'male', role: 'Mobile Engineer',
    jobRole: 'mobile', stereotype: 'builder', language: 'en-do',
    hook: "If it stutters on a five-year-old phone, it's not done.",
    backstory: 'Built his first app for the family guagua route because the printed schedule was fiction. Tests on the cheapest Android he can buy in Villa Consuelo, on purpose.',
    persona: { style: 'Easygoing and practical. Measures everything in frames and battery; celebrates small wins out loud.' },
    voiceId: '', ring: '#e0a15a', avatar: 'rafelito.png', engine: ENGINE_DEFAULT,
  }),
  preset({
    id: 'dulce', name: 'Dulce', gender: 'female', role: 'Product Designer',
    jobRole: 'design', stereotype: 'diplomat', language: 'en-do',
    hook: 'Draws the version everyone was arguing toward.',
    backstory: 'Started painting colmado signs in Samaná and learned that a design works when a stranger squints and still gets it. She defends users with a smile that does not move.',
    persona: { style: 'Warm, visual, disarming. Restates the fight fairly, then shows a sketch that ends it.' },
    voiceId: '', ring: '#d977c8', avatar: 'dulce.png', engine: ENGINE_DEFAULT,
  }),
  preset({
    id: 'josefina', name: 'Josefina', gender: 'female', role: 'Product Manager',
    jobRole: 'pm', stereotype: 'diplomat', language: 'en-do',
    hook: 'Turns a shouting match into a shipped decision.',
    backstory: "Ran her mother's import business logistics at twenty-two, negotiating customs, drivers, and weather in the same phone call. Scope is her love language.",
    persona: { style: 'Calm, structured, decisive. Summarizes in threes and closes with who does what by when.' },
    voiceId: '', ring: '#5fd0b0', avatar: 'josefina.png', engine: ENGINE_DEFAULT,
  }),
  preset({
    id: 'anselmo', name: 'Anselmo', gender: 'male', role: 'Technical Writer',
    jobRole: 'docs', stereotype: 'architect', language: 'en-do',
    hook: 'Writes the docs that survive the rewrite.',
    backstory: 'Kept the only accurate runbook at a Santo Domingo bank through three migrations and two acquisitions. He interviews code like a journalist and quotes it honestly.',
    persona: { style: 'Unhurried, precise, gently funny. Asks the question the new hire was afraid to ask, then writes down the answer.' },
    voiceId: '', ring: '#f2778f', avatar: 'anselmo.png', engine: ENGINE_DEFAULT,
  }),
];

export function findPreset(id: string): PresetAgent | undefined {
  return PRESET_AGENTS.find((p) => p.id === id);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd swarm && node --import tsx --test src/personas.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Expose in the catalog** — in `swarm/src/server.ts`, add `PRESET_AGENTS` to the existing personas import, and in the `GET /agents/catalog` handler (line 857) add one field:

```ts
    this.app.get('/agents/catalog', async () => {
      return {
        stereotypes: STEREOTYPES,
        jobRoles: JOB_ROLES,
        engines: ENGINES,
        languages: LANGUAGES,
        quickQuestions: QUICK_QUESTIONS,
        reactionLevels: REACTION_LEVELS,
        presets: PRESET_AGENTS,
      };
    });
```

- [ ] **Step 6: Full swarm suite + lint**

Run: `cd swarm && npm test && npx biome check --write src/personas.ts src/personas.test.ts`
Expected: all PASS, no lint errors.

- [ ] **Step 7: Commit**

```bash
git add swarm/src/personas.ts swarm/src/personas.test.ts swarm/src/server.ts
git commit -m "feat(swarm): 11 preset agents in the creation catalog"
```

---

### Task 2: Swarm avatar file module (`avatars.ts`)

**Files:**
- Create: `swarm/src/avatars.ts`
- Create: `swarm/src/avatars.test.ts`

**Interfaces:**
- Consumes: `node:fs/promises`, `node:path` only.
- Produces (used by Task 3's routes):
  - `AVATAR_FILE_RE: RegExp`
  - `decodeAvatarData(avatarData: string): Buffer` — throws `Error` with a user-facing message on non-PNG or >2 MB
  - `stageAvatar(opts: { agentId: string; liveDir: string; presetDir: string; avatarData?: string; avatarPreset?: string }): Promise<string | undefined>` — returns the stored filename (`<agentId>.png`) or `undefined` when the body carried no avatar; throws on invalid data / unknown preset
  - `readAvatar(file: string, liveDir: string, presetDir: string): Promise<Buffer | null>` — two-directory lookup, `null` on bad name or miss

- [ ] **Step 1: Write the failing tests** — create `swarm/src/avatars.test.ts`:

```ts
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { decodeAvatarData, readAvatar, stageAvatar } from './avatars.js';

// Smallest possible valid-magic PNG payload for tests: real header, junk body.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('body')]);
const dirs = async () => ({
  liveDir: await mkdtemp(join(tmpdir(), 'av-live-')),
  presetDir: await mkdtemp(join(tmpdir(), 'av-preset-')),
});

test('decodeAvatarData: accepts a small png, rejects non-png and oversize', () => {
  assert.deepEqual(decodeAvatarData(PNG.toString('base64')), PNG);
  assert.throws(() => decodeAvatarData(Buffer.from('GIF89a...').toString('base64')), /PNG/);
  const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
  assert.throws(() => decodeAvatarData(big.toString('base64')), /2 MB/);
  assert.throws(() => decodeAvatarData(''), /PNG/);
});

test('stageAvatar: writes avatarData as <id>.png in liveDir', async () => {
  const { liveDir, presetDir } = await dirs();
  const file = await stageAvatar({ agentId: 'nena', liveDir, presetDir, avatarData: PNG.toString('base64') });
  assert.equal(file, 'nena.png');
  assert.deepEqual(await readFile(join(liveDir, 'nena.png')), PNG);
});

test('stageAvatar: copies preset art into liveDir under the agent id', async () => {
  const { liveDir, presetDir } = await dirs();
  await writeFile(join(presetDir, 'minerva.png'), PNG);
  const file = await stageAvatar({ agentId: 'minerva-2', liveDir, presetDir, avatarPreset: 'minerva' });
  assert.equal(file, 'minerva-2.png');
  assert.deepEqual(await readFile(join(liveDir, 'minerva-2.png')), PNG);
});

test('stageAvatar: no avatar in body -> undefined; missing preset art and bad ids throw', async () => {
  const { liveDir, presetDir } = await dirs();
  assert.equal(await stageAvatar({ agentId: 'x', liveDir, presetDir }), undefined);
  await assert.rejects(stageAvatar({ agentId: 'x', liveDir, presetDir, avatarPreset: 'ghost' }), /ghost/);
  await assert.rejects(stageAvatar({ agentId: '../evil', liveDir, presetDir, avatarData: PNG.toString('base64') }), /id/i);
  await assert.rejects(stageAvatar({ agentId: 'x', liveDir, presetDir, avatarPreset: '../evil' }), /preset/i);
});

test('readAvatar: liveDir wins, presetDir is the fallback, bad names and misses are null', async () => {
  const { liveDir, presetDir } = await dirs();
  await writeFile(join(presetDir, 'a.png'), Buffer.from('preset'));
  assert.deepEqual(await readAvatar('a.png', liveDir, presetDir), Buffer.from('preset'));
  await writeFile(join(liveDir, 'a.png'), Buffer.from('live'));
  assert.deepEqual(await readAvatar('a.png', liveDir, presetDir), Buffer.from('live'));
  assert.equal(await readAvatar('missing.png', liveDir, presetDir), null);
  assert.equal(await readAvatar('../../etc/passwd', liveDir, presetDir), null);
  assert.equal(await readAvatar('UPPER.png', liveDir, presetDir), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd swarm && node --import tsx --test src/avatars.test.ts`
Expected: FAIL — module `./avatars.js` does not exist.

- [ ] **Step 3: Implement** — create `swarm/src/avatars.ts`:

```ts
// Avatar file store — the swarm owns agent portraits as files, the way it
// owns agent identity as JSON. Live agents' art lives in .smith/avatars/
// (reset archives it with the roster); the shipped preset art is committed
// under assets/avatars/. avatarData/avatarPreset are transport-only fields
// on the create/update routes — this module turns them into files and a
// stored filename, and nothing else ever touches the bytes.
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Same stem rule as agent ids (agents.ts) — also the traversal guard. */
export const AVATAR_FILE_RE = /^[a-z0-9][a-z0-9-]{0,63}\.png$/;

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/** Decode and validate a base64 avatar payload. Throws a user-facing Error. */
export function decodeAvatarData(avatarData: string): Buffer {
  const buf = Buffer.from(avatarData, 'base64');
  if (buf.length > MAX_AVATAR_BYTES) {
    throw new Error('avatar image must be under 2 MB');
  }
  if (buf.length < PNG_MAGIC.length || !buf.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    throw new Error('avatar image must be a PNG');
  }
  return buf;
}

/**
 * Persist the avatar a create/update body carried, if any. Custom art
 * arrives as base64 (`avatarData`); a preset join names committed art
 * (`avatarPreset`) which is copied so every live agent's portrait lives in
 * one directory. Returns the filename to store on the agent record.
 */
export async function stageAvatar(opts: {
  agentId: string;
  liveDir: string;
  presetDir: string;
  avatarData?: string;
  avatarPreset?: string;
}): Promise<string | undefined> {
  const { agentId, liveDir, presetDir, avatarData, avatarPreset } = opts;
  if (!avatarData && !avatarPreset) return undefined;
  const file = `${agentId}.png`;
  if (!AVATAR_FILE_RE.test(file)) {
    throw new Error(`invalid agent id for avatar file: "${agentId}"`);
  }
  await mkdir(liveDir, { recursive: true });
  if (avatarData) {
    await writeFile(join(liveDir, file), decodeAvatarData(avatarData));
    return file;
  }
  const presetFile = `${avatarPreset}.png`;
  if (!AVATAR_FILE_RE.test(presetFile)) {
    throw new Error(`invalid avatar preset: "${avatarPreset}"`);
  }
  try {
    await copyFile(join(presetDir, presetFile), join(liveDir, file));
  } catch {
    throw new Error(`no committed art for preset "${avatarPreset}"`);
  }
  return file;
}

/** Serve lookup: live art first, committed preset art as the fallback. */
export async function readAvatar(file: string, liveDir: string, presetDir: string): Promise<Buffer | null> {
  if (!AVATAR_FILE_RE.test(file)) return null;
  for (const dir of [liveDir, presetDir]) {
    try {
      return await readFile(join(dir, file));
    } catch {
      // try the next directory
    }
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd swarm && node --import tsx --test src/avatars.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add swarm/src/avatars.ts swarm/src/avatars.test.ts
git commit -m "feat(swarm): avatar file store (stage, validate, serve lookup)"
```

---

### Task 3: Swarm routes — avatar field, staging, serving, reset

**Files:**
- Modify: `swarm/src/agents.ts:33` (add field near `avatarRing`)
- Modify: `swarm/src/server.ts` (POST /agents ~line 868-937, PUT /agents/:id ~line 960-1003, new GET /avatars/:file, reset ~line 1166-1186)
- Modify: `swarm/src/server-enrich.test.ts` (one merge test)

**Interfaces:**
- Consumes: `stageAvatar`, `readAvatar` from `./avatars.js` (Task 2); `findPreset` is NOT needed here — `avatarPreset` staging fails naturally when no art file exists.
- Produces: `ComposedAgent.avatar?: string`; HTTP surface used by the broker (Task 5): `POST /agents` + `PUT /agents/:id` accept transport-only `avatarData`/`avatarPreset`; `GET /avatars/:file` → `image/png` or 404 `{error}`.

- [ ] **Step 1: Add the field** — in `swarm/src/agents.ts`, directly under `avatarRing?: string;` (line 33):

```ts
  /** Portrait filename under .smith/avatars/ (assets/avatars/ for presets). */
  avatar?: string;
```

- [ ] **Step 2: Write the failing merge test** — append to `swarm/src/server-enrich.test.ts` (match its existing imports of `buildAgentUpdate` / `ComposedAgent`; add them to the import lists if absent):

```ts
test('buildAgentUpdate: avatar survives an update that does not mention it', () => {
  const existing: ComposedAgent = {
    id: 'nena', name: 'Nena', role: 'QA', directives: 'test', engine: { cli: 'claude', model: 'claude-opus' },
    avatar: 'nena.png',
  };
  assert.equal(buildAgentUpdate(existing, { name: 'Nena Dos' }).avatar, 'nena.png');
});
```

- [ ] **Step 3: Run it**

Run: `cd swarm && node --import tsx --test src/server-enrich.test.ts`
Expected: PASS already (the `...existing` spread in `buildAgentUpdate` carries the new optional field) — this test pins that behavior. If it FAILS, `buildAgentUpdate` is explicitly dropping unknown fields and needs `avatar: existing.avatar` added.

- [ ] **Step 4: Wire POST /agents** — in `swarm/src/server.ts`:
  - Add to imports: `import { readAvatar, stageAvatar } from './avatars.js';`
  - In the POST /agents handler, widen the body type and stage the avatar after the collision check (after line 903) and before the `const agent: ComposedAgent = {` literal:

```ts
      const withAvatar = b as typeof b & { avatarData?: string; avatarPreset?: string };
      let avatar: string | undefined;
      try {
        avatar = await stageAvatar({
          agentId: id,
          liveDir: resolve(process.cwd(), '.smith/avatars'),
          presetDir: resolve(process.cwd(), 'assets/avatars'),
          avatarData: withAvatar.avatarData,
          avatarPreset: withAvatar.avatarPreset,
        });
      } catch (err) {
        return reply.status(400).send({ error: `avatar: ${String((err as Error).message)}` });
      }
```

  - In the agent literal, add `avatar,` on the line after `avatarRing: b.avatarRing,`.

- [ ] **Step 5: Wire PUT /agents/:id** — in the PUT handler, after `const updated = buildAgentUpdate(existing, b);` (line 995) and before `saveAgent`:

```ts
      const withAvatar = b as typeof b & { avatarData?: string };
      if (withAvatar.avatarData) {
        try {
          updated.avatar = await stageAvatar({
            agentId: existing.id,
            liveDir: resolve(process.cwd(), '.smith/avatars'),
            presetDir: resolve(process.cwd(), 'assets/avatars'),
            avatarData: withAvatar.avatarData,
          });
        } catch (err) {
          return reply.status(400).send({ error: `avatar: ${String((err as Error).message)}` });
        }
      }
```

- [ ] **Step 6: Serving route** — register next to the catalog route (directly above `this.app.post('/agents', …)`):

```ts
    // Portrait bytes. Live agents' art first, committed preset art second —
    // one URL shape for roster avatars and chooser cards alike. The filename
    // regex inside readAvatar doubles as the traversal guard.
    this.app.get<{ Params: { file: string } }>('/avatars/:file', async (req, reply) => {
      const buf = await readAvatar(
        req.params.file,
        resolve(process.cwd(), '.smith/avatars'),
        resolve(process.cwd(), 'assets/avatars'),
      );
      if (!buf) return reply.status(404).send({ error: `Unknown avatar: ${req.params.file}` });
      return reply.type('image/png').send(buf);
    });
```

- [ ] **Step 7: Reset archives avatars** — in the reset route's `if (scope.agents)` block (line ~1166), directly after the `.smith/agents` rename+mkdir pair and before the squads block:

```ts
        // Portraits ride with the roster: archived beside it, never deleted.
        await rename(
          resolve(process.cwd(), '.smith/avatars'),
          resolve(process.cwd(), `.smith/avatars-archived-${stamp}`),
        ).catch(() => {});
```

- [ ] **Step 8: Full swarm suite + lint**

Run: `cd swarm && npm test && npx biome check --write src/agents.ts src/server.ts src/server-enrich.test.ts`
Expected: all PASS. Route glue beyond `stageAvatar`/`readAvatar` (which are unit-tested) is verified by inspection per this package's convention — no server-boot harness exists.

- [ ] **Step 9: Commit**

```bash
git add swarm/src/agents.ts swarm/src/server.ts swarm/src/server-enrich.test.ts
git commit -m "feat(swarm): avatar staging on create/update, GET /avatars, reset archival"
```

---

### Task 4: Broker config + Gemini avatar generator

**Files:**
- Modify: `broker/src/config.ts`, `broker/src/config.test.ts`
- Create: `broker/src/avatar-generator.ts`, `broker/src/avatar-generator.test.ts`
- Modify: `broker/package.json` (deps)

**Interfaces:**
- Consumes: `@google/genai` (new dep, wired in Task 5's `main.ts`; this module only sees the minimal interface), `sharp` (new dep).
- Produces (used by Task 5):
  - `BrokerConfig.geminiApiKey?: string`, `BrokerConfig.geminiImageModel: string`
  - `AvatarRequest { name?: string; gender?: string; role?: string; backstory?: string; stereotype?: string }`
  - `ImagesClient` — minimal `models.generateContent` shape (same trick as `MessagesClient` in `persona-generator.ts:42`)
  - `class AvatarGenerator { constructor(client: ImagesClient, model: string); generate(req: AvatarRequest): Promise<string> }` — resolves to base64 of a 512×512 PNG; throws user-facing `Error` on refusal/empty response
  - `buildAvatarPrompt(req: AvatarRequest): string` (exported for tests)

- [ ] **Step 1: Install deps**

Run: `cd broker && npm install @google/genai sharp`
Expected: both added to `dependencies`.

- [ ] **Step 2: Failing config tests** — in `broker/src/config.test.ts`, the existing test builds a full env fixture (`ANTHROPIC_API_KEY: 'sk-ant'`, …). Add two tests reusing that fixture object (call it as the file already names it):

```ts
test('gemini config: absent key -> undefined + default image model', () => {
  const c = loadBrokerConfig(ENV);
  assert.equal(c.geminiApiKey, undefined);
  assert.equal(c.geminiImageModel, 'gemini-2.5-flash-image');
});

test('gemini config: key and model override are read', () => {
  const c = loadBrokerConfig({ ...ENV, GEMINI_API_KEY: 'g-key', GEMINI_IMAGE_MODEL: 'imagen-4' });
  assert.equal(c.geminiApiKey, 'g-key');
  assert.equal(c.geminiImageModel, 'imagen-4');
});
```

(If the fixture const has a different name than `ENV`, use that name.)

- [ ] **Step 3: Run to verify failure**

Run: `cd broker && node --import tsx --test src/config.test.ts`
Expected: FAIL — properties missing.

- [ ] **Step 4: Implement config** — in `broker/src/config.ts` add to the interface:

```ts
  /** Optional: enables the avatar generator. Absent = feature degrades, presets still work. */
  geminiApiKey?: string;
  geminiImageModel: string;
```

and to the returned object:

```ts
    geminiApiKey: env.GEMINI_API_KEY || undefined,
    geminiImageModel: env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image',
```

- [ ] **Step 5: Run config tests** — same command. Expected: PASS.

- [ ] **Step 6: Failing generator tests** — create `broker/src/avatar-generator.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { AvatarGenerator, buildAvatarPrompt, type ImagesClient } from './avatar-generator.ts';

const tinyPng = () =>
  sharp({ create: { width: 4, height: 4, channels: 3, background: '#aa5533' } }).png().toBuffer();

const clientReturning = (parts: Array<{ inlineData?: { data?: string; mimeType?: string } }>): ImagesClient => ({
  models: { generateContent: async () => ({ candidates: [{ content: { parts } }] }) },
});

test('buildAvatarPrompt: house style always present, persona clauses appended', () => {
  const p = buildAvatarPrompt({ name: 'Minerva', gender: 'female', role: 'Security Engineer', backstory: 'Found her first injection hole at nineteen.' });
  assert.match(p, /Flat vector bust portrait/);
  assert.match(p, /no text/);
  assert.match(p, /A woman called Minerva, a Security Engineer\./);
  assert.match(p, /injection hole/);
  assert.match(buildAvatarPrompt({}), /A person\./);
});

test('generate: normalizes whatever Gemini returns to a 512x512 png (base64)', async () => {
  const src = (await tinyPng()).toString('base64');
  const gen = new AvatarGenerator(clientReturning([{ inlineData: { data: src, mimeType: 'image/png' } }]), 'gemini-2.5-flash-image');
  const out = Buffer.from(await gen.generate({ name: 'Nena' }), 'base64');
  const meta = await sharp(out).metadata();
  assert.equal(meta.width, 512);
  assert.equal(meta.height, 512);
  assert.equal(meta.format, 'png');
});

test('generate: empty candidates -> a user-facing error', async () => {
  const gen = new AvatarGenerator(clientReturning([{}]), 'gemini-2.5-flash-image');
  await assert.rejects(gen.generate({}), /no image/i);
});
```

- [ ] **Step 7: Run to verify failure**

Run: `cd broker && node --import tsx --test src/avatar-generator.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 8: Implement** — create `broker/src/avatar-generator.ts`:

```ts
/**
 * AvatarGenerator — one Gemini image call that gives a teammate a face.
 *
 * The house style lives here, not in the UI: every portrait — preset art
 * authored at build time and custom art generated in the wizard — goes
 * through this prompt, so the whole cast reads as one set. Output is
 * normalized to a 512×512 PNG so the swarm's 2 MB avatarData cap and the
 * roster's 40px rendering never meet a surprise.
 */
import sharp from 'sharp';

export interface AvatarRequest {
  name?: string;
  gender?: string;
  role?: string;
  backstory?: string;
  stereotype?: string;
}

/** Minimal shape of the @google/genai client this needs — keeps testing trivial. */
export interface ImagesClient {
  models: {
    generateContent(params: { model: string; contents: string; config?: Record<string, unknown> }): Promise<{
      candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> } }>;
    }>;
  };
}

const HOUSE_STYLE =
  'Flat vector bust portrait of a software professional, bold geometric shapes, limited warm palette, ' +
  'solid single-color background, centered, square crop, no text, no logos, no watermark.';

export function buildAvatarPrompt(req: AvatarRequest): string {
  const subject = req.gender === 'male' ? 'A man' : req.gender === 'female' ? 'A woman' : 'A person';
  const clauses = [
    HOUSE_STYLE,
    `${subject}${req.name ? ` called ${req.name}` : ''}${req.role ? `, a ${req.role}` : ''}.`,
  ];
  if (req.backstory) clauses.push(`Character notes: ${req.backstory.slice(0, 400)}`);
  return clauses.join(' ');
}

export class AvatarGenerator {
  constructor(
    private readonly client: ImagesClient,
    private readonly model: string,
  ) {}

  /** Base64 of a 512×512 PNG. Throws with a message the wizard can show verbatim. */
  async generate(req: AvatarRequest): Promise<string> {
    const res = await this.client.models.generateContent({
      model: this.model,
      contents: buildAvatarPrompt(req),
      config: { responseModalities: ['IMAGE'] },
    });
    const data = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData?.data;
    if (!data) throw new Error('Gemini returned no image — try again');
    const png = await sharp(Buffer.from(data, 'base64')).resize(512, 512, { fit: 'cover' }).png().toBuffer();
    return png.toString('base64');
  }
}
```

- [ ] **Step 9: Run tests**

Run: `cd broker && node --import tsx --test src/avatar-generator.test.ts src/config.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add broker/package.json broker/package-lock.json broker/src/config.ts broker/src/config.test.ts broker/src/avatar-generator.ts broker/src/avatar-generator.test.ts
git commit -m "feat(broker): Gemini avatar generator behind optional GEMINI_API_KEY"
```

---

### Task 5: Broker routes + wiring (`/avatars/generate`, `/avatars/:file`, catalog flag, roster field)

**Files:**
- Modify: `broker/src/swarm-client.ts` (`RegistryAgent` interface + new method)
- Modify: `broker/src/text-channel.ts` (creation interface ~line 119-129; routes inside the `if (this.creation)` block, next to `/agent-catalog` at line 285)
- Modify: `broker/src/text-channel.test.ts` (extend `stubCreation`, add route tests)
- Modify: `broker/src/main.ts` (creation wiring at line ~637-645; roster mapping at line ~356)

**Interfaces:**
- Consumes: `AvatarGenerator`, `AvatarRequest` from `./avatar-generator.ts` (Task 4); swarm HTTP surface from Task 3.
- Produces (used by the UI, Tasks 6-8):
  - `GET /agent-catalog` response now carries `presets` (proxied untouched from the swarm) and a broker-injected `avatarGen: boolean`
  - `POST /avatars/generate` `{name?, gender?, role?, backstory?, stereotype?}` → `{imageData}` (base64 PNG) or 4xx `{error}`
  - `GET /avatars/:file` → `image/png` bytes or 404 `{error}`
  - Roster frames' agent entries gain `avatar?: string`

- [ ] **Step 1: swarm-client** — in `broker/src/swarm-client.ts`, add to `RegistryAgent` (after `avatarRing?: string;`):

```ts
  /** Portrait filename; fetch bytes via GET /avatars/<file>. */
  avatar?: string;
```

and add a method next to `agentCatalog()` (line 247), following the class's existing fetch/auth pattern exactly (same base URL + token header the private `http` helper uses — read `http`'s implementation and mirror its header construction; only the body handling differs because this returns bytes, not JSON):

```ts
  /** Raw PNG bytes for an avatar file, or null when the swarm has none. */
  async avatarFile(file: string): Promise<Buffer | null> {
    const res = await fetch(`${this.baseUrl}/avatars/${encodeURIComponent(file)}`, {
      headers: this.authHeaders(),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`swarm GET /avatars/${file}: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
```

(If the class exposes no `authHeaders()`/`baseUrl` members under those names, use whatever the private `http` method actually uses — the point is byte-for-byte the same auth, different decode.)

- [ ] **Step 2: text-channel interface** — in `broker/src/text-channel.ts`, extend the `creation` constructor param (line 119-129) with:

```ts
      /** Gemini portrait for the wizard preview; {error} when no key or refusal. */
      generateAvatar(body: Record<string, unknown>): Promise<Record<string, unknown>>;
      /** Portrait bytes proxied from the swarm; null = 404. */
      avatarFile(file: string): Promise<Buffer | null>;
```

- [ ] **Step 3: Failing route tests** — in `broker/src/text-channel.test.ts`, first extend `stubCreation` with the two new members:

```ts
  generateAvatar: async () => ({}),
  avatarFile: async () => null,
```

then add:

```ts
test('GET /avatars/:file streams png bytes; misses and traversal shapes 404', async () => {
  const channel = channelWith({
    creation: { ...stubCreation, avatarFile: async (f) => (f === 'minerva.png' ? Buffer.from('PNGBYTES') : null) },
  });
  const port = await channel.start(0);
  try {
    const hit = await fetch(`http://127.0.0.1:${port}/avatars/minerva.png`);
    assert.equal(hit.status, 200);
    assert.equal(hit.headers.get('content-type'), 'image/png');
    assert.equal(Buffer.from(await hit.arrayBuffer()).toString(), 'PNGBYTES');
    assert.equal((await fetch(`http://127.0.0.1:${port}/avatars/ghost.png`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/avatars/..%2Fsecrets.png`)).status, 404);
  } finally {
    await channel.stop();
  }
});

test('POST /avatars/generate maps handler result: imageData -> 200, error -> 400', async () => {
  const channel = channelWith({
    creation: {
      ...stubCreation,
      generateAvatar: async (body) => (body.name === 'Nena' ? { imageData: 'QUJD' } : { error: 'no Gemini key configured' }),
    },
  });
  const port = await channel.start(0);
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/avatars/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Nena' }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { imageData: 'QUJD' });
    const err = await fetch(`http://127.0.0.1:${port}/avatars/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(err.status, 400);
  } finally {
    await channel.stop();
  }
});
```

(Match the file's actual start/stop idiom — if other tests call something other than `channel.stop()`, e.g. `channel.close()`, use that.)

- [ ] **Step 4: Run to verify failure**

Run: `cd broker && node --import tsx --test src/text-channel.test.ts`
Expected: new tests FAIL (routes 404/handler missing); pre-existing tests may fail to COMPILE until `stubCreation` has the new members — that compile error is Step 3's edit, the route 404s are Step 5's job.

- [ ] **Step 5: Implement routes** — in the `if (this.creation)` block of `text-channel.ts`, directly under the `/agent-catalog` route (line 285-288), add:

```ts
        // Portraits: one URL shape for roster avatars, chooser cards, and
        // edit-mode previews. `no-cache` because a reroll or preset join can
        // replace bytes behind an unchanged filename.
        const avatarFileMatch = /^\/avatars\/([a-z0-9][a-z0-9-]{0,63}\.png)$/.exec(url.pathname);
        if (req.method === 'GET' && avatarFileMatch) {
          void this.creation.avatarFile(avatarFileMatch[1]!).then(
            (buf) =>
              buf
                ? res.writeHead(200, { ...CORS, 'content-type': 'image/png', 'cache-control': 'no-cache' }).end(buf)
                : json(404, { error: 'avatar not found' }),
            fail,
          );
          return;
        }
        if (req.method === 'POST' && url.pathname === '/avatars/generate') {
          let body = '';
          req.on('data', (c) => {
            body += c;
          });
          req.on('end', () => {
            let parsed: Record<string, unknown> = {};
            try {
              parsed = JSON.parse(body || '{}') as Record<string, unknown>;
            } catch {
              return json(400, { error: 'body must be JSON' });
            }
            void this.creation!.generateAvatar(parsed).then(
              (r) => json((r as { error?: string }).error ? 400 : 200, r),
              fail,
            );
          });
          return;
        }
```

- [ ] **Step 6: Run route tests** — same command as Step 4. Expected: PASS (all, including pre-existing).

- [ ] **Step 7: main.ts wiring** — in `broker/src/main.ts`:
  - Imports: `import { GoogleGenAI } from '@google/genai';` and `import { AvatarGenerator, type AvatarRequest } from './avatar-generator.ts';`
  - Near the `const anthropic = new Anthropic(...)` construction (line 47):

```ts
const avatarGenerator = config.geminiApiKey
  ? new AvatarGenerator(new GoogleGenAI({ apiKey: config.geminiApiKey }), config.geminiImageModel)
  : null;
```

  - In the creation wiring (line ~637): replace `catalog: () => swarm.agentCatalog(),` with

```ts
    // avatarGen rides on the catalog the wizard already fetches — the UI
    // learns in one request whether to render the Generate button at all.
    catalog: async () => ({ ...(await swarm.agentCatalog()), avatarGen: avatarGenerator !== null }),
```

  and add alongside the other creation members:

```ts
    generateAvatar: async (body) => {
      if (!avatarGenerator) return { error: 'no Gemini key configured' };
      try {
        return { imageData: await avatarGenerator.generate(body as AvatarRequest) };
      } catch (err) {
        return { error: String((err as Error).message) };
      }
    },
    avatarFile: (file) => swarm.avatarFile(file),
```

  - In `toRosterEntries` (line ~356), under `ring: p.agent.avatarRing,` add `avatar: p.agent.avatar,` — and add `avatar?: string;` to the `RosterEntry` interface in `text-channel.ts` (line 11) so the frame type carries it.

- [ ] **Step 8: Full broker suite + lint**

Run: `cd broker && npm test && npx biome check --write src/`
Expected: all PASS. (`GoogleGenAI` is constructed but never called in tests — no network.)

- [ ] **Step 9: Commit**

```bash
git add broker/src/swarm-client.ts broker/src/text-channel.ts broker/src/text-channel.test.ts broker/src/main.ts
git commit -m "feat(broker): avatar generate + file routes, avatarGen catalog flag, roster avatar"
```

---

### Task 6: Control-plane avatar rendering (roster portraits)

**Files:**
- Modify: `control-plane/src/hooks/useBrokerChat.ts:28-41` (`RosterAgent`)
- Modify: `control-plane/src/atoms/Avatar.tsx`
- Create: `control-plane/src/atoms/Avatar.test.tsx`
- Modify: `control-plane/src/molecules/AgentAvatar.tsx`
- Modify: `control-plane/src/pages/HomePage.tsx` (the `<AgentAvatar` render site that passes `ring={a.ring ?? ringForIndex(i)}`, ~line 98)
- Modify: `control-plane/src/styles/components.css` (after the `.avatar` block, ~line 80-205)

**Interfaces:**
- Consumes: roster frames now carrying `avatar?: string` (Task 5).
- Produces: `Avatar` accepts `image?: string` (full URL, falls back to `initial` on load error); `AgentAvatar` accepts `avatar?: string` (filename) and builds the URL.

- [ ] **Step 1: Failing tests** — create `control-plane/src/atoms/Avatar.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Avatar } from "./Avatar";

describe("Avatar", () => {
  afterEach(cleanup);

  it("renders the initial when no image is given", () => {
    render(<Avatar initial="M" label="Minerva" />);
    expect(screen.getByRole("button", { name: "Minerva" }).textContent).toBe("M");
  });

  it("renders the portrait image when given", () => {
    render(<Avatar initial="M" label="Minerva" image="http://127.0.0.1:7790/avatars/minerva.png" />);
    const img = screen.getByRole("button", { name: "Minerva" }).querySelector("img");
    expect(img?.getAttribute("src")).toContain("minerva.png");
  });

  it("falls back to the initial when the image fails to load", () => {
    render(<Avatar initial="M" label="Minerva" image="http://127.0.0.1:7790/avatars/minerva.png" />);
    const img = screen.getByRole("button", { name: "Minerva" }).querySelector("img");
    expect(img).not.toBeNull();
    fireEvent.error(img as HTMLImageElement);
    expect(screen.getByRole("button", { name: "Minerva" }).querySelector("img")).toBeNull();
    expect(screen.getByRole("button", { name: "Minerva" }).textContent).toBe("M");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd control-plane && npx vitest run src/atoms/Avatar.test.tsx`
Expected: image tests FAIL (`image` prop unknown, no `<img>` rendered).

- [ ] **Step 3: Implement `Avatar.tsx`** — replace the component with:

```tsx
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";

interface AvatarProps {
  initial: string;
  label: string;
  ring?: string;
  /** Full portrait URL; the initial is the automatic fallback when absent or broken. */
  image?: string;
  style?: CSSProperties;
  onClick?: () => void;
  children?: ReactNode;
  /**
   * Activity the ring animates: "listening" pulses while they are addressed,
   * "working" spins a dotted ring while they are on a task. Rendered as a data
   * attribute so the animation is pure CSS with no per-frame React work.
   */
  state?: "listening" | "working";
}

/** Circular identity button; ring color arrives via the --ring custom property. */
export function Avatar({ initial, label, ring, image, style, onClick, children, state }: AvatarProps) {
  const [broken, setBroken] = useState(false);
  // A reroll or edit swaps the URL under us — give the new image a fresh chance.
  useEffect(() => setBroken(false), [image]);
  const ringStyle = { ...(ring ? { "--ring": ring } : {}), ...style } as CSSProperties;
  return (
    <button
      type="button"
      className="avatar"
      data-state={state}
      style={ringStyle}
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      {image && !broken ? (
        <img className="avatar__img" src={image} alt="" onError={() => setBroken(true)} />
      ) : (
        initial
      )}
      {children}
    </button>
  );
}
```

- [ ] **Step 4: CSS** — in `components.css`, directly after the `.avatar { … }` rule block, add (the `.avatar` rule already positions children absolutely — badges/status rely on it; if `.avatar` lacks `position: relative`, add it there):

```css
.avatar__img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border-radius: inherit;
  object-fit: cover;
}
```

- [ ] **Step 5: Run tests** — same command. Expected: PASS (3 tests).

- [ ] **Step 6: Plumb through** —
  - `useBrokerChat.ts`: in `RosterAgent`, under `ring?: string;` add `avatar?: string;`.
  - `AgentAvatar.tsx`: add to `AgentAvatarProps`: `/** Portrait filename from the roster frame. */ avatar?: string;`; add `avatar` to the destructured props; add `const BASE = "127.0.0.1:7790";` at the top of the file (precedent: `AddAgentModal.tsx:5`); pass to `<Avatar … image={avatar ? `http://${BASE}/avatars/${avatar}` : undefined}`.
  - `HomePage.tsx`: at the `<AgentAvatar` render site that passes `ring=`, add `avatar={a.avatar}` (the roster entry variable at that site — match its actual name).

- [ ] **Step 7: Full control-plane suite + lint**

Run: `cd control-plane && npm test && npx biome check --write src/`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add control-plane/src/hooks/useBrokerChat.ts control-plane/src/atoms/Avatar.tsx control-plane/src/atoms/Avatar.test.tsx control-plane/src/molecules/AgentAvatar.tsx control-plane/src/pages/HomePage.tsx control-plane/src/styles/components.css
git commit -m "feat(control-plane): roster portraits with initials fallback"
```

---

### Task 7: Chooser step — 12 cards in `AddAgentModal`

**Files:**
- Create: `control-plane/src/organisms/AddAgentChooser.tsx`
- Modify: `control-plane/src/organisms/AddAgentModal.tsx`
- Create: `control-plane/src/organisms/AddAgentModal.test.tsx`
- Modify: `control-plane/src/styles/components.css` (next to `.stereotype-grid`, line ~1455)

**Interfaces:**
- Consumes: catalog `presets` + `avatarGen` (Task 5), `GET /agents` for taken ids (existing broker route), `POST /agents` with `id`/`avatarPreset`/`avatarRing` (Task 3), `POST /voices/preview` (existing).
- Produces: `PresetCard` type (exported from `AddAgentChooser.tsx`, reused by Task 8's submit path); `AddAgentChooser` component with props `{ presets, takenIds, selectedId, onSelect, onCustom, onPreview, stereotypeLabels, base }`.

- [ ] **Step 1: Failing tests** — create `control-plane/src/organisms/AddAgentModal.test.tsx`. This file is also Task 8's home; start it with the fetch-router harness both tasks share:

```tsx
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddAgentModal } from "./AddAgentModal";

const PRESETS = [
  {
    id: "minerva", name: "Minerva", gender: "female", role: "Security Engineer",
    jobRole: "security", stereotype: "auditor", language: "en-do",
    hook: "Reads your diff like a border agent reads a passport.",
    backstory: "Treats every input as hostile because one always is.",
    persona: { style: "Clipped, precise." },
    voiceId: "v-minerva", ring: "#5fd0b0", avatar: "minerva.png",
    engine: { cli: "claude", model: "claude-opus" },
  },
  {
    id: "yesenia", name: "Yesenia", gender: "female", role: "Frontend Engineer",
    jobRole: "frontend", stereotype: "builder", language: "en-do",
    hook: "Ships pixels before the meeting ends.",
    backstory: "Believes a UI is finished when abuela can use it without asking.",
    persona: { style: "Fast, upbeat, concrete." },
    voiceId: "", ring: "#6f8dff", avatar: "yesenia.png",
    engine: { cli: "claude", model: "claude-opus" },
  },
];

const CATALOG = {
  stereotypes: [
    { id: "auditor", label: "The Auditor", style: "clipped", directives: "audit", reactions: { agree: ["ok"] } },
    { id: "builder", label: "The Builder", style: "fast", directives: "build", reactions: { agree: ["dale"] } },
  ],
  jobRoles: [
    { id: "security", label: "Security Engineer", directives: "guard" },
    { id: "frontend", label: "Frontend Engineer", directives: "pixels" },
  ],
  engines: [{ cli: "claude", label: "Claude Code", models: ["claude-opus"], warmSessions: true }],
  languages: [{ id: "en-do", label: "English (Dominican)", speech: "spanglish" }],
  quickQuestions: [{ id: "name", question: "What should I call you?" }],
  reactionLevels: ["agree"],
  presets: PRESETS,
  avatarGen: true,
};

/** Routes every fetch by URL; tests override per-route. Captures POST /agents bodies. */
function stubFetch(overrides: Record<string, unknown> = {}) {
  const posted: Array<Record<string, unknown>> = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const respond = (body: unknown) => ({ ok: true, json: async () => body, blob: async () => new Blob() }) as Response;
    if (url.endsWith("/agent-catalog")) return respond(overrides.catalog ?? CATALOG);
    if (url.endsWith("/agents") && init?.method === "POST") {
      posted.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return respond(overrides.created ?? { id: "x", name: "x" });
    }
    if (url.endsWith("/agents")) return respond(overrides.agents ?? { agents: [] });
    if (url.endsWith("/avatars/generate")) return respond(overrides.generated ?? { imageData: "QUJD" });
    if (url.includes("/voices")) return respond({ voices: [] });
    return respond({});
  });
  vi.stubGlobal("fetch", fn);
  return { fn, posted };
}

describe("AddAgentModal chooser", () => {
  beforeEach(() => stubFetch());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("create mode opens on the chooser with every preset card plus Create custom", async () => {
    stubFetch();
    render(<AddAgentModal open onClose={vi.fn()} />);
    expect(await screen.findByText("Minerva")).toBeTruthy();
    expect(screen.getByText("Yesenia")).toBeTruthy();
    expect(screen.getByText("The Auditor")).toBeTruthy();
    expect(screen.getByText(/create custom/i)).toBeTruthy();
    expect(screen.queryByLabelText(/name/i)).toBeNull(); // wizard not shown yet
  });

  it("one-click join posts the full preset body with explicit id, avatarPreset and ring", async () => {
    const { posted } = stubFetch();
    const onCreated = vi.fn();
    render(<AddAgentModal open onClose={vi.fn()} onCreated={onCreated} />);
    await userEvent.click(await screen.findByText("Minerva"));
    await userEvent.click(screen.getByRole("button", { name: /join team/i }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("Minerva"));
    expect(posted[0]).toMatchObject({
      id: "minerva",
      name: "Minerva",
      stereotype: "auditor",
      jobRole: "security",
      avatarPreset: "minerva",
      avatarRing: "#5fd0b0",
      voice: { voiceId: "v-minerva" },
    });
  });

  it("a preset already on the roster is marked and cannot join again", async () => {
    stubFetch({ agents: { agents: [{ id: "minerva", name: "Minerva" }] } });
    render(<AddAgentModal open onClose={vi.fn()} />);
    expect(await screen.findByText(/on the team/i)).toBeTruthy();
    await userEvent.click(screen.getByText("Yesenia"));
    expect(screen.getByRole("button", { name: /join team/i })).toBeTruthy();
  });

  it("Customize prefills the wizard from the preset", async () => {
    stubFetch();
    render(<AddAgentModal open onClose={vi.fn()} />);
    await userEvent.click(await screen.findByText("Minerva"));
    await userEvent.click(screen.getByRole("button", { name: /customize/i }));
    await userEvent.click(screen.getByRole("button", { name: /next/i })); // Setup -> Persona
    expect((screen.getByLabelText(/^name$/i) as HTMLInputElement).value).toBe("Minerva");
    expect((screen.getByLabelText(/backstory/i) as HTMLTextAreaElement).value).toContain("hostile");
  });

  it("Create custom enters the blank wizard", async () => {
    stubFetch();
    render(<AddAgentModal open onClose={vi.fn()} />);
    await userEvent.click(await screen.findByText(/create custom/i));
    expect(await screen.findByText(/job role/i)).toBeTruthy();
  });

  it("edit mode skips the chooser entirely", async () => {
    stubFetch({ agents: { agents: [{ id: "minerva", name: "Minerva", role: "Security", engine: { cli: "claude", model: "claude-opus" } }] } });
    render(<AddAgentModal open onClose={vi.fn()} editingId="minerva" />);
    expect(await screen.findByText(/job role/i)).toBeTruthy();
    expect(screen.queryByText(/join team/i)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd control-plane && npx vitest run src/organisms/AddAgentModal.test.tsx`
Expected: FAIL — no chooser exists.

- [ ] **Step 3: Implement `AddAgentChooser.tsx`**:

```tsx
import { Play } from "lucide-react";
import type { CSSProperties } from "react";

/** A premade card from the catalog — a complete character, joinable in one click. */
export interface PresetCard {
  id: string;
  name: string;
  gender: string;
  role: string;
  jobRole: string;
  stereotype: string;
  language: string;
  hook: string;
  backstory: string;
  persona: { style: string };
  reactions?: Record<string, string[]>;
  quickAnswers?: Record<string, string>;
  voiceId: string;
  ring: string;
  avatar: string;
  engine: { cli: string; model: string };
}

interface AddAgentChooserProps {
  presets: PresetCard[];
  /** Agent ids already on the roster — those cards badge "On the team" and can't re-join. */
  takenIds: Set<string>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** The 12th card: straight into the blank wizard. */
  onCustom: () => void;
  onPreview: (voiceId: string) => void;
  stereotypeLabels: Record<string, string>;
  /** Broker host:port for portrait URLs. */
  base: string;
}

/** The 12-card grid: 11 premade characters + Create custom. */
export function AddAgentChooser({
  presets,
  takenIds,
  selectedId,
  onSelect,
  onCustom,
  onPreview,
  stereotypeLabels,
  base,
}: AddAgentChooserProps) {
  return (
    <div className="preset-grid">
      {presets.map((p) => {
        const taken = takenIds.has(p.id);
        return (
          <div
            key={p.id}
            className={`preset-card${selectedId === p.id ? " is-picked" : ""}${taken ? " is-taken" : ""}`}
          >
            <button
              type="button"
              className="preset-card__pick"
              onClick={() => onSelect(selectedId === p.id ? null : p.id)}
              disabled={taken}
            >
              <img
                className="preset-card__portrait"
                src={`http://${base}/avatars/${p.avatar}`}
                alt=""
                style={{ "--ring": p.ring } as CSSProperties}
                onError={(e) => {
                  (e.target as HTMLImageElement).style.visibility = "hidden";
                }}
              />
              <b>{p.name}</b>
              <span className="preset-card__role">{p.role}</span>
              <span className="preset-card__stereo">{stereotypeLabels[p.stereotype] ?? p.stereotype}</span>
              <span className="preset-card__hook">{p.hook}</span>
              {taken && <span className="preset-card__taken">On the team</span>}
            </button>
            {p.voiceId && !taken && (
              <button
                type="button"
                className="voice-row__play preset-card__play"
                onClick={() => onPreview(p.voiceId)}
                aria-label={`Preview ${p.name}'s voice`}
              >
                <Play size={12} strokeWidth={2} />
              </button>
            )}
          </div>
        );
      })}
      <button type="button" className="preset-card preset-card--custom" onClick={onCustom}>
        <b>Create custom</b>
        <span className="preset-card__hook">
          Build your own teammate — persona, voice, and an AI-painted portrait.
        </span>
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Wire the modal** — in `AddAgentModal.tsx`:
  - Import: `import { AddAgentChooser, type PresetCard } from "./AddAgentChooser";`
  - Extend the `Catalog` interface with `presets?: PresetCard[]; avatarGen?: boolean;` and `StoredAgent` with `archived?: boolean; avatar?: string;`.
  - New state:

```tsx
  const [mode, setMode] = useState<"choose" | "wizard">("choose");
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [takenIds, setTakenIds] = useState<Set<string>>(new Set());
  /** Preset whose committed art the new agent should copy (customize keeps it until a reroll replaces it). */
  const [avatarPresetRef, setAvatarPresetRef] = useState<string | null>(null);
  const [presetRing, setPresetRing] = useState<string | null>(null);
```

  - Reset mode when the modal opens (before the catalog effect):

```tsx
  useEffect(() => {
    if (!open) return;
    setMode(editingId ? "wizard" : "choose");
    setSelectedPresetId(null);
    setAvatarPresetRef(null);
    setPresetRing(null);
  }, [open, editingId]);
```

  - Load taken ids while the chooser is up (non-archived only):

```tsx
  useEffect(() => {
    if (!open || editingId) return;
    void fetch(`http://${BASE}/agents`)
      .then((r) => r.json())
      .then((res: { agents?: StoredAgent[] }) =>
        setTakenIds(new Set((res.agents ?? []).filter((a) => !a.archived).map((a) => a.id))),
      )
      .catch(() => setTakenIds(new Set()));
  }, [open, editingId]);
```

  - Join and customize handlers (place next to `submit`):

```tsx
  const joinPreset = async (p: PresetCard) => {
    setBusy(true);
    setError(null);
    const res = (await fetch(`http://${BASE}/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        // Explicit id: the server slugs names and would mangle diacritics
        // ("Radhamés" -> "radham-s"); the preset id is the canonical slug.
        id: p.id,
        name: p.name,
        role: p.role,
        gender: p.gender,
        backstory: p.backstory,
        stereotype: p.stereotype,
        jobRole: p.jobRole,
        language: p.language,
        persona: p.persona,
        engine: p.engine,
        voice: p.voiceId ? { voiceId: p.voiceId } : undefined,
        reactions: p.reactions,
        quickAnswers: p.quickAnswers,
        avatarRing: p.ring,
        avatarPreset: p.id,
      }),
    })
      .then((r) => r.json())
      .catch((err: unknown) => ({ error: String(err) }))) as { error?: string };
    setBusy(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    onCreated?.(p.name);
    onClose();
  };

  /** Refine-via-custom: the preset seeds every wizard field, then it's the normal flow. */
  const customizePreset = (p: PresetCard) => {
    setName(p.name);
    setRole(p.role);
    setGender((p.gender as "male" | "female" | "neutral") ?? "neutral");
    setBackstory(p.backstory);
    setLanguage(p.language);
    setVoiceId(p.voiceId);
    setStereotype(catalog?.stereotypes.find((s) => s.id === p.stereotype) ?? null);
    setJobRole(catalog?.jobRoles.find((r) => r.id === p.jobRole) ?? null);
    const eng = catalog?.engines.find((e) => e.cli === p.engine.cli) ?? null;
    setEngine(eng);
    setModel(p.engine.model);
    setGeneratedStyle(p.persona.style);
    if (p.reactions) setReactions(Object.fromEntries(Object.entries(p.reactions).map(([k, v]) => [k, v?.[0] ?? ""])));
    if (p.quickAnswers) setAnswers(p.quickAnswers);
    setAvatarPresetRef(p.id);
    setPresetRing(p.ring);
    setMode("wizard");
    setStep(0);
  };
```

  - Render: inside `<section className="wizard">`, when `mode === "choose"` show a chooser body + its own footer instead of the step header/body/footer:

```tsx
        {mode === "choose" ? (
          <>
            <header className="wizard__head">
              <span className="wizard__step is-active">Choose your agent</span>
            </header>
            <div className="wizard__body">
              <AddAgentChooser
                presets={catalog?.presets ?? []}
                takenIds={takenIds}
                selectedId={selectedPresetId}
                onSelect={setSelectedPresetId}
                onCustom={() => {
                  setSelectedPresetId(null);
                  setMode("wizard");
                  setStep(0);
                }}
                onPreview={(id) => void preview(id)}
                stereotypeLabels={Object.fromEntries((catalog?.stereotypes ?? []).map((s) => [s.id, s.label]))}
                base={BASE}
              />
              {!catalog && <p className="wizard__hint">Loading the catalog…</p>}
            </div>
            {error && <p className="wizard__error">{error}</p>}
            <footer className="wizard__foot">
              <button
                type="button"
                className="settings-btn"
                disabled={!selectedPresetId}
                onClick={() => {
                  const p = catalog?.presets?.find((x) => x.id === selectedPresetId);
                  if (p) customizePreset(p);
                }}
              >
                customize
              </button>
              <button
                type="button"
                className="settings-btn settings-btn--primary"
                disabled={!selectedPresetId || busy}
                onClick={() => {
                  const p = catalog?.presets?.find((x) => x.id === selectedPresetId);
                  if (p) void joinPreset(p);
                }}
              >
                {busy ? "joining…" : "join team"}
              </button>
            </footer>
          </>
        ) : (
          <>
            {/* existing header / body / error / footer JSX moves inside this branch unchanged */}
          </>
        )}
```

    (Wrap the existing header+body+error+footer in the `:` branch — no changes to their internals in this task.)

- [ ] **Step 5: CSS** — in `components.css`, after the `.stereotype-card span` rule (~line 1482):

```css
.preset-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}
.preset-card {
  position: relative;
  border-radius: 12px;
  border: 1px solid var(--pill-br);
  background: rgba(255, 255, 255, 0.03);
  color: var(--text);
}
.preset-card__pick {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  width: 100%;
  padding: 10px 12px;
  text-align: left;
  background: none;
  border: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
  border-radius: inherit;
}
.preset-card.is-picked {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}
.preset-card.is-taken {
  opacity: 0.55;
}
.preset-card.is-taken .preset-card__pick {
  cursor: default;
}
.preset-card__portrait {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  object-fit: cover;
  border: 2px solid var(--ring, var(--pill-br));
  margin-bottom: 4px;
}
.preset-card b {
  font-size: 13px;
}
.preset-card__role {
  font-size: 11px;
  color: var(--text-2);
}
.preset-card__stereo {
  font-size: 10px;
  color: var(--accent);
}
.preset-card__hook {
  font-size: 11px;
  line-height: 1.35;
  color: var(--text-dim);
}
.preset-card__taken {
  position: absolute;
  top: 8px;
  right: 8px;
  font-size: 9.5px;
  padding: 2px 7px;
  border-radius: 999px;
  border: 1px solid var(--pill-br);
  color: var(--text-dim);
}
.preset-card__play {
  position: absolute;
  bottom: 8px;
  right: 8px;
}
.preset-card--custom {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 4px;
  padding: 10px 12px;
  text-align: left;
  border-style: dashed;
  cursor: pointer;
  font: inherit;
}
```

- [ ] **Step 6: Run the chooser tests**

Run: `cd control-plane && npx vitest run src/organisms/AddAgentModal.test.tsx`
Expected: PASS (6 tests).

- [ ] **Step 7: Full suite + lint**

Run: `cd control-plane && npm test && npx biome check --write src/`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add control-plane/src/organisms/AddAgentChooser.tsx control-plane/src/organisms/AddAgentModal.tsx control-plane/src/organisms/AddAgentModal.test.tsx control-plane/src/styles/components.css
git commit -m "feat(control-plane): 12-card add-agent chooser with one-click join and customize"
```

---

### Task 8: Avatar generator block in the Persona step

**Files:**
- Create: `control-plane/src/molecules/AvatarGeneratorBlock.tsx`
- Modify: `control-plane/src/organisms/AddAgentModal.tsx` (Persona step + submit)
- Modify: `control-plane/src/organisms/AddAgentModal.test.tsx` (new describe block)
- Modify: `control-plane/src/styles/components.css`

**Interfaces:**
- Consumes: `POST /avatars/generate` (Task 5), catalog `avatarGen` flag, `avatarPresetRef`/`presetRing` state (Task 7).
- Produces: `AvatarGeneratorBlock` with props `{ base, enabled, name, gender, role, backstory, stereotype, ring, value, onGenerated }`; submit body gains `avatarData` (base64, prefix stripped), `avatarPreset`, `avatarRing`.

- [ ] **Step 1: Failing tests** — append to `AddAgentModal.test.tsx`:

```tsx
describe("AddAgentModal avatar generator", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  async function openBlankWizardAtPersona() {
    render(<AddAgentModal open onClose={vi.fn()} />);
    await userEvent.click(await screen.findByText(/create custom/i));
    await userEvent.click(await screen.findByRole("button", { name: /next/i })); // Setup -> Persona
  }

  it("generates a portrait, flips to reroll, and submits avatarData without the data-uri prefix", async () => {
    const { posted } = stubFetch();
    await openBlankWizardAtPersona();
    await userEvent.type(screen.getByLabelText(/^name$/i), "Nena");
    await userEvent.click(screen.getByRole("button", { name: /generate a portrait/i }));
    expect(await screen.findByRole("button", { name: /reroll the portrait/i })).toBeTruthy();
    // walk to the last step and create
    await userEvent.click(screen.getByRole("button", { name: /next/i })); // Voice
    await userEvent.click(screen.getByRole("button", { name: /next/i })); // Reactions
    await userEvent.click(screen.getByRole("button", { name: /next/i })); // Answers
    await userEvent.click(screen.getByRole("button", { name: /create agent/i }));
    await waitFor(() => expect(posted.length).toBe(1));
    expect(posted[0].avatarData).toBe("QUJD");
    expect(posted[0].avatarPreset).toBeUndefined();
  });

  it("generation failure shows the error and never blocks saving", async () => {
    const { posted } = stubFetch({ generated: { error: "Gemini returned no image — try again" } });
    await openBlankWizardAtPersona();
    await userEvent.type(screen.getByLabelText(/^name$/i), "Nena");
    await userEvent.click(screen.getByRole("button", { name: /generate a portrait/i }));
    expect(await screen.findByText(/no image/i)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /next/i }));
    await userEvent.click(screen.getByRole("button", { name: /next/i }));
    await userEvent.click(screen.getByRole("button", { name: /next/i }));
    await userEvent.click(screen.getByRole("button", { name: /create agent/i }));
    await waitFor(() => expect(posted.length).toBe(1));
    expect(posted[0].avatarData).toBeUndefined();
  });

  it("avatarGen false hides the generate button", async () => {
    stubFetch({ catalog: { ...CATALOG, avatarGen: false } });
    await openBlankWizardAtPersona();
    expect(screen.queryByRole("button", { name: /generate a portrait/i })).toBeNull();
  });

  it("customized preset keeps its committed art: submit carries avatarPreset, not avatarData", async () => {
    const { posted } = stubFetch();
    render(<AddAgentModal open onClose={vi.fn()} />);
    await userEvent.click(await screen.findByText("Minerva"));
    await userEvent.click(screen.getByRole("button", { name: /customize/i }));
    await userEvent.click(screen.getByRole("button", { name: /next/i })); // -> Persona
    await userEvent.clear(screen.getByLabelText(/^name$/i));
    await userEvent.type(screen.getByLabelText(/^name$/i), "Minerva Dos");
    await userEvent.click(screen.getByRole("button", { name: /next/i }));
    await userEvent.click(screen.getByRole("button", { name: /next/i }));
    await userEvent.click(screen.getByRole("button", { name: /next/i }));
    await userEvent.click(screen.getByRole("button", { name: /create agent/i }));
    await waitFor(() => expect(posted.length).toBe(1));
    expect(posted[0].avatarPreset).toBe("minerva");
    expect(posted[0].avatarRing).toBe("#5fd0b0");
    expect(posted[0].avatarData).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd control-plane && npx vitest run src/organisms/AddAgentModal.test.tsx`
Expected: new block FAILS (no generate button, submit lacks fields).

- [ ] **Step 3: Implement `AvatarGeneratorBlock.tsx`**:

```tsx
import { RefreshCw, Sparkles } from "lucide-react";
import type { CSSProperties } from "react";
import { useState } from "react";

interface AvatarGeneratorBlockProps {
  /** Broker host:port. */
  base: string;
  /** catalog.avatarGen — false renders nothing (no Gemini key on the broker). */
  enabled: boolean;
  name: string;
  gender: string;
  role: string;
  backstory: string;
  stereotype?: string;
  ring?: string;
  /** Current portrait: a data URI fresh from Gemini, or a server URL (preset art / editing). */
  value?: string;
  onGenerated: (dataUri: string) => void;
}

/**
 * Generate/reroll a portrait for the agent being written. Preview-only by
 * design: the base64 lives in wizard state and is submitted with the agent,
 * so a reroll never leaves an orphaned file anywhere.
 */
export function AvatarGeneratorBlock({
  base,
  enabled,
  name,
  gender,
  role,
  backstory,
  stereotype,
  ring,
  value,
  onGenerated,
}: AvatarGeneratorBlockProps) {
  const [genBusy, setGenBusy] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  if (!enabled) return null;

  const generate = async () => {
    setGenBusy(true);
    setGenError(null);
    const res = (await fetch(`http://${base}/avatars/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, gender, role, backstory, stereotype }),
    })
      .then((r) => r.json())
      .catch((err: unknown) => ({ error: String(err) }))) as { imageData?: string; error?: string };
    setGenBusy(false);
    if (res.error || !res.imageData) {
      setGenError(res.error ?? "generation failed — try again");
      return;
    }
    onGenerated(`data:image/png;base64,${res.imageData}`);
  };

  return (
    <div className="avatar-gen">
      <span className="avatar-gen__preview" style={{ "--ring": ring } as CSSProperties}>
        {value ? <img src={value} alt="" /> : <b>{name[0]?.toUpperCase() ?? "?"}</b>}
      </span>
      <button type="button" className="settings-btn" onClick={() => void generate()} disabled={genBusy}>
        {value ? <RefreshCw size={12} strokeWidth={2} /> : <Sparkles size={12} strokeWidth={2} />}{" "}
        {genBusy ? "painting the portrait…" : value ? "reroll the portrait" : "generate a portrait"}
      </button>
      {genError && <p className="wizard__error">{genError}</p>}
    </div>
  );
}
```

- [ ] **Step 4: Wire into the modal** — in `AddAgentModal.tsx`:
  - Import the block; add state `const [avatarData, setAvatarData] = useState<string | null>(null);` and clear it in the open-reset effect from Task 7 (`setAvatarData(null);`). Also add `avatar?: string` prefill for editing: in the edit-prefill effect, after `setVoiceId(...)`, add `setAvatarPresetRef(null); setAvatarData(null); setEditingAvatar(a.avatar ?? null);` with `const [editingAvatar, setEditingAvatar] = useState<string | null>(null);`.
  - In the Persona step (step 1), after the gender chips `</div>` and before the Backstory label:

```tsx
              <AvatarGeneratorBlock
                base={BASE}
                enabled={catalog?.avatarGen ?? false}
                name={name}
                gender={gender}
                role={role}
                backstory={backstory}
                stereotype={stereotype?.id}
                ring={presetRing ?? undefined}
                value={
                  avatarData ??
                  (avatarPresetRef
                    ? `http://${BASE}/avatars/${avatarPresetRef}.png`
                    : editingAvatar
                      ? `http://${BASE}/avatars/${editingAvatar}`
                      : undefined)
                }
                onGenerated={(uri) => {
                  setAvatarData(uri);
                  setAvatarPresetRef(null); // a reroll replaces preset art
                }}
              />
```

  - In `submit`'s body JSON, after `quickAnswers: answers,` add:

```ts
        avatarData: avatarData ? avatarData.replace(/^data:image\/png;base64,/, "") : undefined,
        avatarPreset: !avatarData && avatarPresetRef ? avatarPresetRef : undefined,
        avatarRing: presetRing ?? undefined,
```

- [ ] **Step 5: CSS** — in `components.css`, after the `.avatar-gen` insert point chosen in Task 7's block (keep them adjacent):

```css
.avatar-gen {
  display: flex;
  align-items: center;
  gap: 10px;
}
.avatar-gen__preview {
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  border: 2px solid var(--ring, var(--pill-br));
  overflow: hidden;
  flex: none;
  color: var(--text-2);
}
.avatar-gen__preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
```

- [ ] **Step 6: Run the full modal test file**

Run: `cd control-plane && npx vitest run src/organisms/AddAgentModal.test.tsx`
Expected: PASS (10 tests).

- [ ] **Step 7: Full suite + lint**

Run: `cd control-plane && npm test && npx biome check --write src/`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add control-plane/src/molecules/AvatarGeneratorBlock.tsx control-plane/src/organisms/AddAgentModal.tsx control-plane/src/organisms/AddAgentModal.test.tsx control-plane/src/styles/components.css
git commit -m "feat(control-plane): AI portrait generate/reroll in the persona step"
```

---

### Task 9: Authoring — deep persona content, voices, and committed preset art

**This task needs Edwin's environment**: the live broker (tmux session `smith-broker`, port 7790) restarted with `GEMINI_API_KEY` (and the existing `ELEVENLABS_API_KEY`) in the repo-root `.env`. NEVER kill it with an unscoped `pkill` — restart inside the tmux session. If keys are unavailable, land the two scripts and stop; the feature ships degraded-but-working (cards without portraits fall back to hidden images, joins still work).

**Files:**
- Create: `swarm/scripts/author-presets.ts`
- Create: `swarm/scripts/generate-preset-avatars.ts`
- Modify: `swarm/src/personas.ts` (paste curated output)
- Create: `swarm/assets/avatars/*.png` (11 files, committed)

**Interfaces:**
- Consumes: `PRESET_AGENTS` seeds (Task 1), broker `POST /agents/generate` + `GET /voices` (existing), broker `POST /avatars/generate` (Task 5).
- Produces: fully-authored `PRESET_AGENTS` (voiceId, reactions, quickAnswers filled) + 11 committed PNGs.

- [ ] **Step 1: Authoring script** — create `swarm/scripts/author-presets.ts`:

```ts
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
import { PRESET_AGENTS } from '../src/personas.js';

const BROKER = process.env.BROKER ?? '127.0.0.1:7790';

const authored: unknown[] = [];
for (const p of PRESET_AGENTS) {
  const draft = (await fetch(`http://${BROKER}/agents/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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
    `http://${BROKER}/voices?search=${encodeURIComponent('dominican spanish latin')}&gender=${p.gender}`,
  ).then((r) => r.json())) as { voices?: Array<{ voiceId: string; name: string }>; error?: string };
  authored.push({
    ...p,
    voiceId: p.voiceId || voices.voices?.[0]?.voiceId || '',
    reactions: Object.fromEntries((draft.reactions ?? []).map((r) => [r.level, [r.line]])),
    quickAnswers: Object.fromEntries((draft.quickAnswers ?? []).map((a) => [a.id, a.answer])),
  });
  console.error(`authored ${p.id}${voices.error ? ` (no voice: ${voices.error})` : ''}`);
}
console.log(JSON.stringify(authored, null, 2));
```

- [ ] **Step 2: Art script** — create `swarm/scripts/generate-preset-avatars.ts`:

```ts
/**
 * One-shot preset portraits against a LIVE broker with GEMINI_API_KEY set.
 * Writes swarm/assets/avatars/<id>.png for every preset — these files are
 * COMMITTED; runtime never regenerates them.
 *
 * Usage: cd swarm && BROKER=127.0.0.1:7790 node --import tsx scripts/generate-preset-avatars.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { PRESET_AGENTS } from '../src/personas.js';

const BROKER = process.env.BROKER ?? '127.0.0.1:7790';
const outDir = new URL('../assets/avatars/', import.meta.url);
await mkdir(outDir, { recursive: true });

for (const p of PRESET_AGENTS) {
  const res = (await fetch(`http://${BROKER}/avatars/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: p.name, gender: p.gender, role: p.role, backstory: p.backstory, stereotype: p.stereotype }),
  }).then((r) => r.json())) as { imageData?: string; error?: string };
  if (!res.imageData) throw new Error(`${p.id}: ${res.error ?? 'no image'}`);
  await writeFile(new URL(`${p.id}.png`, outDir), Buffer.from(res.imageData, 'base64'));
  console.error(`painted ${p.id}`);
}
```

- [ ] **Step 3: Commit the scripts** (they must land even if keys are missing today):

```bash
git add swarm/scripts/author-presets.ts swarm/scripts/generate-preset-avatars.ts
git commit -m "feat(swarm): one-shot preset authoring and portrait scripts"
```

- [ ] **Step 4: Run authoring** (requires live broker; ask Edwin to restart `smith-broker` with the new env if needed):

Run: `cd swarm && BROKER=127.0.0.1:7790 node --import tsx scripts/author-presets.ts > /tmp/presets.json`
Expected: 11 `authored <id>` lines on stderr; JSON array in `/tmp/presets.json`.

- [ ] **Step 5: Curate** — merge `/tmp/presets.json` into `PRESET_AGENTS` in `personas.ts`: fill each entry's `voiceId`, `reactions`, `quickAnswers`. Curation bar (read `swarm/.smith/agents/ignacio.json` for the tone): every reaction line stays in character AND in the seed's language register (`en-do` = English with Dominican Spanish sprinkled in); `quickAnswers.name` must state the preset's actual name; no two presets share a `voiceId`; delete any generator line that contradicts the seed's backstory. Edit lines freely — the generator drafts, the human decides.

- [ ] **Step 6: Verify catalog still valid**

Run: `cd swarm && npm test`
Expected: PASS — `personas.test.ts` invariants still hold with the deep content.

- [ ] **Step 7: Generate + commit art**

Run: `cd swarm && BROKER=127.0.0.1:7790 node --import tsx scripts/generate-preset-avatars.ts && ls -la assets/avatars/`
Expected: 11 `painted <id>` lines; 11 PNGs, each well under 2 MB. Eyeball all 11 (open the directory) — regenerate any one that broke house style by re-running the script (it overwrites).

```bash
git add swarm/src/personas.ts swarm/assets/avatars/
git commit -m "feat(swarm): authored preset personas, voices, and committed portraits"
```

- [ ] **Step 8: End-to-end smoke** (live broker + app): open the control-plane (`cd control-plane && npm run dev`), press `+` on the roster rail → chooser shows 11 portrait cards → join one → it appears on the roster with its portrait and ring → edit it → Persona step shows the portrait with a reroll button (if `GEMINI_API_KEY` is live). Then archive/delete the smoke-test agent from the UI.

---

## Self-Review (run after writing, fixed inline)

- **Spec coverage:** chooser step create-only ✓(T7 mode reset) · 12 cards ✓(T7) · voice preview on cards ✓(T7 chooser `onPreview`) · on-team badge ✓(T7) · one-click join with explicit id ✓(T7) · customize-prefill ✓(T7 `customizePreset`) · avatar block generate/reroll/non-blocking ✓(T8) · edit-mode retroactive portraits ✓(T8 `editingAvatar`) · `PresetAgent` in catalog ✓(T1) · `avatar` field + staging + serving + traversal guard ✓(T2/T3) · reset archives avatars ✓(T3) · broker Gemini module + optional key + `avatarGen` flag ✓(T4/T5) · roster `avatar` ✓(T5/T6) · `<img onerror>` fallback ✓(T6) · 2 MB/PNG cap ✓(T2) · preset ring persisted ✓(T7 join body) · tests across all three packages ✓(T1-T8) · authoring process ✓(T9).
- **Spec deltas (deliberate):** `PresetAgent.reactions`/`quickAnswers` are optional in the type (spec listed them required) because the seeds land before authoring fills them — the join flow is safe either way since `POST /agents` falls back to stereotype reactions. `avatarGen` lives at the catalog top level (spec said the same). No other deltas.
- **Placeholder scan:** no TBDs; every code step has full code; Task 9 Steps 4-8 depend on live keys and say exactly what to do when absent.
- **Type consistency:** `PresetAgent` (swarm) and `PresetCard` (UI) field lists match; `stageAvatar`/`readAvatar` signatures identical between Tasks 2 and 3; `generateAvatar`/`avatarFile` names identical between Tasks 4-5 interface, stub, and wiring; `avatarData`/`avatarPreset`/`avatarRing` body fields identical between Tasks 3, 7, 8.
