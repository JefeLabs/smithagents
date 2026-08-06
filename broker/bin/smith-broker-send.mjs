#!/usr/bin/env node
// smith-broker-send — hand a PRD to the broker for delegation, from an
// external tool (Claude Code, Copilot) running on the same machine as the
// broker. The PRD is sent as a file-path reference, never inlined — the
// delegated agent reads it itself once it has repo access in its worktree.
//
// Usage: smith-broker-send <prd-path> [instruction...]
// Env:   SMITH_BROKER_URL (default http://127.0.0.1:7790)
//        SMITH_BRIDGE_SOURCE (default "bridge") — tags the transcript with
//          the calling tool's identity, e.g. "claude-code" or "copilot".
//        SMITH_BROKER_SEND_TIMEOUT_MS (default 45000)
//
// On success: prints {"taskId","agent","task"} to stdout, exits 0. Pass
// taskId to smith-broker-check to poll for completion.
// On timeout with no delegation: prints the brain's last reply to stderr,
// exits 1 — the brain didn't delegate (declined, or asked a question).
import { WebSocket } from 'ws';

const BROKER_URL = (process.env.SMITH_BROKER_URL ?? 'http://127.0.0.1:7790').replace(/\/$/, '');
const BROKER_WS = `${BROKER_URL.replace(/^http/, 'ws')}/events`;
const SOURCE = process.env.SMITH_BRIDGE_SOURCE ?? 'bridge';
const TIMEOUT_MS = Number(process.env.SMITH_BROKER_SEND_TIMEOUT_MS ?? 45000);

const [prdPath, ...rest] = process.argv.slice(2);
if (!prdPath) {
  console.error('usage: smith-broker-send <prd-path> [instruction...]');
  process.exit(2);
}
const instruction = rest.join(' ');
const text = `Edwin (via ${SOURCE}): delegate ${prdPath}${instruction ? ` — ${instruction}` : ''}`;

const ws = new WebSocket(BROKER_WS);

const result = await new Promise((resolve, reject) => {
  let lastSpeech = null;
  const timer = setTimeout(() => resolve({ dispatched: null, reply: lastSpeech }), TIMEOUT_MS);

  ws.on('error', (err) => {
    clearTimeout(timer);
    reject(err);
  });

  ws.on('message', (data) => {
    let frame;
    try {
      frame = JSON.parse(String(data));
    } catch {
      return;
    }
    if (frame.type === 'task-dispatched') {
      clearTimeout(timer);
      resolve({ dispatched: frame, reply: null });
    } else if (frame.type === 'utterance' || frame.type === 'speech') {
      lastSpeech = frame.text;
    }
  });

  ws.on('open', () => {
    fetch(`${BROKER_URL}/utterance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    }).catch((err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
});

ws.close();

if (result.dispatched) {
  console.log(JSON.stringify({ taskId: result.dispatched.taskId, agent: result.dispatched.agent, task: result.dispatched.task }));
  process.exit(0);
} else {
  console.error(result.reply ?? '(no reply from the broker within the timeout — is it running?)');
  process.exit(1);
}
