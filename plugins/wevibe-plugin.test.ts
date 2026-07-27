import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// @ts-expect-error tsx test runner resolves .ts extension imports.
import { WeVibeMemoryPlugin, buildMemoryBlock, formatMemoryLine } from './wevibe-plugin.ts';

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

const triggerRecall = async (
  hooks: Record<string, (input: unknown, output: unknown) => Promise<void>>,
  calls: FetchCall[],
  sessionID: string,
): Promise<void> => {
  const recallBefore = calls.filter(call => call.url.endsWith('/v1/recall')).length;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await hooks['chat.message'](
      { sessionID },
      {
        parts: [{ type: 'text', text: `recall prompt ${attempt}` }],
      },
    );
    const recallAfter = calls.filter(call => call.url.endsWith('/v1/recall')).length;
    if (recallAfter > recallBefore) {
      return;
    }
    await sleep(25);
  }
  throw new Error('Timed out waiting for recall request');
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

  await triggerRecall(hooks, calls, sessionID);

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

  await triggerRecall(hooks, calls, sessionID);

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

  await triggerRecall(hooks, calls, sessionID);

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

  await triggerRecall(hooks, calls, sessionID);

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

  await triggerRecall(hooks, calls, sessionID);
  await hooks['experimental.chat.system.transform']({ sessionID }, { system: ['base system'] });
  await hooks['tool.execute.after'](
    {
      tool: 'bash',
      sessionID,
      callID: 'call-build-1',
      args: { command: 'npm run build' },
    },
    {
      title: '',
      output: 'error TS2345: boom',
      metadata: { exit: 1 },
    },
  );

  await waitForRecallCount(calls, 2);

  const recalls = recallCalls(calls);
  assert.equal(recalls.length, 2);

  const secondBody = JSON.parse(recalls[1].bodyText ?? '{}') as Record<string, unknown>;
  const secondQuery = typeof secondBody.query === 'string' ? secondBody.query : '';
  assert.match(secondQuery, /(build failing|tool failure)/);
  assert.ok(secondQuery.includes('npm run build'));
  assert.equal(typeof secondBody.org_id, 'string');
  assert.equal(typeof secondBody.session_id, 'string');
});

test('stays silent on clean tool.execute.after results', { concurrency: false }, async (t) => {
  const harness = await setupHarness([{ cid: 'cid-clean', text: 'clean memory' }], { recall_max_injected: 10, inject_char_budget: 8000 });
  t.after(() => harness.cleanup());

  const { hooks, calls } = harness;
  const sessionID = 'session-tool-clean';

  await triggerRecall(hooks, calls, sessionID);
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

  await triggerRecall(hooks, calls, sessionID);
  await hooks['experimental.chat.system.transform']({ sessionID }, { system: ['base system'] });

  await hooks['tool.execute.after'](
    {
      tool: 'bash',
      sessionID,
      callID: 'c1',
      args: { command: 'npm run build' },
    },
    failingOutput,
  );
  await waitForRecallCount(calls, 2);

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

  assert.equal(recallCalls(calls).length, 2);
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

  const { hooks, calls } = harness;
  const sessionID = 'session-tool-inflight';

  try {
    await triggerRecall(hooks, calls, sessionID);
    assert.equal(recallCalls(calls).length, 1);

    await hooks['tool.execute.after'](
      {
        tool: 'bash',
        sessionID,
        callID: 'call-inflight-1',
        args: { command: 'npm run build' },
      },
      {
        title: '',
        output: 'error TS2345: boom',
        metadata: { exit: 1 },
      },
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

  await triggerRecall(hooks, calls, sessionID);
  await hooks['experimental.chat.system.transform']({ sessionID }, { system: ['base system'] });
  await hooks['tool.execute.after'](
    {
      tool: 'bash',
      sessionID,
      callID: 'call-funnel-1',
      args: { command: 'npm run build' },
    },
    {
      title: '',
      output: 'error TS2345: boom',
      metadata: { exit: 1 },
    },
  );
  await waitForRecallCount(calls, 2);
  await sleep(50);

  const messages = appLogMessages(appLogs);

  assert.ok(messages.some(message => /recall_fired trigger=user_message sid=\S+/.test(message)));
  assert.ok(messages.some(message => /recall_fired trigger=tool_failure sid=\S+/.test(message)));
  assert.ok(messages.some(message => /recall_returned status=\S+ count=\d+ reason_code=\S+ dur_ms=\d+ error=\S+/.test(message)));

  assert.ok(logFilePath);
  const logText = existsSync(logFilePath) ? readFileSync(logFilePath, 'utf8') : '';
  const recallLines = logText.split('\n').filter(line => line.includes('recall_fired') || line.includes('recall_returned'));
  const firedLines = recallLines.filter(line => line.includes('recall_fired'));
  const returnedLines = recallLines.filter(line => line.includes('recall_returned'));

  assert.ok(firedLines.some(line => /recall_fired trigger=user_message sid=\S+/.test(line)));
  assert.ok(firedLines.some(line => /recall_fired trigger=tool_failure sid=\S+/.test(line)));
  assert.ok(firedLines.every(line => /trace=[0-9a-f]{8}/.test(line)));
  assert.ok(returnedLines.length >= firedLines.length);
  assert.ok(returnedLines.every(line => /recall_returned status=\S+ count=\d+ reason_code=\S+ dur_ms=\d+ error=\S+/.test(line)));

  const toolFailureLine = firedLines.find(line => /recall_fired trigger=tool_failure sid=\S+/.test(line));
  assert.ok(toolFailureLine);
  const toolFailureTrace = (toolFailureLine?.match(/trace=([0-9a-f]{8})/) ?? [])[1];
  assert.equal(typeof toolFailureTrace, 'string');
  assert.ok(returnedLines.some(line => line.includes(`trace=${toolFailureTrace}`)));
});

test('posts a decision-note on deny with org, memory hash, and reason', { concurrency: false }, async (t) => {
  const harness = await setupHarness([], { recall_max_injected: 10, inject_char_budget: 8000 });
  t.after(() => harness.cleanup());

  const { hooks, calls } = harness;
  const sessionID = 'session-decision-note-deny-reason';

  await triggerRecall(hooks, calls, sessionID);
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

  await triggerRecall(hooks, calls, sessionID);
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

  await triggerRecall(hooks, calls, sessionID);
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

  await triggerRecall(hooks, calls, sessionID);
  writeDecisions(harness, [{ memoryID: 'cid-deny-4', action: 'deny', reason: 'network fail', timestamp: Date.now() }]);

  await hooks['experimental.chat.system.transform']({ sessionID }, { system: ['base system'] });
  await waitForAppLog(harness.appLogs, /\[decision-note\] deny note failed reason=.*ECONNREFUSED/);

  assert.deepEqual(readDecisions(harness), []);
  const status = readStatus(harness) as { denied?: string[] };
  assert.ok(status.denied?.includes('cid-deny-4'));
});
