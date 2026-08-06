import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrokerBrain, type BrainStreamLike, type StreamFactory, type ToolExecutors } from './brain.ts';

type FinalMsg = Awaited<ReturnType<BrainStreamLike['finalMessage']>>;

/** Scripted fake: each call to the factory pops the next scripted response. */
function scripted(responses: Array<{ textDeltas: string[]; final: FinalMsg }>): {
  factory: StreamFactory;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  const factory: StreamFactory = (params) => {
    calls.push(params as unknown as Record<string, unknown>);
    const r = responses.shift();
    if (!r) throw new Error('no scripted response left');
    const textCbs: Array<(d: string) => void> = [];
    return {
      on(event, cb) {
        if (event === 'text') textCbs.push(cb);
      },
      async finalMessage() {
        for (const cb of textCbs) for (const d of r.textDeltas) cb(d);
        return r.final;
      },
    };
  };
  return { factory, calls };
}

const NOOP_EXEC: ToolExecutors = {
  delegate: async () => 'ok',
  check_status: async () => 'ok',
  raise_hand: async () => 'ok',
  remember: async () => 'ok',
  lookup_ticket: async () => 'ok',
  search_docs: async () => 'ok',
  draft_agent: async () => 'ok',
  confirm_agent: async () => 'ok',
};

test('plain text answer streams to onSpeech as chunks', async () => {
  const { factory } = scripted([
    {
      textDeltas: ['Sure — the meeting orchestrator is healthy. ', 'All nine tests pass.'],
      final: { content: [{ type: 'text', text: 'Sure — ...' }], stop_reason: 'end_turn' },
    },
  ]);
  const spoken: string[] = [];
  const brain = new BrokerBrain(factory, NOOP_EXEC);
  await brain.handleUtterance('how are the tests?', { roster: 'Manuel — idle', onSpeech: (c) => spoken.push(c) });
  assert.ok(spoken.length >= 1);
  assert.match(spoken.join(' '), /nine tests pass/);
});

test('tool_use runs the executor and continues with tool_result', async () => {
  const { factory, calls } = scripted([
    {
      textDeltas: ['On it. '],
      final: {
        content: [
          { type: 'text', text: 'On it. ' },
          { type: 'tool_use', id: 'tu_1', name: 'delegate', input: { agent: 'Octavio', task: 'refactor auth' } },
        ],
        stop_reason: 'tool_use',
      },
    },
    {
      textDeltas: ['Octavio is on it — task queued.'],
      final: { content: [{ type: 'text', text: 'Octavio is on it — task queued.' }], stop_reason: 'end_turn' },
    },
  ]);
  const delegated: unknown[] = [];
  const exec: ToolExecutors = {
    ...NOOP_EXEC,
    delegate: async (input) => {
      delegated.push(input);
      return 'queued as task t-42';
    },
  };
  const spoken: string[] = [];
  const brain = new BrokerBrain(factory, exec);
  await brain.handleUtterance('have octavio refactor auth', { roster: 'Octavio — idle', onSpeech: (c) => spoken.push(c) });

  assert.deepEqual(delegated, [{ agent: 'Octavio', task: 'refactor auth' }]);
  assert.equal(calls.length, 2);
  const second = calls[1]!.messages as Array<{ role: string; content: unknown }>;
  const toolResult = second.at(-1)!;
  assert.equal(toolResult.role, 'user');
  assert.match(JSON.stringify(toolResult.content), /queued as task t-42/);
  assert.match(spoken.join(' '), /Octavio is on it/);
});

