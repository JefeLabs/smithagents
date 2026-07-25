# Smith Agents

A fire-and-forget AI agent swarm controller that manages named agents running concurrently across local and remote machines.

## Quick Start

```bash
npm install
npm run typecheck
npm run serve        # Start orchestrator on :7777
```

In another terminal:

```bash
npx tsx src/cli.ts submit --agent claude --prompt "Fix the login bug"
npx tsx src/cli.ts agents
npx tsx src/cli.ts dashboard
```

## Binaries

After `npm run build`:

```bash
smith submit --agent claude --prompt "..."
smith agents
smith dashboard
smith squad submit --prompt "Build the feature" --mode squad
smith council join alpha
smith-worker --orchestrator ws://HOST:7777 --secret "xxx"
```

## Documentation

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full system specification.
