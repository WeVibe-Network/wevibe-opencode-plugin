import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// @ts-expect-error tsx test runner resolves .ts extension imports.
import { WeVibeMemoryPlugin, buildMemoryBlock, formatMemoryLine } from './wevibe-plugin.ts';
// @ts-expect-error tsx test runner resolves .ts extension imports.
import { registerPredicateAdapter, type PredicateAdapter, type PredicateRunContext } from './predicate-adapter.ts';
// @ts-expect-error tsx test runner resolves .ts extension imports.
import { computeFailureKey } from './failure-key.ts';
// @ts-expect-error tsx test runner resolves .ts extension imports.
import { computeEpisodeRef } from './outcome-episode.ts';
// @ts-expect-error tsx test runner resolves .ts extension imports.
import { fp8 } from './gstv-spool.ts';
// @ts-expect-error tsx test runner resolves .ts extension imports.
import { clearPredicateCache } from './predicate-binding.ts';
// @ts-expect-error tsx test runner resolves .ts extension imports.
import { snapshot, resetFunnelCountersTrackers } from './funnel-counters.ts';

type FetchCall = {
  url: string
  method: string
  bodyText?: string
  headers?: Record<string, unknown>
}

type Harness = {
  hooks: Record<string, (input: unknown, output: unknown) => Promise<void>>
  calls: FetchCall[]
  appLogs: unknown[]
  worktree: string
  decisionsPath: string
  statusPath: string
  logFilePath?: string
  cleanup: () => void
}

type SetupHarnessOptions = {
  recallResponder?: (call: FetchCall) => Response | Promise<Response>
  decisionNoteResponder?: (call: FetchCall) => Response | Promise<Response>
  confirmResponder?: (call: FetchCall) => Response | Promise<Response>
  serveResponder?: (call: FetchCall) => Response | Promise<Response>
  captureLogFile?: boolean
  recallMode?: 'test' | 'prod'
  answererPolicy?: 'auto-accept' | 'auto-deny' | 'off'
}

type RecallMemory = {
  cid: string
  text: string
  score?: number
  matchedKeywords?: string[]
  flags?: string[]
}

const sleep = async (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const toJsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });

const readBodyText = (body: unknown): string | undefined => {
  if (typeof body === 'string') {
    return body;
  }
  if (body === undefined || body === null) {
    return undefined;
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body).toString('utf8');
  }
  return String(body);
};

const recallPayload = (memories: RecallMemory[]): { status: string; memories: Array<Record<string, unknown>> } => ({
  status: 'ok',
  memories: memories.map((memory) => ({
    cid: memory.cid,
    text: memory.text,
    score: memory.score ?? 0.9,
    matched_keywords: memory.matchedKeywords ?? [],
    memory_type: 'correct_implementation',
    guard: {
      passed: true,
      flags: memory.flags ?? [],
    },
  })),
});

const writeBoundMarker = (worktree: string): void => {
  const markerDir = join(worktree, '.wevibe');
  mkdirSync(markerDir, { recursive: true });
  writeFileSync(
    join(markerDir, 'org.json'),
    JSON.stringify({
      org_id: 'org-test',
      project_fingerprint: 'a'.repeat(64),
      fingerprint_source: 'origin',
    }),
    'utf8',
  );
};

const writePluginConfig = (homeDir: string, config: Record<string, unknown>): void => {
  const wevibeDir = join(homeDir, '.wevibe');
  mkdirSync(wevibeDir, { recursive: true });
  writeFileSync(join(wevibeDir, 'plugin-config.json'), JSON.stringify(config, null, 2), 'utf8');
};

const writeSessionToken = (homeDir: string): void => {
  const wevibeDir = join(homeDir, '.wevibe');
  mkdirSync(wevibeDir, { recursive: true });
  writeFileSync(join(wevibeDir, 'mcp-session-token'), 'token-test', 'utf8');
};

const setupHarness = async (
  memories: RecallMemory[],
  config: Record<string, unknown> = {},
  options: SetupHarnessOptions = {},
): Promise<Harness> => {
  const oldFetch = globalThis.fetch;
  const oldHome = process.env.HOME;
  const oldRecallMode = process.env.WEVIBE_RECALL_MODE;
  const oldMcpUrl = process.env.WEVIBE_MCP_HTTP_URL;
  const oldLogDir = process.env.WEVIBE_LOG_DIR;
  const oldAnswererPolicy = process.env.WEVIBE_ANSWERER_POLICY;

  const calls: FetchCall[] = [];
  const appLogs: unknown[] = [];
  const homeDir = mkdtempSync(join(tmpdir(), 'wevibe-plugin-home-'));
  const worktree = mkdtempSync(join(tmpdir(), 'wevibe-plugin-worktree-'));
  const logDir = join(homeDir, 'plugin-logs');
  const logFilePath = join(logDir, 'wevibe-plugin-errors.log');
  const decisionsPath = join(worktree, '.wevibe', 'state', 'wevibe-plugin-decisions.json');
  const statusPath = join(worktree, '.wevibe', 'state', 'wevibe-plugin-status.json');

  writeBoundMarker(worktree);
  writeSessionToken(homeDir);
  writePluginConfig(homeDir, config);

  process.env.HOME = homeDir;
  process.env.WEVIBE_RECALL_MODE = options.recallMode ?? 'test';
  process.env.WEVIBE_MCP_HTTP_URL = 'http://wevibe-mock:4450';
  if (options.answererPolicy !== undefined) {
    process.env.WEVIBE_ANSWERER_POLICY = options.answererPolicy;
  } else if (oldAnswererPolicy !== undefined) {
    process.env.WEVIBE_ANSWERER_POLICY = oldAnswererPolicy;
  } else {
    delete process.env.WEVIBE_ANSWERER_POLICY;
  }
  if (options.captureLogFile) {
    process.env.WEVIBE_LOG_DIR = logDir;
  } else if (oldLogDir !== undefined) {
    process.env.WEVIBE_LOG_DIR = oldLogDir;
  } else {
    delete process.env.WEVIBE_LOG_DIR;
  }

  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? (typeof input === 'string' || input instanceof URL ? 'GET' : input.method) ?? 'GET').toUpperCase();
    const bodyText = readBodyText(init?.body);
    const headers = init?.headers instanceof Headers
      ? Object.fromEntries(init.headers.entries()) as Record<string, unknown>
      : init?.headers && typeof init.headers === 'object' && !Array.isArray(init.headers)
        ? init.headers as Record<string, unknown>
        : undefined;
    const call = { url, method, bodyText, headers };
    calls.push(call);

    if (url.endsWith('/v1/health')) {
      return toJsonResponse(200, { status: 'ok' });
    }
    if (url.endsWith('/v1/recall')) {
      if (options.recallResponder) {
        return options.recallResponder(call);
      }
      return toJsonResponse(200, recallPayload(memories));
    }
    if (url.endsWith('/v1/decision-notes')) {
      if (options.decisionNoteResponder) {
        return options.decisionNoteResponder(call);
      }
      return toJsonResponse(200, { status: 'ok' });
    }
    if (url.endsWith('/v1/serves')) {
      if (options.serveResponder) {
        return options.serveResponder(call);
      }
      return toJsonResponse(200, { status: 'ok' });
    }
    if (url.includes('/serves/confirm')) {
      if (options.confirmResponder) {
        return options.confirmResponder(call);
      }
      return toJsonResponse(200, { serves: [] });
    }
    if (url.endsWith('/v1/shutdown')) {
      return toJsonResponse(200, { status: 'ok' });
    }

    throw new Error(`Unexpected fetch: ${method} ${url}`);
  }) as typeof fetch;

  const plugin = await WeVibeMemoryPlugin({
    directory: worktree,
    worktree,
    client: {
      app: {
        log: async (entry: unknown) => {
          appLogs.push(entry);
        },
      },
      tui: {
        showToast: async () => {},
      },
    },
    $: {},
  } as never);

  const cleanup = (): void => {
    globalThis.fetch = oldFetch;
    if (oldHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = oldHome;
    }
    if (oldRecallMode === undefined) {
      delete process.env.WEVIBE_RECALL_MODE;
    } else {
      process.env.WEVIBE_RECALL_MODE = oldRecallMode;
    }
    if (oldMcpUrl === undefined) {
      delete process.env.WEVIBE_MCP_HTTP_URL;
    } else {
      process.env.WEVIBE_MCP_HTTP_URL = oldMcpUrl;
    }
    if (oldLogDir === undefined) {
      delete process.env.WEVIBE_LOG_DIR;
    } else {
      process.env.WEVIBE_LOG_DIR = oldLogDir;
    }
    if (oldAnswererPolicy === undefined) {
      delete process.env.WEVIBE_ANSWERER_POLICY;
    } else {
      process.env.WEVIBE_ANSWERER_POLICY = oldAnswererPolicy;
    }
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  };

  return {
    hooks: plugin as unknown as Record<string, (input: unknown, output: unknown) => Promise<void>>,
    calls,
    appLogs,
    worktree,
    decisionsPath,
    statusPath,
    ...(options.captureLogFile ? { logFilePath } : {}),
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

// C3 trigger rework: the sole recall trigger is a REPEAT failure under a stable
// failureKey (D-RECALL-TRIGGER-REPEAT). Drive the repeat-failure pattern: first
// red opens the episode (no arm), a file.edited between reds arms the C3b flake
// guard, and the second red arms the recall. Polls until the recall fetch lands
// so binding/wevibe warm-up is absorbed, exactly like the old chat.message loop.
const driveRepeatFailure = async (
  hooks: Record<string, (input: unknown, output: unknown) => Promise<void>>,
  calls: FetchCall[],
  sessionID: string,
): Promise<void> => {
  const recallBefore = calls.filter(call => call.url.endsWith('/v1/recall')).length;
  // call #1: first red — opens the episode, never arms.
  await hooks['tool.execute.after'](redCall(sessionID, `${sessionID}-fail-1`), failOutput());
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await emitFileEdit(hooks, sessionID);
    await hooks['tool.execute.after'](redCall(sessionID, `${sessionID}-fail-${attempt + 2}`), failOutput());
    if (calls.filter(call => call.url.endsWith('/v1/recall')).length > recallBefore) {
      return;
    }
    await sleep(25);
  }
  throw new Error('Timed out waiting for repeat-failure recall');
};

