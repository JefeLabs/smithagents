import { Check, ChevronLeft, ChevronRight, Play, Search, Sparkles } from "lucide-react";
import type { MouseEvent } from "react";
import { useEffect, useState } from "react";

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

interface Catalog {
  stereotypes: Stereotype[];
  jobRoles: JobRole[];
  engines: EngineOption[];
  quickQuestions: Array<{ id: string; question: string }>;
  reactionLevels: string[];
}

interface AddAgentModalProps {
  open: boolean;
  onClose: () => void;
  /** Fired after the registry accepted the new agent. */
  onCreated?: (name: string) => void;
}

const LEVEL_LABELS: Record<string, string> = {
  strong_agree: "Strongly agrees",
  agree: "Agrees",
  neutral: "Neutral",
  disagree: "Disagrees",
  strong_disagree: "Strongly disagrees",
};

const STEPS = ["Stereotype", "Role", "Identity", "Engine", "Voice", "Reactions", "Answers"] as const;

/**
 * Agent creation wizard: stereotype → identity → voice → reactions → answers.
 * The stereotype seeds style and directives; everything after it is the user's.
 * Reactions and quick answers are fixed lines, so the broker pre-synthesizes
 * them on create — they play back instantly instead of waiting on TTS.
 */
export function AddAgentModal({ open, onClose, onCreated }: AddAgentModalProps) {
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
  const [voiceId, setVoiceId] = useState("");
  const [voices, setVoices] = useState<CatalogVoice[]>([]);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [voiceSearch, setVoiceSearch] = useState("");
  const [generatedStyle, setGeneratedStyle] = useState<string | undefined>();
  const [generatedDirectives, setGeneratedDirectives] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      })
      .catch(() => setError("Could not load the persona catalog — is the broker running?"));
  }, [open, catalog]);

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
    if (open && step === 4) void loadVoices(voiceSearch, gender);
  }, [open, step]);

  if (!open) return null;

  const pickStereotype = (s: Stereotype) => {
    setStereotype(s);
    setReactions(Object.fromEntries(Object.entries(s.reactions).map(([level, lines]) => [level, lines[0] ?? ""])));
    setStep(1);
  };

  /** One model call fills every field; the user edits whatever they want after. */
  const generate = async () => {
    setGenerating(true);
    setError(null);
    const draft = (await fetch(`http://${BASE}/agents/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stereotype: stereotype?.id, jobRole: jobRole?.id, gender, hint }),
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
    setStep(2);
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
    const res = (await fetch(`http://${BASE}/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        role,
        gender,
        backstory,
        stereotype: stereotype?.id,
        jobRole: jobRole?.id,
        persona: { style: generatedStyle ?? stereotype?.style },
        directives: generatedDirectives ?? jobRole?.directives ?? stereotype?.directives,
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

  const canAdvance = step === 0 ? Boolean(stereotype) : step === 2 ? name.trim().length > 0 : true;
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
      aria-label="Create an agent"
      onClick={onScrimClick}
    >
      <section className="wizard">
        <header className="wizard__head">
          {STEPS.map((label, i) => (
            <span key={label} className={`wizard__step${i === step ? " is-active" : ""}${i < step ? " is-done" : ""}`}>
              {i < step ? <Check size={10} strokeWidth={3} /> : `${i + 1}`} {label}
            </span>
          ))}
        </header>

        <div className="wizard__body">
          {step === 0 && (
            <div className="stereotype-grid">
              {(catalog?.stereotypes ?? []).map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={`stereotype-card${stereotype?.id === s.id ? " is-picked" : ""}`}
                  onClick={() => pickStereotype(s)}
                >
                  <b>{s.label}</b>
                  <span>{s.style}</span>
                </button>
              ))}
              {!catalog && <p className="wizard__hint">Loading personas…</p>}
            </div>
          )}

          {step === 1 && (
            <div className="wizard__form">
              <p className="wizard__hint">
                The job says what they own; the archetype says how they say it. Pick a role, then let AI write the rest
                — or fill it in yourself.
              </p>
              <div className="role-grid">
                {(catalog?.jobRoles ?? []).map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className={`chip${jobRole?.id === r.id ? " is-picked" : ""}`}
                    onClick={() => setJobRole(r)}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
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
                {generating ? "writing the persona…" : "generate everything with AI"}
              </button>
              <button type="button" className="settings-btn settings-btn--wide" onClick={() => setStep(2)}>
                skip — I'll write it myself
              </button>
            </div>
          )}

          {step === 2 && (
            <div className="wizard__form">
              <label>
                Name
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Fabian" />
              </label>
              <label>
                Role
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

          {step === 3 && (
            <div className="wizard__form">
              <p className="wizard__hint">Which CLI this agent runs on, and the model it uses for delegated work.</p>
              <div className="role-grid">
                {(catalog?.engines ?? []).map((e) => (
                  <button
                    key={e.cli}
                    type="button"
                    className={`chip${engine?.cli === e.cli ? " is-picked" : ""}`}
                    onClick={() => {
                      setEngine(e);
                      setModel(e.models[0] ?? "");
                    }}
                  >
                    {e.label}
                  </button>
                ))}
              </div>
              {engine && (
                <>
                  <div className="role-grid">
                    {engine.models.map((m) => (
                      <button
                        key={m}
                        type="button"
                        className={`chip${model === m ? " is-picked" : ""}`}
                        onClick={() => setModel(m)}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                  <p className="wizard__hint">
                    {engine.warmSessions
                      ? "Supports warm sessions — this agent can hold context across turns."
                      : (engine.note ?? "Task work and steering only.")}
                  </p>
                </>
              )}
            </div>
          )}

          {step === 4 && (
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

          {step === 5 && (
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
            <button type="button" className="settings-btn" onClick={() => setStep((s) => s + 1)} disabled={!canAdvance}>
              next <ChevronRight size={12} strokeWidth={2} />
            </button>
          ) : (
            <button
              type="button"
              className="settings-btn settings-btn--primary"
              onClick={() => void submit()}
              disabled={busy || !name.trim()}
            >
              {busy ? "creating…" : "create agent"}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
