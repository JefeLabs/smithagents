import { useState } from "react";
import type { PermissionStance, Setup, WizardPermissions, WizardSaveState } from "../lib/wizardSteps";

const CAPABILITIES: Array<{ key: keyof WizardPermissions; label: string }> = [
  { key: "readFiles", label: "Read your files" },
  { key: "runCommands", label: "Run commands" },
  { key: "browseWeb", label: "Browse the web" },
];

const STANCES: Array<{ value: PermissionStance; label: string }> = [
  { value: "ask", label: "Ask first" },
  { value: "allow", label: "Go ahead" },
  { value: "never", label: "Never" },
];

const DEFAULT_PERMISSIONS: WizardPermissions = { readFiles: "ask", runCommands: "ask", browseWeb: "ask" };

export interface WizardMemoryStepProps {
  initialRemember?: boolean;
  initialDeeperRecall?: boolean;
  initialPermissions?: WizardPermissions;
  /** The real state root, shown so "where do you keep this" has an honest answer. */
  storagePath: string;
  onDone: (patch: { setup: Setup }) => void;
  onBack?: () => void;
  saveState?: WizardSaveState;
}

/**
 * The wizard's *Remembering, and what I may do* step.
 *
 * Remembering already works — `broker/src/memory.ts` recalls lexically and
 * says in its own header that it needs no embeddings at this corpus size. So
 * the spec's "your login can't do that part" download is NOT offered: the
 * preference for deeper recall is recorded, and a control appears only once
 * something can act on it.
 *
 * The storage path is shown rather than edited. Moving a live state root means
 * relocating agents, sessions, worktrees and the queue while the broker holds
 * them open — not a wizard-sized change.
 */
export function WizardMemoryStep({
  initialRemember = true,
  initialDeeperRecall = false,
  initialPermissions = DEFAULT_PERMISSIONS,
  storagePath,
  onDone,
  onBack,
  saveState = "idle",
}: WizardMemoryStepProps) {
  const [remember, setRemember] = useState(initialRemember);
  const [deeperRecall, setDeeperRecall] = useState(initialDeeperRecall);
  const [permissions, setPermissions] = useState<WizardPermissions>(initialPermissions);

  const set = (key: keyof WizardPermissions, value: PermissionStance) =>
    setPermissions((p) => ({ ...p, [key]: value }));

  return (
    <section>
      <h2>Remembering, and what I may do</h2>

      <fieldset>
        <legend>Should I remember our conversations?</legend>
        <label>
          <input type="radio" name="remember" checked={remember} onChange={() => setRemember(true)} />
          Yes, remember me
        </label>
        <label>
          <input type="radio" name="remember" checked={!remember} onChange={() => setRemember(false)} />
          Start fresh each time
        </label>
      </fieldset>

      {remember && (
        <label>
          <input type="checkbox" checked={deeperRecall} onChange={(e) => setDeeperRecall(e.target.checked)} />
          Tell me when I can recall things more deeply than by wording
        </label>
      )}

      <fieldset>
        <legend>What may I do without asking?</legend>
        {CAPABILITIES.map((cap) => (
          <fieldset key={cap.key} aria-label={cap.label}>
            <legend>{cap.label}</legend>
            {STANCES.map((s) => (
              <label key={s.value}>
                <input
                  type="radio"
                  name={cap.key}
                  checked={permissions[cap.key] === s.value}
                  onChange={() => set(cap.key, s.value)}
                />
                {s.label}
              </label>
            ))}
          </fieldset>
        ))}
      </fieldset>

      <p>
        Where I keep all this: <code>{storagePath}</code>
      </p>

      <footer>
        {onBack && (
          <button type="button" onClick={onBack} disabled={saveState === "saving"}>
            Back
          </button>
        )}
        <button
          type="button"
          disabled={saveState === "saving"}
          onClick={() => onDone({ setup: { remember, deeperRecall, permissions } })}
        >
          Continue
        </button>
      </footer>
    </section>
  );
}
