import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDiscordTextActive } from './discord-state.ts';

test('isDiscordTextActive returns false when activeDiscordText is null', () => {
  const lifecycle = { activeDiscordText: null };
  assert.equal(isDiscordTextActive(lifecycle), false);
});

test('isDiscordTextActive returns true when activeDiscordText is set', () => {
  const lifecycle = { activeDiscordText: { some: 'adapter' } };
  assert.equal(isDiscordTextActive(lifecycle), true);
});

test('isDiscordTextActive returns true even for falsy non-null values', () => {
  // Edge case: as long as activeDiscordText is not null, it's "active"
  const lifecycleWithZero = { activeDiscordText: 0 };
  assert.equal(isDiscordTextActive(lifecycleWithZero), true);

  const lifecycleWithFalse = { activeDiscordText: false };
  assert.equal(isDiscordTextActive(lifecycleWithFalse), true);

  const lifecycleWithEmptyString = { activeDiscordText: '' };
  assert.equal(isDiscordTextActive(lifecycleWithEmptyString), true);
});