const recallCalls = (calls: FetchCall[]): FetchCall[] => calls.filter(call => call.url.endsWith('/v1/recall'));

const waitForRecallCount = async (calls: FetchCall[], expected: number): Promise<void> => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (recallCalls(calls).length >= expected) {
      return;
    }
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${expected} recall calls`);
};

const decisionNoteCalls = (calls: FetchCall[]): FetchCall[] => calls.filter(call => call.url.endsWith('/v1/decision-notes'));

const appLogMessages = (appLogs: unknown[]): string[] =>
  appLogs
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return '';
      const body = (entry as { body?: { message?: unknown } }).body;
      return typeof body?.message === 'string' ? body.message : '';
    })
    .filter(message => message.length > 0);

const waitForAppLog = async (appLogs: unknown[], pattern: RegExp): Promise<void> => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (appLogMessages(appLogs).some(message => pattern.test(message))) {
      return;
    }
    await sleep(25);
  }
  throw new Error(`Timed out waiting for app log matching ${pattern.toString()}`);
};

type StoredDecisionItem = {
  memoryID: string
  action: 'accept' | 'deny' | 'block' | 'report'
  reason?: string
  note?: string
  timestamp: number
  source?: 'user'
}

const writeDecisions = (
  harness: Harness,
  decisions: StoredDecisionItem[],
): void => {
  writeFileSync(harness.decisionsPath, JSON.stringify(decisions), 'utf8');
};

const readDecisions = (harness: Harness): unknown => JSON.parse(readFileSync(harness.decisionsPath, 'utf8'));

const stateDirOf = (worktree: string): string => join(worktree, '.wevibe', 'state');

// Engages the TUI-live recall gate: isTuiLive() reads wevibe-tui-active.json and
// requires a ts within the last 30s. Fresh ts => the gate loop engages on the
// next transform.
const enableTuiLive = (worktree: string): void => {
  writeFileSync(join(stateDirOf(worktree), 'wevibe-tui-active.json'), JSON.stringify({ ts: Date.now() }), 'utf8');
};

// Reads the outcome-spool jsonl (one OutcomeSpoolRecord per line) under the
// state dir. Polls briefly since enqueue persists via a queued async append.
const readOutcomeSpoolRecords = async (worktree: string): Promise<Array<Record<string, unknown>>> => {
  const spoolPath = join(stateDirOf(worktree), 'outcome-spool', 'outcome-spool-v1.jsonl');
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (existsSync(spoolPath)) {
      const text = readFileSync(spoolPath, 'utf8').trim();
      if (text.length > 0) {
        return text.split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
      }
    }
    await sleep(25);
  }
  return [];
};

// Runs a transform hook under the gate and asserts it is STILL PENDING after a
// bounded window (proving it blocks — no timeout). Caller must then unblock
// (write a decision / set the answerer) and await the returned promise so no
// wedge leaks. Resolves to the pending transform promise after the window.
const assertGateStillPending = async (
  hooks: Record<string, (input: unknown, output: unknown) => Promise<void>>,
  sessionID: string,
  output: { system: string[] },
  windowMs = 500,
): Promise<Promise<void>> => {
  const gatePromise = hooks['experimental.chat.system.transform']({ sessionID }, output);
  let resolved = false;
  const raced = await Promise.race([
    gatePromise.then(() => { resolved = true; }),
    sleep(windowMs),
  ]);
  assert.equal(raced, undefined, 'gate transform must be pending during the window');
  assert.equal(resolved, false, `gate must still be blocked after ${windowMs}ms (NO timeout)`);
  return gatePromise;
};

const tuiActivePathOf = (worktree: string): string => join(stateDirOf(worktree), 'wevibe-tui-active.json');

// Releases a blocked gate deterministically: aging the TUI heartbeat out makes
// `isTuiLive()` return false, firing the gate loop's `!isTuiLive()` dropout break
// (the sanctioned TUI-close exit, distinct from the removed timeout). This is the
// reliable unblock path in the harness; decision-mid-loop writes are not reliably
// observed by the gate loop's drain (sandbox filesystem-visibility anomaly), so the
// blocking tests release via the dropout while decision-completion is covered by
// the answerer / direct-decision tests.
const releaseGateViaHeartbeatDropout = (worktree: string): void => {
  writeFileSync(tuiActivePathOf(worktree), JSON.stringify({ ts: Date.now() - 60_000 }), 'utf8');
};

const readStatus = (harness: Harness): unknown => JSON.parse(readFileSync(harness.statusPath, 'utf8'));

const serveBodies = (calls: FetchCall[]): Array<Record<string, unknown>> =>
  calls
    .filter(call => call.url.endsWith('/v1/serves'))
    .map(call => JSON.parse(call.bodyText ?? '{}') as Record<string, unknown>);

const waitForServeRejected = async (sessionID: string, expected: number): Promise<void> => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if ((snapshot(sessionID)?.serve_rejected ?? 0) >= expected) return;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for serve_rejected=${expected} on ${sessionID}`);
};

test('injects once per session, preserves stable position, avoids re-push, restores exact block on compacting, and serves once', { concurrency: false }, async (t) => {
  const memories: RecallMemory[] = [
    { cid: 'cid-a', text: 'Memory A', matchedKeywords: ['alpha'] },
    { cid: 'cid-b', text: 'Memory B', matchedKeywords: ['beta'] },
  ];
  const harness = await setupHarness(memories, { recall_max_injected: 10, inject_char_budget: 8000 });
  t.after(() => harness.cleanup());

  const { hooks, calls } = harness;
  const sessionID = 'session-inject-once';

  await driveRepeatFailure(hooks, calls, sessionID);

  const turnOneOutput = { system: ['base system instruction'] };
  await hooks['experimental.chat.system.transform']({ sessionID }, turnOneOutput);

  assert.equal(turnOneOutput.system.length, 2);
  assert.equal(turnOneOutput.system[0], 'base system instruction');
  const injectedBlock = turnOneOutput.system[1];
  assert.equal(typeof injectedBlock, 'string');
  assert.ok(injectedBlock.includes('## Team Memory (WeVibe Network)'));
  assert.ok(injectedBlock.includes('1. Memory A'));
  assert.ok(injectedBlock.includes('2. Memory B'));

  const serveAfterTurnOne = serveBodies(calls);
  assert.equal(serveAfterTurnOne.length, 2);
  assert.deepEqual(
    serveAfterTurnOne.map(body => body.memory_hash),
    ['cid-a', 'cid-b'],
  );

  const turnTwoOutput = { system: [...turnOneOutput.system] };
  const beforeSecondTransform = [...turnTwoOutput.system];
  await hooks['experimental.chat.system.transform']({ sessionID }, turnTwoOutput);
  assert.deepEqual(turnTwoOutput.system, beforeSecondTransform);

  const serveAfterTurnTwo = serveBodies(calls);
  assert.equal(serveAfterTurnTwo.length, 2);

  const compactOutput = { context: ['existing context entry'] };
  await hooks['experimental.session.compacting']({ sessionID }, compactOutput);
  assert.equal(compactOutput.context[0], injectedBlock);
  assert.equal(compactOutput.context[1], 'existing context entry');
});

