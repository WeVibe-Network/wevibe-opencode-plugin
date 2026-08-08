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
  captureLogFile?: boolean
  recallMode?: 'test' | 'prod'
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
      return toJsonResponse(200, { status: 'ok' });
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

const writeDecisions = (
  harness: Harness,
  decisions: Array<{ memoryID: string; action: 'accept' | 'deny' | 'block' | 'report'; reason?: string; note?: string; timestamp: number }>,
): void => {
  writeFileSync(harness.decisionsPath, JSON.stringify(decisions), 'utf8');
};

const readDecisions = (harness: Harness): unknown => JSON.parse(readFileSync(harness.decisionsPath, 'utf8'));

const readStatus = (harness: Harness): unknown => JSON.parse(readFileSync(harness.statusPath, 'utf8'));

const serveBodies = (calls: FetchCall[]): Array<Record<string, unknown>> =>
  calls
    .filter(call => call.url.endsWith('/v1/serves'))
    .map(call => JSON.parse(call.bodyText ?? '{}') as Record<string, unknown>);

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
