# Deterministic Session Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tell the CLI which session id to use, so the swarm knows the transcript path instead of inferring it by diffing a directory.

**Architecture:** `AgentSessionManager.create()` already generates a UUID per session and never tells the CLI about it, then reverse-engineers which transcript is its own by snapshotting `listSessionFiles()` before launch and diffing after. Passing `--session-id <that same uuid>` makes the path `sessionDir(cwd)/<uuid>.jsonl` — verified empirically 2026-08-16. The inference becomes unnecessary for drivers that support pinning, and stays as a fallback for those that do not.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `node:test` + `node:assert/strict`, real tmux in tests, pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-08-16-workspace-instances-and-assignment-design.md` §5

## Global Constraints

- Node >= 24, TypeScript ~6.0.0, biome 2.5.3. Lint baseline is ZERO diagnostics — any new warning is new debt.
- Run tests from `swarm/`: `node --import tsx --test --test-timeout 60000 'src/*.test.ts' 'src/**/*.test.ts'`
- Typecheck with the workspace binary, not `npx`: `swarm/node_modules/.bin/tsc --noEmit`. **Baseline is 12 pre-existing errors** — the goal is 12, not 0. `npx tsc` resolves a decoy binary that prints "This is not the tsc command you are looking for" and reports success without running.
- Read the error count from tsc's own trailing `Found N errors` line, NOT `grep -c 'error TS'` — tsc can emit colorized output even when redirected, and the escape codes defeat that grep silently.
- `ToolDriver` has five implementations: `claude`, `agy`, `codex`, `copilot`, `opencode`. New capabilities are **optional** interface members (the existing house pattern: `warmSessionsSupported?`, `readMessages?`, `prepareWorkspace?`), so drivers that cannot support them are unchanged.
- Never assert on call shape where behavior can be asserted. A test that checks which flags were passed can stay green through a total failure of the thing those flags were meant to cause.
- Exit codes after a pipe are the pipe's, not the command's. Measure with a redirect, not `$?` after `| grep`.

---

### Task 1: `ClaudeDriver` learns deterministic session identity

**Files:**
- Modify: `swarm/src/drivers/types.ts` (the `ToolDriver` interface)
- Modify: `swarm/src/drivers/claude.ts`
- Test: `swarm/src/drivers/claude.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `ToolDriver.interactiveCommand(baseCommand: string, model?: string, sessionId?: string): string`
  - `ToolDriver.sessionFileFor?(cwd: string, sessionId: string): string`
  - `ClaudeDriver` implements both. Task 2 calls them.

- [ ] **Step 1: Write the failing tests**

Append to `swarm/src/drivers/claude.test.ts`:

```ts
test("ClaudeDriver.interactiveCommand: pins the session id so the transcript path is known up front", () => {
  const d = new ClaudeDriver("/tmp/fake-claude-home");
  const cmd = d.interactiveCommand("claude", "sonnet", "11111111-2222-3333-4444-555555555555");
  assert.match(cmd, /--session-id 11111111-2222-3333-4444-555555555555/);
});

test("ClaudeDriver.interactiveCommand: omits the flag when no id is pinned", () => {
  const d = new ClaudeDriver("/tmp/fake-claude-home");
  assert.ok(!d.interactiveCommand("claude", "sonnet").includes("--session-id"));
});

test("ClaudeDriver.sessionFileFor: the transcript is <sessionDir>/<id>.jsonl", () => {
  const d = new ClaudeDriver("/tmp/fake-claude-home");
  const cwd = "/repo/work";
  assert.equal(
    d.sessionFileFor(cwd, "11111111-2222-3333-4444-555555555555"),
    join(d.sessionDir(cwd), "11111111-2222-3333-4444-555555555555.jsonl"),
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd swarm && node --import tsx --test --test-timeout 60000 \
  --test-name-pattern 'session id|sessionFileFor' 'src/drivers/claude.test.ts'
```

Expected: FAIL. The first two assert on a flag that is not emitted; the third fails with `d.sessionFileFor is not a function`.

- [ ] **Step 3: Add the optional capability to the interface**

In `swarm/src/drivers/types.ts`, replace the `interactiveCommand` declaration and add `sessionFileFor` beneath `sessionDir`:

