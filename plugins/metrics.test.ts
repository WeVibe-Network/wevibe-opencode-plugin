import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// @ts-expect-error tsx test runner resolves .ts extension imports.
import { SessionMetricsRecorder } from './metrics.ts';

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
