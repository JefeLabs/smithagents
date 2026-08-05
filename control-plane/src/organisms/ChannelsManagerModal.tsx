import { Plus, X } from "lucide-react";
import type { MouseEvent } from "react";
import { useEffect, useState } from "react";
import type { ChannelsRecord, WorkspaceRecord } from "../hooks/useBrokerChat";

interface ChannelsManagerModalProps {
  open: boolean;
  onClose: () => void;
  listWorkspaces: () => Promise<WorkspaceRecord[]>;
  getChannels: (name: string) => Promise<ChannelsRecord>;
  saveChannels: (
    name: string,
    body: { discord?: { botToken: string; textChannels: string[]; voiceChannels: string[] } },
  ) => Promise<ChannelsRecord & { error?: string }>;
  verifyDiscord: (name: string) => Promise<{ ok?: boolean; detail?: string; error?: string }>;
}

interface FormState {
  hasDiscordToken: boolean;
  botToken: string; // cleared to "" on every load — never round-tripped
  textChannels: string[];
  voiceChannels: string[];
}

const blankForm = (): FormState => ({ hasDiscordToken: false, botToken: "", textChannels: [""], voiceChannels: [""] });

/** Discord (and future channel-type) config — its own area, separate from the workspace connector form. */
export function ChannelsManagerModal({
  open,
  onClose,
  listWorkspaces,
  getChannels,
  saveChannels,
  verifyDiscord,
}: ChannelsManagerModalProps) {
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(blankForm());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const [testing, setTesting] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: only re-fetch when the panel opens
  useEffect(() => {
    if (!open) return;
    setSelected(null);
    setForm(blankForm());
    setError(null);
    setTestResult(null);
    setLoadError(null);
    void listWorkspaces().then(setWorkspaces, (err: unknown) =>
      setLoadError(`Could not load workspaces — ${String(err)}`),
    );
  }, [open]);

  if (!open) return null;

  const selectWorkspace = (name: string) => {
    setSelected(name);
    setError(null);
    setTestResult(null);
    // Always keep at least one empty row per list — same convention as
    // WorkspaceManagerModal's repos — so there's somewhere to type a first
    // channel id into rather than requiring an extra "+ channel" click.
    void getChannels(name).then((c) =>
      setForm({
        hasDiscordToken: c.hasDiscordToken,
        botToken: "",
        textChannels: c.textChannels.length ? c.textChannels : [""],
        voiceChannels: c.voiceChannels.length ? c.voiceChannels : [""],
      }),
    );
  };

  const submit = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    // No botToken typed and nothing saved yet -> omit discord entirely rather
    // than persist an empty-token block (same "don't send what wasn't
    // touched" discipline AccountPanel already applies to its own secrets).
    const discord =
      form.botToken.trim() || form.hasDiscordToken
        ? {
            botToken: form.botToken.trim(),
            textChannels: form.textChannels.filter(Boolean),
            voiceChannels: form.voiceChannels.filter(Boolean),
          }
        : undefined;
    const result = await saveChannels(selected, { discord }).catch((err: unknown): { error?: string } => ({
      error: String(err),
    }));
    setBusy(false);
    if ("error" in result && result.error) {
      setError(result.error);
      return;
    }
    setForm((f) => ({ ...f, hasDiscordToken: (result as ChannelsRecord).hasDiscordToken, botToken: "" }));
  };

  const testDiscord = async () => {
    if (!selected) return;
    setTesting(true);
    const r = await verifyDiscord(selected);
    setTesting(false);
    setTestResult({ ok: Boolean(r.ok), detail: r.detail ?? r.error ?? "unknown" });
  };

  const updateList = (key: "textChannels" | "voiceChannels", index: number, value: string) => {
    setForm((f) => ({ ...f, [key]: f[key].map((v, i) => (i === index ? value : v)) }));
  };
  const addToList = (key: "textChannels" | "voiceChannels") => setForm((f) => ({ ...f, [key]: [...f[key], ""] }));
  const removeFromList = (key: "textChannels" | "voiceChannels", index: number) =>
    setForm((f) => ({ ...f, [key]: f[key].filter((_, i) => i !== index) }));

  const onScrimClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: click-outside dismiss, same pattern as WorkspaceManagerModal/AccountPanel
    <div
      className="scrim"
      data-open="true"
      role="dialog"
      aria-modal="true"
      aria-label="Manage channels"
      onClick={onScrimClick}
    >
      <section className="workspace-manager">
        <header className="workspace-manager__head">
          <h2>channels</h2>
          <button type="button" className="sessions-panel__close" onClick={onClose} aria-label="Close channels manager">
            <X size={13} strokeWidth={2} />
          </button>
        </header>
        {loadError && <p className="wizard__error">{loadError}</p>}
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
                <span className="wizard__hint">
                  Discord {form.hasDiscordToken ? "— token saved" : "— not connected"}
                </span>
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
                  <button type="button" className="settings-btn" onClick={() => void testDiscord()} disabled={testing}>
                    {testing ? "testing…" : "Test connection"}
                  </button>
                )}
                {testResult && <p className={testResult.ok ? "wizard__hint" : "wizard__error"}>{testResult.detail}</p>}

                {error && <p className="wizard__error">{error}</p>}

                <button
                  type="button"
                  className="settings-btn settings-btn--primary settings-btn--wide"
                  onClick={() => void submit()}
                  disabled={busy}
                >
                  {busy ? "saving…" : "save"}
                </button>
              </>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
