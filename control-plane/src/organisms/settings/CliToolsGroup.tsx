import { RefreshCw } from "lucide-react";
import { useState } from "react";
import type { CliToolListing } from "../../api/types";
import { ConnectorCard } from "../../molecules/ConnectorCard";
import { useCliTools, useRefreshCliTools, useSetCliToolEnabled } from "../../queries/http";

/** Status pill precedence: reality before preference (spec §6). Exported for tests. */
export function pillFor(t: CliToolListing): { label: string; cls: string } {
  if (!t.status) return { label: "not checked", cls: "connector-status--unconnected" };
  if (!t.status.detected) return { label: "not installed", cls: "connector-status--unconnected" };
  if (t.status.authOk === false) return { label: "needs login", cls: "connector-status--unconnected" };
  if (!t.status.enabled) return { label: "disabled", cls: "connector-status--unconnected" };
  return { label: "active", cls: "connector-status--connected" };
}

/** The next concrete step for an inactive tool. Exported for direct testing, same as `pillFor`. */
export interface ToolGuidance {
  /** Short instruction line — additive to the detail already shown beside the pill, not a repeat of it. */
  note: string;
  /** An exact, copyable command — only ever sourced from the probe's own `detail`, never invented. */
  code?: string;
}

/** The backtick-quoted substring of a driver's `detail`, e.g. "codex login" out of "not logged in — run `codex login`". */
function extractCommand(detail: string): string | undefined {
  return detail.match(/`([^`]+)`/)?.[1];
}

/**
 * Class-aware next step for an inactive tool (spec: name the right problem
 * instead of one collapsed "unavailable") — keyed on `CliToolStatusRecord`'s
 * `failure` (Task 1, mirroring swarm's `AuthFailure`). Returns `null` for
 * anything without a CONFIRMED failure: absent status or `authOk ===
 * "unknown"` is ACTIVE, never inactive (cli-tools.ts's own isActive/gate
 * rule — block only confirmed negatives), so those keep today's rendering
 * unchanged, exactly as the spec's class table requires.
 *
 * `missing` and `billing` name the problem and stop — no link. A prior draft
 * linked out to a search query (no real install/billing URL is sourced
 * anywhere in this codebase — see swarm/src/config.ts's DEFAULT_AGENT_COMMANDS,
 * binary only), but Edwin ruled it out: a search link reads unfinished sitting
 * beside `unauthenticated`'s genuinely precise, copyable command, and the two
 * rows should not look unequal. Curating five vendors' install commands by
 * hand was the alternative, and it buys a table that rots silently. So this
 * under-delivers on the spec's "hand over the exact command" for `missing`,
 * knowingly — the re-check button (always rendered, one level up) is the rest
 * of the answer.
 *
 * `billing` and `policy` are exercised only by hand-built test fixtures
 * today — no driver in this codebase sets them (cli-tools.ts's own doc
 * comment) — but the guidance has to be right if/when a probe starts
 * populating them.
 */
export function guidanceFor(t: CliToolListing): ToolGuidance | null {
  const status = t.status;
  if (!status?.failure) return null;
  const detail = status.detail;
  switch (status.failure) {
    case "missing":
      return { note: `Install ${t.cli}, then re-check.` };
    case "unauthenticated": {
      const code = extractCommand(detail);
      return code ? { note: "Run this, then re-check.", code } : { note: detail || "Not logged in." };
    }
    case "billing":
      // `detail` is already shown above, next to the pill — the note here is
      // additive (why to look, not a repeat of what it already said).
      return { note: "There may be a billing issue with this subscription." };
    case "policy":
      // No generic fix for a policy block — the detail prose above (next to
      // the pill) is the whole answer; this says so rather than echoing it.
      return { note: "No generic fix for this — see the reason above." };
    default:
      return null;
  }
}

/** Best-effort — jsdom/older browsers may have no Clipboard API at all; never throw over it. */
function copyToClipboard(text: string) {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText)
    void navigator.clipboard.writeText(text).catch(() => {});
}

/** The fix-it block a `guidanceFor` result renders as, or nothing for an active/unknown tool. */
function ToolGuidanceBlock({ guidance }: { guidance: ToolGuidance | null }) {
  if (!guidance) return null;
  const code = guidance.code; // narrowed to `string` once, so the closure below needs no assertion
  return (
    <div className="connector-guidance">
      <p className="wizard__hint">{guidance.note}</p>
      {code && (
        <div className="connector-instance">
          <code className="connector-guidance__code">{code}</code>
          <button type="button" className="settings-btn" onClick={() => copyToClipboard(code)}>
            copy
          </button>
        </div>
      )}
    </div>
  );
}

export interface CliToolsGroupProps {
  /**
   * The group's own title tag. Defaults to `"h1"` — correct in Settings,
   * where `SettingsPanel` shows one group at a time under no heading of its
   * own, so this is the page's only `<h1>`. A host that already owns the
   * page's `<h1>` (the welcome wizard, which also renders a SECOND group
   * beside this one) passes `"h2"` instead, rather than this component
   * guessing its own depth. Purely the document outline: no styling here
   * keys off the tag, and Settings' own `.settings-screen__content h1` rule
   * is untouched.
   */
  headingLevel?: "h1" | "h2";
}

/** Card grid, one per catalog engine — machine status, refresh probes, and the opt-out toggle. */
export function CliToolsGroup({ headingLevel: Heading = "h1" }: CliToolsGroupProps = {}) {
  const { data: tools = [], error: loadError } = useCliTools();
  const refreshTools = useRefreshCliTools();
  const setEnabled = useSetCliToolEnabled();
  const [busy, setBusy] = useState<string | null>(null); // cli being refreshed, "*" = all
  const [error, setError] = useState<string | null>(null);

  const displayError = error ?? (loadError ? `Could not load CLI tools — ${String(loadError)}` : null);

  const refresh = async (tool?: string) => {
    setBusy(tool ?? "*");
    setError(null);
    try {
      await refreshTools.mutateAsync(tool);
    } catch (err) {
      setError(`Refresh failed — ${String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (t: CliToolListing) => {
    const result = await setEnabled.mutateAsync({ id: t.cli, enabled: !(t.status?.enabled ?? true) });
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setError(null);
  };

  return (
    <>
      <Heading className="settings-group__title">cli tools</Heading>
      <p className="wizard__hint">
        Agent CLI tools detected on this machine. Only active tools can be assigned to agents; an agent whose tool goes
        dark is flagged in the rail and blocked from launching.
      </p>
      {displayError && <p className="wizard__error">{displayError}</p>}
      <button type="button" className="settings-btn" onClick={() => void refresh()} disabled={busy !== null}>
        <RefreshCw size={12} strokeWidth={2} /> {busy === "*" ? "checking…" : "refresh all"}
      </button>
      <div className="connector-grid">
        {tools.map((t) => (
          <ConnectorCard
            key={t.cli}
            label={t.label}
            note={t.note}
            pill={pillFor(t)}
            line={`${t.status?.version ? t.status.version : t.cli}${t.status?.detail ? ` — ${t.status.detail}` : ""}`}
            lastCheckedAt={t.status?.lastCheckedAt}
          >
            <ToolGuidanceBlock guidance={guidanceFor(t)} />
            <div className="connector-instance">
              <button
                type="button"
                className="settings-btn"
                onClick={() => void refresh(t.cli)}
                disabled={busy !== null}
              >
                {busy === t.cli ? "checking…" : "refresh"}
              </button>
              {t.status?.detected && (
                <button type="button" className="settings-btn" onClick={() => void toggle(t)}>
                  {t.status.enabled ? "disable" : "enable"}
                </button>
              )}
            </div>
          </ConnectorCard>
        ))}
      </div>
    </>
  );
}
