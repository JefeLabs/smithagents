import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import * as api from "../api/broker";
import type { ContextSourceT } from "../api/types";
import { BOARD_ROUTES_UI } from "../lib/board-aggregate";
import { FormTextField, ModalShell } from "../molecules/form";
import { useSaveWorkspace, useWorkspaceRecords } from "../queries/http";
import { useUpdateBoard } from "../queries/work";
import type { WorkBoardT } from "./BoardStage";

interface QueueSourcesSheetProps {
  board: WorkBoardT;
  open: boolean;
  onClose: () => void;
}

// The product presets, used only until /work-kinds answers (and if it never
// does). Without a fallback a failed fetch would render an empty select,
// which reads as "this workspace has no sources" rather than "the server is
// down".
const FALLBACK_PRESETS: Array<{ id: string; label: string; cadence: ContextSourceT["cadence"] }> = [
  { id: "jira", label: "Jira", cadence: "nightly" },
  { id: "releases", label: "Releases", cadence: "nightly" },
  { id: "observability", label: "Observability", cadence: "hourly" },
  { id: "support", label: "Support", cadence: "6h" },
  { id: "custom", label: "Custom", cadence: "nightly" },
];

const CADENCES: Array<{ id: ContextSourceT["cadence"]; label: string }> = [
  { id: "hourly", label: "Hourly" },
  { id: "6h", label: "Every 6 hours" },
  { id: "nightly", label: "Nightly" },
];

interface AddSourceFormValues {
  preset: ContextSourceT["preset"];
  name: string;
  url: string;
  query: string;
  connectorId: string;
  cadence: ContextSourceT["cadence"];
  prompt: string;
}

const blankForm = (): AddSourceFormValues => ({
  preset: "jira",
  name: "",
  url: "",
  query: "",
  connectorId: "",
  cadence: "nightly",
  prompt: "",
});

/** Non-blank after trimming. */
const filled = (v: string) => v.trim().length > 0;

