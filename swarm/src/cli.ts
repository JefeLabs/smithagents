#!/usr/bin/env node
// ---------------------------------------------------------------------------
// @smith/agent-orchestrator CLI — Command-line client for the orchestrator server
//
// Usage:
//   smith submit --agent claude --prompt "Fix the login test"
//   smith submit --agent agy --prompt "Refactor auth" --runtime docker
//   smith list
//   smith status <taskId>
//   smith cancel <taskId>
//   smith health
//   smith quarantine
//   smith quarantine release <taskId>
//   smith logs <taskId>
//
// Configuration:
//   SMITH_SERVER_URL=http://localhost:7777  (default)
// ---------------------------------------------------------------------------

const BASE_URL = process.env.SMITH_SERVER_URL ?? 'http://localhost:7777';

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function request(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; data: unknown }> {
  const url = `${BASE_URL}${path}`;
  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) init.body = JSON.stringify(body);

  try {
    const res = await fetch(url, init);
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  } catch (err) {
    console.error(`\x1b[31m✗ Cannot reach server at ${BASE_URL}\x1b[0m`);
    console.error(`  Is the orchestrator running? → pnpm serve`);
    process.exit(1);
  }
}

function json(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function table(rows: Record<string, unknown>[]): void {
  if (rows.length === 0) {
    console.log('  (none)');
    return;
  }
  console.table(rows);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdSubmit(args: string[]): Promise<void> {
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, '');
    opts[key] = args[i + 1];
  }

  if (!opts.agent || !opts.prompt) {
    console.error('Usage: smith submit --agent <claude|agy|codex> --prompt "..."');
    console.error('Options:');
    console.error('  --agent     Required. Agent CLI to use (claude, agy, codex)');
    console.error('  --prompt    Required. Task prompt');
    console.error('  --runtime   Optional. tmux or docker (default: config default)');
    console.error('  --location  Optional. local, docker, or remote (default: auto)');
    console.error('  --priority  Optional. normal or high (default: normal)');
    console.error('  --branch    Optional. Git branch for context');
    console.error('  --files     Optional. Comma-separated file paths for context');
    process.exit(1);
  }

  const body: Record<string, unknown> = {
    agent: opts.agent,
    prompt: opts.prompt,
    context: {
      repository: opts.repo ?? process.cwd(),
      branch: opts.branch ?? 'main',
      files: opts.files?.split(',') ?? [],
    },
  };

  if (opts.runtime) body.runtime = opts.runtime;
  if (opts.location) body.location = opts.location;
  if (opts.priority) body.priority = opts.priority;

  const { status, data } = await request('POST', '/tasks', body);

  if (status === 202) {
    const d = data as Record<string, unknown>;
    const name = d.agentName ? `\x1b[1m${d.agentName}\x1b[0m` : '';
    console.log(`\x1b[32m✓ Task queued${name ? ` as ${name}` : ''}\x1b[0m`);
    console.log(`  ID:       ${d.taskId}`);
    if (d.agentName) console.log(`  Agent:    ${d.agentName}`);
    console.log(`  Position: #${d.position}`);
  } else {
    console.error(`\x1b[31m✗ Failed (${status})\x1b[0m`);
    json(data);
  }
}

async function cmdList(): Promise<void> {
  const { data } = await request('GET', '/tasks');
  const d = data as { active: unknown[]; queued: unknown[]; completed: unknown[] };

  console.log(`\n\x1b[1m  Active (${d.active.length})\x1b[0m`);
  table(d.active as Record<string, unknown>[]);

  console.log(`\n\x1b[1m  Queued (${d.queued.length})\x1b[0m`);
  table(d.queued as Record<string, unknown>[]);

  console.log(`\n\x1b[1m  Completed (${d.completed.length})\x1b[0m`);
  table(d.completed as Record<string, unknown>[]);
}

async function cmdStatus(taskId: string): Promise<void> {
  if (!taskId) {
    console.error('Usage: smith status <taskId>');
    process.exit(1);
  }
  const { status, data } = await request('GET', `/tasks/${taskId}`);
  if (status === 404) {
    console.error(`\x1b[31m✗ Task ${taskId} not found\x1b[0m`);
    process.exit(1);
  }
  json(data);
}

async function cmdCancel(taskId: string): Promise<void> {
  if (!taskId) {
    console.error('Usage: smith cancel <taskId>');
    process.exit(1);
  }
  const { status, data } = await request('DELETE', `/tasks/${taskId}`);
  if (status === 200) {
    console.log(`\x1b[32m✓ Task ${taskId} cancelled\x1b[0m`);
  } else {
    const d = data as Record<string, unknown>;
    console.error(`\x1b[31m✗ ${d.error}\x1b[0m`);
  }
}

