import { Check, ChevronLeft, ChevronRight, Play, Search, Sparkles } from "lucide-react";
import type { MouseEvent } from "react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { AvatarGeneratorBlock } from "../molecules/AvatarGeneratorBlock";
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
  /** From the cli-tool registry: false = grayed out in the picker. Absent/true = selectable. */
  active?: boolean;
  /** Human reason when inactive ("not logged in — run `codex login`"). */
  statusDetail?: string;
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
  avatarGen?: "api" | "agy" | null;
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
 * Every user-typed or user-picked value in the wizard, across all five steps. The three
 * catalog-backed pickers hold their *id* (`engine` a cli, `stereotype`/`jobRole` an id);
 * the catalog object each one names is derived at render, so a stored id the catalog no
 * longer offers resolves to null exactly as it did when these were object state.
 */
interface AgentFormValues {
  name: string;
  role: string;
  gender: "male" | "female" | "neutral";
  backstory: string;
  hint: string;
  engine: string;
  model: string;
  language: string;
  stereotype: string;
  jobRole: string;
  voiceId: string;
  voiceSearch: string;
  reactions: Record<string, string>;
  quickAnswers: Record<string, string>;
}

/** Prefer the first CLI the tool registry marked active; fall back to the catalog's first when none are. */
const defaultEngine = (c: Catalog | null): EngineOption | null =>
  c?.engines?.find((e) => e.active !== false) ?? c?.engines?.[0] ?? null;

/**
 * A blank wizard, with the catalog's own defaults already applied. Passed to `reset` at
 * every point the old code ran its `setX` cascade, which is what keeps an abandoned
 * Customize from bleeding into the next Create custom.
 */
function emptyAgent(catalog: Catalog | null): AgentFormValues {
  const first = defaultEngine(catalog);
  return {
    name: "",
    role: "",
    gender: "neutral",
    backstory: "",
    hint: "",
    engine: first?.cli ?? "",
    model: first?.models[0] ?? "",
    language: catalog?.languages?.[0]?.id ?? "",
    stereotype: "",
    jobRole: "",
    voiceId: "",
    voiceSearch: "",
    reactions: {},
    quickAnswers: {},
  };
}

/**
 * Registering an input seeds its key, so a Reactions/Answers step the user merely walked
 * past would otherwise submit `{ agree: [""] }` where it used to submit `{}` — and swarm
 * stores that as a real (empty) line, since `b.reactions ?? seed` only falls back on
 * undefined. Dropping blanks keeps the old payload; the Answers step already tells the
 * user "Blank = skip".
 */