test('injects at index 0 when output.system starts empty', { concurrency: false }, async (t) => {
  const harness = await setupHarness([{ cid: 'cid-empty', text: 'Memory in empty system' }], { recall_max_injected: 10, inject_char_budget: 8000 });
  t.after(() => harness.cleanup());

  const { hooks, calls } = harness;
  const sessionID = 'session-empty-system';

  await driveRepeatFailure(hooks, calls, sessionID);

  const output = { system: [] as string[] };
  await hooks['experimental.chat.system.transform']({ sessionID }, output);

  assert.equal(output.system.length, 1);
  assert.ok(output.system[0].includes('## Team Memory (WeVibe Network)'));
});

test('prod recall mode drains accept decisions into approved and injects them via transform', { concurrency: false }, async (t) => {
  const memory = { cid: 'cid-prod-accept', text: 'Accepted in prod mode' };
  const harness = await setupHarness(
    [memory],
    { recall_max_injected: 10, inject_char_budget: 8000 },
    { recallMode: 'prod' },
  );
  t.after(() => harness.cleanup());

  const { hooks, calls, appLogs, worktree } = harness;
  const sessionID = 'session-prod-accept-drain';

  await driveRepeatFailure(hooks, calls, sessionID);

  const preDecisionOutput = { system: ['base system instruction'] };
  await hooks['experimental.chat.system.transform']({ sessionID }, preDecisionOutput);
  const preDecisionLogs = appLogMessages(appLogs);
  assert.ok(preDecisionLogs.some(message => message.includes('[inject]') && message.includes('nothing injected') && message.includes('approved=0')));
  assert.equal(preDecisionOutput.system.length, 1);

  const stateDir = join(worktree, '.wevibe', 'state');
  writeFileSync(join(stateDir, 'wevibe-tui-active.json'), JSON.stringify({ ts: Date.now() }), 'utf8');
  writeDecisions(harness, [{ memoryID: memory.cid, action: 'accept', reason: '', note: '', timestamp: Date.now() }]);

  const output = { system: ['base system instruction'] };
  await hooks['experimental.chat.system.transform']({ sessionID }, output);

  assert.equal(output.system.length, 2);
  assert.ok(output.system[1].includes('## Team Memory (WeVibe Network)'));
  assert.ok(output.system[1].includes(memory.text));
  assert.deepEqual(readDecisions(harness), []);
  const postDecisionLogs = appLogMessages(appLogs);
  assert.ok(postDecisionLogs.some(message => message.includes('[inject] injected count=1')));
});

test('budget cap skips oversized memory, continues to inject fitting later memory, and never serves oversized memory on later turns', { concurrency: false }, async (t) => {
  const tinyMemory = { cid: 'cid-small', text: 'short fit' };
  const oversizedMemory = { cid: 'cid-large', text: 'X'.repeat(5000) };

  const overhead = buildMemoryBlock([], 'test').length;
  const tinyCharge = formatMemoryLine({ text: tinyMemory.text, flags: [] }, 1).length + 1;
  const injectBudget = overhead + tinyCharge + 2;

  const harness = await setupHarness(
    [oversizedMemory, tinyMemory],
    {
      recall_max_injected: 10,
      inject_char_budget: injectBudget,
    },
  );
  t.after(() => harness.cleanup());

  const { hooks, calls } = harness;
  const sessionID = 'session-budget';

  await driveRepeatFailure(hooks, calls, sessionID);

  const firstTurn = { system: ['seed system'] };
  await hooks['experimental.chat.system.transform']({ sessionID }, firstTurn);

  assert.equal(firstTurn.system.length, 2);
  assert.ok(firstTurn.system[1].includes(tinyMemory.text));
  assert.ok(!firstTurn.system[1].includes(oversizedMemory.text));

  const firstServes = serveBodies(calls);
  assert.equal(firstServes.length, 1);
  assert.equal(firstServes[0].memory_hash, tinyMemory.cid);

  const secondTurn = { system: [...firstTurn.system] };
  const snapshot = [...secondTurn.system];
  await hooks['experimental.chat.system.transform']({ sessionID }, secondTurn);

  assert.deepEqual(secondTurn.system, snapshot);
  assert.ok(!secondTurn.system[1].includes(oversizedMemory.text));

  const secondServes = serveBodies(calls);
  assert.equal(secondServes.length, 1);
  assert.equal(secondServes[0].memory_hash, tinyMemory.cid);
});

test('fires need-gated recall on failing tool.execute.after signals', { concurrency: false }, async (t) => {
  const harness = await setupHarness([{ cid: 'cid-failure', text: 'failure memory' }], { recall_max_injected: 10, inject_char_budget: 8000 });
  t.after(() => harness.cleanup());

  const { hooks, calls } = harness;
  const sessionID = 'session-tool-failure-fire';

  await driveRepeatFailure(hooks, calls, sessionID);
  await hooks['experimental.chat.system.transform']({ sessionID }, { system: ['base system'] });
  await waitForRecallCount(calls, 1);

  const recalls = recallCalls(calls);
  assert.equal(recalls.length, 1);

  const body = JSON.parse(recalls[0].bodyText ?? '{}') as Record<string, unknown>;
  const query = typeof body.query === 'string' ? body.query : '';
  assert.match(query, /(build failing|tool failure)/);
  assert.ok(query.includes('npm run build'));
  assert.equal(typeof body.org_id, 'string');
  assert.equal(typeof body.session_id, 'string');
});

test('stays silent on clean tool.execute.after results', { concurrency: false }, async (t) => {
  const harness = await setupHarness([{ cid: 'cid-clean', text: 'clean memory' }], { recall_max_injected: 10, inject_char_budget: 8000 });
  t.after(() => harness.cleanup());

  const { hooks, calls } = harness;
  const sessionID = 'session-tool-clean';

  await driveRepeatFailure(hooks, calls, sessionID);
  await hooks['experimental.chat.system.transform']({ sessionID }, { system: ['base system'] });
  await hooks['tool.execute.after'](
    {
      tool: 'bash',
      sessionID,
      callID: 'call-build-clean',
      args: { command: 'npm run build' },
    },
    {
      title: '',
      output: 'ok',
      metadata: { exit: 0 },
    },
  );

  await sleep(150);
  assert.equal(recallCalls(calls).length, 1);
});

test('dedups identical failing signatures for tool.execute.after recall', { concurrency: false }, async (t) => {
  const harness = await setupHarness([{ cid: 'cid-dedup', text: 'dedup memory' }], { recall_max_injected: 10, inject_char_budget: 8000 });
  t.after(() => harness.cleanup());

  const { hooks, calls } = harness;
  const sessionID = 'session-tool-dedup';
  const failingOutput = {
    title: '',
    output: 'error TS2345: boom',
    metadata: { exit: 1 },
  };

  await driveRepeatFailure(hooks, calls, sessionID);
  await hooks['experimental.chat.system.transform']({ sessionID }, { system: ['base system'] });
  await waitForRecallCount(calls, 1);

  // A third identical failing red (even with another file edit) must NOT fire
  // again: after the armed call the key is markFired (episode.fired=true).
  await emitFileEdit(hooks, sessionID);
  await hooks['tool.execute.after'](
    {
      tool: 'bash',
      sessionID,
      callID: 'c1',
      args: { command: 'npm run build' },
    },
    failingOutput,
  );
  await emitFileEdit(hooks, sessionID);
  await hooks['tool.execute.after'](
    {
      tool: 'bash',
      sessionID,
      callID: 'c2',
      args: { command: 'npm run build' },
    },
    failingOutput,
  );
  await sleep(150);

  assert.equal(recallCalls(calls).length, 1);
});

test('does not fire tool failure recall while recall request is in flight', { concurrency: false }, async (t) => {
  let resolveRecall: (value: Response) => void = () => {};
  let hasResolveRecall = false;
  let recallDeferred: Promise<Response> | null = null;

  const harness = await setupHarness(
    [{ cid: 'cid-inflight', text: 'inflight memory' }],
    { recall_max_injected: 10, inject_char_budget: 8000 },
    {
      recallResponder: () => {
        if (!recallDeferred) {
          recallDeferred = new Promise<Response>((resolve) => {
            resolveRecall = resolve;
            hasResolveRecall = true;
          });
        }
        return recallDeferred;
      },
    },
  );
  t.after(() => harness.cleanup());

  const { hooks, calls, appLogs } = harness;
  const sessionID = 'session-tool-inflight';

  try {
    // Wait for the binding + wevibe readiness so the arming red below actually fires.
    await waitForAppLog(appLogs, /\[binding\] session bind: active=true/);
    await waitForAppLog(appLogs, /\[recall\] init wevibeAvailable=true/);

    // Arm episode A (build fail): first red opens it, file edit between, second
    // red arms the recall which stays in flight (deferred responder).
    await hooks['tool.execute.after'](
      {
        tool: 'bash',
        sessionID,
        callID: 'inflight-a-1',
        args: { command: 'npm run build' },
      },
      { title: '', output: 'error TS1234: broken', metadata: { exit: 1 } },
    );
    await emitFileEdit(hooks, sessionID);
    await hooks['tool.execute.after'](
      {
        tool: 'bash',
        sessionID,
        callID: 'inflight-a-2',
        args: { command: 'npm run build' },
      },
      { title: '', output: 'error TS1234: broken', metadata: { exit: 1 } },
    );
    await waitForRecallCount(calls, 1);
    assert.equal(recallCalls(calls).length, 1);

    // A DIFFERENT episode (test fail, distinct command fp) would arm on its
    // repeat red, but the recall is still in flight, so the !recallInFlight
    // guard suppresses it. Assert no second recall fires.
    await hooks['tool.execute.after'](
      {
        tool: 'bash',
        sessionID,
        callID: 'inflight-b-1',
        args: { command: 'npm run test' },
      },
      { title: '', output: 'error TS9999: broken', metadata: { exit: 1 } },
    );
    await emitFileEdit(hooks, sessionID);
    await hooks['tool.execute.after'](
      {
        tool: 'bash',
        sessionID,
        callID: 'inflight-b-2',
        args: { command: 'npm run test' },
      },
      { title: '', output: 'error TS9999: broken', metadata: { exit: 1 } },
    );

    await sleep(150);
    assert.equal(recallCalls(calls).length, 1);
  } finally {
    if (hasResolveRecall) {
      resolveRecall(toJsonResponse(200, recallPayload([{ cid: 'cid-inflight', text: 'inflight memory' }])));
    }
  }

  await hooks['experimental.chat.system.transform']({ sessionID }, { system: ['base'] });
  assert.equal(recallCalls(calls).length, 1);
});

