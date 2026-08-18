import assert from "node:assert/strict";
import os from "node:os";
import { test } from "node:test";
import { machineFacts } from "./machine.js";

test("machineFacts: reports this machine's total memory", () => {
  assert.equal(machineFacts().totalMemBytes, os.totalmem());
});
