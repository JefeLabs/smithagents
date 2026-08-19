import { type FormEvent, useState } from "react";
import { brokerFetch } from "../api/origin";
import type { Setup, WizardSaveState } from "../lib/wizardSteps";

export interface WizardTalkStepProps {
  /** Seeds a RESUMED record. Chatty is the product default — the personality IS the product. */
  initialSmallTalk?: boolean;
  /** News ingestion is opt-in, so this defaults to declined. */
  initialWorldAware?: boolean;
  /** Topics already on the server (GET /topics). Shown, never re-posted. */
  initialTopics?: string[];
  /** Always sends BOTH answers explicitly — setup merges server-side. */
  onDone: (patch: { setup: Setup }) => void;
  onBack?: () => void;
  saveState?: WizardSaveState;
}

/**
 * The wizard's *How I talk* step.
 *
 * Two questions, and neither can trap. Saying yes to the world reveals a topic
 * entry and nothing else — no key field anywhere, because the feeds pipeline
 * this rides is keyless. Yes with no topics at all is a valid answer: the daily
 * digest alone is world-awareness.
 *
 * A topic that fails to post must not strand the wizard in the middle of
 * first-run setup, so the failure is stated and a way onward is offered. The
 * preference itself is the answer to the question; the topics are an extra.
 */
export function WizardTalkStep({
  initialSmallTalk = true,
  initialWorldAware = false,
  initialTopics = [],
  onDone,
  onBack,
  saveState = "idle",
}: WizardTalkStepProps) {
  const [smallTalk, setSmallTalk] = useState(initialSmallTalk);
  const [worldAware, setWorldAware] = useState(initialWorldAware);
  const [existing] = useState<string[]>(initialTopics);
  const [added, setAdded] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [topicError, setTopicError] = useState<string | null>(null);

  const finish = () => onDone({ setup: { smallTalk, worldAware } });

  function addTopic(e: FormEvent) {
    e.preventDefault();
    const name = draft.trim();
    if (!name) return;
    if (![...existing, ...added].includes(name)) setAdded((t) => [...t, name]);
    setDraft("");
  }

  async function handleContinue() {
    setTopicError(null);
    // Only topics entered HERE are posted. Anything seeded from the server is
    // already there, and posting it again would duplicate it.
    if (!worldAware || added.length === 0) {
      finish();
      return;
    }
    setBusy(true);
    try {
      for (const name of added) {
        // brokerFetch resolves for non-2xx as well as 2xx, so an unchecked
        // response would report a silent success and lose the topic.
        const res = await brokerFetch("/topics", undefined, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name }),
        });
        if (!res.ok) throw new Error(`${res.status}`);
      }
      finish();
    } catch {
      setTopicError("I couldn't save those topics just now.");
    } finally {
      setBusy(false);
    }
  }

  const inert = busy || saveState === "saving";

  return (
    <section>
      <h2>How I talk</h2>

      <fieldset>
        <legend>Should I make small talk?</legend>
        <label>
          <input type="radio" name="smallTalk" checked={smallTalk} onChange={() => setSmallTalk(true)} />
          Yes — say hello properly before we get to work
        </label>
        <label>
          <input type="radio" name="smallTalk" checked={!smallTalk} onChange={() => setSmallTalk(false)} />
          No — straight to the point
        </label>
      </fieldset>

      <fieldset>
        <legend>Should I keep up with what's happening in the world?</legend>
        <label>
          <input type="radio" name="worldAware" checked={worldAware} onChange={() => setWorldAware(true)} />
          Yes — keep up with the news, and bring it up when it matters
        </label>
        <label>
          <input type="radio" name="worldAware" checked={!worldAware} onChange={() => setWorldAware(false)} />
          No — I'll stick to what I already know
        </label>
      </fieldset>

      {worldAware && (
        <div>
          <p>I'll follow the news and anything you name here, and go find good sources for it.</p>
          <form onSubmit={addTopic}>
            <label htmlFor="talk-topic">Add a topic</label>
            <input
              id="talk-topic"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="rust releases"
            />
          </form>
          <ul>
            {[...existing, ...added].map((t) => (
              <li key={t}>
                {t}
                <button type="button" onClick={() => setAdded((all) => all.filter((x) => x !== t))}>
                  Remove {t}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {topicError && (
        <p role="alert">
          {topicError} Your answer about topics is saved either way — you can add them later from Maintenance.
        </p>
      )}

      <footer>
        {onBack && (
          <button type="button" onClick={onBack} disabled={inert}>
            Back
          </button>
        )}
        <button type="button" onClick={handleContinue} disabled={inert}>
          Continue
        </button>
        {topicError && (
          <button type="button" onClick={finish}>
            Continue without saving topics
          </button>
        )}
      </footer>
    </section>
  );
}
