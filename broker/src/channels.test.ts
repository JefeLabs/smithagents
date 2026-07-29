import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdapterHub, type ChannelAdapter, type ChannelSpeechLine } from './channels.ts';

const resolveSpeaker = (text: string) => {
  const m = /^([A-Z][\w-]{1,24}):\s(.*)$/.exec(text);
  return m ? { speaker: m[1], spokenText: m[2]! } : { spokenText: text };
};
const AGENTS = [
  { id: 'ignacio', name: 'Ignacio', channels: ['tauri', 'discord'] },
  { id: 'wilkin', name: 'Wilkin', channels: ['tauri'] },
];
function fakeAdapter(kind: string) {
  const delivered: Array<{ line: ChannelSpeechLine; ref: string }> = [];
  const adapter: ChannelAdapter = { kind, deliver: async (line, ref) => void delivered.push({ line, ref }) };
  return { adapter, delivered };
}

test("onUtterance formats the line and forwards its derived origin; once active, that turn's speech routes back to the same channelRef", () => {
  const submitted: Array<{ text: string; origin: { kind: string; channelRef: string } }> = [];
  const { adapter, delivered } = fakeAdapter('discord');
  const hub = new AdapterHub({
    resolveSpeaker,
    agents: () => AGENTS,
    submitUserText: (text, origin) => submitted.push({ text, origin }),
  });
  hub.register(adapter);
  hub.onUtterance('discord', { text: 'que lo que', author: 'Edwin', channelRef: 'chan-1' });
  assert.deepEqual(submitted, [
    { text: 'Edwin (via discord): que lo que', origin: { kind: 'discord', channelRef: 'chan-1' } },
  ]);
  // onUtterance never touches hub state itself — nothing is active yet.
  hub.dispatchSpeech('Ignacio: too early');
  assert.equal(delivered.length, 0);
  // The broker's onTurnStart activates the exact origin it was handed.
  hub.setActiveOrigin(submitted[0]!.origin);
  hub.dispatchSpeech('Ignacio: dime a ver');
  assert.deepEqual(delivered, [{ line: { agentId: 'ignacio', name: 'Ignacio', text: 'dime a ver' }, ref: 'chan-1' }]);
});

test('agents not designated for the channel are not delivered', () => {
  const { adapter, delivered } = fakeAdapter('discord');
  const hub = new AdapterHub({ resolveSpeaker, agents: () => AGENTS, submitUserText: () => {} });
  hub.register(adapter);
  hub.setActiveOrigin({ kind: 'discord', channelRef: 'chan-1' });
  hub.dispatchSpeech('Wilkin: I should stay silent here'); // channels lacks "discord"
  assert.equal(delivered.length, 0);
});

test('speech with no active origin (Tauri/PTT/meeting turns) never spills into channels', () => {
  const { adapter, delivered } = fakeAdapter('discord');
  const hub = new AdapterHub({ resolveSpeaker, agents: () => AGENTS, submitUserText: () => {} });
  hub.register(adapter);
  hub.dispatchSpeech('Ignacio: local-only line');
  assert.equal(delivered.length, 0);
});

test('setActiveOrigin(undefined) ends the turn; sticky-speaker follows the last speaker within a turn but resets on the next one', () => {
  const { adapter, delivered } = fakeAdapter('discord');
  const hub = new AdapterHub({ resolveSpeaker, agents: () => AGENTS, submitUserText: () => {} });
  hub.register(adapter);
  hub.setActiveOrigin({ kind: 'discord', channelRef: 'chan-1' });
  hub.dispatchSpeech('Ignacio: first chunk.');
  hub.dispatchSpeech('second chunk, no prefix.'); // sticky speaker
  assert.equal(delivered.length, 2);
  assert.equal(delivered[1]!.line.agentId, 'ignacio');
  hub.setActiveOrigin(undefined); // turn ends
  hub.dispatchSpeech('Ignacio: after the turn');
  assert.equal(delivered.length, 2);
  hub.setActiveOrigin({ kind: 'discord', channelRef: 'chan-2' }); // a new turn — sticky speaker must not carry over
  hub.dispatchSpeech('unprefixed, no speaker resolved for this turn yet');
  assert.equal(delivered.length, 2); // still nothing — last turn's speaker was reset, not inherited
});

