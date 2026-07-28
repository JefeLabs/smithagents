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

test('utterance from a channel routes that turn\'s speech back to the same channelRef', () => {
  const submitted: string[] = [];
  const { adapter, delivered } = fakeAdapter('discord');
  const hub = new AdapterHub({ resolveSpeaker, agents: () => AGENTS, submitUserText: (t) => submitted.push(t) });
  hub.register(adapter);
  hub.onUtterance('discord', { text: 'que lo que', author: 'Edwin', channelRef: 'chan-1' });
  assert.deepEqual(submitted, ['Edwin (via discord): que lo que']);
  hub.dispatchSpeech('Ignacio: dime a ver');
  assert.deepEqual(delivered, [{ line: { agentId: 'ignacio', name: 'Ignacio', text: 'dime a ver' }, ref: 'chan-1' }]);
});

test('agents not designated for the channel are not delivered', () => {
  const { adapter, delivered } = fakeAdapter('discord');
  const hub = new AdapterHub({ resolveSpeaker, agents: () => AGENTS, submitUserText: () => {} });
  hub.register(adapter);
  hub.onUtterance('discord', { text: 'hi', author: 'Edwin', channelRef: 'chan-1' });
  hub.dispatchSpeech('Wilkin: I should stay silent here'); // channels lacks "discord"
  assert.equal(delivered.length, 0);
});

test('speech with no origin (Tauri/PTT turns) never spills into channels', () => {
  const { adapter, delivered } = fakeAdapter('discord');
  const hub = new AdapterHub({ resolveSpeaker, agents: () => AGENTS, submitUserText: () => {} });
  hub.register(adapter);
  hub.dispatchSpeech('Ignacio: local-only line');
  assert.equal(delivered.length, 0);
});

test('clearOrigin ends the turn; sticky-speaker unprefixed chunks follow the last speaker', () => {
  const { adapter, delivered } = fakeAdapter('discord');
  const hub = new AdapterHub({ resolveSpeaker, agents: () => AGENTS, submitUserText: () => {} });
  hub.register(adapter);
  hub.onUtterance('discord', { text: 'hi', author: 'Edwin', channelRef: 'chan-1' });
  hub.dispatchSpeech('Ignacio: first chunk.');
  hub.dispatchSpeech('second chunk, no prefix.'); // sticky speaker
  assert.equal(delivered.length, 2);
  assert.equal(delivered[1]!.line.agentId, 'ignacio');
  hub.clearOrigin();
  hub.dispatchSpeech('Ignacio: after the turn');
  assert.equal(delivered.length, 2);
});

test('an agent with NO channels field attends everywhere', () => {
  const { adapter, delivered } = fakeAdapter('discord');
  const hub = new AdapterHub({
    resolveSpeaker, agents: () => [{ id: 'nomad', name: 'Nomad' }], submitUserText: () => {},
  });
  hub.register(adapter);
  hub.onUtterance('discord', { text: 'hi', author: 'E', channelRef: 'c' });
  hub.dispatchSpeech('Nomad: present');
  assert.equal(delivered.length, 1);
});