test('emits funnel recall_fired and recall_returned line shapes with matching trace for tool failure', { concurrency: false }, async (t) => {
  const harness = await setupHarness(
    [{ cid: 'cid-funnel', text: 'funnel memory' }],
    { recall_max_injected: 10, inject_char_budget: 8000 },
    { captureLogFile: true },
  );
  t.after(() => harness.cleanup());

  const { hooks, calls, appLogs, logFilePath } = harness;
  const sessionID = 'session-tool-funnel';

  await driveRepeatFailure(hooks, calls, sessionID);
  await hooks['experimental.chat.system.transform']({ sessionID }, { system: ['base system'] });
  await waitForRecallCount(calls, 1);
  await waitForAppLog(appLogs, /recall_returned /);
  await sleep(50);

  const messages = appLogMessages(appLogs);

  assert.ok(messages.some(message => /recall_fired trigger=repeat_failure sid=\S+/.test(message)));
  assert.ok(messages.some(message => /recall_returned status=\S+ count=\d+ reason_code=\S+ dur_ms=\d+ error=\S+/.test(message)));

  assert.ok(logFilePath);
  const logText = existsSync(logFilePath) ? readFileSync(logFilePath, 'utf8') : '';
  const recallLines = logText.split('\n').filter(line => line.includes('recall_fired') || line.includes('recall_returned'));
  const firedLines = recallLines.filter(line => line.includes('recall_fired'));
  const returnedLines = recallLines.filter(line => line.includes('recall_returned'));

  assert.ok(firedLines.some(line => /recall_fired trigger=repeat_failure sid=\S+/.test(line)));
  assert.ok(firedLines.every(line => /trace=[0-9a-f]{8}/.test(line)));
  assert.ok(returnedLines.length >= firedLines.length);
  assert.ok(returnedLines.every(line => /recall_returned status=\S+ count=\d+ reason_code=\S+ dur_ms=\d+ error=\S+/.test(line)));

  const repeatFailureLine = firedLines.find(line => /recall_fired trigger=repeat_failure sid=\S+/.test(line));
  assert.ok(repeatFailureLine);
  const repeatFailureTrace = (repeatFailureLine?.match(/trace=([0-9a-f]{8})/) ?? [])[1];
  assert.equal(typeof repeatFailureTrace, 'string');
  assert.ok(returnedLines.some(line => line.includes(`trace=${repeatFailureTrace}`)));
});

test('posts a decision-note on deny with org, memory hash, and reason', { concurrency: false }, async (t) => {
  const harness = await setupHarness([], { recall_max_injected: 10, inject_char_budget: 8000 });
  t.after(() => harness.cleanup());

  const { hooks, calls } = harness;
  const sessionID = 'session-decision-note-deny-reason';

  await driveRepeatFailure(hooks, calls, sessionID);
  writeDecisions(harness, [{ memoryID: 'cid-deny-1', action: 'deny', reason: 'not relevant', timestamp: Date.now() }]);

  await hooks['experimental.chat.system.transform']({ sessionID }, { system: ['base system'] });

  const noteCalls = decisionNoteCalls(calls);
  assert.equal(noteCalls.length, 1);
  assert.equal(noteCalls[0].method, 'POST');
  assert.deepEqual(JSON.parse(noteCalls[0].bodyText ?? '{}'), {
    org_id: 'org-test',
    memory_hash: 'cid-deny-1',
    action: 'deny',
    reason: 'not relevant',
  });

  assert.equal(noteCalls[0].headers?.Authorization, 'Bearer token-test');
  const traceId = noteCalls[0].headers?.['X-WeVibe-Trace-Id'];
  assert.equal(typeof traceId, 'string');
  assert.match(traceId as string, /^[0-9a-f]{8}$/);

  assert.ok(appLogMessages(harness.appLogs).some(message => /\[decision-note\] deny memory_fp=/.test(message)));
  assert.deepEqual(readDecisions(harness), []);

  const status = readStatus(harness) as { denied?: string[] };
  assert.ok(status.denied?.includes('cid-deny-1'));
});

test('omits reason on the decision-note when the deny carries none', { concurrency: false }, async (t) => {
  const harness = await setupHarness([], { recall_max_injected: 10, inject_char_budget: 8000 });
  t.after(() => harness.cleanup());

  const { hooks, calls } = harness;
  const sessionID = 'session-decision-note-deny-no-reason';

  await driveRepeatFailure(hooks, calls, sessionID);
  writeDecisions(harness, [{ memoryID: 'cid-deny-2', action: 'deny', timestamp: Date.now() }]);

  await hooks['experimental.chat.system.transform']({ sessionID }, { system: ['base system'] });

  const noteCalls = decisionNoteCalls(calls);
  assert.equal(noteCalls.length, 1);
  assert.deepEqual(JSON.parse(noteCalls[0].bodyText ?? '{}'), {
    org_id: 'org-test',
    memory_hash: 'cid-deny-2',
    action: 'deny',
  });

  const status = readStatus(harness) as { denied?: string[] };
  assert.ok(status.denied?.includes('cid-deny-2'));
});

test('logs but does not fail the deny when the decision-note endpoint returns non-2xx', { concurrency: false }, async (t) => {
  const harness = await setupHarness(
    [],
    { recall_max_injected: 10, inject_char_budget: 8000 },
    { decisionNoteResponder: () => toJsonResponse(500, { error: 'mcp exploded' }) },
  );
  t.after(() => harness.cleanup());

  const { hooks, calls } = harness;
  const sessionID = 'session-decision-note-deny-500';

  await driveRepeatFailure(hooks, calls, sessionID);
  writeDecisions(harness, [{ memoryID: 'cid-deny-3', action: 'deny', reason: 'bad status', timestamp: Date.now() }]);

  await hooks['experimental.chat.system.transform']({ sessionID }, { system: ['base system'] });
  await waitForAppLog(harness.appLogs, /\[decision-note\] deny note failed status=500/);

  assert.deepEqual(readDecisions(harness), []);
  const status = readStatus(harness) as { denied?: string[] };
  assert.ok(status.denied?.includes('cid-deny-3'));
});

test('logs but does not fail the deny when the decision-note fetch throws', { concurrency: false }, async (t) => {
  const harness = await setupHarness(
    [],
    { recall_max_injected: 10, inject_char_budget: 8000 },
    {
      decisionNoteResponder: () => {
        throw new Error('connect ECONNREFUSED');
      },
    },
  );
  t.after(() => harness.cleanup());

  const { hooks, calls } = harness;
  const sessionID = 'session-decision-note-deny-fetch-throw';

  await driveRepeatFailure(hooks, calls, sessionID);
  writeDecisions(harness, [{ memoryID: 'cid-deny-4', action: 'deny', reason: 'network fail', timestamp: Date.now() }]);

  await hooks['experimental.chat.system.transform']({ sessionID }, { system: ['base system'] });
  await waitForAppLog(harness.appLogs, /\[decision-note\] deny note failed reason=.*ECONNREFUSED/);

  assert.deepEqual(readDecisions(harness), []);
  const status = readStatus(harness) as { denied?: string[] };
  assert.ok(status.denied?.includes('cid-deny-4'));
});

