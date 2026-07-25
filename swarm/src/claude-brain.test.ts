import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeBrain } from './claude-brain.js';
import type { ComposedAgent } from './agents.js';

const AGENT: ComposedAgent = {
  id: 'manuel',
  name: 'Manuel',
  role: 'The Architect',
  directives: 'Own multi-tenant routing. Voice: warm, human, conversational.',
  engine: { cli: 'claude', model: 'claude-opus' },
};

function fakeJson(result: string) {
  return JSON.stringify({ type: 'result', subtype: 'success', result });
}

function makeFakeRun() {
  const calls: { args: string[]; input: string; env: NodeJS.ProcessEnv }[] = [];
  let reply = 'ok';
  const run = async (args: string[], input: string, env: NodeJS.ProcessEnv) => {
    calls.push({ args, input, env });
    return fakeJson(reply);
  };
  return { calls, run, setReply: (r: string) => (reply = r) };
}

test('turn() builds the first-turn argv, strips ANTHROPIC_API_KEY, and returns the parsed reply', async () => {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-should-not-reach-child';
  try {
    const { calls, run, setReply } = makeFakeRun();
    setReply('Hello, I am Manuel.');
    const brain = new ClaudeBrain(AGENT, { model: AGENT.engine.model }, { run });

    const reply = await brain.turn('Introduce yourself.');

    assert.equal(reply, 'Hello, I am Manuel.');
    assert.equal(calls.length, 1);
    const { args, env } = calls[0];

    assert.ok(args.includes('-p'));
    assert.ok(args.includes('--output-format'));
    assert.ok(args.includes('json'));
    assert.ok(args.includes('--model'));
    assert.equal(args[args.indexOf('--model') + 1], AGENT.engine.model);
    assert.ok(args.includes('--append-system-prompt'));
    assert.equal(args[args.indexOf('--append-system-prompt') + 1], AGENT.directives);
    assert.ok(args.includes('--session-id'));
    assert.equal(args[args.indexOf('--session-id') + 1], brain.sessionId);
    assert.ok(!args.includes('--resume'), 'first turn must not resume');

    assert.equal(env.ANTHROPIC_API_KEY, undefined);
  } finally {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
  }
});

test('a second turn() resumes the same session instead of starting a new one', async () => {
  const { calls, run } = makeFakeRun();
  const brain = new ClaudeBrain(AGENT, { model: AGENT.engine.model }, { run });
  const sessionIdBefore = brain.sessionId;

  await brain.turn('first message');
  await brain.turn('what did I just ask?');

  assert.equal(calls.length, 2);
  const second = calls[1];
  assert.ok(second.args.includes('--resume'));
  assert.equal(second.args[second.args.indexOf('--resume') + 1], sessionIdBefore);
  assert.ok(!second.args.includes('--session-id'), 'resumed turn must not pass --session-id');
  assert.equal(brain.sessionId, sessionIdBefore);
});

test('model defaults to claude-haiku-4-5 when opts.model is omitted', async () => {
  const { calls, run } = makeFakeRun();
  const brain = new ClaudeBrain(AGENT, undefined, { run });
  await brain.turn('hi');
  assert.equal(calls[0].args[calls[0].args.indexOf('--model') + 1], 'claude-haiku-4-5');
});
