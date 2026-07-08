import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// @ts-expect-error tsx test runner resolves .ts extension imports.
import { detectBinding } from './binding.ts';

const createTempDir = async (): Promise<string> => mkdtemp(join(tmpdir(), 'wevibe-binding-'));

const writeMarker = async (root: string, fileName: string, contents: string): Promise<void> => {
  const markerDir = join(root, '.wevibe');
  await mkdir(markerDir, { recursive: true });
  await writeFile(join(markerDir, fileName), contents, 'utf-8');
};

const removeTempDir = async (root: string): Promise<void> => {
  await rm(root, { recursive: true, force: true });
};

test('detectBinding returns dormant when marker files are absent', async () => {
  const root = await createTempDir();
  try {
    const state = await detectBinding(root);
    assert.deepEqual(state, { active: false });
  } finally {
    await removeTempDir(root);
  }
});

test('detectBinding reads a valid org.json marker', async () => {
  const root = await createTempDir();
  try {
    const fingerprint = 'a'.repeat(64);
    await writeMarker(
      root,
      'org.json',
      JSON.stringify({
        mc_version: 1,
        org_id: 'org-main',
        project_fingerprint: fingerprint,
        fingerprint_source: 'origin',
        bound_at: '2026-07-07T00:00:00.000Z',
      }),
    );

    const state = await detectBinding(root);
    assert.equal(state.active, true);
    assert.equal(state.orgId, 'org-main');
    assert.equal(state.fingerprint, fingerprint);
    assert.equal(state.source, 'origin');
    assert.equal(state.markerPath, join(root, '.wevibe', 'org.json'));
  } finally {
    await removeTempDir(root);
  }
});

test('detectBinding prefers org.json when both marker files exist', async () => {
  const root = await createTempDir();
  try {
    await writeMarker(
      root,
      'org.json',
      JSON.stringify({ org_id: 'org-primary', project_fingerprint: 'b'.repeat(64), fingerprint_source: 'origin' }),
    );
    await writeMarker(
      root,
      'org.local.json',
      JSON.stringify({ org_id: 'org-local', project_fingerprint: 'c'.repeat(64), fingerprint_source: 'realpath' }),
    );

    const state = await detectBinding(root);
    assert.equal(state.active, true);
    assert.equal(state.orgId, 'org-primary');
    assert.equal(state.fingerprint, 'b'.repeat(64));
    assert.equal(state.source, 'origin');
    assert.equal(state.markerPath, join(root, '.wevibe', 'org.json'));
  } finally {
    await removeTempDir(root);
  }
});

test('detectBinding falls back to org.local.json when org.json is absent', async () => {
  const root = await createTempDir();
  try {
    await writeMarker(
      root,
      'org.local.json',
      JSON.stringify({ org_id: 'org-local', project_fingerprint: 'd'.repeat(64), fingerprint_source: 'realpath' }),
    );

    const state = await detectBinding(root);
    assert.equal(state.active, true);
    assert.equal(state.orgId, 'org-local');
    assert.equal(state.fingerprint, 'd'.repeat(64));
    assert.equal(state.source, 'realpath');
    assert.equal(state.markerPath, join(root, '.wevibe', 'org.local.json'));
  } finally {
    await removeTempDir(root);
  }
});

test('detectBinding fail-closes on malformed org.json JSON', async () => {
  const root = await createTempDir();
  try {
    await writeMarker(root, 'org.json', '{this is not valid json');

    const state = await detectBinding(root);
    assert.deepEqual(state, { active: false });
  } finally {
    await removeTempDir(root);
  }
});

test('detectBinding fail-closes on org.json missing required fields', async () => {
  const root = await createTempDir();
  try {
    await writeMarker(
      root,
      'org.json',
      JSON.stringify({ org_id: 'org-main', fingerprint_source: 'origin', bound_at: '2026-07-07T00:00:00.000Z' }),
    );

    const state = await detectBinding(root);
    assert.deepEqual(state, { active: false });
  } finally {
    await removeTempDir(root);
  }
});

test('detectBinding (hard-gate): activates ONLY on the spawn-root marker and exposes org_id', async () => {
  const root = await createTempDir();
  try {
    await writeMarker(
      root,
      'org.json',
      JSON.stringify({
        mc_version: 1,
        org_id: 'org-spawn-root',
        project_fingerprint: 'a'.repeat(64),
        fingerprint_source: 'origin',
        bound_at: '2026-07-08T00:00:00.000Z',
      }),
    );

    const state = await detectBinding(root);
    assert.equal(state.active, true);
    // org_id is the value the plugin uses to scope the /v1/recall query.
    assert.equal(state.orgId, 'org-spawn-root');
  } finally {
    await removeTempDir(root);
  }
});

test('detectBinding (hard-gate): stays DORMANT when only a SUBDIR is bound (no downward traversal)', async () => {
  const root = await createTempDir();
  try {
    // Spawn-root has NO .wevibe. A nested subdir IS bound. Must NOT activate.
    const subMarkerDir = join(root, 'packages', 'app', '.wevibe');
    await mkdir(subMarkerDir, { recursive: true });
    await writeFile(
      join(subMarkerDir, 'org.json'),
      JSON.stringify({ org_id: 'org-subdir', project_fingerprint: 'b'.repeat(64), fingerprint_source: 'origin' }),
      'utf-8',
    );

    const state = await detectBinding(root);
    assert.deepEqual(state, { active: false });
  } finally {
    await removeTempDir(root);
  }
});

test('detectBinding (hard-gate): mixed subdirs (some bound, some not) do NOT activate an unbound spawn-root', async () => {
  const root = await createTempDir();
  try {
    // Two subdirs: one bound, one not. Spawn-root itself is unbound.
    const boundSub = join(root, 'services', 'api', '.wevibe');
    await mkdir(boundSub, { recursive: true });
    await writeFile(
      join(boundSub, 'org.json'),
      JSON.stringify({ org_id: 'org-a', project_fingerprint: 'c'.repeat(64), fingerprint_source: 'origin' }),
      'utf-8',
    );
    await mkdir(join(root, 'services', 'web'), { recursive: true });

    const state = await detectBinding(root);
    assert.deepEqual(state, { active: false });
  } finally {
    await removeTempDir(root);
  }
});

test('detectBinding (hard-gate): fail-closes on an empty/blank spawn-root path', async () => {
  assert.deepEqual(await detectBinding(''), { active: false });
  assert.deepEqual(await detectBinding('   '), { active: false });
});
