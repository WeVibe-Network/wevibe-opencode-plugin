import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// @ts-expect-error tsx test runner resolves .ts extension imports.
import { deriveDeterministicNonceHex, type HarvestedOutcome } from "./outcome-episode.ts";
// @ts-expect-error tsx test runner resolves .ts extension imports.
import { OUTCOME_SPOOL_FILENAME, OUTCOME_SPOOL_SUBDIR, createOutcomeSpool } from "./outcome-spool.ts";

function withTempDir(run: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "outcome-spool-"));
  return Promise.resolve()
    .then(() => run(dir))
    .finally(() => {
      rmSync(dir, { recursive: true, force: true });
    });
}

function outcome(overrides: Partial<HarvestedOutcome> = {}): HarvestedOutcome {
  return {
    orgId: "org-1",
    sessionId: "session-1",
    episodeRef: "a".repeat(64),
    evidenceRef: "b".repeat(64),
    memoryHash: "c".repeat(64),
    worked: true,
    needSignature: "need",
    ...overrides,
  };
}

function nonce(input = outcome()): string {
  return deriveDeterministicNonceHex(input.orgId, input.memoryHash, input.episodeRef, input.worked);
}

function readRecords(stateDir: string): Array<Record<string, unknown>> {
  return readFileSync(join(stateDir, OUTCOME_SPOOL_SUBDIR, OUTCOME_SPOOL_FILENAME), "utf8")
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function okResponse(status = 200, body = { status: "ok", fingerprint_first8: "12345678" }): Response {
  return new Response(JSON.stringify(body), { status });
}

test("enqueue writes pending JSONL and duplicate enqueue is a no-op", async () => {
  await withTempDir(async (stateDir) => {
    const spool = createOutcomeSpool({
      stateDir,
      mcpBase: "http://mcp",
      getToken: () => "token",
      getOrgActive: () => true,
      newTrace: () => "trace-1",
    });

    const item = outcome();
    spool.enqueue(item);
    spool.enqueue(item);
    await spool.flush();

    assert.equal(spool.pendingCount(), 1);
    const records = readRecords(stateDir);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.status, "pending");
    assert.equal(records[0]?.nonce_hex, nonce(item));
  });
});

test("drainOnce 200 acks and does not re-post on second drain", async () => {
  await withTempDir(async (stateDir) => {
    let calls = 0;
    const spool = createOutcomeSpool({
      stateDir,
      mcpBase: "http://mcp",
      getToken: () => "token",
      getOrgActive: () => true,
      newTrace: () => "trace-1",
      fetchFn: async () => {
        calls += 1;
        return okResponse();
      },
    });

    const item = outcome();
    spool.enqueue(item);
    await spool.flush();
    assert.deepEqual(await spool.drainOnce(), { posted: 1, acked: 1, failed: 0 });
    assert.equal(spool.statusOf(nonce(item)), "acked");
    assert.deepEqual(await spool.drainOnce(), { posted: 0, acked: 0, failed: 0 });
    assert.equal(calls, 1);
  });
});

test("4xx client error marks terminal and is not retried", async () => {
  await withTempDir(async (stateDir) => {
    let calls = 0;
    const item = outcome();
    const spool = createOutcomeSpool({
      stateDir,
      mcpBase: "http://mcp",
      getToken: () => "token",
      getOrgActive: () => true,
      newTrace: () => "trace-1",
      fetchFn: async () => {
        calls += 1;
        return new Response("bad", { status: 400 });
      },
    });
    spool.enqueue(item);
    await spool.flush();

    assert.deepEqual(await spool.drainOnce(), { posted: 1, acked: 0, failed: 1 });
    assert.equal(spool.statusOf(nonce(item)), "terminal");
    assert.deepEqual(await spool.drainOnce(), { posted: 0, acked: 0, failed: 0 });
    assert.equal(calls, 1);
  });
});

test("5xx stays pending, increments attempts, sets backoff, and retries when due", async () => {
  await withTempDir(async (stateDir) => {
    let now = 1000;
    let calls = 0;
    const item = outcome();
    const spool = createOutcomeSpool({
      stateDir,
      mcpBase: "http://mcp",
      getToken: () => "token",
      getOrgActive: () => true,
      newTrace: () => `trace-${calls + 1}`,
      nowMs: () => now,
      fetchFn: async () => {
        calls += 1;
        return calls === 1 ? new Response("server", { status: 500 }) : okResponse();
      },
    });
    spool.enqueue(item);
    await spool.flush();

    assert.deepEqual(await spool.drainOnce(), { posted: 1, acked: 0, failed: 1 });
    assert.equal(spool.statusOf(nonce(item)), "pending");
    let latest = readRecords(stateDir).at(-1) as { attempts: number; next_attempt_at: number };
    assert.equal(latest.attempts, 1);
    assert.equal(latest.next_attempt_at, 2000);

    assert.deepEqual(await spool.drainOnce(), { posted: 0, acked: 0, failed: 0 });
    now = 2000;
    assert.deepEqual(await spool.drainOnce(), { posted: 1, acked: 1, failed: 0 });
    assert.equal(spool.statusOf(nonce(item)), "acked");
  });
});