/** lowercase, non-alnum runs collapse to one "-"; a colliding slug gets "-2", "-3"… appended. */
export function sourceIdFor(name: string, existing: ContextSourceT[]): string {
  const base =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "source";
  const ids = new Set(existing.map((s) => s.id));
  if (!ids.has(base)) return base;
  let n = 2;
  while (ids.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * The queue-sources config surface the edge-column gear opens on the intake
 * column (spec 2026-08-13 queue-sources-terminal-effects). Bindings toggle
 * which of the workspace's sources feed this board; sources themselves are
 * owned by the workspace record, not the board, so adding one saves the
 * whole record (Task 12's `useSaveWorkspace`, this sheet its first caller).
 */
export function QueueSourcesSheet({ board, open, onClose }: QueueSourcesSheetProps) {
  const { data: records = [] } = useWorkspaceRecords(open);
  const record = records.find((r) => r.name === board.workspaceId);
  const updateBoard = useUpdateBoard();
  const save = useSaveWorkspace();
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [presets, setPresets] = useState(FALLBACK_PRESETS);

  useEffect(() => {
    let live = true;
    api
      .getWorkKinds()
      .then((r) => {
        if (!live) return;
        const byId = new Map<string, { id: string; label: string; cadence: ContextSourceT["cadence"] }>();
        for (const kind of r.kinds) for (const p of kind.presets) byId.set(p.id, p);
        byId.set("custom", { id: "custom", label: "Custom", cadence: "nightly" });
        setPresets([...byId.values()]);
      })
      .catch(() => {
        /* keep the fallback — an unreachable server must not empty the select */
      });
    return () => {
      live = false;
    };
  }, []);

  const {
    control,
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { isValid },
  } = useForm<AddSourceFormValues>({ mode: "onChange", defaultValues: blankForm() });
  const preset = watch("preset");
  const presetField = register("preset");

  const boundIds = board.queue?.sourceIds ?? [];

  const toggle = async (source: ContextSourceT, checked: boolean) => {
    const next = checked ? [...boundIds, source.id] : boundIds.filter((id) => id !== source.id);
    try {
      await updateBoard.mutateAsync({ boardId: board.id, body: { queue: { sourceIds: next } } });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update queue sources");
    }
  };

  const onCreate = handleSubmit(async (values) => {
    if (!record) return;
    const row: ContextSourceT = {
      id: sourceIdFor(values.name, record.sources ?? []),
      name: values.name.trim(),
      preset: values.preset,
      origin: {
        connectorId: values.connectorId.trim() || undefined,
        url: values.url.trim() || undefined,
        query: values.query.trim() || undefined,
      },
      cadence: values.cadence,
      transform:
        values.preset === "jira" ? { mode: "map" } : { mode: "analyze", prompt: values.prompt.trim() || undefined },
      enabled: true,
    };
    const result = await save
      .mutateAsync({ body: { ...record, sources: [...(record.sources ?? []), row] }, isNew: false })
      .catch((err: unknown): { error?: string } => ({ error: err instanceof Error ? err.message : String(err) }));
    if (result.error) {
      setError(result.error);
      return;
    }
    setError(null);
    reset(blankForm());
    setAdding(false);
  });

  const arrivals = Object.entries(BOARD_ROUTES_UI).flatMap(([fromType, exits]) =>
    exits.filter((e) => e.toType === board.type).map((e) => `${fromType} · ${e.label}`),
  );

  return (
    <ModalShell open={open} onClose={onClose} title={`${board.name} · queue sources`}>
      {!board.workspaceId ? (
        <p className="wizard__hint">Personal boards have no context sources.</p>
      ) : (
        <>
          <div className="q-sheet__sources">
            {(record?.sources ?? []).map((s) => (
              <label key={s.id} className="q-sheet__source">
                <input
                  type="checkbox"
                  checked={boundIds.includes(s.id)}
                  disabled={updateBoard.isPending}
                  onChange={(e) => void toggle(s, e.target.checked)}
                />{" "}
                {s.name} <span className="q-sheet__preset">{s.preset}</span>
              </label>
            ))}
            {(record?.sources ?? []).length === 0 && <p className="wizard__hint">No sources yet.</p>}
          </div>

          {adding && (
            <div className="q-sheet__add">
              <label>
                Preset
                <select
                  aria-label="Preset"
                  name={presetField.name}
                  ref={presetField.ref}
                  onBlur={presetField.onBlur}
                  onChange={(e) => {
                    void presetField.onChange(e);
                    setValue("cadence", presets.find((p) => p.id === e.target.value)?.cadence ?? "nightly");
                  }}
                >
                  {presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              <FormTextField
                control={control}
                name="name"
                label="Name"
                placeholder="Support inbox"
                rules={{ validate: filled }}
              />
              <FormTextField
                control={control}
                name="url"
                label="URL"
                placeholder="https://…"
                rules={{ validate: filled }}
              />
              <FormTextField control={control} name="query" label="Query" placeholder="project = PROJ" />
              <FormTextField control={control} name="connectorId" label="Connector ID" />
              <label>
                Cadence
                <select aria-label="Cadence" {...register("cadence")}>
                  {CADENCES.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
              {/* map-transform presets (jira) never prompt an analyze pass — hidden, not
                  unmounted, so a prompt typed before switching presets survives switching back. */}
              <div hidden={preset === "jira"}>
                <FormTextField control={control} name="prompt" label="Analyze prompt" multiline rows={3} />
              </div>
              <button
                type="button"
                className="settings-btn settings-btn--primary"
                disabled={!isValid || save.isPending}
                onClick={() => void onCreate()}
              >
                create source
              </button>
            </div>
          )}
          <button type="button" className="settings-btn" onClick={() => setAdding((v) => !v)}>
            add source
          </button>

          {arrivals.length > 0 && (
            <div className="q-sheet__arrivals">
              <span className="q-sheet__arrivals-head">Cards also arrive from</span>
              {/* v1 renders the static route table only — a board's OWN inbound terminal
                  effects (another board's routed exit) are not cross-referenced here yet. */}
              {/* Undecorated <p>s inherit q-sheet__arrivals's font-size/color —
                  wizard__hint would pin its own 11px over that. */}
              {arrivals.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          )}

          {error && <p className="wizard__error">{error}</p>}
        </>
      )}
    </ModalShell>
  );
}