const withoutBlanks = (r: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(r).filter(([, v]) => v.trim()));

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
  const [generating, setGenerating] = useState(false);
  const [voices, setVoices] = useState<CatalogVoice[]>([]);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [generatedStyle, setGeneratedStyle] = useState<string | undefined>();
  const [generatedDirectives, setGeneratedDirectives] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"choose" | "wizard">("choose");
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [takenIds, setTakenIds] = useState<Set<string>>(new Set());
  /** Preset whose committed art the new agent should copy (customize keeps it until a reroll replaces it). */
  const [avatarPresetRef, setAvatarPresetRef] = useState<string | null>(null);
  /**
   * The preset a Customize started from, id + name as they were at that moment. Lets
   * submit() send the canonical preset id instead of re-slugging a name unchanged since
   * customize (e.g. "Radhamés" -> "radham-s", shadowing the real "radhames" preset).
   * Independent of avatarPresetRef, which a portrait reroll clears — a reroll shouldn't
   * revive the slug-mismatch bug.
   */
  const [customizedPresetOrigin, setCustomizedPresetOrigin] = useState<{ id: string; name: string } | null>(null);
  const [presetRing, setPresetRing] = useState<string | null>(null);
  /** Fresh portrait from Gemini — a data URI, submitted as base64 and never touching disk until create/save. */
  const [avatarData, setAvatarData] = useState<string | null>(null);
  /** The stored agent's existing portrait filename, prefilled when editing. */
  const [editingAvatar, setEditingAvatar] = useState<string | null>(null);

  // One form spans all five steps: navigating between them doesn't remount it, so values
  // persist across steps. It is NOT per-open, though — HomePage keeps this modal mounted
  // and toggles `open` — which is why the reset below still has to run explicitly.
  const { register, getValues, setValue, watch, reset } = useForm<AgentFormValues>({
    defaultValues: emptyAgent(null),
  });

  // The wizard's gate is per-STEP, not whole-form: formState.isValid is whole-form and
  // would keep Next disabled on Setup until Persona's name is filled — which the user
  // can't reach while Next is disabled. These four feed that gate literally.
  const [engineCli, model, language, name] = watch(["engine", "model", "language", "name"]);
  const [gender, voiceId, stereotypeId, jobRoleId] = watch(["gender", "voiceId", "stereotype", "jobRole"]);

  // The catalog object behind each id-holding picker. `find` returning undefined is the
  // same "not in this catalog" case the old object state modelled as null.
  const engine = catalog?.engines.find((e) => e.cli === engineCli) ?? null;
  const stereotype = catalog?.stereotypes.find((s) => s.id === stereotypeId) ?? null;
  const jobRole = catalog?.jobRoles.find((r) => r.id === jobRoleId) ?? null;

  /**
   * Every wizard field back to blank/catalog-default. The modal stays mounted
   * across close/reopen, so without this a Customize the user abandoned
   * bleeds into the next Create custom — this is what keeps that path blank.
   */
  const resetWizardFields = () => {
    reset(emptyAgent(catalog));
    setGeneratedStyle(undefined);
    setGeneratedDirectives(undefined);
    setError(null);
    setAvatarData(null);
    setEditingAvatar(null);
    setCustomizedPresetOrigin(null);
  };

  // Reset-on-open only: deliberately excludes resetWizardFields (and thus
  // catalog) from deps — re-running this when the catalog loads would wipe
  // fields the user is already mid-editing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!open) return;
    setMode(editingId ? "wizard" : "choose");
    setSelectedPresetId(null);
    setAvatarPresetRef(null);
    setPresetRing(null);
    if (!editingId) resetWizardFields();
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
        const first = defaultEngine(c);
        if (first) {
          setValue("engine", first.cli);
          setValue("model", first.models[0] ?? "");
        }
        setValue("language", c.languages?.[0]?.id ?? "");
      })
      .catch(() => setError("Could not load the persona catalog — is the broker running?"));
  }, [open, catalog, setValue]);

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
        const eng = catalog.engines.find((x) => x.cli === a.engine?.cli) ?? null;
        reset({
          name: a.name ?? "",
          role: a.role ?? "",
          backstory: a.backstory ?? "",
          gender: (a.gender as "male" | "female" | "neutral") ?? "neutral",
          language: a.language ?? catalog.languages?.[0]?.id ?? "",
          voiceId: a.voice?.voiceId ?? "",
          voiceSearch: "",
          hint: "",
          stereotype: catalog.stereotypes.find((x) => x.id === a.stereotype)?.id ?? "",
          // Agents created before jobRole was stored have only their free-text
          // title; recover the dropdown by matching it against the catalog.
          jobRole:
            (catalog.jobRoles.find((x) => x.id === a.jobRole) ?? catalog.jobRoles.find((x) => x.label === a.role))
              ?.id ?? "",
          engine: eng?.cli ?? "",
          model: a.engine?.model ?? eng?.models[0] ?? "",
          reactions: Object.fromEntries(Object.entries(a.reactions ?? {}).map(([k, v]) => [k, v?.[0] ?? ""])),
          quickAnswers: a.quickAnswers ?? {},
        });
        setAvatarPresetRef(null);
        setAvatarData(null);
        setEditingAvatar(a.avatar ?? null);
      })
      .catch(() => setError("Could not load this agent — is the broker running?"));
  }, [open, editingId, catalog, reset]);

  /**
   * ESCAPE IS OWNED BY THE TOPMOST OVERLAY, and this modal is it while open.
   *
   * It used to be a bare `addEventListener("keydown", …)` — window, bubble phase, no
   * stopPropagation — and `AlertMenu` binds Escape exactly the same way. With both open,
   * one Escape ran both handlers: the user asked to dismiss one thing and dismissed two.
   * Measured in the browser, `.scrim` and `.alert-menu__popover` disappeared together.
   *
   * Window level cannot fix it. Listener order on one target is registration order, and
   * the menu is open FIRST by construction — it is what the modal was opened from — so
   * its handler has already run by the time this one could stop anything.
   *
   * Capture on `document` is the level that works, and it is what react-aria does for the
   * modals `ModalShell` already covers: measured, their Escape reaches a document-capture
   * listener and never reaches a window-bubble one. Safe here because the modal contains
   * no in-DOM surface that wants Escape first — its five dropdowns are native `<select>`,
   * whose popup is an OS-level surface that never enters this event flow.
   */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
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
    if (open && step === 2) void loadVoices(getValues("voiceSearch"), getValues("gender"));
  }, [open, step]);

  if (!open) return null;

  /** Seeds the reaction lines from the archetype; the user edits them later. */
  const pickStereotype = (s: Stereotype | null) => {
    setValue("stereotype", s?.id ?? "");
    if (s) {
      setValue(
        "reactions",
        Object.fromEntries(Object.entries(s.reactions).map(([level, lines]) => [level, lines[0] ?? ""])),
      );
    }
  };

  /** One model call fills every field; the user edits whatever they want after. */
  const generate = async () => {
    setGenerating(true);
    setError(null);
    const draft = (await fetch(`http://${BASE}/agents/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stereotype: stereotype?.id,
        jobRole: jobRole?.id,
        gender,
        hint: getValues("hint"),
        language,
      }),
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
    setValue("name", draft.name ?? "");
    setValue("role", draft.role ?? "");
    setValue("backstory", draft.backstory ?? "");
    setGeneratedStyle(draft.style);
    setGeneratedDirectives(draft.directives);
    if (draft.reactions) setValue("reactions", Object.fromEntries(draft.reactions.map((r) => [r.level, r.line])));
    if (draft.quickAnswers)
      setValue("quickAnswers", Object.fromEntries(draft.quickAnswers.map((a) => [a.id, a.answer])));
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
    const v = getValues();
    // Customize-without-rename: the name still matches the preset it came from, so send its
    // canonical id — otherwise the server slugs the (possibly accented) name fresh and this
    // agent shadows the real preset as a near-duplicate instead of being recognized as it.
    const idOverride =
      !editing && customizedPresetOrigin && v.name === customizedPresetOrigin.name
        ? customizedPresetOrigin.id
        : undefined;
    const res = (await fetch(`http://${BASE}/agents${editingId ? `/${encodeURIComponent(editingId)}` : ""}`, {
      method: editing ? "PUT" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: idOverride,
        name: v.name,
        role: v.role,
        gender: v.gender,
        backstory: v.backstory,
        stereotype: stereotype?.id,
        jobRole: jobRole?.id,
        language: v.language,
        // When editing, only send prose the user actually changed. Falling back
        // to the stereotype's copy here would silently overwrite the directives
        // and style already saved on this agent.
        persona: editing && !generatedStyle ? undefined : { style: generatedStyle ?? stereotype?.style },
        directives: editing
          ? (generatedDirectives ?? jobRole?.directives)
          : (generatedDirectives ?? jobRole?.directives ?? stereotype?.directives),
        engine: engine ? { cli: engine.cli, model: v.model } : undefined,
        voice: v.voiceId ? { voiceId: v.voiceId } : undefined,
        reactions: Object.fromEntries(Object.entries(withoutBlanks(v.reactions)).map(([k, val]) => [k, [val]])),
        quickAnswers: withoutBlanks(v.quickAnswers),
        avatarData: avatarData ? avatarData.replace(/^data:image\/png;base64,/, "") : undefined,
        avatarPreset: !avatarData && avatarPresetRef ? avatarPresetRef : undefined,
        avatarRing: presetRing ?? undefined,
      }),
    }).then((r) => r.json())) as { error?: string; name?: string };
    setBusy(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    onCreated?.(v.name);
    onClose();
    setStep(0);
    setValue("stereotype", "");
    setValue("name", "");
    setValue("role", "");
    setValue("backstory", "");
    setValue("voiceId", "");
    setCustomizedPresetOrigin(null);
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
    setError(null);
    reset({
      name: p.name,
      role: p.role,
      gender: (p.gender as "male" | "female" | "neutral") ?? "neutral",
      backstory: p.backstory,
      language: p.language,
      voiceId: p.voiceId,
      voiceSearch: "",
      hint: "",
      stereotype: catalog?.stereotypes.find((s) => s.id === p.stereotype)?.id ?? "",
      jobRole: catalog?.jobRoles.find((r) => r.id === p.jobRole)?.id ?? "",
      engine: catalog?.engines.find((e) => e.cli === p.engine.cli)?.cli ?? "",
      model: p.engine.model,
      reactions: p.reactions ? Object.fromEntries(Object.entries(p.reactions).map(([k, v]) => [k, v?.[0] ?? ""])) : {},
      quickAnswers: p.quickAnswers ?? {},
    });
    setGeneratedStyle(p.persona.style);
    setAvatarPresetRef(p.id);
    setPresetRing(p.ring);
    setCustomizedPresetOrigin({ id: p.id, name: p.name });
    setMode("wizard");
    setStep(0);
  };

  /** The 12th card: always a blank wizard, even if a prior Customize (this open or an earlier one) left fields populated. */
  const enterCustomWizard = () => {
    resetWizardFields();
    setSelectedPresetId(null);
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

  // CLI ids the tool registry marked inactive — cards for those presets warn and can't join.
  const inactiveClis = new Set((catalog?.engines ?? []).filter((e) => e.active === false).map((e) => e.cli));
  const selectedPreset = catalog?.presets?.find((x) => x.id === selectedPresetId) ?? null;
  const selectedPresetEngine = selectedPreset
    ? catalog?.engines.find((e) => e.cli === selectedPreset.engine.cli)
    : undefined;
  const selectedPresetCliInactive = selectedPresetEngine?.active === false;

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
                onCustom={enterCustomWizard}
                onPreview={(id) => void preview(id)}
                stereotypeLabels={Object.fromEntries((catalog?.stereotypes ?? []).map((s) => [s.id, s.label]))}
                base={BASE}
                busy={busy}
                inactiveClis={inactiveClis}
              />
              {!catalog && <p className="wizard__hint">Loading the catalog…</p>}
            </div>
            {error ? (
              <p className="wizard__error">{error}</p>
            ) : (
              selectedPresetCliInactive && (
                <p className="wizard__error">
                  {selectedPresetEngine?.statusDetail ?? "This CLI is unavailable on this machine."} Customize to pick
                  an active one.
                </p>
              )
            )}
            <footer className="wizard__foot">
              <button
                type="button"
                className="settings-btn"
                disabled={!selectedPresetId || busy}
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
                disabled={!selectedPresetId || busy || selectedPresetCliInactive}
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
                  {/* The catalog-backed pickers stay controlled off `watch` + `setValue`
                      rather than `register`: each one either derives a second field (CLI
                      resets the model) or shares its value with another control (the two
                      model inputs), which an uncontrolled input can't mirror. RHF still
                      owns every value — this is the same job `Controller` does. */}
                  <label>
                    Job role
                    <select value={jobRoleId} onChange={(e) => setValue("jobRole", e.target.value)}>
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
                      value={engineCli}
                      onChange={(e) => {
                        const picked = catalog?.engines.find((x) => x.cli === e.target.value) ?? null;
                        setValue("engine", picked?.cli ?? "");
                        setValue("model", picked?.models[0] ?? "");
                      }}
                    >
                      {(catalog?.engines ?? []).map((e) => (
                        <option key={e.cli} value={e.cli} disabled={e.active === false}>
                          {e.label}
                          {e.active === false ? " — unavailable" : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Model
                    <select value={model} onChange={(e) => setValue("model", e.target.value)}>
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
                    <input
                      value={model}
                      onChange={(e) => setValue("model", e.target.value)}
                      placeholder="claude-opus"
                    />
                  </label>
                  {engine && (
                    <p className="wizard__hint">
                      {engine.warmSessions
                        ? "Supports warm sessions — this agent can hold context across turns."
                        : (engine.note ?? "Task work and steering only.")}
                    </p>
                  )}
                  {engine?.active === false && (
                    <p className="wizard__error">
                      {engine.statusDetail ?? "This CLI is unavailable on this machine."} Fix it in Settings → CLI
                      Tools.
                    </p>
                  )}
                  <label>
                    Personality
                    <select
                      value={stereotypeId}
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
                    <select {...register("language")}>
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
                    <input {...register("hint")} placeholder="veteran who has seen three failed launches" />
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
                    <input {...register("name")} placeholder="Fabian" />
                  </label>
                  <label>
                    Title
                    <input {...register("role")} placeholder="The Architect" />
                  </label>
                  <div className="wizard__genders">
                    <span>Voice gender</span>
                    {(["male", "female", "neutral"] as const).map((g) => (
                      <button
                        key={g}
                        type="button"
                        className={`sm-chip${gender === g ? " is-picked" : ""}`}
                        onClick={() => setValue("gender", g)}
                      >
                        {g}
                      </button>
                    ))}
                  </div>
                  <AvatarGeneratorBlock
                    base={BASE}
                    engine={catalog?.avatarGen ?? null}
                    name={name}
                    gender={gender}
                    role={watch("role")}
                    backstory={watch("backstory")}
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
                  <label>
                    Backstory
                    <textarea
                      {...register("backstory")}
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
                      {...register("voiceSearch")}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void loadVoices(getValues("voiceSearch"), gender);
                      }}
                      placeholder="Search the ElevenLabs catalog — latin, warm, deep…"
                    />
                  </div>
                  {voiceError && <p className="wizard__error">{voiceError}</p>}
                  <div className="voice-list">
                    {voices.map((v) => (
                      <div key={v.voiceId} className={`voice-row${voiceId === v.voiceId ? " is-picked" : ""}`}>
                        <button
                          type="button"
                          className="voice-row__pick"
                          onClick={() => setValue("voiceId", v.voiceId)}
                        >
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
                    {/* Controlled off `watch`, not `register`: picking a voice from the list
                        above has to show up in this box, which needs a re-render. */}
                    <input
                      value={voiceId}
                      onChange={(e) => setValue("voiceId", e.target.value)}
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
                      <input {...register(`reactions.${level}`)} />
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
                      <input {...register(`quickAnswers.${q.id}`)} />
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
