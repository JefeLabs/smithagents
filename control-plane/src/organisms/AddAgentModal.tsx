import { Check, ChevronLeft, ChevronRight, Play, Search, Sparkles } from "lucide-react";
import type { MouseEvent } from "react";
import { useEffect, useState } from "react";
import { AddAgentChooser, type PresetCard } from "./AddAgentChooser";

const BASE = "127.0.0.1:7790";

interface Stereotype {
  id: string;
  label: string;
  style: string;
  directives: string;
  reactions: Record<string, string[]>;
}

interface CatalogVoice {
  voiceId: string;
  name: string;
  gender?: string;
  accent?: string;
  description?: string;
}

interface JobRole {
  id: string;
  label: string;
  directives: string;
}

interface EngineOption {
  cli: string;
  label: string;
  models: string[];
  warmSessions: boolean;
  note?: string;
}

interface LanguageOption {
  id: string;
  label: string;
  speech: string;
}

interface Catalog {
  stereotypes: Stereotype[];
  jobRoles: JobRole[];
  engines: EngineOption[];
  languages: LanguageOption[];
  quickQuestions: Array<{ id: string; question: string }>;
  reactionLevels: string[];
  presets?: PresetCard[];
  avatarGen?: boolean;
}

/** The stored agent record, as the registry returns it. */
interface StoredAgent {
  id: string;
  name?: string;
  role?: string;
  backstory?: string;
  gender?: string;
  language?: string;
  stereotype?: string;
  jobRole?: string;
  engine?: { cli?: string; model?: string };
  voice?: { voiceId?: string };
  reactions?: Record<string, string[]>;
  quickAnswers?: Record<string, string>;
  archived?: boolean;
  avatar?: string;
}

interface AddAgentModalProps {
  open: boolean;
  onClose: () => void;
  /** Fired after the registry accepted the new agent. */
  onCreated?: (name: string) => void;
  /** Agent id to edit. Absent = creating a new one. */
  editingId?: string;
}

const LEVEL_LABELS: Record<string, string> = {
  strong_agree: "Strongly agrees",
  agree: "Agrees",
  neutral: "Neutral",
  disagree: "Disagrees",
  strong_disagree: "Strongly disagrees",
};

const STEPS = ["Setup", "Persona", "Voice", "Reactions", "Answers"] as const;

/**
 * Agent creation wizard: setup → persona → voice → reactions → answers.
 *
 * Setup comes first and holds the decisions that actually determine what gets
 * launched — job role, CLI, model, personality, and the language they speak.
 * Everything after it is flavor, and can be typed by hand or written by AI in
 * one call. Reactions and quick answers are fixed lines, so the broker
 * pre-synthesizes them on create — they play back instantly instead of
 * waiting on TTS.
 */
