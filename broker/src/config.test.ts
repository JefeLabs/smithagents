import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadBrokerConfig } from './config.ts';

const FULL = {
  ANTHROPIC_API_KEY: 'sk-ant',
  DEEPGRAM_API_KEY: 'dg',
  LIVEKIT_URL: 'ws://127.0.0.1:7880',
  LIVEKIT_API_KEY: 'devkey',
  LIVEKIT_API_SECRET: 'secret',
};

test('loads with defaults for optional vars', () => {
  const c = loadBrokerConfig(FULL);
  assert.equal(c.swarm.baseUrl, 'http://127.0.0.1:7777');
  assert.equal(c.swarm.repository, '');
  assert.equal(c.swarm.token, undefined);
  assert.equal(c.livekit.url, 'ws://127.0.0.1:7880');
});

test('throws naming the missing required var', () => {
  const { DEEPGRAM_API_KEY: _omit, ...rest } = FULL;
  assert.throws(() => loadBrokerConfig(rest), /DEEPGRAM_API_KEY/);
});

test('optional overrides are honored', () => {
  const c = loadBrokerConfig({ ...FULL, SWARM_URL: 'http://h:9999', SMITH_API_TOKEN: 't', SWARM_REPO: 'git@x:y.git' });
  assert.equal(c.swarm.baseUrl, 'http://h:9999');
  assert.equal(c.swarm.token, 't');
  assert.equal(c.swarm.repository, 'git@x:y.git');
});
