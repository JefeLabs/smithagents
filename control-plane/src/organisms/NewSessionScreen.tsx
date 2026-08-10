import { RadioButtonGroup } from "@heroui-pro/react";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import type { BlueprintT, ExecutionMode, SessionSummary } from "../api/types";
import { FormSelect, FormTextField } from "../molecules/form";
import { useExecutionModes, useWorkspaceRecords } from "../queries/http";
import { useSessions, useWorkspaces } from "../queries/pushed";

export interface NewSessionScreenProps {
  /** Set when the caller already knows the target workspace (spec §3) — the picker becomes static text. */
  lockedWorkspace?: string;
  /** Zero-session boot: this screen is the only thing on screen, so it hides the cancel affordance. */
  forced?: boolean;
  onSend: (workspace: string, runtime: ExecutionMode, prompt: string) => Promise<{ error?: string } | undefined>;
  onCancel: () => void;
  /**
   * Present once HomePage wires document creation (Task 9). Its absence is what keeps this
   * screen chat-only and byte-identical to the pre-Task-8 markup — the kind toggle itself
   * only renders when this is set.
   */
  onCreateDocument?: (blueprintId: string, workType: string, title: string) => Promise<{ error?: string } | undefined>;
  /** Paired 1:1 with `onCreateDocument` — loads the blueprint list backing the document form. */
  listBlueprints?: () => Promise<BlueprintT[]>;
}

export const MODE_LABELS: Record<ExecutionMode, string> = {
  "local-in-process": "In process",
  "local-docker": "Local Docker",
  "remote-in-process": "Remote",
  "remote-docker": "Remote Docker",
};

const MODE_ORDER = Object.keys(MODE_LABELS) as ExecutionMode[];

// Stable empties for the pushed queries' "frame hasn't landed yet" state — same reasoning as
// HomePage's own NO_SESSIONS/NO_WORKSPACES: a fresh `[]` per render would re-run every effect
// downstream that lists one of these in its deps.
const NO_SESSIONS: SessionSummary[] = [];
const NO_WORKSPACES: string[] = [];

/** modes === null means the capability probe hasn't resolved — the only mode every machine can always run. */
function availableModes(modes: Record<ExecutionMode, boolean> | null): ExecutionMode[] {
  return modes === null ? ["local-in-process"] : MODE_ORDER.filter((m) => modes[m]);
}

/** Most recent session in `ws` whose runtime is still available, else the universal fallback. */
function defaultMode(ws: string, sessions: SessionSummary[], available: ExecutionMode[]): ExecutionMode {
  const recent = sessions
    .filter((s) => s.workspace === ws)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .find((s) => available.includes(s.runtime));
  return recent?.runtime ?? "local-in-process";
}

/**
 * Calm, centered "start a session" screen — not a modal (spec §3). This screen only ever
 * mounts while the composer is visible (see HomePage), so calling these hooks unconditionally
 * here reproduces the same "hold the probes until the composer is on screen, re-read them on
 * every reopen" contract the caller used to gate with an `enabled` flag — mount IS the gate.
 */
