import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  FunnelCountersTracker,
  createFunnelCountersTracker,
  snapshot,
  snapshotAll,
  serializeFunnelSnapshot,
  resetFunnelCountersTrackers,
} from './funnel-counters';
// @ts-expect-error tsx test runner resolves .ts extension imports.
import { WeVibeMemoryPlugin } from './wevibe-plugin.ts';

// ---------------------------------------------------------------------------
// Unit tests: the full tracker surface (each seam, latency, read accessors).
// ---------------------------------------------------------------------------

test('record increments each seam exactly once per call', () => {
  const tracker = new FunnelCountersTracker();
  const sid = 'session-1';
  tracker.episodeOpened(sid);
  tracker.episodeOpened(sid);
  tracker.episodeArmed(sid);
  tracker.recallFired(sid);
  tracker.gateShown(sid);
  tracker.gateDecided(sid);
  tracker.serveSent(sid);

  const snap = tracker.snapshot(sid);
  assert.ok(snap);
  assert.equal(snap.episode_opened, 2);
  assert.equal(snap.episode_armed, 1);
  assert.equal(snap.recall_fired, 1);
  assert.equal(snap.gate_shown, 1);
  assert.equal(snap.gate_decided, 1);
  assert.equal(snap.serve_sent, 1);
  // No latency measured without beginGate/endGate.
  assert.equal(snap.gate_decision_ms, null);
});

test('gate_decision_ms is measured by beginGate/endGate (>= 0, set after endGate)', () => {
  const tracker = new FunnelCountersTracker();
  const sid = 'session-latency';
  assert.equal(tracker.snapshot(sid), undefined);

  tracker.beginGate(sid);
  // Snapshot between begin and end shows no ms yet.
  assert.equal(tracker.snapshot(sid)?.gate_decision_ms, null);

  tracker.endGate(sid);
  const snap = tracker.snapshot(sid);
  assert.ok(snap);
  assert.ok(snap.gate_decision_ms !== null && snap.gate_decision_ms >= 0);
});

test('endGate without beginGate is a no-op (no undefined timestamp)', () => {
  const tracker = new FunnelCountersTracker();
  const sid = 'session-noop';
  tracker.endGate(sid);
  const snap = tracker.snapshot(sid);
  assert.equal(snap, undefined);
});

test('snapshot returns a copy; snapshotAll returns per-session map', () => {
  const tracker = new FunnelCountersTracker();
  tracker.recallFired('a');
  tracker.recallFired('a');
  tracker.serveSent('b');

  const snapA = tracker.snapshot('a');
  assert.equal(snapA?.recall_fired, 2);
  assert.equal(snapA?.serve_sent, 0);
  // Mutating the returned snapshot must not affect the tracker.
  snapA!.recall_fired = 999;
  assert.equal(tracker.snapshot('a')?.recall_fired, 2);

  const all = tracker.snapshotAll();
  assert.equal(all.size, 2);
  assert.equal(all.get('a')?.recall_fired, 2);
  assert.equal(all.get('b')?.serve_sent, 1);
  assert.equal(all.get('c'), undefined);
});

test('record with the generic seam key increments the named counter', () => {
  const tracker = new FunnelCountersTracker();
  tracker.record('s', 'episode_opened');
  tracker.record('s', 'episode_armed');
  tracker.record('s', 'recall_fired');
  tracker.record('s', 'gate_shown');
  tracker.record('s', 'gate_decided');
  tracker.record('s', 'serve_sent');
  const snap = tracker.snapshot('s')!;
  assert.equal(snap.episode_opened, 1);
  assert.equal(snap.episode_armed, 1);
  assert.equal(snap.recall_fired, 1);
  assert.equal(snap.gate_shown, 1);
  assert.equal(snap.gate_decided, 1);
  assert.equal(snap.serve_sent, 1);
});

test('recordConfirmed accumulates confirmed_on_chain per session', () => {
  const tracker = new FunnelCountersTracker();
  const sid = 'session-confirmed';
  assert.equal(tracker.snapshot(sid), undefined);
  assert.equal(tracker.snapshot(sid)?.confirmed_on_chain, undefined);

  tracker.recordConfirmed(sid, 2);
  assert.equal(tracker.snapshot(sid)?.confirmed_on_chain, 2);

  // Accumulates across calls.
  tracker.recordConfirmed(sid, 3);
  assert.equal(tracker.snapshot(sid)?.confirmed_on_chain, 5);

  // Sessions are isolated.
  assert.equal(tracker.snapshot('other-session'), undefined);
  assert.equal(tracker.snapshot(sid)?.serve_sent, 0);
});

// ---------------------------------------------------------------------------
// Integration: real plugin hooks drive the episode seams + module read surface.
// ---------------------------------------------------------------------------

type FetchCall = {
  url: string;
  method: string;
  bodyText: string | undefined;
  headers: Record<string, unknown> | undefined;
};

