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