async function cmdHealth(): Promise<void> {
  const { data } = await request('GET', '/health');
  const d = data as Record<string, unknown>;
  const mem = d.memory as Record<string, number>;

  console.log(`\x1b[1m  Orchestrator Health\x1b[0m`);
  console.log(`  Status:         ${d.status}`);
  console.log(`  Uptime:         ${Math.round(d.uptime as number)}s`);
  console.log(`  Active tasks:   ${d.activeTasks} / ${d.maxConcurrent}`);
  console.log(`  Queued tasks:   ${d.queuedTasks}`);
  console.log(`  Completed:      ${d.completedTasks}`);
  console.log(`  Memory (RSS):   ${mem.rss} MB`);
  console.log(`  Memory (Heap):  ${mem.heap} MB`);
}

async function cmdQuarantine(subCmd: string, taskId?: string): Promise<void> {
  if (subCmd === 'release' && taskId) {
    const { status, data } = await request('POST', `/quarantine/${taskId}/release`);
    if (status === 200) {
      console.log(`\x1b[32m✓ Task ${taskId} released from quarantine\x1b[0m`);
    } else {
      const d = data as Record<string, unknown>;
      console.error(`\x1b[31m✗ ${d.error}\x1b[0m`);
    }
    return;
  }

  // Default: list quarantined tasks
  const { data } = await request('GET', '/quarantine');
  const entries = data as Record<string, unknown>[];
  if (entries.length === 0) {
    console.log('  No quarantined tasks.');
  } else {
    table(entries);
  }
}

// ---------------------------------------------------------------------------
// Agent Control Commands
// ---------------------------------------------------------------------------

async function cmdOutput(taskId: string): Promise<void> {
  if (!taskId) {
    console.error('Usage: smith output <taskId>');
    process.exit(1);
  }
  const { status, data } = await request('GET', `/tasks/${taskId}/output`);
  if (status !== 200) {
    const d = data as Record<string, unknown>;
    console.error(`\x1b[31m✗ ${d.error}\x1b[0m`);
    process.exit(1);
  }
  const d = data as Record<string, unknown>;
  console.log(`\x1b[1m  Task ${d.taskId}\x1b[0m`);
  console.log(`  Agent:    ${d.agent}`);
  console.log(`  Runtime:  ${d.runtime}`);
  console.log(`  Session:  ${d.sessionName}`);
  console.log(`  Uptime:   ${Math.round((d.uptime as number) / 1000)}s`);
  console.log(`\n\x1b[2m${'─'.repeat(60)}\x1b[0m`);
  console.log(d.output);
  console.log(`\x1b[2m${'─'.repeat(60)}\x1b[0m`);
}

async function cmdSteer(taskId: string, rest: string[]): Promise<void> {
  if (!taskId || rest.length === 0) {
    console.error('Usage: smith steer <taskId> "your instruction here"');
    console.error('       smith steer <taskId> --message "your instruction"');
    process.exit(1);
  }
  let message: string;
  if (rest[0] === '--message' || rest[0] === '-m') {
    message = rest.slice(1).join(' ');
  } else {
    message = rest.join(' ');
  }
  const { status, data } = await request('POST', `/tasks/${taskId}/steer`, {
    keys: message,
  });
  if (status === 200) {
    console.log(`\x1b[32m✓ Sent to ${taskId}\x1b[0m`);
  } else {
    const d = data as Record<string, unknown>;
    console.error(`\x1b[31m✗ ${d.error}\x1b[0m`);
  }
}

async function cmdKill(taskId: string): Promise<void> {
  if (!taskId) {
    console.error('Usage: smith kill <taskId>');
    process.exit(1);
  }
  const { status, data } = await request('POST', `/tasks/${taskId}/kill`);
  if (status === 200) {
    console.log(`\x1b[32m✓ Task ${taskId} killed\x1b[0m`);
  } else {
    const d = data as Record<string, unknown>;
    console.error(`\x1b[31m✗ ${d.error}\x1b[0m`);
  }
}