```ts
  /**
   * Interactive TUI command for a warm session. `model` comes from the agent
   * definition — the driver spells the flag its own tool understands.
   * `sessionId`, when given, pins the tool's session id so the caller knows the
   * transcript path without discovering it. Tools that cannot pin ignore it.
   */
  interactiveCommand(baseCommand: string, model?: string, sessionId?: string): string;

  /**
   * Where this tool writes the transcript when launched with `sessionId`.
   * Present only for tools that let the caller pin the id; absent means the
   * session manager must discover the file after launch.
   */
  sessionFileFor?(cwd: string, sessionId: string): string;
```

- [ ] **Step 4: Implement in `ClaudeDriver`**

In `swarm/src/drivers/claude.ts`, replace `interactiveCommand` and add `sessionFileFor` directly beneath `sessionDir`:

```ts
  interactiveCommand(baseCommand: string, model?: string, sessionId?: string): string {
    return `${baseCommand}${modelFlag(model)}${sessionId ? ` --session-id ${sessionId}` : ""}`;
  }

  sessionFileFor(cwd: string, sessionId: string): string {
    return join(this.sessionDir(cwd), `${sessionId}.jsonl`);
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd swarm && node --import tsx --test --test-timeout 60000 \
  --test-name-pattern 'session id|sessionFileFor' 'src/drivers/claude.test.ts'
```

Expected: PASS, 3 tests.

- [ ] **Step 6: Run the full suite and typecheck**

```bash
cd swarm && node --import tsx --test --test-timeout 60000 'src/*.test.ts' 'src/**/*.test.ts' > /tmp/suite.txt 2>&1; echo "exit=$?"
grep -E "^. (tests|pass|fail)" /tmp/suite.txt
./node_modules/.bin/tsc --noEmit > /tmp/tsc.txt 2>&1; echo "errors=$(grep -oE 'Found [0-9]+ error' /tmp/tsc.txt | grep -oE '[0-9]+')"
```

Expected: all tests pass; `errors=12` (the baseline — not 0).

- [ ] **Step 7: Commit**

```bash
git add swarm/src/drivers/types.ts swarm/src/drivers/claude.ts swarm/src/drivers/claude.test.ts
git commit -m "feat(swarm): let a driver pin its session id

The CLI accepts --session-id <uuid> and writes the transcript to
<sessionDir>/<uuid>.jsonl. Exposing that as an optional driver capability lets
the session manager know the path up front instead of discovering it.

Optional on ToolDriver, matching warmSessionsSupported?/readMessages?, so the
four non-claude drivers are untouched."
```

---

### Task 2: `AgentSessionManager` pins the id it already generates

**Files:**
- Modify: `swarm/src/agent-sessions.ts:101-135` (`create()`)
- Test: `swarm/src/agent-sessions.test.ts`

**Interfaces:**
- Consumes: `interactiveCommand(base, model?, sessionId?)` and `sessionFileFor(cwd, id)` from Task 1.
- Produces: after `create()`, `state.sessionFile` is already set for drivers that pin. Task 3 relies on this.

- [ ] **Step 1: Teach the test harness to pin ids**

The shared `FakeDriver` and its tool script currently ignore arguments. In `swarm/src/agent-sessions.test.ts`, replace `FakeDriver.interactiveCommand` and add `sessionFileFor`:

```ts
  interactiveCommand(baseCommand: string, _model?: string, sessionId?: string): string {
    return sessionId ? `${baseCommand} --session-id ${sessionId}` : baseCommand;
  }
  sessionFileFor(cwd: string, sessionId: string): string {
    return join(this.sessionDir(cwd), `${sessionId}.jsonl`);
  }
```

and replace the tool script body written in `before()` so it honors the flag:

```ts
  writeFileSync(
    toolScript,
    `#!/bin/bash
mkdir -p .fake-sessions
SID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --session-id) SID="$2"; shift 2 ;;
    *) shift ;;
  esac
