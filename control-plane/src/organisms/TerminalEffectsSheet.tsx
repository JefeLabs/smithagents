import { X } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import type { TerminalEffectT } from "../api/types";
import { BOARD_ROUTES_UI, BOARD_TYPE_LABELS_UI, BOARD_TYPE_ORDER_UI } from "../lib/board-aggregate";
import { FormTextField, ModalShell } from "../molecules/form";
import { useUpdateBoard } from "../queries/work";
import type { WorkBoardT } from "./BoardStage";

interface TerminalEffectsSheetProps {
  board: WorkBoardT;
  open: boolean;
  onClose: () => void;
}

/**
 * Board types that actually appear as a route `toType` somewhere in
 * BOARD_ROUTES_UI — release and reactive never appear as a target, only as
 * a source, so offering them would be a dead end the swarm always refuses.
 */
const ROUTE_TARGET_TYPES = new Set(Object.values(BOARD_ROUTES_UI).flatMap((exits) => exits.map((e) => e.toType)));

interface AddEffectFormValues {
  kind: TerminalEffectT["kind"];
  connectorId: string;
  projectKey: string;
  toType: string;
  toColumn: string;
}

const blankForm = (defaultToType: string): AddEffectFormValues => ({
  kind: "publish-jira",
  connectorId: "",
  projectKey: "",
  toType: defaultToType,
  toColumn: "",
});

/** Non-blank after trimming. */
const filled = (v: string) => v.trim().length > 0;

/** The row text's target half, and the remove button's aria-label target — same string, one source. */
function targetFor(effect: TerminalEffectT): string {
  return effect.kind === "route"
    ? `${effect.toType}/${effect.toColumn}`
    : `${effect.projectKey} (${effect.connectorId})`;
}

/**
 * The terminal-effects config surface the edge-column gear opens on the
 * completion column (spec 2026-08-13 queue-sources-terminal-effects): which
 * column counts as "done" for this board, and what fires when a card lands
 * there. Mirrors QueueSourcesSheet's shape and the same `useUpdateBoard`
 * full-block-write convention.
 */
export function TerminalEffectsSheet({ board, open, onClose }: TerminalEffectsSheetProps) {
  const update = useUpdateBoard();
  const [error, setError] = useState<string | null>(null);

  const effects = board.terminal?.effects ?? [];
  const columnId = board.terminal?.columnId ?? board.columns[board.columns.length - 1]?.id;
  // Self-routing is refused server-side with an error entry — the UI must not offer it.
  const toTypeOptions = BOARD_TYPE_ORDER_UI.filter((t) => ROUTE_TARGET_TYPES.has(t) && t !== board.type);

  const { control, register, watch, getValues, reset } = useForm<AddEffectFormValues>({
    mode: "onChange",
    defaultValues: blankForm(toTypeOptions[0] ?? ""),
  });
  const kind = watch("kind");
  const connectorId = watch("connectorId");
  const projectKey = watch("projectKey");
  const toType = watch("toType");
  const toColumn = watch("toColumn");
  const canAdd =
    kind === "publish-jira" ? filled(connectorId) && filled(projectKey) : filled(toType) && filled(toColumn);

  const patchColumn = async (nextColumnId: string) => {
    try {
      await update.mutateAsync({ boardId: board.id, body: { terminal: { columnId: nextColumnId, effects } } });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update the terminal column");
    }
  };

  // Omits columnId when the board never had one set — a mutation that isn't
  // itself changing the column must not stamp today's default in, or the
  // default stops tracking board.columns as columns are added/removed later.
  const patchEffects = async (next: TerminalEffectT[]) => {
    try {
      await update.mutateAsync({
        boardId: board.id,
        body: {
          terminal: { ...(board.terminal?.columnId ? { columnId: board.terminal.columnId } : {}), effects: next },
        },
      });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update completion effects");
    }
  };

  const removeEffect = (index: number) => void patchEffects(effects.filter((_, i) => i !== index));

  const addEffect = () => {
    const values = getValues();
    const next: TerminalEffectT =
      values.kind === "publish-jira"
        ? { kind: "publish-jira", connectorId: values.connectorId.trim(), projectKey: values.projectKey.trim() }
        : { kind: "route", toType: values.toType, toColumn: values.toColumn.trim() };
    void patchEffects([...effects, next]);
    reset(blankForm(toTypeOptions[0] ?? ""));
  };

  return (
    <ModalShell open={open} onClose={onClose} title={`${board.name} · completion effects`}>
      <label>
        Terminal column
        <select
          aria-label="Terminal column"
          value={columnId}
          onChange={(e) => void patchColumn(e.target.value)}
          disabled={update.isPending}
        >
          {board.columns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>

      <div className="q-sheet__sources">
        {effects.map((effect, i) => {
          const target = targetFor(effect);
          return (
            <div key={`${effect.kind}:${target}`} className="card-sheet__story">
              <span>
                {effect.kind} → {target}
              </span>
              <button
                type="button"
                className="card-sheet__story-remove"
                aria-label={`Remove ${effect.kind} to ${target}`}
                disabled={update.isPending}
                onClick={() => removeEffect(i)}
              >
                <X size={10} strokeWidth={2} />
              </button>
            </div>
          );
        })}
        {effects.length === 0 && <p className="wizard__hint">No completion effects yet.</p>}
      </div>

      <div className="q-sheet__add">
        <label>
          Effect kind
          <select aria-label="Effect kind" {...register("kind")}>
            <option value="publish-jira">Publish to Jira</option>
            <option value="route">Route to board</option>
          </select>
        </label>
        {/* Hidden, not unmounted, so a value typed before switching kinds survives switching back. */}
        <div hidden={kind !== "publish-jira"}>
          <FormTextField control={control} name="connectorId" label="Connector" />
          <FormTextField control={control} name="projectKey" label="Project key" />
        </div>
        <div hidden={kind !== "route"}>
          <label>
            To type
            <select aria-label="To type" {...register("toType")}>
              {toTypeOptions.map((t) => (
                <option key={t} value={t}>
                  {BOARD_TYPE_LABELS_UI[t]}
                </option>
              ))}
            </select>
          </label>
          <FormTextField control={control} name="toColumn" label="To column" placeholder="queue" />
        </div>
        <button
          type="button"
          className="settings-btn settings-btn--primary"
          disabled={!canAdd || update.isPending}
          onClick={addEffect}
        >
          add effect
        </button>
      </div>

      {error && <p className="wizard__error">{error}</p>}
    </ModalShell>
  );
}