export function AddAgentModal({ open, onClose, onCreated, editingId }: AddAgentModalProps) {
  const editing = Boolean(editingId);
  const [step, setStep] = useState(0);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [stereotype, setStereotype] = useState<Stereotype | null>(null);
  const [jobRole, setJobRole] = useState<JobRole | null>(null);
  const [hint, setHint] = useState("");
  const [generating, setGenerating] = useState(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [gender, setGender] = useState<"male" | "female" | "neutral">("neutral");
  const [backstory, setBackstory] = useState("");
  const [reactions, setReactions] = useState<Record<string, string>>({});
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [engine, setEngine] = useState<EngineOption | null>(null);
  const [model, setModel] = useState("");
  const [language, setLanguage] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [voices, setVoices] = useState<CatalogVoice[]>([]);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [voiceSearch, setVoiceSearch] = useState("");
  const [generatedStyle, setGeneratedStyle] = useState<string | undefined>();
  const [generatedDirectives, setGeneratedDirectives] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"choose" | "wizard">("choose");
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [takenIds, setTakenIds] = useState<Set<string>>(new Set());
  /** Preset whose committed art the new agent should copy (customize keeps it until a reroll replaces it). */
  const [avatarPresetRef, setAvatarPresetRef] = useState<string | null>(null);
  const [presetRing, setPresetRing] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setMode(editingId ? "wizard" : "choose");
    setSelectedPresetId(null);
    setAvatarPresetRef(null);
    setPresetRing(null);
  }, [open, editingId]);

  useEffect(() => {
    if (!open || editingId) return;
    void fetch(`http://${BASE}/agents`)
      .then((r) => r.json())
      .then((res: { agents?: StoredAgent[] }) =>
        setTakenIds(new Set((res.agents ?? []).filter((a) => !a.archived).map((a) => a.id))),
      )
      .catch(() => setTakenIds(new Set()));
  }, [open, editingId]);

  useEffect(() => {
    if (!open || catalog) return;
    void fetch(`http://${BASE}/agent-catalog`)
      .then((r) => r.json())
      .then((c: Catalog) => {
        setCatalog(c);
        const first = c.engines?.[0];
        if (first) {
          setEngine(first);
          setModel(first.models[0] ?? "");
        }
        setLanguage(c.languages?.[0]?.id ?? "");
      })
      .catch(() => setError("Could not load the persona catalog — is the broker running?"));
  }, [open, catalog]);

  // Editing pre-fills from the STORED record, not the roster frame — the
  // frame is a view model and carries none of the persona detail.
  useEffect(() => {
    if (!open || !editingId || !catalog) return;
    void fetch(`http://${BASE}/agents`)
      .then((r) => r.json())
      .then((res: { agents?: StoredAgent[] }) => {
        const a = res.agents?.find((x) => x.id === editingId);
        if (!a) {
          setError(`Could not load ${editingId} — it may have been removed.`);
          return;
        }
        setName(a.name ?? "");
        setRole(a.role ?? "");
        setBackstory(a.backstory ?? "");
        setGender((a.gender as "male" | "female" | "neutral") ?? "neutral");
        setLanguage(a.language ?? catalog.languages?.[0]?.id ?? "");
        setVoiceId(a.voice?.voiceId ?? "");
        setStereotype(catalog.stereotypes.find((x) => x.id === a.stereotype) ?? null);
        // Agents created before jobRole was stored have only their free-text
        // title; recover the dropdown by matching it against the catalog.
        setJobRole(
          catalog.jobRoles.find((x) => x.id === a.jobRole) ?? catalog.jobRoles.find((x) => x.label === a.role) ?? null,
        );
        const eng = catalog.engines.find((x) => x.cli === a.engine?.cli) ?? null;
        setEngine(eng);
        setModel(a.engine?.model ?? eng?.models[0] ?? "");
        setReactions(Object.fromEntries(Object.entries(a.reactions ?? {}).map(([k, v]) => [k, v?.[0] ?? ""])));
        setAnswers(a.quickAnswers ?? {});
      })
      .catch(() => setError("Could not load this agent — is the broker running?"));
  }, [open, editingId, catalog]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Voice browsing is its own async surface: a key without voices_read fails
  // here with an actionable message while every other step still works.
  const loadVoices = async (search: string, genderFilter: string) => {
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (genderFilter && genderFilter !== "neutral") params.set("gender", genderFilter);
    const res = (await fetch(`http://${BASE}/voices?${params}`).then((r) => r.json())) as {
      voices?: CatalogVoice[];
      error?: string;
    };
    if (res.error) {
      setVoiceError(res.error);
      setVoices([]);
    } else {
      setVoiceError(null);
      setVoices(res.voices ?? []);
    }
  };

  // Load the catalog when the voice step opens. Deliberately keyed on the
  // step only: search and gender re-query on submit/toggle, not per keystroke.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (open && step === 2) void loadVoices(voiceSearch, gender);
  }, [open, step]);

  if (!open) return null;

  /** Seeds the reaction lines from the archetype; the user edits them later. */
  const pickStereotype = (s: Stereotype | null) => {
    setStereotype(s);
    if (s) {
      setReactions(Object.fromEntries(Object.entries(s.reactions).map(([level, lines]) => [level, lines[0] ?? ""])));
    }
  };

  /** One model call fills every field; the user edits whatever they want after. */
  const generate = async () => {
    setGenerating(true);
    setError(null);
    const draft = (await fetch(`http://${BASE}/agents/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stereotype: stereotype?.id, jobRole: jobRole?.id, gender, hint, language }),
    })
      .then((r) => r.json())
      .catch((err: unknown) => ({ error: String(err) }))) as {
      error?: string;
      name?: string;
      role?: string;
      backstory?: string;
      style?: string;
      directives?: string;
      reactions?: Array<{ level: string; line: string }>;
      quickAnswers?: Array<{ id: string; answer: string }>;
    };
    setGenerating(false);
    if (draft.error) {
      setError(draft.error);
      return;
    }
    setName(draft.name ?? "");
    setRole(draft.role ?? "");
    setBackstory(draft.backstory ?? "");
    setGeneratedStyle(draft.style);
    setGeneratedDirectives(draft.directives);
    if (draft.reactions) setReactions(Object.fromEntries(draft.reactions.map((r) => [r.level, r.line])));
    if (draft.quickAnswers) setAnswers(Object.fromEntries(draft.quickAnswers.map((a) => [a.id, a.answer])));
    setStep(1); // land on Persona with every field filled in and editable
  };

  const preview = async (id: string) => {
    const res = await fetch(`http://${BASE}/voices/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ voiceId: id, text: `Hola, I am ${name || "your new teammate"}.` }),
    });
    if (!res.ok) return;
    void new Audio(URL.createObjectURL(await res.blob())).play();
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    const res = (await fetch(`http://${BASE}/agents${editingId ? `/${encodeURIComponent(editingId)}` : ""}`, {
      method: editing ? "PUT" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        role,
        gender,
        backstory,
        stereotype: stereotype?.id,
        jobRole: jobRole?.id,
        language,
        // When editing, only send prose the user actually changed. Falling back
        // to the stereotype's copy here would silently overwrite the directives
        // and style already saved on this agent.
        persona: editing && !generatedStyle ? undefined : { style: generatedStyle ?? stereotype?.style },
        directives: editing
          ? (generatedDirectives ?? jobRole?.directives)
          : (generatedDirectives ?? jobRole?.directives ?? stereotype?.directives),
        engine: engine ? { cli: engine.cli, model } : undefined,
        voice: voiceId ? { voiceId } : undefined,
        reactions: Object.fromEntries(Object.entries(reactions).map(([k, v]) => [k, [v]])),
        quickAnswers: answers,
      }),
    }).then((r) => r.json())) as { error?: string; name?: string };
    setBusy(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    onCreated?.(name);
    onClose();
    setStep(0);
    setStereotype(null);
    setName("");
    setRole("");
    setBackstory("");
    setVoiceId("");
  };

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

  // Setup is the only step whose fields decide what actually gets launched, so
  // it is the only one that gates. Persona needs a name to create the agent.
  const canAdvance =
    step === 0 ? Boolean(engine && model.trim() && language) : step === 1 ? name.trim().length > 0 : true;
  const onScrimClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: click-outside dismiss; the keyboard path is the Escape handler bound while open
    <div
      className="scrim"
      data-open="true"
      role="dialog"
      aria-modal="true"
      aria-label={editing ? "Edit agent" : "Create an agent"}
      onClick={onScrimClick}
    >
      <section className="wizard">
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
            <header className="wizard__head">
              {STEPS.map((label, i) => (
                <span
                  key={label}
                  className={`wizard__step${i === step ? " is-active" : ""}${i < step ? " is-done" : ""}`}
                >
                  {i < step ? <Check size={10} strokeWidth={3} /> : `${i + 1}`} {label}
                </span>
              ))}
            </header>

            <div className="wizard__body">
              {step === 0 && (
                <div className="wizard__form">
                  <p className="wizard__hint">
                    These decide what actually gets launched: the job they own, the CLI process they live in, and the
                    language they speak. Everything after this is flavor.
                  </p>
                  <label>
                    Job role
                    <select
                      value={jobRole?.id ?? ""}
                      onChange={(e) => setJobRole(catalog?.jobRoles.find((r) => r.id === e.target.value) ?? null)}
                    >
                      <option value="">— pick a role —</option>
                      {(catalog?.jobRoles ?? []).map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    CLI
                    <select
                      value={engine?.cli ?? ""}
                      onChange={(e) => {
                        const picked = catalog?.engines.find((x) => x.cli === e.target.value) ?? null;
                        setEngine(picked);
                        setModel(picked?.models[0] ?? "");
                      }}
                    >
                      {(catalog?.engines ?? []).map((e) => (
                        <option key={e.cli} value={e.cli}>
                          {e.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Model
                    <select value={model} onChange={(e) => setModel(e.target.value)}>
                      {(engine?.models ?? []).map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                      {model && !(engine?.models ?? []).includes(model) && (
                        <option value={model}>{model} (custom)</option>
                      )}
                    </select>
                  </label>
                  <label>
                    Or type any model id {engine?.label ?? "this CLI"} accepts
                    <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="claude-opus" />
                  </label>
                  {engine && (
                    <p className="wizard__hint">
                      {engine.warmSessions
                        ? "Supports warm sessions — this agent can hold context across turns."
                        : (engine.note ?? "Task work and steering only.")}
                    </p>
                  )}
                  <label>
                    Personality
                    <select
                      value={stereotype?.id ?? ""}
                      onChange={(e) =>
                        pickStereotype(catalog?.stereotypes.find((x) => x.id === e.target.value) ?? null)
                      }
                    >
                      <option value="">— pick an archetype —</option>
                      {(catalog?.stereotypes ?? []).map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.label} — {x.style}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Primary language
                    <select value={language} onChange={(e) => setLanguage(e.target.value)}>
                      {(catalog?.languages ?? []).map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {!catalog && <p className="wizard__hint">Loading the catalog…</p>}
                </div>
              )}

              {step === 1 && (
                <div className="wizard__form">
                  <p className="wizard__hint">
                    Write this yourself, or let AI fill every remaining field from your setup — name, backstory,
                    reactions and answers included. Everything stays editable after.
                  </p>
                  <label>
                    Anything specific? (optional)
                    <input
                      value={hint}
                      onChange={(e) => setHint(e.target.value)}
                      placeholder="veteran who has seen three failed launches"
                    />
                  </label>
                  <button
                    type="button"
                    className="settings-btn settings-btn--primary settings-btn--wide"
                    onClick={() => void generate()}
                    disabled={generating}
                  >
                    <Sparkles size={12} strokeWidth={2} />{" "}
                    {generating
                      ? "writing the persona…"
                      : editing
                        ? "rewrite the persona with AI"
                        : "generate the rest with AI"}
                  </button>
                  <label>
                    Name
                    <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Fabian" />
                  </label>
                  <label>
                    Title
                    <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="The Architect" />
                  </label>
                  <div className="wizard__genders">
                    <span>Voice gender</span>
                    {(["male", "female", "neutral"] as const).map((g) => (
                      <button
                        key={g}
                        type="button"
                        className={`chip${gender === g ? " is-picked" : ""}`}
                        onClick={() => setGender(g)}
                      >
                        {g}
                      </button>
                    ))}
                  </div>
                  <label>
                    Backstory
                    <textarea
                      value={backstory}
                      onChange={(e) => setBackstory(e.target.value)}
                      rows={3}
                      placeholder="Grew up debugging his father's POS system in Santiago; believes every outage is a design smell."
                    />
                  </label>
                </div>
              )}

              {step === 2 && (
                <div className="voice-browser">
                  <div className="voice-browser__search">
                    <Search size={13} strokeWidth={2} />
                    <input
                      value={voiceSearch}
                      onChange={(e) => setVoiceSearch(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void loadVoices(voiceSearch, gender);
                      }}
                      placeholder="Search the ElevenLabs catalog — latin, warm, deep…"
                    />
                  </div>
                  {voiceError && <p className="wizard__error">{voiceError}</p>}
                  <div className="voice-list">
                    {voices.map((v) => (
                      <div key={v.voiceId} className={`voice-row${voiceId === v.voiceId ? " is-picked" : ""}`}>
                        <button type="button" className="voice-row__pick" onClick={() => setVoiceId(v.voiceId)}>
                          <b>{v.name}</b>
                          <span>{[v.gender, v.accent, v.description].filter(Boolean).join(" · ").slice(0, 70)}</span>
                        </button>
                        <button
                          type="button"
                          className="voice-row__play"
                          onClick={() => void preview(v.voiceId)}
                          aria-label={`Preview ${v.name}`}
                        >
                          <Play size={12} strokeWidth={2} />
                        </button>
                      </div>
                    ))}
                    {voices.length === 0 && !voiceError && (
                      <p className="wizard__hint">Search the catalog above to audition voices.</p>
                    )}
                  </div>
                  <label>
                    Or paste a voice id
                    <input
                      value={voiceId}
                      onChange={(e) => setVoiceId(e.target.value)}
                      placeholder="bnes5tb6xZ5GxqUjhUSq"
                    />
                  </label>
                </div>
              )}

              {step === 3 && (
                <div className="wizard__form">
                  <p className="wizard__hint">
                    What they say across the agreement spectrum. Cached as audio on create, so they fire instantly.
                  </p>
                  {(catalog?.reactionLevels ?? []).map((level) => (
                    <label key={level}>
                      {LEVEL_LABELS[level] ?? level}
                      <input
                        value={reactions[level] ?? ""}
                        onChange={(e) => setReactions((r) => ({ ...r, [level]: e.target.value }))}
                      />
                    </label>
                  ))}
                </div>
              )}

              {step === 4 && (
                <div className="wizard__form">
                  <p className="wizard__hint">
                    First-meeting answers — pre-synthesized so they never wait on a model. Blank = skip.
                  </p>
                  {(catalog?.quickQuestions ?? []).map((q) => (
                    <label key={q.id}>
                      {q.question}
                      <input
                        value={answers[q.id] ?? ""}
                        onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
                      />
                    </label>
                  ))}
                </div>
              )}
            </div>

            {error && <p className="wizard__error">{error}</p>}

            <footer className="wizard__foot">
              <button
                type="button"
                className="settings-btn"
                onClick={() => setStep((s) => Math.max(0, s - 1))}
                disabled={step === 0}
              >
                <ChevronLeft size={12} strokeWidth={2} /> back
              </button>
              {step < STEPS.length - 1 ? (
                <button
                  type="button"
                  className="settings-btn"
                  onClick={() => setStep((s) => s + 1)}
                  disabled={!canAdvance}
                >
                  next <ChevronRight size={12} strokeWidth={2} />
                </button>
              ) : (
                <button
                  type="button"
                  className="settings-btn settings-btn--primary"
                  onClick={() => void submit()}
                  disabled={busy || !name.trim()}
                >
                  {busy ? (editing ? "saving…" : "creating…") : editing ? "save changes" : "create agent"}
                </button>
              )}
            </footer>
          </>
        )}
      </section>
    </div>
  );
}
