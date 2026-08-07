import { Send, Trash2, X } from "lucide-react";
import { useState } from "react";
import type { RosterAgent } from "../hooks/useBrokerChat";
import type { WorkBoardT, WorkCardT } from "./BoardStage";

const BASE = "127.0.0.1:7790";

interface CardSheetProps {
  board: WorkBoardT;
  card: WorkCardT;
  roster: RosterAgent[];
  workspaces: string[];
  onClose: () => void;
  /** Fired after any successful mutation so the stage refetches. */
  onChanged: () => void;
}

/** Card detail: edit, Jira link/unlink, explicit Send-to-agent, delete. */
export function CardSheet({ board, card, roster, workspaces, onClose, onChanged }: CardSheetProps) {
  const [title, setTitle] = useState(card.title);
  const [notes, setNotes] = useState(card.notes ?? "");
  const [jiraKey, setJiraKey] = useState("");
  const [stories, setStories] = useState(card.stories ?? []);
  const [storyText, setStoryText] = useState("");
  const [delegating, setDelegating] = useState(false);
  const [agentId, setAgentId] = useState("");
  const [workspace, setWorkspace] = useState(workspaces[0] ?? "");
  const [prompt, setPrompt] = useState(`${card.title}${card.notes ? `\n\n${card.notes}` : ""}`);
  const [error, setError] = useState<string | null>(null);

  const cardUrl = `http://${BASE}/work/boards/${encodeURIComponent(board.id)}/cards/${encodeURIComponent(card.id)}`;
  const patch = async (body: unknown) => {
    const res = await fetch(cardUrl, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (!res?.ok) {
      setError("Update failed");
      return false;
    }
    onChanged();
    return true;
  };

  const save = async () => {
    // Stories are replaced wholesale — the whole checklist rides the single PATCH.
    if (await patch({ title, notes, stories })) onClose();
  };

  const linkJira = async () => {
    const key = jiraKey.trim().toUpperCase();
    if (!key || !board.jira) return;
    await patch({ jira: { key, url: `${board.jira.siteUrl.replace(/\/$/, "")}/browse/${key}` } });
    setJiraKey("");
  };

  const unlinkJira = async () => patch({ jira: null });

  const remove = async () => {
    const res = await fetch(cardUrl, { method: "DELETE" }).catch(() => null);
    if (res?.ok) {
      onChanged();
      onClose();
    } else setError("Delete failed");
  };

  const delegate = async () => {
    const res = (await fetch(`http://${BASE}/work/delegate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ boardId: board.id, cardId: card.id, agentId, workspace: workspace || undefined, prompt }),
    })
      .then((r) => r.json())
      .catch(() => ({ error: "Broker unreachable" }))) as { taskId?: string; error?: string };
    if (res.error) {
      setError(res.error);
      return;
    }
    onChanged();
    onClose();
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
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        Notes
        <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      <div className="card-sheet__stories">
        <span className="card-sheet__stories-head">Stories</span>
        {stories.map((s) => (
          <label
            key={s.id}
            className="card-sheet__story"
            title={s.verifiedBy ? `verified: ${s.verifiedBy}` : undefined}
          >
            <input
              type="checkbox"
              checked={s.done}
              onChange={(e) =>
                setStories((list) =>
                  list.map((x) =>
                    x.id === s.id
                      ? {
                          ...x,
                          done: e.target.checked,
                          verifiedBy: e.target.checked
                            ? (x.verifiedBy ?? `manual ${new Date().toISOString().slice(0, 10)}`)
                            : undefined,
                        }
                      : x,
                  ),
                )
              }
            />
            <span className={s.done ? "is-done" : ""}>{s.text}</span>
            <button
              type="button"
              className="card-sheet__story-remove"
              aria-label={`Remove story: ${s.text}`}
              onClick={() => setStories((list) => list.filter((x) => x.id !== s.id))}
            >
              <X size={10} strokeWidth={2} />
            </button>
          </label>
        ))}
        <input
          placeholder="Add a story…"
          value={storyText}
          onChange={(e) => setStoryText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && storyText.trim()) {
              setStories((list) => [...list, { id: crypto.randomUUID(), text: storyText.trim(), done: false }]);
              setStoryText("");
            }
          }}
        />
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
            <input placeholder="PROJ-123" value={jiraKey} onChange={(e) => setJiraKey(e.target.value)} />
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
            <select aria-label="Agent" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
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
            Workspace
            <select aria-label="Workspace" value={workspace} onChange={(e) => setWorkspace(e.target.value)}>
              {workspaces.map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
          </label>
          <label>
            Prompt
            <textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
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