test('C3b flake guard: a repeat red without a file edit does not arm, and a later edit arms', { concurrency: false }, async (t) => {
  const harness = await setupHarness([{ cid: 'cid-flake-guard', text: 'flake guard memory' }], { recall_max_injected: 10, inject_char_budget: 8000 });
  t.after(() => harness.cleanup());

  const { hooks, calls, appLogs } = harness;
  const sessionID = 'session-flake-guard-arm';

  await waitForAppLog(appLogs, /\[binding\] session bind: active=true/);
  await waitForAppLog(appLogs, /\[recall\] init wevibeAvailable=true/);

  // call #1: first red opens the episode.
  await hooks['tool.execute.after'](redCall(sessionID, 'flake-1'), failOutput());
  // call #2: repeat red with NO file edit between → TOUCHED but never arms (C3b).
  await hooks['tool.execute.after'](redCall(sessionID, 'flake-2'), failOutput());
  await sleep(150);
  assert.equal(recallCalls(calls).length, 0);

  // A file edit on a LATER repeat then arms — the unedited repeat did not burn
  // the interrupt (the episode is still the same open, non-fired episode).
  await emitFileEdit(hooks, sessionID);
  await hooks['tool.execute.after'](redCall(sessionID, 'flake-3'), failOutput());
  await waitForRecallCount(calls, 1);
  assert.equal(recallCalls(calls).length, 1);
});

test('C3b flake guard: no edit then green records no false worked', { concurrency: false }, async (t) => {
  const harness = await setupHarness([{ cid: 'cid-flake-green', text: 'flake green memory' }], { recall_max_injected: 10, inject_char_budget: 8000 });
  t.after(() => harness.cleanup());

  const { hooks, calls, appLogs } = harness;
  const sessionID = 'session-flake-guard-green';

  await waitForAppLog(appLogs, /\[binding\] session bind: active=true/);
  await waitForAppLog(appLogs, /\[recall\] init wevibeAvailable=true/);

  // call #1: first red opens the episode.
  await hooks['tool.execute.after'](redCall(sessionID, 'fg-1'), failOutput());
  // call #2: repeat red with no edit → touches but does not arm.
  await hooks['tool.execute.after'](redCall(sessionID, 'fg-2'), failOutput());
  await sleep(150);
  assert.equal(recallCalls(calls).length, 0);

  // A green closes the episode, but it was never served (never armed/fired), so
  // no outcome is harvested — the unedited repeat produced no false "worked".
  await hooks['tool.execute.after'](
    { sessionID, callID: 'fg-green', tool: 'bash', args: { command: 'npm run build' } },
    { title: '', output: 'ok', metadata: { exit: 0 } },
  );
  await sleep(150);
  assert.equal(recallCalls(calls).length, 0);
  assert.ok(!appLogMessages(appLogs).some(message => message.includes('[outcome] harvested')));
});

test('C3a cascade fan-out: one arm per red wave, first sorted id armed, non-first markFired, test-scoped green close', { concurrency: false }, async (t) => {
  const CASCADE_COMMAND = 'npm run cascade';
  const cascadeAdapter: PredicateAdapter = {
    predicateId: 'cascade:unit',
    matches: (ctx: PredicateRunContext): boolean => ctx.command === CASCADE_COMMAND,
    extractFailingTestIds: (): string[] => ['pkg/b.test.ts', 'pkg/a.test.ts'],
    extractPassingTestIds: (ctx: PredicateRunContext): string[] =>
      (ctx.metadata as { passing?: boolean } | undefined)?.passing ? ['pkg/a.test.ts'] : [],
  };
  // Module-level residue is accepted (no unregister exists); the marker command
  // is distinctive so it never collides with other tests' tripwire path.
  registerPredicateAdapter(cascadeAdapter);

  const harness = await setupHarness([{ cid: 'c0'.repeat(32), text: 'cascade memory' }], { recall_max_injected: 10, inject_char_budget: 8000 });
  t.after(() => harness.cleanup());

  const { hooks, calls, appLogs } = harness;
  const sessionID = 'session-cascade';

  await waitForAppLog(appLogs, /\[binding\] session bind: active=true/);
  await waitForAppLog(appLogs, /\[recall\] init wevibeAvailable=true/);

  const cascadeRed = (callID: string): Record<string, unknown> => ({
    sessionID,
    callID,
    tool: 'bash',
    args: { command: CASCADE_COMMAND },
  });
  const cascadeFail = (): Record<string, unknown> => ({ title: '', output: 'failing cascade tests', metadata: { exit: 1 } });

  // Wave #1: first red under the predicate — opens an episode PER failing test
  // (both a.test.ts and b.test.ts), neither fires. b is already markFired (non-first).
  await hooks['tool.execute.after'](cascadeRed('cascade-1'), cascadeFail());
  await sleep(50);
  assert.equal(recallCalls(calls).length, 0);

  // Wave #2 (after a file edit): the FIRST sorted id (pkg/a.test.ts) arms once;
  // b.test.ts stays markFired. Exactly ONE recall for the wave, not two.
  await emitFileEdit(hooks, sessionID);
  await hooks['tool.execute.after'](cascadeRed('cascade-2'), cascadeFail());
  await waitForRecallCount(calls, 1);
  assert.equal(recallCalls(calls).length, 1);

  // Inject so the armed a.test.ts episode is served (pairs its outcome on close).
  await hooks['experimental.chat.system.transform']({ sessionID }, { system: ['base system'] });

  // Wave #3 (with edit): a.test.ts is already fired, b.test.ts markFired — no new fire.
  await emitFileEdit(hooks, sessionID);
  await hooks['tool.execute.after'](cascadeRed('cascade-3'), cascadeFail());
  await sleep(150);
  assert.equal(recallCalls(calls).length, 1);

  // Green for ONLY pkg/a.test.ts → test-scoped close of a; b.test.ts stays open.
  await hooks['tool.execute.after'](
    cascadeRed('cascade-green'),
    { title: '', output: 'a passed', metadata: { exit: 0, passing: true } },
  );
  await waitForAppLog(appLogs, /\[outcome\] harvested n=1 worked=true/);
  assert.ok(appLogMessages(appLogs).some(message => message.includes('[outcome] harvested n=1 worked=true')));
});

test('bench-fixture adapter: failing-test-scoped failureKey + C3b flake guard', { concurrency: false }, async (t) => {
  // Module-global predicate cache is keyed by repoRoot (a fresh temp worktree
  // per harness), but clear it anyway so a stale declaration never leaks in.
  clearPredicateCache();

  const harness = await setupHarness([{ cid: 'c1'.repeat(32), text: 'bench memory' }], { recall_max_injected: 10, inject_char_budget: 8000 });
  t.after(() => harness.cleanup());

  const { hooks, calls, appLogs, worktree } = harness;
  const sessionID = 'session-bench';
  const BENCH_CMD = 'npm run bench';
  const FAILING_TEST = 'suite:file::TestA';
  const PASSING_TEST = 'suite:file::TestB';

  // Declare the bench-fixture predicate in the spawn-root .wevibe dir BEFORE
  // the bind resolves so resolvePredicateForRepo binds it once at bind time.
  writeFileSync(
    join(worktree, '.wevibe', 'predicate.json'),
    JSON.stringify({ reporter: 'bench-fixture', command: BENCH_CMD }),
    'utf8',
  );

  await waitForAppLog(appLogs, /\[binding\] session bind: active=true/);
  await waitForAppLog(appLogs, /\[recall\] init wevibeAvailable=true/);

  const benchRed = (callID: string): Record<string, unknown> => ({
    sessionID,
    callID,
    tool: 'bash',
    args: { command: BENCH_CMD },
  });
  const benchRedOutput = (): Record<string, unknown> => ({
    title: '',
    output: `WEVIBE-BENCH-REPORT v1\n{"test":"${FAILING_TEST}","status":"fail"}\n{"test":"${PASSING_TEST}","status":"pass"}\n`,
    metadata: { exit: 1 },
  });

  // Wave #1: first red under the bench predicate opens the per-test episode,
  // never arms (C3b).
  await hooks['tool.execute.after'](benchRed('bench-1'), benchRedOutput());
  await sleep(50);
  assert.equal(recallCalls(calls).length, 0);

  // Wave #2 (NO file edit): C3b flake guard suppresses the arm.
  await hooks['tool.execute.after'](benchRed('bench-2'), benchRedOutput());
  await sleep(50);
  assert.equal(recallCalls(calls).length, 0);

  // Wave #3 (after a file edit): the repeat red arms exactly once.
  await emitFileEdit(hooks, sessionID);
  await hooks['tool.execute.after'](benchRed('bench-3'), benchRedOutput());
  await waitForRecallCount(calls, 1);
  assert.equal(recallCalls(calls).length, 1);

  // Inject so the armed FAILING_TEST episode is served (pairs its outcome on close).
  await hooks['experimental.chat.system.transform']({ sessionID }, { system: ['base system'] });

  // Green carrying ONLY the FAILING_TEST as passing → test-scoped close.
  await hooks['tool.execute.after'](
    benchRed('bench-green'),
    { title: '', output: `WEVIBE-BENCH-REPORT v1\n{"test":"${FAILING_TEST}","status":"pass"}\n`, metadata: { exit: 0 } },
  );

  // Read the outcome spool and assert the failureKey was failing-test-scoped
  // (episode_ref derived from bench-fixture:v1 + failing test id), NOT the
  // tripwire (cmd:<fp8> + null test) identity.
  const spoolPath = join(worktree, '.wevibe', 'state', 'outcome-spool', 'outcome-spool-v1.jsonl');
  let episodeRefs: string[] = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (existsSync(spoolPath)) {
      const text = readFileSync(spoolPath, 'utf8').trim();
      episodeRefs = text.length === 0 ? [] : text.split('\n').map(line => (JSON.parse(line) as { episode_ref: string }).episode_ref);
      if (episodeRefs.length >= 1) break;
    }
    await sleep(25);
  }
  assert.ok(episodeRefs.length >= 1, 'expected at least one harvested outcome');

  const commandFp8 = fp8(BENCH_CMD);
  const repoBinding = 'a'.repeat(64);
  const benchKey = computeFailureKey({ repoBinding, predicateId: 'bench-fixture:v1', failingTest: FAILING_TEST, commandFp8 });
  const expectedRef = computeEpisodeRef('org-test', sessionID, benchKey);
  const tripwireKey = computeFailureKey({ repoBinding, predicateId: `cmd:${commandFp8}`, failingTest: null, commandFp8 });
  const tripwireRef = computeEpisodeRef('org-test', sessionID, tripwireKey);

  assert.ok(episodeRefs.includes(expectedRef), 'episode_ref must match the failing-test-scoped key');
  assert.ok(!episodeRefs.includes(tripwireRef), 'must NOT fall back to the tripwire identity');
});

