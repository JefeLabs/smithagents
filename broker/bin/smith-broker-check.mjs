#!/usr/bin/env node
// smith-broker-check — poll a delegation's status via the broker, using the
// taskId printed by smith-broker-send.
//
// Usage: smith-broker-check <taskId>
// Env:   SMITH_BROKER_URL (default http://127.0.0.1:7790)
//
// Prints {"status","prUrl","raw"} to stdout and exits 0 for any known task
// (including status:"failed" — that's a real answer, not an error). Exits 1
// on an unknown taskId or a broker/network failure; 2 on bad usage.
const BROKER_URL = (process.env.SMITH_BROKER_URL ?? 'http://127.0.0.1:7790').replace(/\/$/, '');
const TOKEN = process.env.SMITH_BROKER_TOKEN;

const [taskId] = process.argv.slice(2);
if (!taskId) {
  console.error('usage: smith-broker-check <taskId>');
  process.exit(2);
}

let res;
try {
  res = await fetch(`${BROKER_URL}/tasks/${encodeURIComponent(taskId)}`, {
    headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : undefined,
  });
} catch (err) {
  console.error(`could not reach the broker at ${BROKER_URL}: ${err.message}`);
  process.exit(1);
}

const body = await res.json().catch(() => ({}));

if (!res.ok) {
  console.error(body.error ?? `broker GET /tasks/${taskId} -> ${res.status}`);
  process.exit(1);
}

const result = body.result ?? {};
console.log(JSON.stringify({ status: body.status, prUrl: result.pullRequestUrl, raw: body }));
process.exit(0);
