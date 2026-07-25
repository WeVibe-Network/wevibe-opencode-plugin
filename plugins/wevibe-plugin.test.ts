import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// @ts-expect-error tsx test runner resolves .ts extension imports.
import { WeVibeMemoryPlugin, buildMemoryBlock, formatMemoryLine } from './wevibe-plugin.ts';

type FetchCall = {
  url: string
  method: string
  bodyText?: string
}

type Harness = {
  hooks: Record<string, (input: unknown, output: unknown) => Promise<void>>
  calls: FetchCall[]
  cleanup: () => void
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
): Promise<Harness> => {
  const oldFetch = globalThis.fetch;
  const oldHome = process.env.HOME;
  const oldRecallMode = process.env.WEVIBE_RECALL_MODE;
  const oldMcpUrl = process.env.WEVIBE_MCP_HTTP_URL;

  const calls: FetchCall[] = [];
  const homeDir = mkdtempSync(join(tmpdir(), 'wevibe-plugin-home-'));
  const worktree = mkdtempSync(join(tmpdir(), 'wevibe-plugin-worktree-'));

  writeBoundMarker(worktree);
  writeSessionToken(homeDir);
  writePluginConfig(homeDir, config);

  process.env.HOME = homeDir;
  process.env.WEVIBE_RECALL_MODE = 'test';
  process.env.WEVIBE_MCP_HTTP_URL = 'http://wevibe-mock:4450';

  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? (typeof input === 'string' || input instanceof URL ? 'GET' : input.method) ?? 'GET').toUpperCase();
    const bodyText = readBodyText(init?.body);
    calls.push({ url, method, bodyText });

    if (url.endsWith('/v1/health')) {
      return toJsonResponse(200, { status: 'ok' });
    }
    if (url.endsWith('/v1/recall')) {
      return toJsonResponse(200, recallPayload(memories));
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
        log: async () => {},
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
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  };

  return {
    hooks: plugin as unknown as Record<string, (input: unknown, output: unknown) => Promise<void>>,
    calls,
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
