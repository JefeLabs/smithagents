import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveSources, releaseSourceId } from './derive.ts';
import type { FeedSource } from './types.ts';

const dep = (name: string, workspace = 'jefelabs') => ({
  name,
  eco: 'maven' as const,
  version: '4.0.0',
  manifest: 'build.gradle',
  workspace,
});

test('a dependency becomes a derived release source carrying its reason', () => {
  const [source] = deriveSources({ deps: [dep('org.springframework.boot:spring-boot')], promoted: [], existing: [] });
  assert.equal(source!.origin, 'derived');
  assert.equal(source!.tag, 'release');
  assert.equal(source!.workspace, 'jefelabs');
  assert.match(source!.reason!, /build\.gradle/);
});

test('the same dependency in two workspaces yields a source for each', () => {
  const sources = deriveSources({
    deps: [dep('org.springframework.boot:spring-boot', 'jefelabs'), dep('org.springframework.boot:spring-boot', 'acme')],
    promoted: [],
    existing: [],
  });
  assert.equal(sources.length, 2);
  assert.deepEqual(sources.map((s) => s.workspace).sort(), ['acme', 'jefelabs']);
});

test('a promoted transcript interest becomes a source, and says why', () => {
  const [source] = deriveSources({
    deps: [],
    promoted: [{ name: 'runpod', eco: 'npm', mentions: 6 }],
    existing: [],
  });
  assert.match(source!.reason!, /mentioned.*6/i);
});

test('a DISMISSED derived source is never resurrected', () => {
  const existing: FeedSource[] = [
    {
      id: releaseSourceId('org.springframework.boot:spring-boot', 'jefelabs'),
      label: 'spring-boot',
      kind: 'registry',
      locator: 'maven:org.springframework.boot:spring-boot',
      tag: 'release',
      origin: 'derived',
      enabled: true,
      dismissed: true,
      workspace: 'jefelabs',
    },
  ];
  const sources = deriveSources({ deps: [dep('org.springframework.boot:spring-boot')], promoted: [], existing });
  assert.equal(sources.length, 1);
  assert.equal(sources[0]!.dismissed, true, 'the dismissal survives regeneration');
});

test('a dependency that disappears from the manifest drops its source', () => {
  const existing: FeedSource[] = [
    {
      id: releaseSourceId('gone', 'jefelabs'),
      label: 'gone',
      kind: 'registry',
      locator: 'npm:gone',
      tag: 'release',
      origin: 'derived',
      enabled: true,
      workspace: 'jefelabs',
    },
  ];
  const sources = deriveSources({ deps: [dep('kept')], promoted: [], existing });
  assert.deepEqual(
    sources.map((s) => s.label),
    ['kept'],
  );
});

test('manual sources are never touched by derivation', () => {
  const manual: FeedSource = {
    id: 'm1',
    label: 'Diario Libre',
    kind: 'rss',
    locator: 'https://x.test/rss',
    tag: 'news',
    origin: 'manual',
    enabled: true,
  };
  const sources = deriveSources({ deps: [], promoted: [], existing: [manual] });
  assert.deepEqual(sources, [], 'deriveSources returns only the DERIVED set');
});
