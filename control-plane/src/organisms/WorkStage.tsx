import { ArrowLeft, OctagonX, SendHorizontal } from "lucide-react";
import { useEffect, useState } from "react";

const POLL_MS = 2000;

interface WorkStageProps {
  /** Roster entry name being inspected (agent name or squad entry id). */
  name: string;
  ring?: string;
  onBack: () => void;
  fetchActivity: (name: string) => Promise<{ busy: boolean; label?: string; output?: string }>;
  onWorkAction: (name: string, action: "steer" | "cancel", message?: string) => Promise<string | null>;
}

/** Focused view of one working agent/squad: live output, steering, cancel. */
export function WorkStage({ name, ring, onBack, fetchActivity, onWorkAction }: WorkStageProps) {
  const [label, setLabel] = useState(name);
  const [output, setOutput] = useState("connecting to the work session…");
  const [busy, setBusy] = useState(true);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    const poll = async () => {
      try {
        const a = await fetchActivity(name);
        if (disposed) return;
        setBusy(a.busy);
        if (a.label) setLabel(a.label);
        setOutput(a.busy ? (a.output ?? "") : "work finished — nothing running.");
      } catch {
        if (!disposed) setOutput("broker unreachable.");
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [name, fetchActivity]);

  const steer = async () => {
    const message = draft.trim();
    if (!message) return;
    setDraft("");
    const error = await onWorkAction(name, "steer", message);
    setNotice(error ?? `steering sent: “${message}”`);
  };

  const cancel = async () => {
    const error = await onWorkAction(name, "cancel");
    setNotice(error ?? "work cancelled.");
    if (!error) setBusy(false);
  };

  return (
    <section
      className="stage work-stage"
      aria-label={`Work: ${name}`}
      style={ring ? ({ "--ring": ring } as React.CSSProperties) : undefined}
    >
      <header className="work-stage__header">
        <button type="button" className="work-stage__back" onClick={onBack} aria-label="Back to the meeting">
          <ArrowLeft size={15} strokeWidth={2} />
        </button>
        <h2>
          {label} <span className={busy ? "live" : "done"}>{busy ? "· working" : "· finished"}</span>
        </h2>
        {busy && (
          <button type="button" className="work-stage__cancel" onClick={() => void cancel()}>
            <OctagonX size={13} strokeWidth={2} /> cancel work
          </button>
        )}
      </header>
      <pre className="work-stage__output">{output}</pre>
      {notice && <div className="work-stage__notice">{notice}</div>}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void steer();
        }}
      >
        <input
          type="text"
          placeholder={busy ? `Steer ${label}…` : "Work is done — nothing to steer"}
          aria-label="Steering message"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={!busy}
        />
        <button
          type="button"
          className="plus"
          title="Send steering"
          aria-label="Send steering"
          onClick={() => void steer()}
        >
          <SendHorizontal strokeWidth={1.7} />
        </button>
      </form>
    </section>
  );
}
