# Premade agent cards + AI avatar generator — design

Date: 2026-08-06
Status: approved pending user review

## Goal

When adding an agent, the user picks from **11 premade agent templates** rendered as cards — or a **12th "Create custom" card** — instead of always walking the 5-step wizard from scratch. A premade joins the team in one click, fully formed (name, persona, voice, backstory, avatar). A premade can also be used as a **starting point**: a Customize action opens the existing wizard prefilled from the template. Custom agents get an **AI avatar generator**: the broker calls Gemini to produce a portrait in a shared house style.

## Decisions already made (with Edwin)

- Card tap = **one-click join**; **Customize** = refine a premade via the existing wizard.
- Avatar engine = **AI image generation**, provider = **Google Gemini API** (`gemini-2.5-flash-image` default, model configurable).
- **The broker makes the avatar** — it holds the key and the house-style prompt, consistent with it owning ElevenLabs/Deepgram/LiveKit/Anthropic.
- Art style = **flat vector bust portrait**: bold geometric shapes, limited palette, solid background — legible at 40px roster size.
- Approach = **catalog presets + committed avatars**: preset data lives in the swarm catalog; preset portraits are generated once during implementation and committed; Gemini runs at runtime only for custom agents.
- **12-card grid**: 11 premades + Create custom.

## 1. UX flow

### Chooser step (new, create-mode only)

`AddAgentModal` gains a chooser step before the current wizard. Edit mode skips it (unchanged behavior). The step renders a scrollable **12-card grid**: 11 preset cards + a visually distinct "Create custom" card. It reuses and extends the orphaned `.stereotype-grid` / `.stereotype-card` CSS in `components.css` (currently 2 columns; extend to 3 columns for this grid).

Each preset card shows:
- portrait (committed PNG, served via broker `/avatars/...`)
- name + title (e.g. "Minerva — Security Engineer")
- stereotype label (e.g. "The Auditor")
- one-line hook (authored, from the preset)
- a small play button that previews the preset's voice via existing `POST /voices/preview`

Presets whose id already exists on the roster (active or archived-then-recreated is out of scope; match on agent id) show an **"On the team"** badge; Join is disabled for them, Customize stays enabled (renaming produces a new id).

### Actions

- Select a preset card → footer shows **Join team** (primary) and **Customize** (secondary).
- **Join team** → `POST /agents` with the full preset body (see §3) → modal closes on success, roster refreshes via the existing `resetComposition` path.
- **Customize** → hydrate the existing 5-step wizard from the preset (same mechanism as the current edit-prefill in `AddAgentModal`) and enter at step 0. From there the flow is the normal custom flow; saving creates a new agent.
- **Create custom** card → blank wizard, exactly today's flow.

### Avatar block (Persona step, custom + edit flows)

Step 1 (Persona) gains an avatar block beside the existing AI persona-generate control:
- Portrait preview; before generation it shows the current initial + ring fallback.
- **Generate avatar** button → `POST /avatars/generate` on the broker with the current persona fields (name, gender, role, backstory, stereotype). 5–15s; button shows a spinner; the rest of the wizard stays usable.
- After a result: preview updates, button becomes **Reroll**.
- Generation is **never required** — save without an avatar keeps the initials look.
- The same block appears in edit mode, so existing agents (ignacio, wilkin) can gain portraits retroactively.

## 2. Preset catalog

### Data model

New in `swarm/src/personas.ts`, following the existing "data, not code" pattern:

```ts
export type PresetAgent = {
  id: string;            // slug, doubles as agent id on join
  name: string;
  gender: 'male' | 'female' | 'neutral';
  role: string;          // display title
  jobRole: string;       // JOB_ROLES id — directives merge source
  stereotype: string;    // STEREOTYPES id — style/reactions merge source
  language: string;      // LANGUAGES id (en-do for the shipped cast)
  hook: string;          // one-line card blurb
  backstory: string;
  persona: { style: string };
  reactions: Partial<Record<ReactionLevel, string[]>>;
  quickAnswers: Record<string, string>;
  voiceId: string;       // ElevenLabs voice id
  ring: string;          // hex from RING_PALETTE, fixed per preset
  avatar: string;        // filename under swarm/assets/avatars/
  engine: { cli: string; model: string };
};
export const PRESET_AGENTS: PresetAgent[] = [ /* 11 entries */ ];
```

`GET /agents/catalog` (swarm `server.ts`) adds `presets: PRESET_AGENTS` to its payload; the broker's `/agent-catalog` proxy forwards it untouched; the broker additionally injects `avatarGen: boolean` (whether a Gemini key is configured) into the proxied response.

### The 11 characters (seeds)

Dominican crew, `en-do`, matching the tone bar set by ignacio (architect/purist) and wilkin (fullstack/auditor). Job roles chosen to complement those two; stereotypes spread across the six.

| # | Name | Gender | Role (title) | jobRole | Stereotype |
|---|------|--------|--------------|---------|------------|
| 1 | Yesenia | female | Frontend Engineer | frontend | builder |
| 2 | Radhamés | male | Backend Engineer | backend | purist |
| 3 | Bienvenido | male | DevOps Engineer | devops | skeptic |
| 4 | Minerva | female | Security Engineer | security | auditor |
| 5 | Altagracia | female | QA Engineer | qa | skeptic |
| 6 | Teófilo | male | Data Engineer | data | purist |
| 7 | Xiomara | female | ML Engineer | ml | builder |
| 8 | Rafelito | male | Mobile Engineer | mobile | builder |
| 9 | Dulce | female | Product Designer | design | diplomat |
| 10 | Josefina | female | Product Manager | pm | diplomat |
| 11 | Anselmo | male | Docs Engineer | docs | architect |