test("a resolver that carries state across calls (mirroring the pre-fix main.ts wiring) leaks a prior turn's speaker into a new turn — exactly why the hub needs a PURE resolver", () => {
  // Mimics main.ts's old bug: resolveSpokenLine's module-global
  // `lastSpokenSpeaker` remembered the last prefixed speaker across EVERY
  // turn (meeting, system-note, Tauri, Discord alike), defeating the hub's
  // own per-turn sticky reset (setActiveOrigin resets `lastSpeaker`).
  let lastSpokenSpeaker: string | undefined;
  const statefulResolver = (text: string) => {
    const m = /^([A-Z][\w-]{1,24}):\s(.*)$/.exec(text);
    const speaker = m?.[1] ?? lastSpokenSpeaker;
    lastSpokenSpeaker = speaker;
    return { speaker, spokenText: m?.[2] ?? text };
  };
  const { adapter, delivered } = fakeAdapter('discord');
  const hub = new AdapterHub({ resolveSpeaker: statefulResolver, agents: () => AGENTS, submitUserText: () => {} });
  hub.register(adapter);
  hub.setActiveOrigin({ kind: 'discord', channelRef: 'chan-1' });
  hub.dispatchSpeech('Ignacio: earlier turn'); // resolver now remembers Ignacio
  hub.setActiveOrigin(undefined); // turn ends
  hub.setActiveOrigin({ kind: 'discord', channelRef: 'chan-2' }); // a brand-new turn
  hub.dispatchSpeech('unprefixed line, first of this new turn'); // bug: resolver still says Ignacio
  assert.equal(delivered.length, 2); // leaked — posted to chan-2 despite no prefix this turn
  assert.equal(delivered[1]!.ref, 'chan-2');
});

test('Finding 1 fix — the pure resolver construction used in main.ts: an unprefixed line at the very start of a turn delivers nothing, even when a PREVIOUS turn had a prefixed speaker', () => {
  // Same shape as resolveSpokenLineForChannels in main.ts: parse-only over
  // the speaker regex, no state carried between calls.
  const pureResolver = (text: string) => {
    const m = /^([A-Z][\w-]{1,24}):\s(.*)$/.exec(text);
    return { speaker: m?.[1], spokenText: m?.[2] ?? text };
  };
  const { adapter, delivered } = fakeAdapter('discord');
  const hub = new AdapterHub({ resolveSpeaker: pureResolver, agents: () => AGENTS, submitUserText: () => {} });
  hub.register(adapter);
  hub.setActiveOrigin({ kind: 'discord', channelRef: 'chan-1' });
  hub.dispatchSpeech('Ignacio: earlier turn');
  assert.equal(delivered.length, 1);
  hub.setActiveOrigin(undefined); // turn ends
  hub.setActiveOrigin({ kind: 'discord', channelRef: 'chan-2' }); // a brand-new turn
  hub.dispatchSpeech('unprefixed line, first of this new turn');
  assert.equal(delivered.length, 1); // unchanged — no speaker resolved for this turn yet
});

test('an agent with NO channels field attends everywhere', () => {
  const { adapter, delivered } = fakeAdapter('discord');
  const hub = new AdapterHub({
    resolveSpeaker,
    agents: () => [{ id: 'nomad', name: 'Nomad' }],
    submitUserText: () => {},
  });
  hub.register(adapter);
  hub.setActiveOrigin({ kind: 'discord', channelRef: 'c' });
  hub.dispatchSpeech('Nomad: present');
  assert.equal(delivered.length, 1);
});