async function cmdAgents(): Promise<void> {
  const { status, data } = await request('GET', '/agents');
  if (status !== 200) {
    console.error('\x1b[31m✗ Could not fetch agents\x1b[0m');
    process.exit(1);
  }
  const d = data as {
    assigned: Array<{ name: string; taskId: string; agent: string | null; location: string | null; status: string; prompt: string | null; startedAt: string | null }>;
    available: string[];
    total: number;
  };

  console.log(`\n\x1b[1m  WORKFORCE (${d.assigned.length}/${d.total} active)\x1b[0m\n`);

  // Show all 10 seats
  const ROSTER = ['Sebastian', 'Dominic', 'Nathaniel', 'Tobias', 'Cameron', 'Samantha', 'Natasha', 'Camila', 'Olivia', 'Vanessa'];
  for (const name of ROSTER) {
    const assigned = d.assigned.find((a) => a.name === name);
    if (assigned) {
      const uptime = assigned.startedAt
        ? `${Math.round((Date.now() - new Date(assigned.startedAt).getTime()) / 1000)}s`
        : '';
      const loc = assigned.location ?? 'local';
      const locColor = loc === 'remote' ? '\x1b[35m' : loc === 'docker' ? '\x1b[36m' : '\x1b[0m';
      console.log(
        `  \x1b[32m●\x1b[0m \x1b[1m${name.padEnd(12)}\x1b[0m ${(assigned.agent ?? '').padEnd(8)} ${locColor}${loc.padEnd(8)}\x1b[0m ${assigned.status.padEnd(10)} ${uptime.padStart(6)}  \x1b[2m${(assigned.prompt ?? '').substring(0, 45)}\x1b[0m`,
      );
    } else {
      console.log(`  \x1b[2m○ ${name.padEnd(12)} idle\x1b[0m`);
    }
  }
  console.log('');
}

async function cmdWorkers(): Promise<void> {
  const { status, data } = await request('GET', '/workers');
  if (status !== 200) {
    console.error('\x1b[31m✗ Could not fetch workers\x1b[0m');
    process.exit(1);
  }
  const d = data as {
    workers: Array<{ workerId: string; name: string; capacity: number; activeCount: number; agents: string[]; runtimes: string[]; connectedAt: string; tasks: string[] }>;
    totalCapacity: number;
    totalActive: number;
    count: number;
  };

  console.log(`\n\x1b[1m  REMOTE WORKERS (${d.count} connected, ${d.totalActive}/${d.totalCapacity} busy)\x1b[0m\n`);

  if (d.workers.length === 0) {
    console.log('  \x1b[2mNo remote workers connected.\x1b[0m');
    console.log('  \x1b[2mStart one with: smith-worker --orchestrator ws://HOST:7777 --secret xxx\x1b[0m');
  } else {
    for (const w of d.workers) {
      const load = `${w.activeCount}/${w.capacity}`;
      const status = w.activeCount >= w.capacity
        ? '\x1b[31m● full\x1b[0m'
        : w.activeCount > 0
          ? '\x1b[33m● busy\x1b[0m'
          : '\x1b[32m● idle\x1b[0m';
      console.log(
        `  ${status} \x1b[1m${w.name.padEnd(16)}\x1b[0m ${load.padEnd(6)} agents: ${w.agents.join(',')}  rt: ${w.runtimes.join(',')}`,
      );
      if (w.tasks.length > 0) {
        console.log(`    \x1b[2mtasks: ${w.tasks.join(', ')}\x1b[0m`);
      }
    }
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// Squad Commands
// ---------------------------------------------------------------------------

async function cmdSquadSubmit(args: string[]): Promise<void> {
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, '');
    opts[key] = args[i + 1];
  }

  if (!opts.prompt) {
    console.error('Usage: smith squad submit --prompt "..." [--squad alpha|beta|gamma] [--mode solo|squad|council] [--agents 2-4]');
    process.exit(1);
  }

  const body: Record<string, unknown> = {
    prompt: opts.prompt,
  };
  if (opts.squad) body.squadId = opts.squad;
  if (opts.mode) body.mode = opts.mode;
  if (opts.agents) body.agents = parseInt(opts.agents, 10);

  const { status, data } = await request('POST', '/squads', body);
  if (status === 200) {
    const d = data as { squadId: string, taskId: string, leader: string, members: string[] };
    console.log(`\x1b[32m✓ Squad assigned\x1b[0m`);
    console.log(`  Squad:    ${d.squadId}`);
    console.log(`  Task ID:  ${d.taskId}`);
    console.log(`  Leader:   ${d.leader}`);
    console.log(`  Members:  ${d.members.join(', ')}`);
  } else {
    console.error(`\x1b[31m✗ Failed (${status})\x1b[0m`);
    json(data);
  }
}