test("attempts cap marks terminal after 8 failures", async () => {
  await withTempDir(async (stateDir) => {
    let now = 1000;
    const item = outcome();
    const spool = createOutcomeSpool({
      stateDir,
      mcpBase: "http://mcp",
      getToken: () => "token",
      getOrgActive: () => true,
      newTrace: () => "trace",
      nowMs: () => now,
      fetchFn: async () => new Response("server", { status: 500 }),
    });
    spool.enqueue(item);
    await spool.flush();

    for (let i = 0; i < 8; i += 1) {
      const result = await spool.drainOnce();
      assert.equal(result.posted, 1);
      assert.equal(result.failed, 1);
      const latest = readRecords(stateDir).at(-1) as { next_attempt_at?: number };
      now = latest.next_attempt_at ?? now;
    }

    assert.equal(spool.statusOf(nonce(item)), "terminal");
    assert.deepEqual(await spool.drainOnce(), { posted: 0, acked: 0, failed: 0 });
  });
});

test("token null and inactive org skip without incrementing attempts", async () => {
  await withTempDir(async (stateDir) => {
    let token: string | null = null;
    let active = true;
    let calls = 0;
    const item = outcome();
    const spool = createOutcomeSpool({
      stateDir,
      mcpBase: "http://mcp",
      getToken: () => token,
      getOrgActive: () => active,
      newTrace: () => "trace",
      fetchFn: async () => {
        calls += 1;
        return okResponse();
      },
    });
    spool.enqueue(item);
    await spool.flush();

    assert.deepEqual(await spool.drainOnce(), { posted: 0, acked: 0, failed: 0 });
    assert.equal((readRecords(stateDir).at(-1) as { attempts: number }).attempts, 0);
    token = "token";
    active = false;
    assert.deepEqual(await spool.drainOnce(), { posted: 0, acked: 0, failed: 0 });
    assert.equal((readRecords(stateDir).at(-1) as { attempts: number }).attempts, 0);
    assert.equal(calls, 0);
  });
});

test("resume posts pending records and does not resend acked records", async () => {
  await withTempDir(async (stateDir) => {
    const item = outcome();
    const first = createOutcomeSpool({
      stateDir,
      mcpBase: "http://mcp",
      getToken: () => "token",
      getOrgActive: () => true,
      newTrace: () => "trace-1",
    });
    first.enqueue(item);
    await first.flush();

    let calls = 0;
    const second = createOutcomeSpool({
      stateDir,
      mcpBase: "http://mcp",
      getToken: () => "token",
      getOrgActive: () => true,
      newTrace: () => "trace-2",
      fetchFn: async () => {
        calls += 1;
        return okResponse();
      },
    });

    assert.equal(second.pendingCount(), 1);
    assert.deepEqual(await second.drainOnce(), { posted: 1, acked: 1, failed: 0 });

    const third = createOutcomeSpool({
      stateDir,
      mcpBase: "http://mcp",
      getToken: () => "token",
      getOrgActive: () => true,
      newTrace: () => "trace-3",
      fetchFn: async () => {
        calls += 1;
        return okResponse();
      },
    });
    assert.equal(third.statusOf(nonce(item)), "acked");
    assert.deepEqual(await third.drainOnce(), { posted: 0, acked: 0, failed: 0 });
    assert.equal(calls, 1);
  });
});

test("posted body is content-free and has exactly the approved keys", async () => {
  await withTempDir(async (stateDir) => {
    let postedBody: Record<string, unknown> | undefined;
    const spool = createOutcomeSpool({
      stateDir,
      mcpBase: "http://mcp",
      getToken: () => "token",
      getOrgActive: () => true,
      newTrace: () => "trace-1",
      fetchFn: async (_url, init) => {
        postedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return okResponse();
      },
    });

    spool.enqueue(outcome());
    await spool.flush();
    await spool.drainOnce();

    assert.ok(postedBody);
    assert.deepEqual(Object.keys(postedBody), [
      "org_id",
      "memory_hash",
      "episode_ref",
      "worked",
      "evidence_ref",
      "session_id",
    ]);
    for (const forbidden of ["text", "content", "plaintext", "score", "verdict"]) {
      assert.equal(Object.hasOwn(postedBody, forbidden), false);
    }
  });
});
