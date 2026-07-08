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