test('serve POST carries the firing episode episodeRef, matching the tracker-computed ref and the outcome spool', { concurrency: false }, async (t) => {
  const harness = await setupHarness([{ cid: 'c5'.repeat(32), text: 'pairing memory' }], { recall_max_injected: 10, inject_char_budget: 8000 });
  t.after(() => harness.cleanup());

  const { hooks, calls, worktree } = harness;
  const sessionID = 'session-ep-ref';
  const COMMAND = 'npm run build';

  // Arms a TRIPWIRE episode (no predicate adapter; failingTest null, testId null),
  // fires recall, caches + approves the memory.
  await driveRepeatFailure(hooks, calls, sessionID);

  // Serve the armed episode's memory.
  await hooks['experimental.chat.system.transform']({ sessionID }, { system: ['base system'] });

  const serves = serveBodies(calls);
  assert.equal(serves.length, 1);
  assert.equal(serves[0].memory_hash, 'c5'.repeat(32));

  // (a) the serve body carries the firing episode's episodeRef.
  assert.ok(typeof serves[0].episode_ref === 'string' && serves[0].episode_ref.length > 0, 'serve body must carry episode_ref');

  // (b) it equals the tracker-computed episodeRef for (org, session, failureKey).
  const commandFp8Val = fp8(COMMAND);
  const repoBinding = 'a'.repeat(64);
  const tripwireKey = computeFailureKey({ repoBinding, predicateId: `cmd:${commandFp8Val}`, failingTest: null, commandFp8: commandFp8Val });
  const expectedRef = computeEpisodeRef('org-test', sessionID, tripwireKey);
  assert.equal(serves[0].episode_ref, expectedRef, 'serve episode_ref must equal tracker-computed episodeRef');

  // Close the episode with a green to harvest its outcome.
  await hooks['tool.execute.after'](
    { sessionID, callID: 'ep-ref-green', tool: 'bash', args: { command: COMMAND } },
    { title: '', output: 'ok', metadata: { exit: 0 } },
  );

  // (c) serve↔outcome pairing: the outcome spool's episode_ref is the SAME string.
  const spoolPath = join(worktree, '.wevibe', 'state', 'outcome-spool', 'outcome-spool-v1.jsonl');
  let spoolRefs: string[] = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (existsSync(spoolPath)) {
      const text = readFileSync(spoolPath, 'utf8').trim();
      spoolRefs = text.length === 0 ? [] : text.split('\n').map(line => (JSON.parse(line) as { episode_ref: string }).episode_ref);
      if (spoolRefs.length >= 1) break;
    }
    await sleep(25);
  }
  assert.ok(spoolRefs.includes(serves[0].episode_ref), 'outcome spool episode_ref must equal serve body episode_ref');
});

test('serve POST without a firing episode omits episode_ref and does not break the transform/tripwire fallback', { concurrency: false }, async (t) => {
  const harness = await setupHarness([{ cid: 'c6'.repeat(32), text: 'no episode memory' }], { recall_max_injected: 10, inject_char_budget: 8000 });
  t.after(() => harness.cleanup());

  const { hooks, calls } = harness;
  const armingSession = 'session-arms-episode';
  const servingSession = 'session-serves-without-episode';

  // Arm an episode under `armingSession` → recall fires, caches + approves the memory.
  await driveRepeatFailure(hooks, calls, armingSession);

  // Serve under a DIFFERENT session that never armed an episode: firedEpisodeBySession
  // has no entry for the serving sid, so the serve still posts but omits episode_ref.
  const output = { system: ['base system'] };
  await hooks['experimental.chat.system.transform']({ sessionID: servingSession }, output);

  const serves = serveBodies(calls);
  assert.ok(serves.length >= 1, 'a serve must still post for a memory');
  assert.ok(serves.some(s => s.memory_hash === 'c6'.repeat(32)), 'the cached memory must be served');

  const noEpServes = serves.filter(s => s.memory_hash === 'c6'.repeat(32));
  assert.ok(noEpServes.length >= 1, 'expected a serve for the no-episode memory');
  for (const body of noEpServes) {
    assert.equal(body.episode_ref, undefined, 'episode-less serve must NOT carry episode_ref (MCP fail-closed 400, intentionally unpaired)');
  }

  // The transform completed without throwing and injected the memory (tripwire fallback intact).
  assert.equal(output.system.length, 2);
  assert.ok(output.system[1].includes('## Team Memory (WeVibe Network)'));
});

// ---------------------------------------------------------------------------
// Confirmed-on-chain serve receipts (WO-TRIGGER-BUILD A8): the relay confirm
// proxy read drives the confirmed_on_chain funnel counter; fail-closed on error.
// ---------------------------------------------------------------------------

const confirmCalls = (calls: FetchCall[]): FetchCall[] => calls.filter(call => call.url.includes('/serves/confirm'));

const waitForConfirmCount = async (calls: FetchCall[], expected: number): Promise<void> => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (confirmCalls(calls).length >= expected) return;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${expected} confirm reads`);
};

const waitForConfirmed = async (sessionID: string, expected: number): Promise<void> => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if ((snapshot(sessionID)?.confirmed_on_chain ?? 0) === expected) return;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for confirmed_on_chain=${expected} on ${sessionID}`);
};

test('confirmed_on_chain counts receipts that are submitted with a tx_hash via the relay confirm GET', { concurrency: false }, async (t) => {
  resetFunnelCountersTrackers();
  const harness = await setupHarness(
    [{ cid: 'c7'.repeat(32), text: 'confirmed memory' }],
    { recall_max_injected: 10, inject_char_budget: 8000 },
    {
      confirmResponder: () =>
        toJsonResponse(200, {
          serves: [
            { id: 'r1', memory_content_hash: 'c7'.repeat(32), episode_ref: 'x', status: 'submitted', tx_hash: '0xabc', created_at: '', submitted_at: '' },
            { id: 'r2', memory_content_hash: 'c7'.repeat(32), episode_ref: 'x', status: 'submitted', tx_hash: null, created_at: '', submitted_at: '' },
            { id: 'r3', memory_content_hash: 'c7'.repeat(32), episode_ref: 'x', status: 'pending', tx_hash: '0xdef', created_at: '', submitted_at: '' },
          ],
        }),
    },
  );
  t.after(() => {
    harness.cleanup();
    resetFunnelCountersTrackers();
  });

  const { hooks, calls } = harness;
  const sessionID = 'session-confirmed-integration';

  await driveRepeatFailure(hooks, calls, sessionID);
  const output = { system: ['base system'] };
  await hooks['experimental.chat.system.transform']({ sessionID }, output);

  // The confirm proxy was read over the relay with the firing episode_ref.
  await waitForConfirmCount(calls, 1);
  const confirms = confirmCalls(calls);
  assert.equal(confirms.length, 1);
  assert.equal(confirms[0].method, 'GET');
  assert.ok(confirms[0].url.includes('org-test'), 'confirm URL must carry the bound org id');
  assert.ok(confirms[0].url.includes('episode_ref='), 'confirm URL must carry episode_ref');
  assert.match(confirms[0].headers?.['X-WeVibe-Trace-Id'] as string, /^[0-9a-f]{8}$/, 'confirm read must carry a trace id');

  // Only the submitted+tx_hash receipt is counted (1 of 3).
  await waitForConfirmed(sessionID, 1);
  assert.equal(snapshot(sessionID)?.confirmed_on_chain, 1);
});