async function cmdSquadList(): Promise<void> {
  const { status, data } = await request('GET', '/squads');
  if (status !== 200) {
    console.error(`\x1b[31m✗ Failed to list squads (${status})\x1b[0m`);
    return;
  }
  const d = data as { squads: { id: string, status: string, taskId: string | null }[], active: number, total: number };
  console.log(`\n\x1b[1m  SQUADS (${d.active}/${d.total} active)\x1b[0m\n`);
  
  for (const s of d.squads) {
    const isAct = s.status === 'active';
    const color = isAct ? '\x1b[32m' : '\x1b[2m';
    const leader = (s as { leader?: { name: string } }).leader?.name ?? s.id;
    console.log(`  ${color}● ${s.id.padEnd(8)}\x1b[0m ${color}(${leader}→)\x1b[0m ${s.taskId ? `[Task: ${s.taskId}]` : ''}`);
  }
  console.log();
}

async function cmdSquadStatus(id: string): Promise<void> {
  if (!id) {
    console.error('Usage: smith squad status <name|squadId>');
    process.exit(1);
  }
  const { status, data } = await request('GET', `/squads/${id}`);
  if (status !== 200) {
    console.error(`\x1b[31m✗ Failed to get status (${status})\x1b[0m`);
    json(data);
    return;
  }
  json(data);
}

async function cmdSquadOutput(id: string): Promise<void> {
  if (!id) {
    console.error('Usage: smith squad output <name|squadId>');
    process.exit(1);
  }
  const { status, data } = await request('GET', `/squads/${id}/output`);
  if (status !== 200) {
    const d = data as any;
    console.error(`\x1b[31m✗ ${d?.error || 'Failed'}\x1b[0m`);
    return;
  }
  const d = data as any;
  console.log(`\x1b[1m  Squad ${d.squadId}\x1b[0m`);
  console.log(`  Session:  ${d.sessionName}`);
  console.log(`\n\x1b[2m${'─'.repeat(60)}\x1b[0m`);
  console.log(d.output);
  console.log(`\x1b[2m${'─'.repeat(60)}\x1b[0m`);
}

async function cmdSquadKill(id: string): Promise<void> {
  if (!id) {
    console.error('Usage: smith squad kill <name|squadId>');
    process.exit(1);
  }
  const { status, data } = await request('DELETE', `/squads/${id}`);
  if (status === 200) {
    console.log(`\x1b[32m✓ Squad ${id} killed\x1b[0m`);
  } else {
    const d = data as any;
    console.error(`\x1b[31m✗ ${d?.error || 'Failed'}\x1b[0m`);
  }
}

async function cmdSquadSteer(id: string, rest: string[]): Promise<void> {
  if (!id || rest.length === 0) {
    console.error('Usage: smith squad steer <name|squadId> "message" [--pane N]');
    process.exit(1);
  }
  let message = '';
  let pane: number | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--pane') {
      pane = parseInt(rest[++i], 10);
    } else {
      message += (message ? ' ' : '') + rest[i];
    }
  }
  const body: any = { keys: message };
  if (pane !== undefined) body.pane = pane;
  
  const { status, data } = await request('POST', `/squads/${id}/steer`, body);
  if (status === 200) {
    console.log(`\x1b[32m✓ Sent to squad ${id}\x1b[0m`);
  } else {
    const d = data as any;
    console.error(`\x1b[31m✗ ${d?.error || 'Failed'}\x1b[0m`);
  }
}

async function cmdCouncilJoin(id: string): Promise<void> {
  if (!id) {
    console.error('Usage: smith council join <name|squadId>');
    process.exit(1);
  }
  const { status, data } = await request('POST', `/squads/${id}/council/join`);
  if (status === 200) {
    const d = data as any;
    console.log(`\x1b[32m✓ Joined council for squad ${d.squadId}\x1b[0m`);
    console.log(`  To interact, you can use:`);
    console.log(`  smith council overrule ${id} "your directive"`);
    console.log(`  (or attach to pane 0 manually)`);
  } else {
    const d = data as any;
    console.error(`\x1b[31m✗ ${d?.error || 'Failed'}\x1b[0m`);
  }
}

async function cmdCouncilOverrule(id: string, rest: string[]): Promise<void> {
  if (!id || rest.length === 0) {
    console.error('Usage: smith council overrule <name|squadId> "directive"');
    process.exit(1);
  }
  const directive = rest.join(' ');
  const { status, data } = await request('POST', `/squads/${id}/council/overrule`, { directive });
  if (status === 200) {
    console.log(`\x1b[32m✓ Sent directive to leader of squad ${id}\x1b[0m`);
  } else {
    const d = data as any;
    console.error(`\x1b[31m✗ ${d?.error || 'Failed'}\x1b[0m`);
  }
}