const sleep = async (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const toJsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const recallPayload = (): { status: string; memories: unknown[] } => ({
  status: 'ok',
  memories: [
    {
      cid: 'c' + 'a'.repeat(63),
      text: 'recalled memory text',
      score: 0.9,
      matched_keywords: [],
      memory_type: 'correct_implementation',
      guard: { passed: true, flags: [] },
    },
  ],
});

const writeBoundMarker = (worktree: string): void => {
  const markerDir = join(worktree, '.wevibe');
  mkdirSync(markerDir, { recursive: true });
  writeFileSync(
    join(markerDir, 'org.json'),
    JSON.stringify({ org_id: 'org-test', project_fingerprint: 'a'.repeat(64), fingerprint_source: 'origin' }),
    'utf8',
  );
};

const writeSessionToken = (homeDir: string): void => {
  const wevibeDir = join(homeDir, '.wevibe');
  mkdirSync(wevibeDir, { recursive: true });
  writeFileSync(join(wevibeDir, 'mcp-session-token'), 'token-test', 'utf8');
};

const writePluginConfig = (homeDir: string): void => {
  const wevibeDir = join(homeDir, '.wevibe');
  mkdirSync(wevibeDir, { recursive: true });
  writeFileSync(join(wevibeDir, 'plugin-config.json'), JSON.stringify({}, null, 2), 'utf8');
};

type Harness = {
  hooks: Record<string, (input: unknown, output: unknown) => Promise<void>>;
  calls: FetchCall[];
  appLogs: unknown[];
  worktree: string;
  cleanup: () => void;
};

const setupHarness = async (): Promise<Harness> => {
  const oldFetch = globalThis.fetch;
  const oldHome = process.env.HOME;
  const oldRecallMode = process.env.WEVIBE_RECALL_MODE;
  const oldMcpUrl = process.env.WEVIBE_MCP_HTTP_URL;
  const oldAnswererPolicy = process.env.WEVIBE_ANSWERER_POLICY;

  const calls: FetchCall[] = [];
  const appLogs: unknown[] = [];
  const homeDir = mkdtempSync(join(tmpdir(), 'wevibe-funnel-home-'));
  const worktree = mkdtempSync(join(tmpdir(), 'wevibe-funnel-worktree-'));

  writeBoundMarker(worktree);
  writeSessionToken(homeDir);
  writePluginConfig(homeDir);

  process.env.HOME = homeDir;
  process.env.WEVIBE_RECALL_MODE = 'test';
  process.env.WEVIBE_MCP_HTTP_URL = 'http://wevibe-mock:4450';
  process.env.WEVIBE_ANSWERER_POLICY = 'off';

  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const bodyText = typeof init?.body === 'string' ? init.body : undefined;
    calls.push({ url, method, bodyText, headers: {} });
    if (url.endsWith('/v1/health')) return toJsonResponse(200, { status: 'ok' });
    if (url.endsWith('/v1/recall')) return toJsonResponse(200, recallPayload());
    if (url.endsWith('/v1/serves')) return toJsonResponse(200, { status: 'ok' });
    return toJsonResponse(404, { status: 'not-found' });
  }) as typeof fetch;

  const plugin = await WeVibeMemoryPlugin({
    directory: worktree,
    worktree,
    client: {
      app: { log: async (entry: unknown) => { appLogs.push(entry); } },
      tui: { showToast: async () => {} },
    },
    $: {},
  } as never);

  const cleanup = (): void => {
    globalThis.fetch = oldFetch;
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldRecallMode === undefined) delete process.env.WEVIBE_RECALL_MODE;
    else process.env.WEVIBE_RECALL_MODE = oldRecallMode;
    if (oldMcpUrl === undefined) delete process.env.WEVIBE_MCP_HTTP_URL;
    else process.env.WEVIBE_MCP_HTTP_URL = oldMcpUrl;
    if (oldAnswererPolicy === undefined) delete process.env.WEVIBE_ANSWERER_POLICY;
    else process.env.WEVIBE_ANSWERER_POLICY = oldAnswererPolicy;
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  };

  return {
    hooks: plugin as unknown as Record<string, (input: unknown, output: unknown) => Promise<void>>,
    calls,
    appLogs,
    worktree,
    cleanup,
  };
};

const failOutput = (): { title: string; output: string; metadata: Record<string, unknown> } => ({
  title: '',
  output: 'error TS1234: broken',
  metadata: { exit: 1, exit_code: 1 },
});

const redCall = (sessionID: string, callID: string): Record<string, unknown> => ({
  sessionID,
  callID,
  tool: 'bash',
  args: { command: 'npm run build' },
});

const emitFileEdit = async (
  hooks: Record<string, (input: unknown, output: unknown) => Promise<void>>,
  sessionID: string,
): Promise<void> => {
  await hooks['event']({ event: { type: 'file.edited', properties: { sessionID, file: 'src/x.ts' } } }, undefined);
};

const appLogMessages = (appLogs: unknown[]): string[] =>
  appLogs
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return '';
      const body = (entry as { body?: { message?: unknown } }).body;
      return typeof body?.message === 'string' ? body.message : '';
    })
    .filter((message) => message.length > 0);

