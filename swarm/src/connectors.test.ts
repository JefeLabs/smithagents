// swarm/src/connectors.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VENDORS, findVendor } from './connectors.js';

test('findVendor: resolves each of the 4 shipped vendors by id', () => {
  for (const id of ['atlassian', 'github', 'datadog', 'snyk']) {
    assert.ok(findVendor(id), `expected a vendor def for "${id}"`);
  }
});

test('findVendor: unknown id resolves to undefined', () => {
  assert.equal(findVendor('not-a-vendor'), undefined);
});

test('field keys match the documented shape for each vendor', () => {
  assert.deepEqual(
    findVendor('atlassian')!.fields.map((f) => f.key),
    ['email', 'apiToken'],
  );
  assert.deepEqual(findVendor('github')!.fields.map((f) => f.key), ['token']);
  assert.deepEqual(findVendor('datadog')!.fields.map((f) => f.key), ['site', 'apiKey', 'appKey']);
  assert.deepEqual(findVendor('snyk')!.fields.map((f) => f.key), ['region', 'token']);
});

test('only Atlassian declares verifyExtraFields', () => {
  assert.deepEqual(
    findVendor('atlassian')!.verifyExtraFields?.map((f) => f.key),
    ['testSiteUrl'],
  );
  for (const id of ['github', 'datadog', 'snyk']) {
    assert.equal(findVendor(id)!.verifyExtraFields, undefined);
  }
});

test('VENDORS has exactly the 4 shipped vendors, no duplicates', () => {
  assert.equal(VENDORS.length, 4);
  assert.equal(new Set(VENDORS.map((v) => v.id)).size, 4);
});