test('roster is injected into the system prompt; history is capped', async () => {
  const responses = Array.from({ length: 12 }, (_, i) => ({
    textDeltas: [`reply ${i}.`],
    final: { content: [{ type: 'text' as const, text: `reply ${i}.` }], stop_reason: 'end_turn' },
  }));
  const { factory, calls } = scripted(responses);
  const brain = new BrokerBrain(factory, NOOP_EXEC, { maxHistory: 6 });
  for (let i = 0; i < 12; i++) {
    await brain.handleUtterance(`utterance ${i}`, { roster: 'ROSTER-MARK', onSpeech: () => {} });
  }
  assert.match(String(calls.at(-1)!.system), /ROSTER-MARK/);
  assert.ok((calls.at(-1)!.messages as unknown[]).length <= 7); // 6 history + current user turn
});

test('history trim respects turn boundaries even after a tool-use turn', async () => {
  const { factory, calls } = scripted([
    // Turn 1, round 0: tool_use
    {
      textDeltas: ['On it. '],
      final: {
        content: [
          { type: 'text', text: 'On it. ' },
          { type: 'tool_use', id: 'tu_1', name: 'delegate', input: { agent: 'Octavio', task: 'refactor auth' } },
        ],
        stop_reason: 'tool_use',
      },
    },
    // Turn 1, round 1: closing text
    {
      textDeltas: ['Queued.'],
      final: { content: [{ type: 'text', text: 'Queued.' }], stop_reason: 'end_turn' },
    },
    // Turn 2: plain text
    {
      textDeltas: ['ack 2.'],
      final: { content: [{ type: 'text', text: 'ack 2.' }], stop_reason: 'end_turn' },
    },
    // Turn 3: plain text
    {
      textDeltas: ['ack 3.'],
      final: { content: [{ type: 'text', text: 'ack 3.' }], stop_reason: 'end_turn' },
    },
  ]);
  const brain = new BrokerBrain(factory, NOOP_EXEC, { maxHistory: 4 });
  await brain.handleUtterance('have octavio refactor auth', { roster: 'ROSTER', onSpeech: () => {} });
  await brain.handleUtterance('utterance 2', { roster: 'ROSTER', onSpeech: () => {} });
  await brain.handleUtterance('utterance 3', { roster: 'ROSTER', onSpeech: () => {} });

  const lastMessages = calls.at(-1)!.messages as Array<{ role: string; content: unknown }>;
  assert.equal(lastMessages[0]!.role, 'user');
  assert.equal(typeof lastMessages[0]!.content, 'string');
});

test('the final permitted tool round forces a text-only reply via tool_choice: none', async () => {
  const toolUseResponse = (id: string) => ({
    textDeltas: [] as string[],
    final: {
      content: [{ type: 'tool_use', id, name: 'delegate', input: { agent: 'Octavio', task: 'work' } }],
      stop_reason: 'tool_use',
    },
  });
  const { factory, calls } = scripted([
    toolUseResponse('tu_1'),
    toolUseResponse('tu_2'),
    toolUseResponse('tu_3'),
    {
      textDeltas: ['Wrapping up now.'],
      final: { content: [{ type: 'text', text: 'Wrapping up now.' }], stop_reason: 'end_turn' },
    },
  ]);
  const spoken: string[] = [];
  const brain = new BrokerBrain(factory, NOOP_EXEC);
  await brain.handleUtterance('keep delegating', { roster: 'ROSTER', onSpeech: (c) => spoken.push(c) });

  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0]!.tool_choice, undefined);
  assert.deepEqual(calls[1]!.tool_choice, undefined);
  assert.deepEqual(calls[2]!.tool_choice, undefined);
  assert.deepEqual(calls[3]!.tool_choice, { type: 'none' });
  assert.match(spoken.join(' '), /Wrapping up now/);
});