async function cmdSquad(args: string[]): Promise<void> {
  const [subCmd, ...rest] = args;
  switch (subCmd) {
    case 'submit':
      await cmdSquadSubmit(rest);
      break;
    case 'list':
    case 'ls':
      await cmdSquadList();
      break;
    case 'status':
      await cmdSquadStatus(rest[0]);
      break;
    case 'output':
      await cmdSquadOutput(rest[0]);
      break;
    case 'kill':
      await cmdSquadKill(rest[0]);
      break;
    case 'steer':
      await cmdSquadSteer(rest[0], rest.slice(1));
      break;
    default:
      if (!subCmd) {
        await cmdSquadList();
      } else {
        console.error(`Unknown squad command: ${subCmd}`);
        process.exit(1);
      }
  }
}

async function cmdCouncil(args: string[]): Promise<void> {
  const [subCmd, ...rest] = args;
  switch (subCmd) {
    case 'join':
      await cmdCouncilJoin(rest[0]);
      break;
    case 'overrule':
      await cmdCouncilOverrule(rest[0], rest.slice(1));
      break;
    default:
      console.error(`Unknown council command: ${subCmd}`);
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === '--help' || command === '-h') {
    console.log(`
\x1b[1msmith\x1b[0m — CLI for the agent orchestrator server

\x1b[1mTask Management:\x1b[0m
  smith submit    --agent <name> --prompt "..."  Submit a task
  smith list                                     List all tasks
  smith status    <name|taskId>                  Get task status
  smith cancel    <name|taskId>                  Cancel / kill a task

\x1b[1mAgent Control (use names!):\x1b[0m
  smith agents                                   Show 10-seat roster
  smith output    <name>                         Live output (e.g. smith output Tobias)
  smith steer     <name> "instruction"           Steer agent (e.g. smith steer Natasha "...")
  smith kill      <name>                         Force-kill (e.g. smith kill Cameron)

\x1b[1mMonitoring:\x1b[0m
  smith dashboard                                Live TUI dashboard
  smith health                                   Server health check
  smith workers                                  List connected remote workers
  smith quarantine                               List quarantined tasks
  smith quarantine release <taskId>              Release from quarantine

\x1b[1mSquad Operations:\x1b[0m
  smith squad submit --prompt "..." [--squad alpha]   Submit squad task
  smith squad list                                    List all squads
  smith squad status <name|squad>                     Squad status
  smith squad output <name|squad>                     Squad output
  smith squad kill <name|squad>                       Kill squad
  smith squad steer <name|squad> "msg" [--pane N]     Steer pane
  smith council join <name|squad>                     Join as human
  smith council overrule <name|squad> "directive"     Override leader

\x1b[1mSubmit options:\x1b[0m
  --agent      claude | agy | codex              (required)
  --prompt     "Task description"                (required)
  --runtime    tmux | docker                     (optional)
  --priority   normal | high                     (optional)
  --branch     Git branch                        (optional)
  --files      file1.ts,file2.ts                 (optional)

\x1b[1mEnvironment:\x1b[0m
  SMITH_SERVER_URL   Server URL (default: http://localhost:7777)
`);
    process.exit(0);
  }

  switch (command) {
    case 'submit':
      await cmdSubmit(args);
      break;
    case 'list':
    case 'ls':
      await cmdList();
      break;
    case 'status':
    case 'get':
      await cmdStatus(args[0]);
      break;
    case 'cancel':
    case 'rm':
      await cmdCancel(args[0]);
      break;
    case 'output':
    case 'out':
    case 'log':
      await cmdOutput(args[0]);
      break;
    case 'steer':
    case 'send':
      await cmdSteer(args[0], args.slice(1));
      break;
    case 'kill':
    case 'stop':
      await cmdKill(args[0]);
      break;
    case 'health':
    case 'ping':
      await cmdHealth();
      break;
    case 'agents':
    case 'roster':
    case 'who':
      await cmdAgents();
      break;
    case 'dashboard':
    case 'dash':
    case 'ui': {
      const { main: dashMain } = await import('./dashboard.js');
      await dashMain();
      break;
    }
    case 'quarantine':
    case 'q':
      await cmdQuarantine(args[0], args[1]);
      break;
    case 'workers':
    case 'remotes':
      await cmdWorkers();
      break;
    case 'squad':
    case 'squads':
      await cmdSquad(args);
      break;
    case 'council':
      await cmdCouncil(args);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Run "smith --help" for usage.');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