const waitForAppLog = async (appLogs: unknown[], pattern: RegExp): Promise<void> => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (appLogMessages(appLogs).some((message) => pattern.test(message))) {
      return;
    }
    await sleep(25);
  }
  throw new Error(`Timed out waiting for app log matching ${pattern.toString()}`);
};

test('integration: repeat-failure drives episode_opened, episode_armed, recall_fired', async () => {
  resetFunnelCountersTrackers();
  const harness = await setupHarness();
  try {
    const sessionID = 'funnel-session';
    // Wait for binding + wevibe readiness so the arming red below actually fires
    // and the first red opens a bound episode.
    await waitForAppLog(harness.appLogs, /\[binding\] session bind: active=true/);
    await waitForAppLog(harness.appLogs, /\[recall\] init wevibeAvailable=true/);

    const recallBefore = harness.calls.filter((call) => call.url.endsWith('/v1/recall')).length;

    // Call #1: first red opens the episode (episode_opened=1), never arms.
    await harness.hooks['tool.execute.after'](redCall(sessionID, `${sessionID}-fail-1`), failOutput());
    let snap = snapshot(sessionID);
    assert.equal(snap?.episode_opened, 1);
    assert.equal(snap?.episode_armed, 0);
    assert.equal(snap?.recall_fired, 0);

    // Drive repeat reds with a file edit between them until recall fires.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await emitFileEdit(harness.hooks, sessionID);
      await harness.hooks['tool.execute.after'](redCall(sessionID, `${sessionID}-fail-${attempt + 2}`), failOutput());
      if (harness.calls.filter((call) => call.url.endsWith('/v1/recall')).length > recallBefore) {
        break;
      }
      await sleep(25);
    }

    snap = snapshot(sessionID);
    assert.ok(snap);
    // The repeat red that armed must have counted episode_armed and recall_fired.
    assert.equal(snap.episode_opened, 1, 'episode opened exactly once');
    assert.equal(snap.episode_armed, 1, 'episode armed exactly once');
    assert.equal(snap.recall_fired, 1, 'recall fired exactly once');

    // snapshotAll exposes the same session map.
    const all = snapshotAll();
    assert.equal(all.get(sessionID)?.episode_armed, 1);
  } finally {
    harness.cleanup();
    resetFunnelCountersTrackers();
  }
});

test('snapshotAll empty when no tracker registered', () => {
  resetFunnelCountersTrackers();
  assert.equal(snapshotAll().size, 0);
  assert.equal(snapshot('whatever'), undefined);
});

test('serializeFunnelSnapshot returns flat sessionId->counters JSON object', () => {
  resetFunnelCountersTrackers();
  try {
    const tracker = createFunnelCountersTracker();
    const sid = 'sess-serialize';
    tracker.episodeOpened(sid);
    tracker.episodeOpened(sid);
    tracker.episodeArmed(sid);
    tracker.gateShown(sid);
    tracker.gateDecided(sid);
    tracker.serveSent(sid);
    tracker.recordConfirmed(sid, 2);

    const json = JSON.parse(serializeFunnelSnapshot());
    assert.equal(typeof json, 'object');
    assert.ok(json[sid], 'snapshot JSON exposes the recorded session');
    assert.equal(json[sid].episode_opened, 2);
    assert.equal(json[sid].episode_armed, 1);
    assert.equal(json[sid].gate_shown, 1);
    assert.equal(json[sid].serve_sent, 1);
    assert.equal(json[sid].confirmed_on_chain, 2);
    assert.equal(json[sid].gate_decision_ms, null);
  } finally {
    resetFunnelCountersTrackers();
  }
});

test('session.idle flush writes funnel-snapshot.json with expected shape', async () => {
  resetFunnelCountersTrackers();
  const harness = await setupHarness();
  try {
    const sessionID = 'funnel-flush-session';
    // Wait for binding + wevibe readiness so the red opens a bound episode.
    await waitForAppLog(harness.appLogs, /\[binding\] session bind: active=true/);
    await waitForAppLog(harness.appLogs, /\[recall\] init wevibeAvailable=true/);

    // One red opens the episode (episode_opened=1).
    await harness.hooks['tool.execute.after'](redCall(sessionID, `${sessionID}-fail-1`), failOutput());

    // Drive session.idle -> terminal flush.
    await harness.hooks['event']({ event: { type: 'session.idle', properties: { sessionID } } }, undefined);

    const snapshotPath = join(harness.worktree, '.wevibe', 'state', 'funnel-snapshot.json');
    const json = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    assert.equal(typeof json, 'object');
    assert.ok(json[sessionID], 'snapshot file exposes the idle session');
    // The recorded red must have opened an episode.
    assert.equal(json[sessionID].episode_opened, 1);
    assert.equal(typeof json[sessionID].gate_decision_ms, 'object'); // JSON null
    assert.equal(json[sessionID].gate_decision_ms, null);
  } finally {
    harness.cleanup();
    resetFunnelCountersTrackers();
  }
});