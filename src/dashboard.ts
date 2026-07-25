#!/usr/bin/env node
// ---------------------------------------------------------------------------
// @smith/agent-orchestrator — TUI Dashboard
//
// Live terminal dashboard for monitoring all running agents.
// Connects to the server via WebSocket for real-time events
// and polls /tasks + /health for state.
//
// Usage:
//   smith dashboard
//   smith dashboard --refresh 2
//
// Keybindings:
//   q / Ctrl+C   Quit
//   r            Force refresh
//   1-9          Select agent slot (for output/steer)
//   o            Show output of selected agent
//   k            Kill selected agent
//   s            Steer selected agent (prompts for input)
//   h            Toggle help overlay
// ---------------------------------------------------------------------------

import { WebSocket } from 'ws';

const BASE_URL = process.env.SMITH_SERVER_URL ?? 'http://localhost:7777';
const WS_URL = BASE_URL.replace(/^http/, 'ws') + '/ws';

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const ESC = '\x1b';
const CSI = `${ESC}[`;

const ansi = {
  clear: `${CSI}2J${CSI}H`,
  cursorHide: `${CSI}?25l`,
  cursorShow: `${CSI}?25h`,
  cursorTo: (row: number, col: number) => `${CSI}${row};${col}H`,
  bold: (s: string) => `${CSI}1m${s}${CSI}0m`,
  dim: (s: string) => `${CSI}2m${s}${CSI}0m`,
  green: (s: string) => `${CSI}32m${s}${CSI}0m`,
  red: (s: string) => `${CSI}31m${s}${CSI}0m`,
  yellow: (s: string) => `${CSI}33m${s}${CSI}0m`,
  cyan: (s: string) => `${CSI}36m${s}${CSI}0m`,
  magenta: (s: string) => `${CSI}35m${s}${CSI}0m`,
  bgBlue: (s: string) => `${CSI}44m${CSI}97m${s}${CSI}0m`,
  bgRed: (s: string) => `${CSI}41m${CSI}97m${s}${CSI}0m`,
  bgGreen: (s: string) => `${CSI}42m${CSI}97m${s}${CSI}0m`,
  bgYellow: (s: string) => `${CSI}43m${CSI}30m${s}${CSI}0m`,
  underline: (s: string) => `${CSI}4m${s}${CSI}0m`,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HealthData {
  status: string;
  uptime: number;
  activeTasks: number;
  queuedTasks: number;
  completedTasks: number;
  maxConcurrent: number;
  memory: { rss: number; heap: number };
}

interface TaskInfo {
  taskId: string;
  agentName?: string;
  status: string;
  agent?: string;
  runtime?: string;
  startedAt?: string;
  position?: number;
  exitCode?: number;
  durationMs?: number;
}

interface TasksData {
  active: TaskInfo[];
  queued: TaskInfo[];
  completed: TaskInfo[];
}

interface AgentSeat {
  name: string;
  taskId?: string;
  agent?: string;
  location?: string;
  status?: string;
  prompt?: string;
  startedAt?: string;
}

interface AgentsData {
  assigned: AgentSeat[];
  available: string[];
  total: number;
}

interface TasksData {
  active: TaskInfo[];
  queued: TaskInfo[];
  completed: TaskInfo[];
}

interface DashboardState {
  health: HealthData | null;
  tasks: TasksData | null;
  agents: AgentsData | null;
  events: string[];
  selectedIdx: number;
  showHelp: boolean;
  showOutput: boolean;
  outputContent: string;
  error: string | null;
  connected: boolean;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

class Dashboard {
  private state: DashboardState = {
    health: null,
    tasks: null,
    agents: null,
    events: [],
    selectedIdx: 0,
    showHelp: false,
    showOutput: false,
    outputContent: '',
    error: null,
    connected: false,
  };

  private refreshMs: number;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private ws: WebSocket | null = null;

  constructor(refreshMs = 2000) {
    this.refreshMs = refreshMs;
  }

  async start(): Promise<void> {
    // Setup terminal
    process.stdout.write(ansi.cursorHide);
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (key: string) => this.handleKey(key));

    // Connect WebSocket
    this.connectWebSocket();

    // Initial fetch + start polling
    await this.refresh();
    this.refreshTimer = setInterval(() => this.refresh(), this.refreshMs);

    // Render
    this.render();
  }

  stop(): void {
    process.stdout.write(ansi.cursorShow);
    process.stdout.write(ansi.clear);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.ws) this.ws.close();
    process.stdin.setRawMode?.(false);
    process.exit(0);
  }

  // -------------------------------------------------------------------------
  // Data fetching
  // -------------------------------------------------------------------------

  private async refresh(): Promise<void> {
    try {
      const [healthRes, tasksRes, agentsRes] = await Promise.all([
        fetch(`${BASE_URL}/health`).then((r) => r.json()),
        fetch(`${BASE_URL}/tasks`).then((r) => r.json()),
        fetch(`${BASE_URL}/agents`).then((r) => r.json()),
      ]);
      this.state.health = healthRes as HealthData;
      this.state.tasks = tasksRes as TasksData;
      this.state.agents = agentsRes as AgentsData;
      this.state.error = null;
    } catch {
      this.state.error = `Cannot reach ${BASE_URL}`;
    }
    this.render();
  }

  private connectWebSocket(): void {
    try {
      this.ws = new WebSocket(WS_URL);
      this.ws.on('open', () => {
        this.state.connected = true;
        this.addEvent('WebSocket connected');
        this.render();
      });
      this.ws.on('message', (data: Buffer) => {
        try {
          const event = JSON.parse(data.toString());
          const msg = `${event.type ?? 'event'}: ${event.taskId ?? ''}`;
          this.addEvent(msg);
          // Auto-refresh on task events
          this.refresh();
        } catch {
          // ignore parse errors
        }
      });
      this.ws.on('close', () => {
        this.state.connected = false;
        this.addEvent('WebSocket disconnected');
        this.render();
        // Reconnect after 3s
        setTimeout(() => this.connectWebSocket(), 3000);
      });
      this.ws.on('error', () => {
        this.state.connected = false;
      });
    } catch {
      this.state.connected = false;
    }
  }

  private addEvent(msg: string): void {
    const ts = new Date().toLocaleTimeString();
    this.state.events.unshift(`${ansi.dim(ts)} ${msg}`);
    if (this.state.events.length > 20) this.state.events.pop();
  }

  // -------------------------------------------------------------------------
  // Keyboard handling
  // -------------------------------------------------------------------------

  private handleKey(key: string): void {
    if (key === 'q' || key === '\x03') { // q or Ctrl+C
      this.stop();
    } else if (key === 'r') {
      this.refresh();
    } else if (key === 'h') {
      this.state.showHelp = !this.state.showHelp;
      this.state.showOutput = false;
      this.render();
    } else if (key === 'o') {
      this.fetchOutput();
    } else if (key === 'k') {
      this.killSelected();
    } else if (key === 's') {
      this.steerSelected();
    } else if (key >= '1' && key <= '9') {
      this.state.selectedIdx = parseInt(key, 10) - 1;
      this.state.showOutput = false;
      this.render();
    } else if (key === '\x1b[A') { // Up arrow
      if (this.state.selectedIdx > 0) this.state.selectedIdx--;
      this.render();
    } else if (key === '\x1b[B') { // Down arrow
      this.state.selectedIdx++;
      this.render();
    } else if (key === '\x1b') { // Escape
      this.state.showHelp = false;
      this.state.showOutput = false;
      this.render();
    }
  }

  private getSelectedTask(): TaskInfo | null {
    const active = this.state.tasks?.active ?? [];
    if (this.state.selectedIdx >= 0 && this.state.selectedIdx < active.length) {
      return active[this.state.selectedIdx];
    }
    return null;
  }

  private async fetchOutput(): Promise<void> {
    const task = this.getSelectedTask();
    if (!task) return;
    try {
      const res = await fetch(`${BASE_URL}/tasks/${task.taskId}/output`);
      if (res.ok) {
        const data = await res.json() as Record<string, unknown>;
        this.state.outputContent = data.output as string;
        this.state.showOutput = true;
        this.state.showHelp = false;
      } else {
        this.addEvent(`Output failed for ${task.taskId}`);
      }
    } catch {
      this.addEvent(`Output fetch error for ${task.taskId}`);
    }
    this.render();
  }

  private async killSelected(): Promise<void> {
    const task = this.getSelectedTask();
    if (!task) return;
    try {
      await fetch(`${BASE_URL}/tasks/${task.taskId}/kill`, { method: 'POST' });
      this.addEvent(`Killed ${task.taskId}`);
    } catch {
      this.addEvent(`Kill failed for ${task.taskId}`);
    }
    await this.refresh();
  }

  private steerSelected(): void {
    const task = this.getSelectedTask();
    if (!task) return;

    // Exit raw mode briefly for input
    process.stdout.write(ansi.cursorShow);
    process.stdin.setRawMode?.(false);
    process.stdout.write(`\n${ansi.cyan('Steer')} ${task.taskId}: `);

    const lines: string[] = [];
    const onData = (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) {
        lines.push(line);
        process.stdin.removeListener('data', onData);
        process.stdin.setRawMode?.(true);
        process.stdout.write(ansi.cursorHide);

        fetch(`${BASE_URL}/tasks/${task.taskId}/steer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ keys: lines[0] }),
        })
          .then(() => this.addEvent(`Steered ${task.taskId}: ${lines[0].substring(0, 40)}`))
          .catch(() => this.addEvent(`Steer failed for ${task.taskId}`))
          .finally(() => this.render());
      }
    };
    process.stdin.on('data', onData);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private render(): void {
    const { columns: w, rows: h } = process.stdout;
    const lines: string[] = [];

    // ── Header ──
    const wsStatus = this.state.connected
      ? ansi.green('● WS')
      : ansi.red('○ WS');
    const title = ` ${ansi.bold('SMITH ORCHESTRATOR')} `;
    const healthTag = this.state.health
      ? ansi.bgGreen(' ONLINE ')
      : ansi.bgRed(' OFFLINE ');

    lines.push(ansi.bgBlue(` ${title}${' '.repeat(Math.max(0, w - title.length - 25))}${healthTag} ${wsStatus} `));

    if (this.state.error) {
      lines.push(ansi.red(`  ✗ ${this.state.error}`));
      lines.push('');
    }

    // ── Health bar ──
    if (this.state.health) {
      const hl = this.state.health;
      const bar = `  Active: ${ansi.bold(String(hl.activeTasks))}/${hl.maxConcurrent}  │  Queued: ${ansi.bold(String(hl.queuedTasks))}  │  Done: ${ansi.bold(String(hl.completedTasks))}  │  RAM: ${hl.memory.rss}MB  │  Uptime: ${formatUptime(hl.uptime)}`;
      lines.push(bar);
      lines.push(ansi.dim('─'.repeat(w)));
    }

    // ── Show output overlay ──
    if (this.state.showOutput) {
      const task = this.getSelectedTask();
      lines.push(ansi.bold(`  Output: ${task?.taskId ?? '?'} (${task?.agent ?? '?'})  `) + ansi.dim('[ESC to close]'));
      lines.push(ansi.dim('─'.repeat(w)));
      const outputLines = this.state.outputContent.split('\n').slice(-(h - 10));
      for (const line of outputLines) {
        lines.push(`  ${line.substring(0, w - 4)}`);
      }
      lines.push(ansi.dim('─'.repeat(w)));
      this.flush(lines, h);
      return;
    }

    // ── Show help overlay ──
    if (this.state.showHelp) {
      lines.push('');
      lines.push(ansi.bold('  Keybindings'));
      lines.push(ansi.dim('  ─────────────────────────────'));
      lines.push(`  ${ansi.cyan('1-9')}     Select agent slot`);
      lines.push(`  ${ansi.cyan('↑/↓')}     Navigate agents`);
      lines.push(`  ${ansi.cyan('o')}       Output of selected agent`);
      lines.push(`  ${ansi.cyan('s')}       Steer selected agent`);
      lines.push(`  ${ansi.cyan('k')}       Kill selected agent`);
      lines.push(`  ${ansi.cyan('r')}       Force refresh`);
      lines.push(`  ${ansi.cyan('h')}       Toggle this help`);
      lines.push(`  ${ansi.cyan('q')}       Quit`);
      lines.push('');
      this.flush(lines, h);
      return;
    }

    // ── Active agents table ──
    // ── 10-Seat Roster ──
    const ROSTER = ['Sebastian', 'Dominic', 'Nathaniel', 'Tobias', 'Cameron', 'Samantha', 'Natasha', 'Camila', 'Olivia', 'Vanessa'];
    const assigned = this.state.agents?.assigned ?? [];
    const activeCount = assigned.length;

    lines.push('');
    lines.push(ansi.bold(`  WORKFORCE (${activeCount}/10)`));
    lines.push(
      `  ${ansi.dim('#')}  ${pad('NAME', 12)} ${pad('TOOL', 8)} ${pad('LOC', 8)} ${pad('STATUS', 10)} ${pad('UPTIME', 8)} ${ansi.dim('TASK')}`,
    );
    lines.push(ansi.dim('  ' + '─'.repeat(Math.min(w - 4, 80))));

    for (let i = 0; i < ROSTER.length; i++) {
      const name = ROSTER[i];
      const seat = assigned.find((a) => a.name === name);
      const sel = i === this.state.selectedIdx ? ansi.cyan('▶') : ' ';
      const idx = ansi.dim(String(i + 1));

      if (seat && seat.taskId) {
        const status = seat.status === 'running'
          ? ansi.green('● running')
          : ansi.yellow('◐ ' + (seat.status ?? '?'));
        const uptime = seat.startedAt
          ? formatUptime((Date.now() - new Date(seat.startedAt).getTime()) / 1000)
          : '-';
        const highlight = i === this.state.selectedIdx
          ? (s: string) => ansi.cyan(s)
          : (s: string) => s;
        const prompt = seat.prompt ? ansi.dim(seat.prompt.substring(0, 35)) : '';
        const loc = seat.location ?? 'local';
        const locStr = loc === 'remote' ? ansi.magenta(pad(loc, 8))
          : loc === 'docker' ? ansi.cyan(pad(loc, 8))
          : pad(loc, 8);

        lines.push(
          `${sel} ${idx}  ${highlight(pad(name, 12))} ${pad(seat.agent ?? '-', 8)} ${locStr} ${status}${' '.repeat(Math.max(0, 10 - stripAnsi(status).length))} ${pad(uptime, 8)} ${prompt}`,
        );
      } else {
        const highlight = i === this.state.selectedIdx
          ? (s: string) => ansi.cyan(s)
          : (s: string) => ansi.dim(s);
        lines.push(
          `${sel} ${idx}  ${highlight(pad(name, 12))} ${ansi.dim(pad('-', 8))} ${ansi.dim('○ idle')}`,
        );
      }
    }

    // ── Queued ──
    const queued = this.state.tasks?.queued ?? [];
    if (queued.length > 0) {
      lines.push('');
      lines.push(ansi.bold(`  QUEUE (${queued.length})`));
      for (const t of queued.slice(0, 5)) {
        lines.push(`  ${ansi.yellow('◻')} #${t.position ?? '?'}  ${shortId(t.taskId)}  ${t.agent ?? '-'}`);
      }
      if (queued.length > 5) {
        lines.push(ansi.dim(`  ... and ${queued.length - 5} more`));
      }
    }

    // ── Recent completed ──
    const completed = this.state.tasks?.completed ?? [];
    if (completed.length > 0) {
      lines.push('');
      lines.push(ansi.bold(`  RECENT (${completed.length})`));
      for (const t of completed.slice(0, 5)) {
        const icon = t.status === 'completed' || t.exitCode === 0
          ? ansi.green('✓')
          : ansi.red('✗');
        const dur = t.durationMs ? `${Math.round(t.durationMs / 1000)}s` : '-';
        lines.push(`  ${icon} ${shortId(t.taskId)}  exit ${t.exitCode ?? '?'}  ${ansi.dim(dur)}`);
      }
    }

    // ── Event log ──
    const eventsSpace = Math.max(3, h - lines.length - 4);
    lines.push('');
    lines.push(ansi.dim('─'.repeat(w)));
    lines.push(ansi.bold('  EVENT LOG'));
    for (const ev of this.state.events.slice(0, eventsSpace)) {
      lines.push(`  ${ev}`);
    }

    // ── Footer ──
    lines.push('');
    lines.push(ansi.dim(`  [h] help  [o] output  [s] steer  [k] kill  [r] refresh  [q] quit   ${BASE_URL}`));

    this.flush(lines, h);
  }

  private flush(lines: string[], maxRows: number): void {
    process.stdout.write(ansi.clear);
    const output = lines.slice(0, maxRows).join('\n');
    process.stdout.write(output);
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function pad(s: string, n: number): string {
  return s.length >= n ? s.substring(0, n) : s + ' '.repeat(n - s.length);
}

function shortId(id: string): string {
  return id.length > 12 ? id.substring(0, 12) : id;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let refreshMs = 2000;

  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === '--refresh') refreshMs = parseInt(args[i + 1], 10) * 1000;
  }

  const dashboard = new Dashboard(refreshMs);

  process.on('SIGINT', () => dashboard.stop());
  process.on('SIGTERM', () => dashboard.stop());

  await dashboard.start();
}

// Run if executed directly
const isDirect = process.argv[1]?.endsWith('dashboard.ts') ||
                 process.argv[1]?.endsWith('dashboard.js');
if (isDirect) {
  main().catch((err) => {
    process.stdout.write(ansi.cursorShow);
    console.error(err);
    process.exit(1);
  });
}
