import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// @ts-expect-error tsx test runner resolves .ts extension imports.
import { SPOOL_FILENAME, SPOOL_SUBDIR, SPOOL_VERSION, TRUNCATION_MARKER, createSpool, excerpt, fp8 } from "./gstv-spool.ts";

function withTempDir(run: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "gstv-spool-"));
  return Promise.resolve()
    .then(() => run(dir))
    .finally(() => {
      rmSync(dir, { recursive: true, force: true });
    });
}

test("append writes one JSONL line with pinned schema and key order", async () => {
  await withTempDir(async (stateDir) => {
    const spool = createSpool({ stateDir });
    spool.append({ sessionId: "s-1", event: "session.created" });
    await spool.flush();

    const spoolPath = join(stateDir, SPOOL_SUBDIR, SPOOL_FILENAME);
    const lines = readFileSync(spoolPath, "utf8").split("\n");
    assert.equal(lines.length, 2);
    assert.equal(lines[1], "");

    const record = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.deepEqual(Object.keys(record), ["v", "seq", "ts", "session_id", "trace_id", "event", "payload"]);
    assert.equal(record.v, SPOOL_VERSION);
    assert.match(String(record.ts), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(record.trace_id, null);
    assert.deepEqual(record.payload, {});
  });
});

test("seq is monotonic and resumes from existing file", async () => {
  await withTempDir(async (stateDir) => {
    const spool1 = createSpool({ stateDir });
    spool1.append({ sessionId: "s-1", event: "session.created" });
    spool1.append({ sessionId: "s-1", event: "session.idle" });
    await spool1.flush();

    const spool2 = createSpool({ stateDir });
    spool2.append({ sessionId: "s-2", event: "session.error" });
    await spool2.flush();

    const records = readFileSync(join(stateDir, SPOOL_SUBDIR, SPOOL_FILENAME), "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as { seq: number });

    assert.equal(records[0]?.seq, 0);
    assert.equal(records[1]?.seq, 1);
    assert.equal(records[2]?.seq, 2);
  });
});

test("excerpt truncates and preserves values as specified", async () => {
  await withTempDir(async (stateDir) => {
    const spool = createSpool({ stateDir });
    await spool.flush();

    const long = "x".repeat(3000);
    const longExcerpt = excerpt(long);
    assert.ok(longExcerpt !== undefined);
    assert.equal(longExcerpt.length, 2048 + TRUNCATION_MARKER.length);
    assert.ok(longExcerpt.endsWith(TRUNCATION_MARKER));

    assert.equal(excerpt("short"), "short");
    assert.equal(excerpt(undefined), undefined);

    const obj = { a: 1, b: "x" };
    assert.equal(excerpt(obj), JSON.stringify(obj));

    const bigObj = { x: "y".repeat(4000) };
    const objExcerpt = excerpt(bigObj, 200);
    assert.ok(objExcerpt !== undefined);
    assert.equal(objExcerpt.length, 200 + TRUNCATION_MARKER.length);
    assert.ok(objExcerpt.endsWith(TRUNCATION_MARKER));
  });
});

test("append is fire-and-forget and logs write failures without throwing", async () => {
  await withTempDir(async (stateDir) => {
    const blockingPath = join(stateDir, SPOOL_SUBDIR);
    writeFileSync(blockingPath, "not-a-dir");

    const errors: string[] = [];
    const spool = createSpool({
      stateDir,
      onError: (message) => {
        errors.push(message);
      },
    });

    assert.doesNotThrow(() => {
      const ret = spool.append({ sessionId: "s-1", event: "session.created" });
      assert.equal(ret, undefined);
      assert.equal(typeof (ret as unknown as { then?: unknown })?.then, "undefined");
    });

    await spool.flush();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 15);
    });

    assert.ok(errors.length >= 1);
    assert.ok(errors.some((message) => message.startsWith("[spool]")));
  });
});

test("disabled spool does not create file and does not call onError", async () => {
  await withTempDir(async (stateDir) => {
    const errors: string[] = [];
    const spool = createSpool({
      stateDir,
      disabled: true,
      onError: (message) => {
        errors.push(message);
      },
    });

    spool.append({ sessionId: "s-1", event: "session.created" });
    await spool.flush();

    const spoolPath = join(stateDir, SPOOL_SUBDIR, SPOOL_FILENAME);
    let exists = true;
    try {
      statSync(spoolPath);
    } catch {
      exists = false;
    }
    assert.equal(exists, false);
    assert.equal(errors.length, 0);
  });
});

test("fp8 returns first eight hex chars of sha256", async () => {
  await withTempDir(async (stateDir) => {
    const spool = createSpool({ stateDir });
    await spool.flush();
    assert.equal(fp8("abc"), "ba7816bf");
  });
});

test("injectable clock controls timestamp", async () => {
  await withTempDir(async (stateDir) => {
    const spool = createSpool({
      stateDir,
      now: () => new Date("2026-07-26T00:00:00.000Z"),
    });

    spool.append({ sessionId: "s-1", event: "session.created" });
    await spool.flush();

    const [firstLine] = readFileSync(join(stateDir, SPOOL_SUBDIR, SPOOL_FILENAME), "utf8").split("\n");
    const record = JSON.parse(firstLine) as { ts: string };
    assert.equal(record.ts, "2026-07-26T00:00:00.000Z");
  });
});
