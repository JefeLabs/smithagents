import { Send, Trash2, X } from "lucide-react";
import { useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import type { RosterAgent } from "../api/types";
import * as api from "../api/work";
import { exitsForUI } from "../lib/board-aggregate";
import type { WorkBoardT, WorkCardT } from "./BoardStage";

interface CardSheetProps {
  board: WorkBoardT;
  card: WorkCardT;
  roster: RosterAgent[];
  workspaces: string[];
  onClose: () => void;
  /** Fired after any successful mutation so the stage refetches. */
  onChanged: () => void;
}

type StoryT = NonNullable<WorkCardT["stories"]>[number];

interface CardFormValues {
  title: string;
  notes: string;
  jiraKey: string;
  stories: StoryT[];
  storyText: string;
  agentId: string;
  workspace: string;
  prompt: string;
  flagReason: string;
}

/** Card detail: edit, Jira link/unlink, explicit Send-to-agent, delete. */
export function CardSheet({ board, card, roster, workspaces, onClose, onChanged }: CardSheetProps) {
  const [delegating, setDelegating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const linked = Boolean(card.capabilityRef);

  // BoardStage mounts this sheet per open card (`key={openCard.id}`), so useForm's
  // per-mount defaults ARE the seed — no reset effect is needed here.
  const { register, control, getValues, setValue, watch } = useForm<CardFormValues>({
    defaultValues: {
      title: card.title,
      notes: card.notes ?? "",
      jiraKey: "",
      stories: card.stories ?? [],
      storyText: "",
      agentId: "",
      workspace: workspaces[0] ?? "",
      prompt: `${card.title}${card.notes ? `\n\n${card.notes}` : ""}`,
      flagReason: card.flag?.reason ?? "",
    },
  });
  const { fields: stories, append, remove: removeStory, update } = useFieldArray({ control, name: "stories" });
  const [agentId, prompt, storyText] = watch(["agentId", "prompt", "storyText"]);

  const patch = async (body: unknown) => {
    try {
      await api.patchCard(board.id, card.id, body);
      onChanged();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
      return false;
    }
  };

  const save = async () => {
    // Stories are replaced wholesale — the whole checklist rides the single PATCH.
    // The flag's kind is set instantly via its own select; only its reason text
    // is edited here, and rides along with title/notes/stories on save.
    const v = getValues();
    if (
      await patch({
        title: v.title,
        notes: v.notes,
        stories: v.stories,
        flag: card.flag ? { kind: card.flag.kind, reason: v.flagReason } : undefined,
      })
    )
      onClose();
  };

  const linkJira = async () => {
    const key = getValues("jiraKey").trim().toUpperCase();
    if (!key || !board.jira) return;
    await patch({ jira: { key, url: `${board.jira.siteUrl.replace(/\/$/, "")}/browse/${key}` } });
    setValue("jiraKey", "");
  };

  const unlinkJira = async () => patch({ jira: null });

  const exits = exitsForUI(board.type, card.columnId);

  const route = async (toType: string) => {
    try {
      await api.routeCard(board.id, card.id, toType);
      onChanged();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not move the card");
    }
  };

  const setFlag = async (kind: string) => {
    // Clearing drops the reason too, so a later re-pick doesn't carry a stale one.
    const reason = getValues("flagReason");
    if (!kind) setValue("flagReason", "");
    await patch({ flag: kind ? { kind, reason } : null });
  };

  const remove = async () => {
    try {
      await api.deleteCard(board.id, card.id);
      onChanged();
      onClose();
    } catch {
      setError("Delete failed");
    }
  };

  const delegate = async () => {
    const v = getValues();
    try {
      await api.delegateCard({
        boardId: board.id,
        cardId: card.id,
        agentId: v.agentId,
        workspace: v.workspace || undefined,
        prompt: v.prompt,
      });
      onChanged();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Broker unreachable");
    }
  };

  return (
    <div className="card-sheet" role="dialog" aria-label={`Card: ${card.title}`}>
      <header className="card-sheet__head">
        <b>{card.title}</b>
        <button type="button" className="settings-btn" onClick={onClose} aria-label="Close card">
          <X size={12} strokeWidth={2} />
        </button>
      </header>
      <label>
        Title
        <input {...register("title")} />
      </label>
      <label>
        Notes
        <textarea rows={3} {...register("notes")} />
      </label>
      <div className="card-sheet__stories">
        <span className="card-sheet__stories-head">Stories</span>
        {linked && <span className="wizard__hint">Stories are managed in the map — toggle only.</span>}
        {/* `s.id` is useFieldArray's own row key, not the story's id — the real ids
            ride in the form values and reach the server untouched via getValues(). */}
        {stories.map((s, i) => (
          <label
            key={s.id}
            className="card-sheet__story"
            title={s.verifiedBy ? `verified: ${s.verifiedBy}` : undefined}
          >
            <input
              type="checkbox"
              checked={s.done}
              onChange={(e) =>
                update(i, {
                  ...getValues(`stories.${i}`),
                  done: e.target.checked,
                  verifiedBy: e.target.checked
                    ? (s.verifiedBy ?? `manual ${new Date().toISOString().slice(0, 10)}`)
                    : undefined,
                })
              }
            />
            <span className={s.done ? "is-done" : ""}>{s.text}</span>
            {!linked && (
              <button
                type="button"
                className="card-sheet__story-remove"
                aria-label={`Remove story: ${s.text}`}
                onClick={() => removeStory(i)}
              >
                <X size={10} strokeWidth={2} />
              </button>
            )}
          </label>
        ))}
        {!linked && (
          <input
            placeholder="Add a story…"
            {...register("storyText")}
            onKeyDown={(e) => {
              if (e.key === "Enter" && storyText.trim()) {
                append({ id: crypto.randomUUID(), text: storyText.trim(), done: false });
                setValue("storyText", "");
              }
            }}
          />
        )}
      </div>
      {board.jira &&
        (card.jira ? (
          <div className="card-sheet__row">
            <a href={card.jira.url} target="_blank" rel="noreferrer">
              {card.jira.key}
            </a>
            {card.jira.lastPushError && <span className="wizard__error">push failed: {card.jira.lastPushError}</span>}
            <button type="button" className="settings-btn" onClick={() => void unlinkJira()}>
              unlink jira
            </button>
          </div>
        ) : (
          <div className="card-sheet__row">
            <input placeholder="PROJ-123" {...register("jiraKey")} />
            <button type="button" className="settings-btn" onClick={() => void linkJira()}>
              link jira
            </button>
          </div>
        ))}
      {!card.delegation && (
        <button type="button" className="settings-btn" onClick={() => setDelegating((v) => !v)}>
          <Send size={12} strokeWidth={2} /> send to agent
        </button>
      )}
      {delegating && (
        <div className="card-sheet__delegate">
          <label>
            Agent
            <select aria-label="Agent" {...register("agentId")}>
              <option value="">— pick an agent —</option>
              {roster
                .filter((a) => !a.members)
                .map((a) => (
                  <option key={a.id} value={a.id} disabled={a.status === "busy"}>
                    {a.name}
                    {a.status === "busy" ? " — busy" : ""}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Delegate to workspace
            <select aria-label="Delegate to workspace" {...register("workspace")}>
              {workspaces.map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
          </label>
          <label>
            Prompt
            <textarea rows={4} {...register("prompt")} />
          </label>
          <button
            type="button"
            className="settings-btn settings-btn--primary"
            disabled={!agentId || !prompt.trim()}
            onClick={() => void delegate()}
          >
            delegate
          </button>
        </div>
      )}
      <div className="card-sheet__row">
        <label>
          Flag
          <select aria-label="Flag" value={card.flag?.kind ?? ""} onChange={(e) => void setFlag(e.target.value)}>
            <option value="">— none —</option>
            <option value="blocked">Blocked</option>
            <option value="at-risk">At risk</option>
            <option value="waiting">Waiting</option>
          </select>
        </label>
        {card.flag && <input placeholder="Why?" {...register("flagReason")} />}
      </div>
      {exits.length > 0 && (
        <div className="card-sheet__routes">
          {exits.map((e) => (
            <button key={e.label} type="button" className="settings-btn" onClick={() => void route(e.toType)}>
              {e.label}
            </button>
          ))}
        </div>
      )}
      {error && <p className="wizard__error">{error}</p>}
      <footer className="card-sheet__foot">
        <button type="button" className="settings-btn" onClick={() => void remove()}>
          <Trash2 size={12} strokeWidth={2} /> delete card
        </button>
        <button type="button" className="settings-btn settings-btn--primary" onClick={() => void save()}>
          save
        </button>
      </footer>
    </div>
  );
}
