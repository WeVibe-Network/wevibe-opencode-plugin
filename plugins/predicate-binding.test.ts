import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// @ts-expect-error tsx test runner resolves .ts extension imports.
import { clearPredicateCache, getCachedPredicate, readPredicateDeclaration, resolvePredicateForRepo } from './predicate-binding.ts';
// @ts-expect-error tsx test runner resolves .ts extension imports.
import { benchFixtureAdapter } from './bench-fixture-adapter.ts';

const createTempDir = async (): Promise<string> => mkdtemp(join(tmpdir(), 'wevibe-predicate-'));

const writeDeclaration = async (
  root: string,
  contents: string,
  fileName = 'predicate.json',
): Promise<void> => {
  const markerDir = join(root, '.wevibe');
  await mkdir(markerDir, { recursive: true });
  await writeFile(join(markerDir, fileName), contents, 'utf-8');
};

const removeTempDir = async (root: string): Promise<void> => {
  await rm(root, { recursive: true, force: true });
};

test.beforeEach(() => {
  clearPredicateCache();
});

test('resolvePredicateForRepo resolves a valid bench-fixture declaration', async () => {
  const root = await createTempDir();
  try {
    await writeDeclaration(root, JSON.stringify({ reporter: 'bench-fixture', command: 'npm run bench' }));

    const resolved = await resolvePredicateForRepo(root);
    assert.ok(resolved !== null);
    assert.equal(resolved.adapter, benchFixtureAdapter);
    assert.equal(resolved.command, 'npm run bench');

    // getCachedPredicate exposes the same cached resolution.
    const cached = getCachedPredicate(root);
    assert.ok(cached !== null);
    assert.equal(cached.command, 'npm run bench');
  } finally {
    await removeTempDir(root);
  }
});

test('resolvePredicateForRepo resolves ONCE and reuses the cache (does not re-read)', async () => {
  const root = await createTempDir();
  try {
    await writeDeclaration(root, JSON.stringify({ reporter: 'bench-fixture', command: 'npm run bench' }));

    const first = await resolvePredicateForRepo(root);
    assert.ok(first !== null);
    assert.equal(first.command, 'npm run bench');

    // Delete the declaration file AFTER the first resolve. A re-read would now
    // see no file (=> null); a cache hit still returns the original command.
    await rm(join(root, '.wevibe', 'predicate.json'));

    const second = await resolvePredicateForRepo(root);
    assert.ok(second !== null);
    assert.equal(second.adapter, benchFixtureAdapter);
    assert.equal(second.command, 'npm run bench');

    // Corrupting instead of deleting must also be ignored while cached.
    await writeDeclaration(root, '{not valid json');

    const third = await resolvePredicateForRepo(root);
    assert.ok(third !== null);
    assert.equal(third.command, 'npm run bench');

    // After clearing the cache, the (now gone) file yields null.
    clearPredicateCache();
    const afterClear = await resolvePredicateForRepo(root);
    assert.equal(afterClear, null);
  } finally {
    await removeTempDir(root);
  }
});

test('absent declaration resolves to null (and caches null)', async () => {
  const root = await createTempDir();
  try {
    const resolved = await resolvePredicateForRepo(root);
    assert.equal(resolved, null);
    assert.equal(getCachedPredicate(root), null);
  } finally {
    await removeTempDir(root);
  }
});

test('malformed/invalid declarations resolve to null', async () => {
  const cases: Array<{ name: string; contents: string }> = [
    { name: 'invalid JSON', contents: '{this is not valid json' },
    { name: 'missing command', contents: JSON.stringify({ reporter: 'bench-fixture' }) },
    { name: 'blank command', contents: JSON.stringify({ reporter: 'bench-fixture', command: '   ' }) },
    { name: 'blank reporter', contents: JSON.stringify({ reporter: '  ', command: 'npm run bench' }) },
    { name: 'missing reporter', contents: JSON.stringify({ command: 'npm run bench' }) },
    { name: 'unknown reporter', contents: JSON.stringify({ reporter: 'nope', command: 'npm run bench' }) },
    { name: 'non-object', contents: JSON.stringify('just a string') },
  ];

  for (const c of cases) {
    const root = await createTempDir();
    try {
      await writeDeclaration(root, c.contents);
      const resolved = await resolvePredicateForRepo(root);
      assert.equal(resolved, null, `${c.name}: expected null`);
      assert.equal(getCachedPredicate(root), null, `${c.name}: cached null`);
    } finally {
      await removeTempDir(root);
    }
  }
});

test('blank/empty repoRoot resolves to null', async () => {
  assert.equal(await resolvePredicateForRepo(''), null);
  assert.equal(await resolvePredicateForRepo('   '), null);
  assert.equal(await readPredicateDeclaration(''), null);
  assert.equal(await readPredicateDeclaration('   '), null);
});

test('bind-once per distinct repo (no cross-talk between repoRoots)', async () => {
  const rootA = await createTempDir();
  const rootB = await createTempDir();
  try {
    await writeDeclaration(rootA, JSON.stringify({ reporter: 'bench-fixture', command: 'npm run bench' }));
    await writeDeclaration(rootB, JSON.stringify({ reporter: 'bench-fixture', command: 'make bench' }));

    const resolvedA = await resolvePredicateForRepo(rootA);
    const resolvedB = await resolvePredicateForRepo(rootB);
    assert.ok(resolvedA !== null);
    assert.ok(resolvedB !== null);
    assert.equal(resolvedA.adapter, benchFixtureAdapter);
    assert.equal(resolvedB.adapter, benchFixtureAdapter);
    assert.equal(resolvedA.command, 'npm run bench');
    assert.equal(resolvedB.command, 'make bench');
  } finally {
    await removeTempDir(rootA);
    await removeTempDir(rootB);
  }
});