done
F=.fake-sessions/\${SID:-session}.jsonl
: > "$F"
while IFS= read -r line; do
  clean=$(printf '%s' "$line" | tr -d '\\033' | sed 's/\\[200~//; s/\\[201~//')
  ts=$(date -u +%Y-%m-%dT%H:%M:%S.999Z)
  printf '{"role":"user","text":"%s","ts":"%s"}\\n' "$clean" "$ts" >> "$F"
  printf '{"role":"assistant","text":"echo: %s","done":true,"ts":"%s"}\\n' "$clean" "$ts" >> "$F"
done
`,
  );
```

- [ ] **Step 2: Write the failing test**

Append to `swarm/src/agent-sessions.test.ts`:

```ts
test("create: a pinning driver's transcript path is known without discovery", async () => {
  const info = await manager.create(AGENT, JSON.stringify(AGENT), repoRoot, "main");
  created.push(info.id);

  // The tool wrote its transcript to the id the manager chose, not one of its own.
  const expected = join(info.cwd, ".fake-sessions", `${info.id}.jsonl`);
  execFileSync("test", ["-f", expected]);

  // And the session is usable through that path.
  const turn = await manager.send(info.id, "hola crew");
  assert.ok(turn.some((m) => m.role === "assistant" && m.text.includes("hola crew")));
});
```

- [ ] **Step 3: Run it to verify it fails**

```bash
cd swarm && node --import tsx --test --test-timeout 60000 \
  --test-name-pattern 'known without discovery' 'src/agent-sessions.test.ts'
```