Authoring process (implementation step, not runtime): for each seed, run the existing persona generator (`POST /agents/generate`) with the seed's stereotype/jobRole/gender/language plus a hint, curate the output by hand to the ignacio/wilkin quality bar, pick a matching ElevenLabs voice via the existing voice browser, and commit the finished entry into `PRESET_AGENTS`. Engine defaults to `{ cli: 'claude', model: 'claude-opus' }` like the live crew. Ring colors are assigned round-robin from `RING_PALETTE` and fixed per preset.

Preset portraits: an authoring script (committed under `swarm/scripts/`) calls the broker's avatar generator once per preset and writes `swarm/assets/avatars/<presetId>.png`; the PNGs are committed.

## 3. Persistence & serving

- `ComposedAgent` (swarm `agents.ts`) gains optional `avatar?: string` — a filename, not a URL. Validator untouched (field is optional).
- Live agent avatar files: `swarm/.smith/avatars/<agentId>.png`. Living under `.smith/` means the existing reset/archive flow covers them.
- Preset art: committed at `swarm/assets/avatars/<presetId>.png`.
- **Preset join**: `POST /agents` body carries `avatarPreset: "<presetId>"` and an explicit `id: preset.id`. The explicit id is required, not cosmetic: the server's name-slugging (`server.ts:871`) dashes non-ASCII, so "Radhamés" would become `radham-s`; `b.id` is already honored. Preset ids are plain-ASCII slugs of the name (`radhames`, `teofilo`). The swarm copies the committed PNG to `.smith/avatars/<agentId>.png` and sets `avatar`.
- **Custom avatar**: `POST /agents` / `PUT /agents/:id` accept `avatarData` (base64 PNG); the swarm writes the file and sets `avatar`. `avatarData`/`avatarPreset` are transport-only — never persisted into the agent JSON.
- Serving: swarm `GET /avatars/:file` checks `.smith/avatars/` first, then `assets/avatars/` (for card art). Broker proxies `GET /avatars/*` to the swarm. Filenames are validated against `/^[a-z0-9-]+\.png$/` (no traversal).
- Preset join also persists `avatarRing` (the preset's `ring`), making preset ring colors stable across roster reorders. Custom agents keep today's index-based fallback unless edited.
- UI: `RosterAgent` (in `useBrokerChat.ts`) gains `avatar?: string`; broker roster snapshot (`main.ts`) forwards it alongside `ring`.
- `Avatar.tsx`: when `avatar` is set, render `<img src={`http://${BASE}/avatars/${avatar}`}>` clipped to the existing circle, ring preserved; on image `onerror`, fall back to the initial rendering.

## 4. Broker avatar pipeline

- New env var `GEMINI_API_KEY` — **optional** (unlike `ANTHROPIC_API_KEY`). Absent → `avatarGen: false` in the catalog, `POST /avatars/generate` returns a clear "no Gemini key configured" error, mirroring the ElevenLabs-less voice behavior.
- New module `broker/src/avatar-generator.ts` using `@google/genai`, model from `GEMINI_IMAGE_MODEL` env (default `gemini-2.5-flash-image`).
- House-style prompt template (single source of truth, in the module): flat vector bust portrait, bold geometric shapes, limited warm palette, solid background, square crop, no text/logos — plus persona-derived clauses (gender presentation, role vibe pulled from title, one visual cue distilled from backstory).
- `POST /avatars/generate` request `{ name, gender, role, backstory, stereotype }` → response `{ imageData: string }` (base64 PNG, resized/normalized to 512×512 broker-side).
- Nothing persists at generate time; the wizard holds the base64 in state (reroll replaces it) and sends it as `avatarData` on save. No orphaned files by construction.

## 5. Error handling

| Failure | Behavior |
|---|---|
| No `GEMINI_API_KEY` | Generate button not rendered (catalog `avatarGen: false`); presets unaffected (committed art) |
| Gemini error/timeout | Inline error on the button, retry allowed; save never blocked |
| Avatar file missing/corrupt at render | `<img onerror>` → initials + ring fallback |
| Preset already on team | Card badge, Join disabled client-side; server id-collision remains the backstop |
| `avatarData` too large / not PNG | Swarm rejects with 400; cap 2 MB decoded |
| Voice preview fails on a card | Same handling as the existing voice browser rows |

## 6. Testing

- **Control-plane** (`AddAgentModal.test.tsx` — new file, closing an existing gap): chooser grid renders from a catalog fixture; one-click join posts the exact preset body incl. `avatarPreset`; "On the team" badge disables Join; Customize prefills wizard fields; avatar button states (idle → spinner → reroll → error) with mocked fetch; save carries `avatarData`. `Avatar.tsx`: img branch + onerror fallback.
- **Broker**: `avatar-generator` unit tests with mocked Gemini client (prompt assembly, resize, error mapping); route test for `/avatars/generate` with and without key; catalog proxy injects `avatarGen`.
- **Swarm**: `avatarPreset` copy, `avatarData` write + validation (size/type/filename), `GET /avatars/:file` two-directory lookup + traversal rejection, `avatar` field round-trip through create/update, reset flow archives `.smith/avatars`.

## 7. Out of scope

- Regenerating or editing preset art at runtime.
- Avatars on any surface other than the control-plane roster (Discord etc. later).
- Seeding premades automatically at workspace creation.
- Migrating existing agents' ring-color fallback (only preset joins persist `avatarRing`).
