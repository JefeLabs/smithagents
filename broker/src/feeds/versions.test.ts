import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyBump, mentionsSecurity, qualifies, latestVersion } from './versions.ts';

test('classifyBump reads semver, ignoring a leading v', () => {
  assert.equal(classifyBump('4.0.7', '5.0.0'), 'major');
  assert.equal(classifyBump('4.0.7', '4.1.0'), 'minor');
  assert.equal(classifyBump('4.0.7', '4.0.8'), 'patch');
  assert.equal(classifyBump('v4.0.7', 'v4.1.0'), 'minor');
});

test('classifyBump returns null when the version is not newer — no re-announcing', () => {
  assert.equal(classifyBump('4.1.0', '4.1.0'), null);
  assert.equal(classifyBump('4.1.0', '4.0.9'), null);
});

test('classifyBump tolerates prerelease and build suffixes', () => {
  assert.equal(classifyBump('4.0.0', '4.1.0-RC1'), 'minor');
  assert.equal(classifyBump('4.0.0', '4.0.1+build.7'), 'patch');
});

test('unparseable versions are null rather than a crash', () => {
  assert.equal(classifyBump('', '4.1.0'), null);
  assert.equal(classifyBump('4.0.0', 'latest'), null);
});

test('mentionsSecurity finds CVEs and security wording', () => {
  assert.equal(mentionsSecurity('Fixes CVE-2026-1234 in the actuator'), true);
  assert.equal(mentionsSecurity('This is a security release'), true);
  assert.equal(mentionsSecurity('security advisory published'), true);
  assert.equal(mentionsSecurity('Improved performance and docs'), false);
  assert.equal(mentionsSecurity('secure by default, as always'), false);
});

test('qualifies: major and minor always; a patch only when it is security', () => {
  assert.equal(qualifies('major', false), true);
  assert.equal(qualifies('minor', false), true);
  assert.equal(qualifies('patch', false), false);
  assert.equal(qualifies('patch', true), true);
});

test('latestVersion reads each ecosystem, and a failure is null not a throw', async () => {
  const npm = async () => ({ version: '19.2.0' });
  assert.equal(await latestVersion(npm, 'npm', 'react'), '19.2.0');

  const maven = async () => ({ response: { docs: [{ latestVersion: '4.1.0' }] } });
  assert.equal(await latestVersion(maven, 'maven', 'org.springframework.boot:spring-boot'), '4.1.0');

  const cargo = async () => ({ crate: { max_stable_version: '2.4.0' } });
  assert.equal(await latestVersion(cargo, 'cargo', 'tauri'), '2.4.0');

  const dead = async () => {
    throw new Error('offline');
  };
  assert.equal(await latestVersion(dead, 'npm', 'react'), null);
});
