// Machine-level facts read straight from the OS — no persistence, no probe,
// no timeout; os.totalmem() is synchronous and always available. Sibling of
// local-models.ts: both feed the wizard's "models on my machine" step, this
// one with the RAM budget a local model has to fit inside.
import os from "node:os";

export function machineFacts(): { totalMemBytes: number } {
  return { totalMemBytes: os.totalmem() };
}