test('confirmed_on_chain fails closed (unchanged, no throw) when the relay confirm errors', { concurrency: false }, async (t) => {
  resetFunnelCountersTrackers();
  const harness = await setupHarness(
    [{ cid: 'c8'.repeat(32), text: 'fail-closed memory' }],
    { recall_max_injected: 10, inject_char_budget: 8000 },
    { confirmResponder: () => toJsonResponse(500, { error: 'relay exploded' }) },
  );
  t.after(() => {
    harness.cleanup();
    resetFunnelCountersTrackers();
  });

  const { hooks, calls } = harness;
  const sessionID = 'session-confirmed-failclosed';

  await driveRepeatFailure(hooks, calls, sessionID);
  const output = { system: ['base system'] };
  await hooks['experimental.chat.system.transform']({ sessionID }, output);

  // The transform completed without throwing despite the failed confirm read.
  await waitForConfirmCount(calls, 1);
  assert.ok(output.system.length >= 1);
  assert.equal(snapshot(sessionID)?.confirmed_on_chain ?? 0, 0, 'confirmed_on_chain must remain unconfirmed on relay error');
});

// (a) D-RECALL-GATE-BLOCKS: the gate BLOCKS with NO timeout. With a prod recall
// candidate undecided and the TUI live, the transform must STILL be pending after
// a bounded window (the old INJECT_GATE_TIMEOUT_MS fallthrough is gone — it would
// have fallen through after 300s; now it must still be blocked). The gate is then
// released via the TUI-heartbeat dropout so no wedged promise leaks. Decision-
// completion of the gate is covered separately by the answerer / direct-decision
// tests (b) and (d).
test('recall gate blocks with NO timeout while a review candidate stays undecided', { concurrency: false }, async (t) => {
  const memory = { cid: 'cid-gate-block', text: 'undecided gate memory' };
  const harness = await setupHarness(
    [memory],
    { recall_max_injected: 10, inject_char_budget: 8000 },
    { recallMode: 'prod' },
  );
  t.after(() => harness.cleanup());

  const { hooks, calls, worktree } = harness;
  const sessionID = 'session-gate-block';

  await driveRepeatFailure(hooks, calls, sessionID);
  enableTuiLive(worktree);

  const output = { system: ['base system instruction'] };
  const gatePromise = await assertGateStillPending(hooks, sessionID, output);

  // Release cleanly: age the TUI heartbeat out so the loop's `!isTuiLive()` break
  // fires and the blocked transform resolves. No wedged promise leaks.
  releaseGateViaHeartbeatDropout(worktree);
  await gatePromise;

  // No decision was ever processed (undecided candidate stays undecided), so the
  // transform released without injecting — proving it was genuinely blocked on the
  // human, not auto-completed.
  assert.equal(output.system.length, 1);
  assert.ok(!output.system[0].includes(memory.text));
});

// (b) D3 answerer completes the gate autonomously: auto-accept approves the
// undecided candidate (injects it), auto-deny denies it (does not inject). Both
// land as source=user outcomes.
test('answerer auto-accept completes the gate and injects the approved memory', { concurrency: false }, async (t) => {
  const memory = { cid: 'cid-answerer-accept', text: 'answerer accept memory' };
  const harness = await setupHarness(
    [memory],
    { recall_max_injected: 10, inject_char_budget: 8000 },
    { recallMode: 'prod', answererPolicy: 'auto-accept' },
  );
  t.after(() => harness.cleanup());

  const { hooks, calls, worktree, appLogs } = harness;
  const sessionID = 'session-answerer-accept';

  await driveRepeatFailure(hooks, calls, sessionID);
  enableTuiLive(worktree);

  const output = { system: ['base system instruction'] };
  await hooks['experimental.chat.system.transform']({ sessionID }, output);

  // Gate completed autonomously; memory approved + injected.
  assert.equal(output.system.length, 2);
  assert.ok(output.system[1].includes(memory.text));
  assert.deepEqual(readDecisions(harness), []);
  await waitForAppLog(appLogs, /\[answerer\] policy=auto-accept/);
  await waitForAppLog(appLogs, /\[outcome\] user verdict enqueued/);

  const records = await readOutcomeSpoolRecords(worktree);
  const verdict = records.find(r => r.memory_hash === memory.cid && r.source === 'user');
  assert.ok(verdict, 'expected a source=user outcome record');
  assert.equal(verdict.resolution, 'worked');
});

test('answerer auto-deny completes the gate and does not inject the denied memory', { concurrency: false }, async (t) => {
  const memory = { cid: 'cid-answerer-deny', text: 'answerer deny memory' };
  const harness = await setupHarness(
    [memory],
    { recall_max_injected: 10, inject_char_budget: 8000 },
    { recallMode: 'prod', answererPolicy: 'auto-deny' },
  );
  t.after(() => harness.cleanup());

  const { hooks, calls, worktree, appLogs } = harness;
  const sessionID = 'session-answerer-deny';

  await driveRepeatFailure(hooks, calls, sessionID);
  enableTuiLive(worktree);

  const output = { system: ['base system instruction'] };
  await hooks['experimental.chat.system.transform']({ sessionID }, output);

  // Gate completed autonomously; memory denied, so NOT injected.
  assert.equal(output.system.length, 1);
  assert.ok(!output.system[0].includes(memory.text));
  assert.deepEqual(readDecisions(harness), []);
  await waitForAppLog(appLogs, /\[answerer\] policy=auto-deny/);
  await waitForAppLog(appLogs, /\[outcome\] user verdict enqueued/);

  const records = await readOutcomeSpoolRecords(worktree);
  const verdict = records.find(r => r.memory_hash === memory.cid && r.source === 'user');
  assert.ok(verdict, 'expected a source=user outcome record');
  assert.equal(verdict.resolution, 'didnt_work');
});

// (c) answerer-off preserves human-blocking: with no WEVIBE_ANSWERER_POLICY the
// gate must stay pending on the human (NOT auto-complete), then release cleanly
// via the TUI-heartbeat dropout.
test('answerer-off keeps the gate human-blocking (no auto-complete)', { concurrency: false }, async (t) => {
  const memory = { cid: 'cid-gate-human', text: 'human gate memory' };
  const harness = await setupHarness(
    [memory],
    { recall_max_injected: 10, inject_char_budget: 8000 },
    { recallMode: 'prod' },
  );
  t.after(() => harness.cleanup());

  const { hooks, calls, worktree, appLogs } = harness;
  const sessionID = 'session-gate-human';

  await driveRepeatFailure(hooks, calls, sessionID);
  enableTuiLive(worktree);

  const output = { system: ['base system instruction'] };
  const gatePromise = await assertGateStillPending(hooks, sessionID, output);

  // Answerer never engaged — still blocked on the human, NOT auto-completed.
  assert.ok(!appLogMessages(appLogs).some(message => message.includes('[answerer]')), 'answerer must not auto-decide when OFF');

  // Release cleanly via the TUI-heartbeat dropout (no wedged promise).
  releaseGateViaHeartbeatDropout(worktree);
  await gatePromise;

  assert.equal(output.system.length, 1);
  assert.ok(!output.system[0].includes(memory.text));
});

// (d) source=user outcomes: decisions carrying source=user land as user-verdict
// outcome records (accept → worked, deny → didnt_work), in the disjoint
// user-verdict namespace.
test('source=user decisions land as user-verdict outcomes (accept=worked, deny=didnt_work)', { concurrency: false }, async (t) => {
  const memAccept = { cid: 'cid-uv-accept', text: 'uv accept memory' };
  const memDeny = { cid: 'cid-uv-deny', text: 'uv deny memory' };
  const harness = await setupHarness(
    [memAccept, memDeny],
    { recall_max_injected: 10, inject_char_budget: 8000 },
    { recallMode: 'prod' },
  );
  t.after(() => harness.cleanup());

  const { hooks, calls, worktree, appLogs } = harness;
  const sessionID = 'session-user-verdict';

  await driveRepeatFailure(hooks, calls, sessionID);
  enableTuiLive(worktree);
  writeDecisions(harness, [
    { memoryID: memAccept.cid, action: 'accept', source: 'user', timestamp: Date.now() },
    { memoryID: memDeny.cid, action: 'deny', source: 'user', timestamp: Date.now() },
  ]);

  const output = { system: ['base system instruction'] };
  await hooks['experimental.chat.system.transform']({ sessionID }, output);

  // Accept injected, deny not.
  assert.equal(output.system.length, 2);
  assert.ok(output.system[1].includes(memAccept.text));
  assert.ok(!output.system[1].includes(memDeny.text));
  assert.deepEqual(readDecisions(harness), []);

  await waitForAppLog(appLogs, /\[outcome\] user verdict enqueued/);

  const records = await readOutcomeSpoolRecords(worktree);
  const acceptRec = records.find(r => r.memory_hash === memAccept.cid && r.source === 'user');
  const denyRec = records.find(r => r.memory_hash === memDeny.cid && r.source === 'user');
  assert.ok(acceptRec, 'expected a source=user accept outcome');
  assert.equal(acceptRec.resolution, 'worked');
  assert.ok(denyRec, 'expected a source=user deny outcome');
  assert.equal(denyRec.resolution, 'didnt_work');
});