Expected: FAIL — the file is `session.jsonl` (the script's fallback), not `<info.id>.jsonl`, because `create()` never passes the id.

- [ ] **Step 4: Pass the id at launch and record the path**

In `swarm/src/agent-sessions.ts`, in `create()`, replace the `state.preexisting` line and the `launch` call with:

```ts
    // A driver that can pin its session id makes the transcript path known up
    // front. Only tools that cannot pin need the before/after directory diff,
    // which cannot distinguish two agents sharing one project dir.
    state.sessionFile = driver.sessionFileFor?.(cwd, id);
    state.preexisting = state.sessionFile ? new Set() : new Set(await driver.listSessionFiles(cwd));
    // A fresh worktree is a directory the tool has never seen, so it would come
    // up on a first-run gate (claude: "Yes, I trust this folder"). A modal
    // satisfies every readiness signal below, so the session would report ready
    // and then silently swallow its first send. Clear the gate before launch.
    await driver.prepareWorkspace?.(cwd);
    // The tmux process an agent lives in is fully determined by its
    // definition: its CLI picks the binary, its model picks the flag.
    await this.runtime.launch(
      state.tmuxSession,
      driver.interactiveCommand(baseCommand, agent.engine.model, id),
      cwd,
    );
```

- [ ] **Step 5: Run it to verify it passes**

```bash
cd swarm && node --import tsx --test --test-timeout 60000 \
  --test-name-pattern 'known without discovery' 'src/agent-sessions.test.ts'
```

Expected: PASS.

- [ ] **Step 6: Run the full suite and typecheck**

```bash
cd swarm && node --import tsx --test --test-timeout 60000 'src/*.test.ts' 'src/**/*.test.ts' > /tmp/suite.txt 2>&1; echo "exit=$?"
grep -E "^. (tests|pass|fail)" /tmp/suite.txt
./node_modules/.bin/tsc --noEmit > /tmp/tsc.txt 2>&1; echo "errors=$(grep -oE 'Found [0-9]+ error' /tmp/tsc.txt | grep -oE '[0-9]+')"
```

Expected: all pass, `errors=12`. The readiness loop in `create()` still discovers a file for non-pinning drivers, so their tests are unaffected.

- [ ] **Step 7: Commit**

```bash
git add swarm/src/agent-sessions.ts swarm/src/agent-sessions.test.ts
git commit -m "feat(swarm): pin the session id the manager already generates

create() has always generated a UUID per session and then reverse-engineered
which transcript belonged to it by diffing the project directory. It now tells
the CLI to use that id, so the path is known before launch.

The diff survives only for drivers that cannot pin."
```

---

### Task 3: Prove the inference is gone, not merely bypassed

**Files:**
- Test: `swarm/src/agent-sessions.test.ts`

**Interfaces:**
- Consumes: Task 2's behavior.
- Produces: nothing — this task is the guarantee that later work (shared project directories, `delegated` squads) rests on.

The diff is unsound whenever two agents share a project directory: each snapshots an empty set, both transcripts appear, and each may claim the other's. Task 2 makes that path unnecessary for `claude`, but a test asserting "the right file was chosen" would still pass if the diff were quietly doing the work. This test makes the diff impossible instead: a driver whose `listSessionFiles` **throws** cannot be used for discovery, so a session that still works proves discovery never ran.

- [ ] **Step 1: Write the failing test**

Append to `swarm/src/agent-sessions.test.ts`:

```ts
test("a pinning driver never falls back to directory discovery", async () => {
  class NoDiscoveryDriver extends FakeDriver {
    async listSessionFiles(): Promise<string[]> {
      throw new Error("listSessionFiles must not be called for a pinning driver");
    }
  }
  const strict = new AgentSessionManager(runtime, {
    agentCommands: { claude: toolScript },
    worktreeDir: ".smith/worktrees",
    resolveDriver: () => new NoDiscoveryDriver(),
    pollIntervalMs: 100,
    readinessTimeoutMs: 10_000,
    turnTimeoutMs: 10_000,
  });

  const info = await strict.create(AGENT, JSON.stringify(AGENT), repoRoot, "main");
  const turn = await strict.send(info.id, "still works");

  assert.ok(turn.some((m) => m.role === "assistant" && m.text.includes("still works")));
  await strict.destroy(info.id).catch(() => {});
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd swarm && node --import tsx --test --test-timeout 60000 \
  --test-name-pattern 'never falls back' 'src/agent-sessions.test.ts'
```

Expected: FAIL with `listSessionFiles must not be called for a pinning driver`, thrown from `create()`'s readiness loop, which still calls it unconditionally.

- [ ] **Step 3: Make the readiness loop respect a known path**

In `swarm/src/agent-sessions.ts`, in `create()`'s readiness loop, replace the `const fresh = …` block with:

```ts
      if (state.sessionFile) {
        // Path is already known; readiness is just "the TUI is up and stays up".
        if (Date.now() >= settleUntil) {
          state.status = "ready";
          await this.persist(state);
          return this.info(state);
        }
      } else {
        const fresh = (await driver.listSessionFiles(cwd)).filter((f) => !state.preexisting.has(f));
        if (fresh.length > 0) {
          state.sessionFile = await this.newest(fresh);
          state.status = "ready";
          await this.persist(state);
          return this.info(state);
        }
        if (Date.now() >= settleUntil) {
          state.status = "ready"; // alive; session file resolves on the first turn
          await this.persist(state);
          return this.info(state);
        }
      }
```

- [ ] **Step 4: Guard `discoverSessionFile` too**

In `swarm/src/agent-sessions.ts`, `discoverSessionFile` is called from `send()` on every poll. It already returns early when `state.sessionFile` is set, so a pinning driver never reaches `listSessionFiles`. Confirm the early return is the **first** statement:

```ts
  private async discoverSessionFile(state: SessionState): Promise<void> {
    if (state.sessionFile) return;
    const fresh = (await state.driver.listSessionFiles(state.cwd)).filter((f) => !state.preexisting.has(f));
    if (fresh.length > 0) state.sessionFile = await this.newest(fresh);
  }
```

No edit is needed if it already reads this way. Do not restructure it.

- [ ] **Step 5: Run it to verify it passes**

```bash
cd swarm && node --import tsx --test --test-timeout 60000 \
  --test-name-pattern 'never falls back' 'src/agent-sessions.test.ts'
```

Expected: PASS.

- [ ] **Step 6: Run the full suite and typecheck**

```bash
cd swarm && node --import tsx --test --test-timeout 60000 'src/*.test.ts' 'src/**/*.test.ts' > /tmp/suite.txt 2>&1; echo "exit=$?"
grep -E "^. (tests|pass|fail)" /tmp/suite.txt
./node_modules/.bin/tsc --noEmit > /tmp/tsc.txt 2>&1; echo "errors=$(grep -oE 'Found [0-9]+ error' /tmp/tsc.txt | grep -oE '[0-9]+')"
```

Expected: all pass, `errors=12`.

- [ ] **Step 7: Commit**

```bash
git add swarm/src/agent-sessions.ts swarm/src/agent-sessions.test.ts
git commit -m "test(swarm): prove pinning drivers never use directory discovery

A test asserting the right transcript was chosen would still pass if the
before/after diff were quietly doing the work. A driver whose listSessionFiles
throws makes discovery impossible, so a session that still works proves it
never ran.

Readiness no longer calls listSessionFiles when the path is already known."
```

---

### Task 4: Verify against the real CLI

**Files:**
- No production changes. Manual verification against a live swarm.

Unit tests use a fake tool that honors `--session-id` because it was written to. This task confirms the real CLI does the same through the whole stack.

- [ ] **Step 1: Restart the swarm on the new code**

The swarm runs detached from `swarm/`. Find and stop it by exact PID — never an unscoped pattern kill, which would also match other agents' processes:

```bash
lsof -nP -iTCP:7777 -sTCP:LISTEN     # note the PID
kill <pid>
cd swarm && nohup node --env-file=../.env --import tsx src/server.ts > /tmp/swarm.log 2>&1 &
until curl -s -m 3 http://127.0.0.1:7777/health > /dev/null; do sleep 1; done
```

- [ ] **Step 2: Create a session, then send a turn**

The real `claude` CLI writes its transcript **only once a turn happens** — that
laziness is the whole reason §5 exists. Checking for the file straight after
`create()` finds nothing and means nothing. Send first, verify after.

```bash
NEW=$(curl -s -m 240 -X POST http://127.0.0.1:7777/agent-sessions \
  -H 'Content-Type: application/json' -d '{"agent":"ignacio","workspace":"proving-ground"}')
ID=$(echo "$NEW"  | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
CWD=$(echo "$NEW" | python3 -c "import sys,json;print(json.load(sys.stdin)['cwd'])")

curl -s -m 240 -X POST "http://127.0.0.1:7777/agent-sessions/$ID/send" \
  -H 'Content-Type: application/json' \
  -d '{"text":"Reply with exactly the word PONG and nothing else.","timeoutMs":200000}'
```

Expected: JSON containing an assistant message `PONG`. Run this in a background
shell — a foreground call hits the 2-minute tool ceiling while the turn is still
running, and killing the client does NOT cancel the turn.

- [ ] **Step 3: Confirm the transcript is named for the swarm's session id**

```bash
ENC=$(python3 -c "import re,sys;print(re.sub(r'[^a-zA-Z0-9]','-',sys.argv[1]))" "$CWD")
ls -1 ~/.claude/projects/"$ENC"/
```

Expected: exactly `<ID>.jsonl`. Before this plan it was an unrelated
CLI-generated UUID, which is the whole point being verified.

- [ ] **Step 4: Clean up and commit nothing**

```bash
curl -s -X DELETE "http://127.0.0.1:7777/agent-sessions/$ID"
```

This task produces no commit. If Step 2 shows any filename other than `<ID>.jsonl`, stop and report — the unit tests would be passing against a fake that is more cooperative than the real CLI.

---

## Self-review

**Spec coverage.** §5 requires three things: pass `--session-id`, replace the snapshot-diff, and make resume-by-id possible. Tasks 1–3 deliver the first two. Resume-by-id (`--resume <known id>`) is deliberately **not** in this plan — it has no consumer until §3.3's session-death recovery, and building it now would be untested speculation. The prerequisite it needs is a known id, which this plan establishes.

**Placeholders.** None. Every code step contains the literal text to write.

**Type consistency.** `sessionFileFor(cwd, sessionId)` and `interactiveCommand(base, model?, sessionId?)` are spelled identically in `types.ts`, `claude.ts`, `FakeDriver`, and `NoDiscoveryDriver`. `state.sessionFile` is `string | undefined` throughout, which is what `sessionFileFor?.()` returns when the driver cannot pin.

**Known residue.** `state.preexisting` remains on `SessionState` and is set to an empty set for pinning drivers. It is not dead — the four non-pinning drivers still use it — so it stays until they are addressed, if ever.
