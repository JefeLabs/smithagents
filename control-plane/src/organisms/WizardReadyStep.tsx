import { useEffect, useRef, useState } from "react";
import { pingBrain } from "../api/broker";
import type { BrainPing } from "../api/types";
import type { WizardSaveState, WizardStep } from "../lib/wizardSteps";
import { useCliTools, useVoiceSettings } from "../queries/http";

export interface WizardReadyStepProps {
  name: string;
  /** Every receipt line jumps back to the step that earned it. */
  onJumpTo: (step: WizardStep) => void;
  onFinish: () => void;
  /** Absent when there is nothing behind this step — same contract as the others. */
  onBack?: () => void;
  /** What became of the host's own PUT for the patch it last sent. */
  saveState?: WizardSaveState;
}

/** `812` → `0.8s`. Only ever called with a figure that was measured. */
function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * The wizard's closing screen — *Before we start*.
 *
 * The ticks are **receipts, not restatements**: each one renders only after its
 * own operation has run and succeeded, in this render, on this machine. Nothing
 * here reads a stored flag, so no tick can be set early, inherited from an
 * earlier run, or left standing after the thing it describes stopped working.
 *
 * That is structural rather than disciplinary. A static "✓ I checked my login"
 * is a lie the user eventually catches, and the cheapest way to never ship one
 * is to have no boolean anyone *could* set.
 */
export function WizardReadyStep({ name, onJumpTo, onFinish, onBack, saveState = "idle" }: WizardReadyStepProps) {
  const [ping, setPing] = useState<BrainPing | null>(null);
  const asked = useRef(false);
  const { data: tools = [] } = useCliTools();
  const { data: voice } = useVoiceSettings();

  useEffect(() => {
    // Once per mount: the ask costs a real model call, and a receipt is one
    // operation rather than one per render.
    if (asked.current) return;
    asked.current = true;
    void pingBrain().then(setPing);
  }, []);

  const loggedIn = tools.filter((t) => t.active);
  const voiceReady = Boolean(voice?.tts);

  return (
    <section>
      <h2>Before we start</h2>
      <p>Here's what I've understood.</p>

      <ul>
        {loggedIn.length > 0 && (
          <li>
            ✓ I checked my {loggedIn.map((t) => t.label).join(" and ")} login — it works
            <button type="button" onClick={() => onJumpTo("sources")}>
              Revisit Where I think
            </button>
          </li>
        )}

        {ping?.ok && (
          <li>
            ✓ I asked myself a question and answered in {seconds(ping.latencyMs)}
            <button type="button" onClick={() => onJumpTo("roles")}>
              Revisit What I think with
            </button>
          </li>
        )}
        {ping && !ping.ok && (
          <li>
            I couldn't get an answer just now — {ping.reason}
            <button type="button" onClick={() => onJumpTo("roles")}>
              Revisit What I think with
            </button>
          </li>
        )}

        <li>
          {voiceReady ? "✓ My voice is set up" : "I'll stay text-only for now"}
          <button type="button" onClick={() => onJumpTo("voice")}>
            Revisit Talking out loud
          </button>
        </li>
      </ul>

      <p>
        <strong>I think we're ready, {name}.</strong>
      </p>

      <footer>
        {onBack && (
          <button type="button" onClick={onBack} disabled={saveState === "saving"}>
            Back
          </button>
        )}
        {/* Inert only while a write is actually in flight. A ping that FAILED
            must never disable it: this is the last screen of first-run setup,
            and a failed check cannot be the reason someone cannot get in. */}
        <button type="button" onClick={onFinish} disabled={saveState === "saving"}>
          Let's talk →
        </button>
      </footer>
    </section>
  );
}