export function NewSessionScreen({
  lockedWorkspace,
  forced,
  onSend,
  onCancel,
  onCreateDocument,
  listBlueprints,
}: NewSessionScreenProps) {
  const { data: workspaces = NO_WORKSPACES } = useWorkspaces();
  const { data: records = null } = useWorkspaceRecords();
  const { data: sessions = NO_SESSIONS } = useSessions();
  const { data: modes = null } = useExecutionModes();

  // This screen is mounted only while the composer is open (HomePage swaps it for the
  // Outlet), so useForm's per-mount defaults ARE the reset — closing and reopening the
  // composer starts from a blank prompt with no explicit clearing.
  const { control, getValues, setValue, watch } = useForm<{
    pickedWs: string;
    mode: ExecutionMode;
    prompt: string;
    blueprintId: string;
    workType: string;
    title: string;
  }>({
    defaultValues: {
      pickedWs: lockedWorkspace ?? workspaces[0] ?? "",
      mode: defaultMode(lockedWorkspace ?? workspaces[0] ?? "", sessions, availableModes(modes)),
      prompt: "",
      blueprintId: "",
      workType: "",
      title: "",
    },
  });
  // `mode` IS watched here, unlike the old native-radio version: RadioButtonGroup is a
  // react-aria controlled component (`value`/`onChange`, not a DOM checked attribute RHF
  // can write to directly), so the checked item has to come from render, not the DOM.
  const [pickedWs, prompt, mode, blueprintId, workType, title] = watch([
    "pickedWs",
    "prompt",
    "mode",
    "blueprintId",
    "workType",
    "title",
  ]);
  const ws = lockedWorkspace ?? pickedWs;
  const available = availableModes(modes);
  // True once the user has manually chosen a mode in the radio group — blocks the
  // derivation effects below from clobbering their choice. Reset on workspace change: a
  // manual pick made for one workspace shouldn't survive into another's default (spec §3
  // default is per-workspace, "most recent session's mode in that workspace").
  const [userPickedMode, setUserPickedMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<"chat" | "document">("chat");
  const [blueprints, setBlueprints] = useState<BlueprintT[]>([]);
  const [blueprintsLoading, setBlueprintsLoading] = useState(false);

  // Recompute the default mode only when the target workspace changes — a manual pick within the
  // same workspace must stick, so `sessions`/`available` are deliberately excluded from the deps.
  // biome-ignore lint/correctness/useExhaustiveDependencies: workspace-keyed recompute, see comment above
  useEffect(() => {
    setValue("mode", defaultMode(ws, sessions, available));
    setUserPickedMode(false);
  }, [ws]);

  // `modes` starts null (the capability probe is still in flight on first open) and
  // resolves asynchronously — the initial useState above ran against `available ===
  // ["local-in-process"]` and can never see the real default. Re-derive the default once
  // `modes` actually transitions from null to a resolved record, but only that one
  // transition (not every `modes`/`ws`/`sessions` change) and only if the user hasn't
  // already made an explicit pick in the meantime.
  const prevModesRef = useRef(modes);
  useEffect(() => {
    const prevWasProbing = prevModesRef.current === null;
    prevModesRef.current = modes;
    if (prevWasProbing && modes !== null && !userPickedMode) {
      setValue("mode", defaultMode(ws, sessions, availableModes(modes)));
    }
  }, [modes, ws, sessions, userPickedMode, setValue]);

  // Loads once, guarded on the prop's presence — mirrors the workspace/session/mode
  // queries above (mount IS the gate), except this list has no cache of its own, so a
  // plain local state + effect is enough.
  useEffect(() => {
    if (!listBlueprints) return;
    let cancelled = false;
    setBlueprintsLoading(true);
    listBlueprints()
      .then((list) => {
        if (cancelled) return;
        setBlueprints(list);
        const first = list[0];
        if (first) setValue("blueprintId", first.id);
      })
      .finally(() => {
        if (!cancelled) setBlueprintsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [listBlueprints, setValue]);

  // The work-type field tracks whichever blueprint is selected — including the very first
  // auto-selection above, not just a later manual re-pick — so it derives off `blueprintId`
  // itself rather than an explicit "blueprint changed" handler on the select.
  useEffect(() => {
    const bp = blueprints.find((b) => b.id === blueprintId);
    if (bp && !bp.workTypes.includes(workType)) {
      setValue("workType", bp.workTypes[0] ?? "");
    }
  }, [blueprintId, blueprints, workType, setValue]);

  useEffect(() => {
    if (forced) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [forced, onCancel]);

  const record = records?.find((r) => r.name === ws) ?? null;
  const links = record?.links ?? [];
  const hasContext = Boolean(record?.description || links.length > 0);

  const submit = async () => {
    const text = getValues("prompt").trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    const result = await onSend(ws, getValues("mode"), text);
    setBusy(false);
    if (result?.error) setError(result.error);
  };

  const submitDocument = async () => {
    if (!onCreateDocument || busy) return;
    const { blueprintId: bpId, workType: wt, title: t } = getValues();
    const trimmedTitle = t.trim();
    if (!bpId || !wt || !trimmedTitle) return;
    setBusy(true);
    setError(null);
    const result = await onCreateDocument(bpId, wt, trimmedTitle);
    setBusy(false);
    if (result?.error) setError(result.error);
  };

  return (
    <section className="new-session-screen" aria-label="New session">
      <div className="new-session-screen__card">
        {!forced && (
          <button
            type="button"
            className="new-session-screen__cancel"
            onClick={onCancel}
            aria-label="Cancel new session"
          >
            <X size={13} strokeWidth={2} />
          </button>
        )}
        <h2 className="new-session-screen__title">Start a session</h2>
        {onCreateDocument && (
          <RadioButtonGroup
            aria-label="Session kind"
            className="new-session-screen__kind grid-cols-2"
            layout="grid"
            value={kind}
            onChange={(next) => setKind(next as "chat" | "document")}
          >
            <RadioButtonGroup.Item value="chat">
              <RadioButtonGroup.ItemContent>chat</RadioButtonGroup.ItemContent>
              <RadioButtonGroup.Indicator />
            </RadioButtonGroup.Item>
            <RadioButtonGroup.Item value="document">
              <RadioButtonGroup.ItemContent>document</RadioButtonGroup.ItemContent>
              <RadioButtonGroup.Indicator />
            </RadioButtonGroup.Item>
          </RadioButtonGroup>
        )}
        {kind === "chat" && (
          <div className="new-session-screen__workspace">
            {lockedWorkspace ? (
              <span className="new-session-screen__workspace-static">{lockedWorkspace}</span>
            ) : (
              <FormSelect
                control={control}
                name="pickedWs"
                label="Workspace"
                labelHidden
                placeholder="Choose a workspace"
                options={workspaces.map((w) => ({ id: w, label: w }))}
              />
            )}
          </div>
        )}
        {kind === "chat" ? (
          <RadioButtonGroup
            aria-label="Execution mode"
            className="new-session-screen__modes grid-cols-2"
            layout="grid"
            value={mode}
            onChange={(next) => {
              setValue("mode", next as ExecutionMode);
              setUserPickedMode(true);
            }}
          >
            {available.map((m) => (
              <RadioButtonGroup.Item
                key={m}
                value={m}
                // onPointerUp (not onClick — react-aria's RadioField/RadioButton both delete
                // any onClick prop they receive, and usePress stops propagation on its own
                // pointer handlers before they'd otherwise bubble to an ancestor listener;
                // both verified empirically against the installed source) marks the manual
                // pick: react-stately's radio-group state skips firing `onChange` when you
                // press the item that's already selected, but a press is still a deliberate
                // interaction either way — same reasoning the old per-item onClick carried
                // for native radios never firing `change` on a same-value reselect.
                onPointerUp={() => setUserPickedMode(true)}
              >
                <RadioButtonGroup.ItemContent>{MODE_LABELS[m]}</RadioButtonGroup.ItemContent>
                <RadioButtonGroup.Indicator />
              </RadioButtonGroup.Item>
            ))}
          </RadioButtonGroup>
        ) : (
          <>
            <FormSelect
              control={control}
              name="blueprintId"
              label="Blueprint"
              labelHidden
              placeholder={blueprintsLoading ? "Loading blueprints…" : "Choose a blueprint"}
              options={blueprints.map((b) => ({ id: b.id, label: b.name }))}
            />
            <FormSelect
              control={control}
              name="workType"
              label="Work type"
              labelHidden
              placeholder="Choose a work type"
              options={(blueprints.find((b) => b.id === blueprintId)?.workTypes ?? []).map((w) => ({
                id: w,
                label: w,
              }))}
            />
          </>
        )}
        {hasContext && (
          <div className="new-session-screen__context">
            {record?.description && <p className="new-session-screen__description">{record.description}</p>}
            {links.length > 0 && (
              <ul className="new-session-screen__links">
                {links.map((link) => (
                  <li key={link}>{link}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {kind === "chat" ? (
          // FormTextField has no onKeyDown passthrough (Phase 1a's adapter surface, out of
          // scope here) — the native keydown still bubbles from its inner textarea up to
          // this wrapper, so Enter-to-submit / Shift+Enter-for-newline survives unchanged.
          /* biome-ignore lint/a11y/noStaticElementInteractions: keyboard delegate for the
             textarea it wraps, not an interactive surface of its own — no independent
             keyboard path is lost, since the real keyboard target stays the textarea. */
          <div
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
          >
            <FormTextField
              control={control}
              name="prompt"
              label="Describe the task"
              labelHidden
              multiline
              rows={4}
              placeholder="What should this session work on?"
            />
          </div>
        ) : (
          <FormTextField control={control} name="title" label="Title" placeholder="Document title" />
        )}
        {error && <p className="new-session-screen__error">{error}</p>}
        {kind === "chat" ? (
          <button
            type="button"
            className="new-session-screen__send"
            onClick={() => void submit()}
            disabled={busy || !prompt.trim()}
          >
            {busy ? "starting…" : "start session"}
          </button>
        ) : (
          <button
            type="button"
            className="new-session-screen__send"
            onClick={() => void submitDocument()}
            disabled={busy || !title.trim() || !blueprintId || !workType}
          >
            {busy ? "creating…" : "create document"}
          </button>
        )}
      </div>
    </section>
  );
}
