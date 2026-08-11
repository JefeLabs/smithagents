#!/usr/bin/env node
// ---------------------------------------------------------------------------
// smith-worker CLI — Start a smith worker on this machine
// ---------------------------------------------------------------------------

import { startWorker } from "./worker.js";

startWorker().catch((err) => {
  console.error(err);
  process.exit(1);
});
