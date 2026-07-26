import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// @ts-expect-error tsx test runner resolves .ts extension imports.
import { SessionMetricsRecorder, assessRecallNeed, extractToolExitCode } from './metrics.ts';

function withRecorder(run: (recorder: SessionMetricsRecorder) => void): void {
  const runsDir = mkdtempSync(join(tmpdir(), 'wevibe-metrics-test-'));
  const recorder = new SessionMetricsRecorder({ runsDir });
  try {
    run(recorder);
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
}

function recordBash(
  recorder: SessionMetricsRecorder,
  sessionID: string,
  callID: string,
  command: string,
  exit: number,
  output: string,
): void {
  recorder.handleToolAfter(
    {
      tool: 'bash',
      sessionID,
      callID,
      args: { command },
    },
    {
      output,
      metadata: { exit },
    },
  );
}

test('getBuildTestSignals maps failed build/test commands to failing=true', () => {
  withRecorder((recorder) => {
    const sessionID = 'session-fail';
    recordBash(recorder, sessionID, 'call-1', 'go build ./...', 1, 'build failed');
    recordBash(recorder, sessionID, 'call-2', 'vitest run', 2, 'tests failed');

    assert.deepEqual(recorder.getBuildTestSignals(sessionID), {
      buildFailing: true,
      testFailing: true,
    });
  });
});

test('getBuildTestSignals maps successful build/test commands to failing=false', () => {
  withRecorder((recorder) => {
    const sessionID = 'session-pass';
    recordBash(recorder, sessionID, 'call-1', 'go build ./...', 0, '(no output)');
    recordBash(recorder, sessionID, 'call-2', 'vitest run', 0, '(no output)');

    assert.deepEqual(recorder.getBuildTestSignals(sessionID), {
      buildFailing: false,
      testFailing: false,
    });
  });
});

test('getBuildTestSignals preserves known signal and omits unknown sibling signal', () => {
  withRecorder((recorder) => {
    const sessionID = 'session-build-only';
    recordBash(recorder, sessionID, 'call-1', 'go build ./...', 1, 'build failed');

    assert.deepEqual(recorder.getBuildTestSignals(sessionID), {
      buildFailing: true,
    });
  });
});

test('getBuildTestSignals omits build/test flags when session has no build/test signal', () => {
  withRecorder((recorder) => {
    const sessionID = 'session-no-build-test';
    recorder.handleToolAfter(
      {
        tool: 'edit',
        sessionID,
        callID: 'call-edit',
        args: { path: 'plugins/example.ts' },
      },
      { output: '' },
    );

    assert.deepEqual(recorder.getBuildTestSignals(sessionID), {});
  });
});

test('getBuildTestSignals returns empty object for unknown session', () => {
  withRecorder((recorder) => {
    assert.doesNotThrow(() => recorder.getBuildTestSignals('missing-session'));
    assert.deepEqual(recorder.getBuildTestSignals('missing-session'), {});
  });
});

test('extractToolExitCode returns first finite numeric exit field in priority order', () => {
  assert.equal(extractToolExitCode({ exit: 7, exit_code: 2, exitCode: 1 }), 7);
  assert.equal(extractToolExitCode({ exit: '1', exit_code: 2, exitCode: 1 }), 2);
  assert.equal(extractToolExitCode({ exit: '1', exit_code: '2', exitCode: 3 }), 3);
  assert.equal(extractToolExitCode({ exit: Number.NaN, exit_code: Number.POSITIVE_INFINITY, exitCode: -4 }), -4);
});

test('extractToolExitCode returns null for non-object metadata and missing numeric keys', () => {
  assert.equal(extractToolExitCode(null), null);
  assert.equal(extractToolExitCode(undefined), null);
  assert.equal(extractToolExitCode('metadata'), null);
  assert.equal(extractToolExitCode(42), null);
  assert.equal(extractToolExitCode({}), null);
  assert.equal(extractToolExitCode({ exit: '1' }), null);
  assert.equal(extractToolExitCode({ exit_code: '2', exitCode: '3' }), null);
});

test('assessRecallNeed returns clean result when no trigger is present', () => {
  assert.deepEqual(
    assessRecallNeed({
      tool: 'bash',
      command: 'go test ./...',
      exitCode: 0,
      pre: {},
      post: {},
      recentErrors: [],
      lastFiredSignature: '',
    }),
    { needed: false, triggers: [], query: '', signature: '' },
  );

  assert.deepEqual(
    assessRecallNeed({
      tool: 'bash',
      command: 'go test ./...',
      exitCode: 0,
      pre: {},
      post: {},
      recentErrors: ['errA', 'errB'],
      lastFiredSignature: 'previous: errA and errB are already known',
    }),
    { needed: false, triggers: [], query: '', signature: '' },
  );
});

test('assessRecallNeed captures exit_nonzero alone and builds tool failure query/signature', () => {
  const result = assessRecallNeed({
    tool: 'bash',
    command: 'npm run test -- --watch=false',
    exitCode: 1,
    pre: {},
    post: {},
    recentErrors: [],
    lastFiredSignature: 'contains every known error already',
  });

  assert.equal(result.needed, true);
  assert.deepEqual(result.triggers, ['exit_nonzero']);
  assert.equal(result.query.startsWith('tool failure'), true);
  assert.equal(result.query.includes('npm run test -- --watch=false'), true);
  assert.equal(result.signature, result.query);
});

test('assessRecallNeed applies build/test transition labels and ignores steady failing state', () => {
  const buildTransition = assessRecallNeed({
    tool: 'bash',
    command: 'go build ./...',
    exitCode: 0,
    pre: {},
    post: { buildFailing: true },
    recentErrors: [],
    lastFiredSignature: '',
  });
  assert.deepEqual(buildTransition.triggers, ['build_transition']);
  assert.equal(buildTransition.query.startsWith('build failing'), true);

  const testTransition = assessRecallNeed({
    tool: 'bash',
    command: 'vitest run',
    exitCode: 0,
    pre: { testFailing: false },
    post: { testFailing: true },
    recentErrors: [],
    lastFiredSignature: '',
  });
  assert.deepEqual(testTransition.triggers, ['test_transition']);
  assert.equal(testTransition.query.startsWith('test failing'), true);

  assert.deepEqual(
    assessRecallNeed({
      tool: 'bash',
      command: 'go build ./...',
      exitCode: 0,
      pre: { buildFailing: true },
      post: { buildFailing: true },
      recentErrors: [],
      lastFiredSignature: '',
    }),
    { needed: false, triggers: [], query: '', signature: '' },
  );
});

test('assessRecallNeed marks only unseen recent errors as new_errors trigger', () => {
  const unseen = assessRecallNeed({
    tool: 'bash',
    command: 'vitest run',
    exitCode: null,
    pre: {},
    post: {},
    recentErrors: ['errA', 'errB'],
    lastFiredSignature: 'history includes errA but not the other one',
  });
  assert.equal(unseen.needed, true);
  assert.deepEqual(unseen.triggers, ['new_errors']);

  assert.deepEqual(
    assessRecallNeed({
      tool: 'bash',
      command: 'vitest run',
      exitCode: null,
      pre: {},
      post: {},
      recentErrors: ['errA', 'errB'],
      lastFiredSignature: 'history includes errA and errB',
    }),
    { needed: false, triggers: [], query: '', signature: '' },
  );
});

test('assessRecallNeed keeps trigger order fixed for combined causes', () => {
  const result = assessRecallNeed({
    tool: 'bash',
    command: 'go build ./...',
    exitCode: 2,
    pre: {},
    post: { buildFailing: true },
    recentErrors: ['new error'],
    lastFiredSignature: '',
  });

  assert.equal(result.needed, true);
  assert.deepEqual(result.triggers, ['exit_nonzero', 'build_transition', 'new_errors']);
});

test('assessRecallNeed query uses last three errors, trims command, joins with separators, and caps length', () => {
  const result = assessRecallNeed({
    tool: 'bash',
    command: 'c'.repeat(600),
    exitCode: 1,
    pre: {},
    post: {},
    recentErrors: [
      'drop-me-first',
      'err-2-second',
      'err-3-third',
      'err-4-fourth',
    ],
    lastFiredSignature: '',
  });

  assert.equal(result.query.includes('drop-me-first'), false);
  assert.equal(result.query.includes('err-2-'), true);
  assert.equal(result.query.includes('err-3-'), true);
  assert.equal(result.query.includes('err-4-'), true);
  assert.equal(result.query.includes(' | '), true);
  assert.equal(result.query.length <= 500, true);
});
