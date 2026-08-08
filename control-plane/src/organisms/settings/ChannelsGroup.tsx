import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { ChannelsRecord } from "../../api/types";
import {
  useSaveWorkspaceChannels,
  useVerifyWorkspaceDiscord,
  useWorkspaceChannels,
  useWorkspaceRecords,
} from "../../queries/http";

interface FormState {
  hasDiscordToken: boolean;
  botToken: string;
  textChannels: string[];
  voiceChannels: string[];
}

const blankForm = (): FormState => ({ hasDiscordToken: false, botToken: "", textChannels: [""], voiceChannels: [""] });

/** Discord channel config, as a Settings group — same behavior as when this lived in its own standalone modal, just re-parented. */
export function ChannelsGroup() {
  const { data: workspaces = [], error: loadError } = useWorkspaceRecords();
  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(blankForm());
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);

  // Only fetches once a workspace is actually picked — `selected` starts null, and the query
  // key would otherwise be a meaningless empty-name request.
  const { data: channels } = useWorkspaceChannels(selected ?? "", selected !== null);
  const saveChannels = useSaveWorkspaceChannels();
  const verifyDiscord = useVerifyWorkspaceDiscord();

  // Reinitializes the editable form whenever the selected workspace's channel config arrives —
  // mirrors the old imperative `getChannels(name).then(setForm)`.
  useEffect(() => {
    if (channels) {
      setForm({
        hasDiscordToken: channels.hasDiscordToken,
        botToken: "",
        textChannels: channels.textChannels.length ? channels.textChannels : [""],
        voiceChannels: channels.voiceChannels.length ? channels.voiceChannels : [""],
      });
    }
  }, [channels]);

  const selectWorkspace = (name: string) => {
    setSelected(name);
    setError(null);
    setTestResult(null);
  };

  const submit = async () => {
    if (!selected) return;
    setError(null);
    const discord =
      form.botToken.trim() || form.hasDiscordToken
        ? {
            botToken: form.botToken.trim(),
            textChannels: form.textChannels.filter(Boolean),
            voiceChannels: form.voiceChannels.filter(Boolean),
          }
        : undefined;
    const result = await saveChannels
      .mutateAsync({ name: selected, body: { discord } })
      .catch((err: unknown): { error?: string } => ({ error: String(err) }));
    if ("error" in result && result.error) {
      setError(result.error);
      return;
    }
    setForm((f) => ({ ...f, hasDiscordToken: (result as ChannelsRecord).hasDiscordToken, botToken: "" }));
  };

  const testDiscord = async () => {
    if (!selected) return;
    const r = await verifyDiscord.mutateAsync(selected);
    setTestResult({ ok: Boolean(r.ok), detail: r.detail ?? r.error ?? "unknown" });
  };

  const updateList = (key: "textChannels" | "voiceChannels", index: number, value: string) => {
    setForm((f) => ({ ...f, [key]: f[key].map((v, i) => (i === index ? value : v)) }));
  };
  const addToList = (key: "textChannels" | "voiceChannels") => setForm((f) => ({ ...f, [key]: [...f[key], ""] }));
  const removeFromList = (key: "textChannels" | "voiceChannels", index: number) =>
    setForm((f) => ({ ...f, [key]: f[key].filter((_, i) => i !== index) }));

  return (
    <>
      <h1>channels</h1>
      {loadError && <p className="wizard__error">Could not load workspaces — {String(loadError)}</p>}
      <div className="workspace-manager__body">
        <div className="workspace-manager__list">
          {workspaces.map((ws) => (
            <div key={ws.name} className={`workspace-row${selected === ws.name ? " workspace-row--active" : ""}`}>
              <button type="button" className="workspace-row__pick" onClick={() => selectWorkspace(ws.name)}>
                <span className="workspace-row__name">{ws.name}</span>
              </button>
            </div>
          ))}
          {workspaces.length === 0 && <p className="wizard__hint">No workspaces yet — create one first.</p>}
        </div>
        <div className="account-panel__form">
          {!selected && <p className="wizard__hint">Pick a workspace to configure its Discord channels.</p>}
          {selected && (
            <>
              <span className="wizard__hint">Discord {form.hasDiscordToken ? "— token saved" : "— not connected"}</span>
              <input
                type="password"
                value={form.botToken}
                onChange={(e) => setForm((f) => ({ ...f, botToken: e.target.value }))}
                placeholder="Discord bot token"
              />

              <span className="wizard__hint">Text channels</span>
              {form.textChannels.map((id, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity until saved; only appended/removed at the ends
                <div key={i} className="repo-row">
                  <input
                    value={id}
                    onChange={(e) => updateList("textChannels", i, e.target.value)}
                    placeholder="Text channel id"
                  />
                  <button
                    type="button"
                    className="repo-row__remove"
                    onClick={() => removeFromList("textChannels", i)}
                    aria-label="Remove text channel"
                  >
                    <X size={12} strokeWidth={2} />
                  </button>
                </div>
              ))}
              <button type="button" className="settings-btn" onClick={() => addToList("textChannels")}>
                <Plus size={11} strokeWidth={2.2} /> text channel
              </button>

              <span className="wizard__hint">Voice channels</span>
              {form.voiceChannels.map((id, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity until saved; only appended/removed at the ends
                <div key={i} className="repo-row">
                  <input
                    value={id}
                    onChange={(e) => updateList("voiceChannels", i, e.target.value)}
                    placeholder="Voice channel id"
                  />
                  <button
                    type="button"
                    className="repo-row__remove"
                    onClick={() => removeFromList("voiceChannels", i)}
                    aria-label="Remove voice channel"
                  >
                    <X size={12} strokeWidth={2} />
                  </button>
                </div>
              ))}
              <button type="button" className="settings-btn" onClick={() => addToList("voiceChannels")}>
                <Plus size={11} strokeWidth={2.2} /> voice channel
              </button>

              {form.hasDiscordToken && (
                <button
                  type="button"
                  className="settings-btn"
                  onClick={() => void testDiscord()}
                  disabled={verifyDiscord.isPending}
                >
                  {verifyDiscord.isPending ? "testing…" : "Test connection"}
                </button>
              )}
              {testResult && <p className={testResult.ok ? "wizard__hint" : "wizard__error"}>{testResult.detail}</p>}
              {error && <p className="wizard__error">{error}</p>}

              <button
                type="button"
                className="settings-btn settings-btn--primary settings-btn--wide"
                onClick={() => void submit()}
                disabled={saveChannels.isPending}
              >
                {saveChannels.isPending ? "saving…" : "save"}
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}
