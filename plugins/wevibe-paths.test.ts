import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import test from 'node:test';

// @ts-expect-error tsx test runner resolves .ts extension imports.
import { resolveScopedWeVibeDir, scopedLogDir, scopedRunsDir, scopedStateDir } from './wevibe-paths.ts';

const fakeHomeDir = join(sep, 'tmp', 'fake-home');
const fakeWorktree = join(sep, 'tmp', 'fake-worktree');

function expectedUnboundDir(projectRoot: string): string {
  return join(
    fakeHomeDir,
    '.wevibe',
    'unbound',
    createHash('sha256').update(realpathSync(projectRoot), 'utf8').digest('hex'),
  );
}

test('resolveScopedWeVibeDir keeps in-project location for bound markers', () => {
  const orgBoundRoot = mkdtempSync(join(tmpdir(), 'wevibe-paths-bound-org-'));
  const orgLocalBoundRoot = mkdtempSync(join(tmpdir(), 'wevibe-paths-bound-org-local-'));

  try {
    mkdirSync(join(orgBoundRoot, '.wevibe'));
    writeFileSync(join(orgBoundRoot, '.wevibe', 'org.json'), '{}');
    assert.equal(resolveScopedWeVibeDir({ worktree: orgBoundRoot }, fakeHomeDir), join(orgBoundRoot, '.wevibe'));

    mkdirSync(join(orgLocalBoundRoot, '.wevibe'));
    writeFileSync(join(orgLocalBoundRoot, '.wevibe', 'org.local.json'), '{}');
    assert.equal(
      resolveScopedWeVibeDir({ worktree: orgLocalBoundRoot }, fakeHomeDir),
      join(orgLocalBoundRoot, '.wevibe'),
    );
  } finally {
    rmSync(orgBoundRoot, { recursive: true, force: true });
    rmSync(orgLocalBoundRoot, { recursive: true, force: true });
  }
});

test('resolveScopedWeVibeDir routes unbound roots to homedir fingerprint path', () => {
  const unboundRoot = mkdtempSync(join(tmpdir(), 'wevibe-paths-unbound-'));

  try {
    assert.equal(resolveScopedWeVibeDir({ worktree: unboundRoot }, fakeHomeDir), expectedUnboundDir(unboundRoot));
  } finally {
    rmSync(unboundRoot, { recursive: true, force: true });
  }
});

test('resolveScopedWeVibeDir prefers worktree then falls through directory, cwd, and wevibeRoot for unbound roots', () => {
  const unboundWorktree = mkdtempSync(join(tmpdir(), 'wevibe-paths-worktree-'));
  const unboundDirectory = mkdtempSync(join(tmpdir(), 'wevibe-paths-directory-'));
  const unboundCwd = mkdtempSync(join(tmpdir(), 'wevibe-paths-cwd-'));
  const unboundWeVibeRoot = mkdtempSync(join(tmpdir(), 'wevibe-paths-weviberoot-'));

  try {
    assert.equal(
      resolveScopedWeVibeDir(
        {
          worktree: unboundWorktree,
          directory: unboundDirectory,
          cwd: unboundCwd,
          wevibeRoot: unboundWeVibeRoot,
        },
        fakeHomeDir,
      ),
      expectedUnboundDir(unboundWorktree),
    );

    assert.equal(
      resolveScopedWeVibeDir(
        {
          worktree: undefined,
          directory: unboundDirectory,
          cwd: unboundCwd,
          wevibeRoot: unboundWeVibeRoot,
        },
        fakeHomeDir,
      ),
      expectedUnboundDir(unboundDirectory),
    );

    assert.equal(
      resolveScopedWeVibeDir(
        {
          worktree: '',
          directory: '   ',
          cwd: unboundCwd,
          wevibeRoot: unboundWeVibeRoot,
        },
        fakeHomeDir,
      ),
      expectedUnboundDir(unboundCwd),
    );

    assert.equal(
      resolveScopedWeVibeDir(
        {
          worktree: '',
          directory: '',
          cwd: undefined,
          wevibeRoot: unboundWeVibeRoot,
        },
        fakeHomeDir,
      ),
      expectedUnboundDir(unboundWeVibeRoot),
    );
  } finally {
    rmSync(unboundWorktree, { recursive: true, force: true });
    rmSync(unboundDirectory, { recursive: true, force: true });
    rmSync(unboundCwd, { recursive: true, force: true });
    rmSync(unboundWeVibeRoot, { recursive: true, force: true });
  }
});

test('resolveScopedWeVibeDir falls back to home when no project context exists', () => {
  assert.equal(resolveScopedWeVibeDir({}, fakeHomeDir), join(fakeHomeDir, '.wevibe'));
});

test('scopedLogDir returns scoped logs dir unless a non-empty override is provided', () => {
  const scopedWeVibeDir = join(fakeWorktree, '.wevibe');
  const expectedLogsDir = join(scopedWeVibeDir, 'logs');

  assert.equal(scopedLogDir(scopedWeVibeDir), expectedLogsDir);

  const override = join(sep, 'tmp', 'custom-logs');
  assert.equal(scopedLogDir(scopedWeVibeDir, override), override);

  assert.equal(scopedLogDir(scopedWeVibeDir, ''), expectedLogsDir);
  assert.equal(scopedLogDir(scopedWeVibeDir, '   '), expectedLogsDir);
});

test('scopedRunsDir returns scoped runs directory', () => {
  const scopedWeVibeDir = join(fakeWorktree, '.wevibe');
  assert.equal(scopedRunsDir(scopedWeVibeDir), join(scopedWeVibeDir, 'runs'));
});

test('scopedStateDir returns scoped state directory', () => {
  assert.equal(scopedStateDir('/x/.wevibe'), join('/x/.wevibe', 'state'));
});