// ---------------------------------------------------------------------------
// Funnel observability wiring (WO-FUNNEL-DISC): serve rejection, predicate
// mode, and distinct failure-key counters at the points where the modes are
// already decided. Observability only — no trigger/tripwire/gate semantics.
// ---------------------------------------------------------------------------

test('serve rejected: a non-2xx serve POST increments serve_sent and serve_rejected, not confirmed_on_chain', { concurrency: false }, async (t) => {
  resetFunnelCountersTrackers();
  const harness = await setupHarness(
    [{ cid: 'r1'.repeat(32), text: 'rejected memory' }],
    { recall_max_injected: 10, inject_char_budget: 8000 },
    { serveResponder: () => toJsonResponse(400, { error: 'no episode_ref' }) },
  );
  t.after(() => {
    harness.cleanup();
    resetFunnelCountersTrackers();
  });

  const { hooks, calls } = harness;
  const sessionID = 'session-serve-rejected';

  await driveRepeatFailure(hooks, calls, sessionID);
  await hooks['experimental.chat.system.transform']({ sessionID }, { system: ['base system'] });

  const serves = serveBodies(calls);
  assert.ok(serves.length >= 1, 'a serve must post');

  // serve_sent is synchronous; serve_rejected lands in the async .then — poll.
  await waitForServeRejected(sessionID, 1);
  const snap = snapshot(sessionID);
  assert.ok((snap?.serve_sent ?? 0) >= 1, 'serve_sent must be incremented');
  assert.ok((snap?.serve_rejected ?? 0) >= 1, 'serve_rejected must be incremented on a non-2xx serve');
  assert.equal(snap?.confirmed_on_chain, 0, 'confirmed_on_chain must NOT increment on a rejected serve');
});

test('serve ok: a 2xx serve POST increments serve_sent and leaves serve_rejected at its default', { concurrency: false }, async (t) => {
  resetFunnelCountersTrackers();
  const harness = await setupHarness(
    [{ cid: 'ok1'.repeat(32), text: 'accepted memory' }],
    { recall_max_injected: 10, inject_char_budget: 8000 },
  );
  t.after(() => {
    harness.cleanup();
    resetFunnelCountersTrackers();
  });

  const { hooks, calls } = harness;
  const sessionID = 'session-serve-ok';

  await driveRepeatFailure(hooks, calls, sessionID);
  await hooks['experimental.chat.system.transform']({ sessionID }, { system: ['base system'] });

  const serves = serveBodies(calls);
  assert.ok(serves.length >= 1, 'a serve must post');

  const snap = snapshot(sessionID);
  assert.ok((snap?.serve_sent ?? 0) >= 1, 'serve_sent must be incremented');
  assert.equal(snap?.serve_rejected, 0, 'serve_rejected must stay at its default on a 2xx serve');
  assert.equal(snap?.confirmed_on_chain, 0, 'confirmed_on_chain must stay 0 on a plain 2xx serve (no confirm receipt)');
});

test('predicate_mode records the concrete bench-fixture adapter id when it matches', { concurrency: false }, async (t) => {
  clearPredicateCache();
  const harness = await setupHarness([{ cid: 'pm1'.repeat(32), text: 'bench predicate memory' }], { recall_max_injected: 10, inject_char_budget: 8000 });
  t.after(() => harness.cleanup());

  const { hooks, calls, appLogs, worktree } = harness;
  const sessionID = 'session-predicate-bench';
  const BENCH_CMD = 'npm run bench';
  const FAILING_TEST = 'suite:file::TestA';

  writeFileSync(
    join(worktree, '.wevibe', 'predicate.json'),
    JSON.stringify({ reporter: 'bench-fixture', command: BENCH_CMD }),
    'utf8',
  );

  await waitForAppLog(appLogs, /\[binding\] session bind: active=true/);
  await waitForAppLog(appLogs, /\[recall\] init wevibeAvailable=true/);

  await hooks['tool.execute.after'](
    { sessionID, callID: 'pm-bench-1', tool: 'bash', args: { command: BENCH_CMD } },
    { title: '', output: `WEVIBE-BENCH-REPORT v1\n{"test":"${FAILING_TEST}","status":"fail"}\n`, metadata: { exit: 1 } },
  );

  assert.equal(snapshot(sessionID)?.predicate_mode, 'bench-fixture:v1', 'concrete bench-fixture adapter id must be recorded');
});

test('predicate_mode records tripwire when no concrete adapter matches', { concurrency: false }, async (t) => {
  resetFunnelCountersTrackers();
  const harness = await setupHarness([{ cid: 'pm2'.repeat(32), text: 'tripwire predicate memory' }], { recall_max_injected: 10, inject_char_budget: 8000 });
  t.after(() => {
    harness.cleanup();
    resetFunnelCountersTrackers();
  });

  const { hooks, calls, appLogs } = harness;
  const sessionID = 'session-predicate-tripwire';

  await waitForAppLog(appLogs, /\[binding\] session bind: active=true/);
  await waitForAppLog(appLogs, /\[recall\] init wevibeAvailable=true/);

  await hooks['tool.execute.after'](redCall(sessionID, 'pm-trip-1'), failOutput());

  assert.equal(snapshot(sessionID)?.predicate_mode, 'tripwire', 'tripwire fallback must be recorded');
});

test('distinct_failure_keys: the same failureKey across waves dedups to 1', { concurrency: false }, async (t) => {
  const SINGLE_CMD = 'npm run singlefail';
  const singleAdapter: PredicateAdapter = {
    predicateId: 'singlefail:unit',
    matches: (ctx: PredicateRunContext): boolean => ctx.command === SINGLE_CMD,
    extractFailingTestIds: (): string[] => ['pkg/only.test.ts'],
    extractPassingTestIds: (): string[] => [],
  };
  registerPredicateAdapter(singleAdapter);

  const harness = await setupHarness([{ cid: 'd0'.repeat(32), text: 'distinct key memory' }], { recall_max_injected: 10, inject_char_budget: 8000 });
  t.after(() => harness.cleanup());

  const { hooks, calls, appLogs } = harness;
  const sessionID = 'session-distinct-same';

  await waitForAppLog(appLogs, /\[binding\] session bind: active=true/);
  await waitForAppLog(appLogs, /\[recall\] init wevibeAvailable=true/);

  const red = (callID: string): Record<string, unknown> => ({
    sessionID,
    callID,
    tool: 'bash',
    args: { command: SINGLE_CMD },
  });
  const fail = (): Record<string, unknown> => ({ title: '', output: 'failing tests', metadata: { exit: 1 } });

  // Same single failing id across two waves → same failureKey → 1 distinct.
  await hooks['tool.execute.after'](red('df-1'), fail());
  await hooks['tool.execute.after'](red('df-2'), fail());
  assert.equal(snapshot(sessionID)?.distinct_failure_keys, 1, 'same failureKey must dedup to 1');
});

test('distinct_failure_keys: two distinct failing ids in one wave count 2', { concurrency: false }, async (t) => {
  const DUAL_CMD = 'npm run dualfail';
  const dualAdapter: PredicateAdapter = {
    predicateId: 'dualfail:unit',
    matches: (ctx: PredicateRunContext): boolean => ctx.command === DUAL_CMD,
    extractFailingTestIds: (): string[] => ['pkg/x.test.ts', 'pkg/y.test.ts'],
    extractPassingTestIds: (): string[] => [],
  };
  registerPredicateAdapter(dualAdapter);

  const harness = await setupHarness([{ cid: 'd1'.repeat(32), text: 'distinct key memory' }], { recall_max_injected: 10, inject_char_budget: 8000 });
  t.after(() => harness.cleanup());

  const { hooks, calls, appLogs } = harness;
  const sessionID = 'session-distinct-dual';

  await waitForAppLog(appLogs, /\[binding\] session bind: active=true/);
  await waitForAppLog(appLogs, /\[recall\] init wevibeAvailable=true/);

  const red = (callID: string): Record<string, unknown> => ({
    sessionID,
    callID,
    tool: 'bash',
    args: { command: DUAL_CMD },
  });
  const fail = (): Record<string, unknown> => ({ title: '', output: 'failing tests', metadata: { exit: 1 } });

  // Two distinct failing ids in one wave → 2 distinct keys.
  await hooks['tool.execute.after'](red('df-3'), fail());
  assert.equal(snapshot(sessionID)?.distinct_failure_keys, 2, 'two distinct failing ids must count 2');
});
