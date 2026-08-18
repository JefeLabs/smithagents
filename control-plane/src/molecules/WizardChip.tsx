import { Button } from "@heroui/react";
import { useState } from "react";
import type { SetupMode } from "../lib/wizardSteps";
import { ModalShell } from "./form";

export interface WizardChipProps {
  /** The user's own name — Anderson addresses them by it in the confirm dialog, first person throughout. */
  name: string;
  mode: SetupMode;
  /** Steps already answered, so the chip knows whether editing costs anything. */
  clears: readonly string[];
  onEdit: () => void;
}

/** Mirrors WizardGateStep's own wording for the two modes — one source of truth for the phrase, not a second one invented here. */
const MODE_LABEL: Record<SetupMode, string> = {
  local: "On your machine",
  hosted: "In the cloud",
};

/**
 * What the gate (WizardGateStep, inside WizardGate.tsx) collapses into once
 * you continue past it — spec 2026-08-18: `Anderson · On your machine ✎`.
 * Persistent past the gate, and clickable to reopen it: the name/location
 * answers stay visible and editable for the rest of setup rather than
 * vanishing the moment the questions that produced them scroll out of view.
 *
 * `clears` is what makes this more than a bare "edit" button. It names the
 * steps this build has ALREADY answered by the time the chip is showing —
 * WizardGate derives it from its own step sequence, never invented here.
 * Empty means nothing past preflight has an answer yet, and a click switches
 * straight back with nothing to warn about. Once it isn't empty, a confirm
 * step names each one individually: a count ("you'll lose 2 answers") or a
 * blanket "your answers will be cleared" both read as honest at a glance and
 * both fail the spec's "says so specifically" — this always itemizes, never
 * summarizes, so the two can't collapse into each other.
 */
export function WizardChip({ name, mode, clears, onEdit }: WizardChipProps) {
  const [confirming, setConfirming] = useState(false);

  const requestEdit = () => {
    if (clears.length === 0) {
      onEdit();
      return;
    }
    setConfirming(true);
  };

  return (
    <>
      <button type="button" className="wizard-chip" onClick={requestEdit}>
        Anderson · {MODE_LABEL[mode]} <span aria-hidden="true">✎</span>
      </button>
      <ModalShell open={confirming} onClose={() => setConfirming(false)} title="Change your answers?">
        {/* The lede never repeats the item names itself — only the list below
            does, once each, so a query for one name matches exactly one node
            instead of two (this sentence AND its own list item). */}
        <p className="wizard-chip__lede">{name}, going back this far means walking through these again:</p>
        <ul className="wizard-chip__clears">
          {clears.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <div className="wizard-chip__footer">
          <Button type="button" variant="secondary" onPress={() => setConfirming(false)}>
            Keep it as is
          </Button>
          <Button
            type="button"
            variant="primary"
            onPress={() => {
              setConfirming(false);
              onEdit();
            }}
          >
            Change it
          </Button>
        </div>
      </ModalShell>
    </>
  );
}