test('round boundary flushes speech: pre-tool text never merges with next round', async () => {
  const { factory } = scripted([
    {
      textDeltas: ['Gabriel: Let me scan for pain points.'], // no trailing whitespace
      final: {
        content: [
          { type: 'text', text: 'Gabriel: Let me scan for pain points.' },
          { type: 'tool_use', id: 'tu_9', name: 'delegate', input: { agent: 'Aurelio', task: 'scan' } },
        ],
        stop_reason: 'tool_use',
      },
    },
    {
      textDeltas: ["Gabriel: Aurelio is on it now."],
      final: { content: [{ type: 'text', text: "Gabriel: Aurelio is on it now." }], stop_reason: 'end_turn' },
    },
  ]);
  const spoken: string[] = [];
  const brain = new BrokerBrain(factory, NOOP_EXEC);
  await brain.handleUtterance('alpha: go', { roster: 'r', onSpeech: (c) => spoken.push(c) });
  assert.deepEqual(spoken, ['Gabriel: Let me scan for pain points.', 'Gabriel: Aurelio is on it now.']);
});

test('system prompt carries the host identity: name, role, style, host rules', async () => {
  const { factory, calls } = scripted([
    { textDeltas: ['Anderson: Aquí estamos.'], final: { content: [{ type: 'text', text: 'Anderson: Aquí estamos.' }], stop_reason: 'end_turn' } },
  ]);
  const brain = new BrokerBrain(factory, NOOP_EXEC);
  await brain.handleUtterance('hey anderson', { roster: 'Manuel — idle', onSpeech: () => {} });
  const system = String(calls[0]!.system);
  assert.match(system, /Anderson \(Chief of Staff\)/);
  assert.match(system, /never takes delegated work/i);
  assert.match(system, /session-open greeting/i);
  assert.match(system, /"Hey team" \/ "everyone" addresses the crew/);
  assert.match(system, /Manuel — idle/); // roster still appended after the persona
});

test('a custom identity replaces Anderson throughout the prompt', async () => {
  const { factory, calls } = scripted([
    { textDeltas: ['x'], final: { content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn' } },
  ]);
  const brain = new BrokerBrain(factory, NOOP_EXEC, {
    identity: { name: 'Smith', role: 'Concierge', style: 'Clipped.' },
  });
  await brain.handleUtterance('hi', { roster: 'r', onSpeech: () => {} });
  const system = String(calls[0]!.system);
  assert.match(system, /Smith \(Concierge\)/);
  assert.match(system, /Clipped\./);
  assert.doesNotMatch(system, /Anderson/);
});

test('draft_agent and confirm_agent route to their executors', async () => {
  const { factory } = scripted([
    {
      textDeltas: [''],
      final: {
        content: [{ type: 'tool_use', id: 'tu_d', name: 'draft_agent', input: { spec: 'an Architect agent' } }],
        stop_reason: 'tool_use',
      },
    },
    {
      textDeltas: ['Anderson: Meet Rafael — add him?'],
      final: { content: [{ type: 'text', text: 'Anderson: Meet Rafael — add him?' }], stop_reason: 'end_turn' },
    },
    {
      textDeltas: [''],
      final: {
        content: [{ type: 'tool_use', id: 'tu_c', name: 'confirm_agent', input: { accept: true } }],
        stop_reason: 'tool_use',
      },
    },
    {
      textDeltas: ['Anderson: Rafael is on the crew.'],
      final: { content: [{ type: 'text', text: 'Anderson: Rafael is on the crew.' }], stop_reason: 'end_turn' },
    },
  ]);
  const drafted: unknown[] = [];
  const confirmed: unknown[] = [];
  const exec: ToolExecutors = {
    ...NOOP_EXEC,
    draft_agent: async (input) => {
      drafted.push(input);
      return 'Draft ready: Rafael, Architect';
    },
    confirm_agent: async (input) => {
      confirmed.push(input);
      return 'created Rafael';
    },
  };
  const brain = new BrokerBrain(factory, exec);
  await brain.handleUtterance('anderson, create an architect agent', { roster: 'r', onSpeech: () => {} });
  await brain.handleUtterance('yes, add him', { roster: 'r', onSpeech: () => {} });
  assert.deepEqual(drafted, [{ spec: 'an Architect agent' }]);
  assert.deepEqual(confirmed, [{ accept: true }]);
});
