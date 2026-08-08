import assert from "node:assert/strict"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

// @ts-expect-error tsx test runner resolves .ts extension imports.
import { WeVibeMemoryPlugin } from "./wevibe-plugin.ts"
// @ts-expect-error tsx test runner resolves .ts extension imports.
import { onSessionCreated, onSessionIdle } from "./gstv-hooks.ts"
// @ts-expect-error tsx test runner resolves .ts extension imports.
import { createSpool, SPOOL_FILENAME, SPOOL_SUBDIR, fp8 } from "./gstv-spool.ts"

type SpoolRecord = {
  event: string
  session_id: string
  trace_id: string | null
  payload: Record<string, unknown>
}

type FetchCall = {
  url: string
  method: string
  headers: Headers
  bodyText?: string
}

type PluginHarness = {
  hooks: Record<string, (input: any, output: any) => Promise<void>>
  calls: FetchCall[]
  logs: string[]
  worktree: string
  homeDir: string
  cleanup: () => void
}

type PluginHarnessOptions = {
  memories?: Array<{ cid: string; text: string; score?: number; matched_keywords?: string[] }>
  sensorsEnv?: string | undefined
  servesMode?: "ok" | "status400" | "reject"
  gstvGoalMode?: "404" | "open" | "closed"
  wevibeRoot?: string
}

const sleep = async (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const toJsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  })

const readSpoolRecords = (stateDir: string): SpoolRecord[] => {
  const path = join(stateDir, SPOOL_SUBDIR, SPOOL_FILENAME)
  if (!existsSync(path)) {
    return []
  }
  const lines = readFileSync(path, "utf8").trim()
  if (lines.length === 0) {
    return []
  }
  return lines.split("\n").map(line => JSON.parse(line) as SpoolRecord)
}

const writeBoundMarker = (worktree: string): void => {
  const markerDir = join(worktree, ".wevibe")
  mkdirSync(markerDir, { recursive: true })
  writeFileSync(
    join(markerDir, "org.json"),
    JSON.stringify({
      org_id: "org-test",
      project_fingerprint: "a".repeat(64),
      fingerprint_source: "origin",
    }),
    "utf8",
  )
}

const writePluginConfig = (homeDir: string): void => {
  const wevibeDir = join(homeDir, ".wevibe")
  mkdirSync(wevibeDir, { recursive: true })
  writeFileSync(join(wevibeDir, "plugin-config.json"), JSON.stringify({ recall_max_injected: 10, inject_char_budget: 8000 }, null, 2), "utf8")
}

const writeSessionToken = (homeDir: string): void => {
  const wevibeDir = join(homeDir, ".wevibe")
  mkdirSync(wevibeDir, { recursive: true })
  writeFileSync(join(wevibeDir, "mcp-session-token"), "token-test", "utf8")
}

const recallPayload = (memories: Array<{ cid: string; text: string; score?: number; matched_keywords?: string[] }>): { status: string; memories: Array<Record<string, unknown>> } => ({
  status: "ok",
  memories: memories.map(memory => ({
    cid: memory.cid,
    text: memory.text,
    score: memory.score ?? 0.9,
    matched_keywords: memory.matched_keywords ?? [],
    memory_type: "correct_implementation",
    guard: {
      passed: true,
      flags: [],
    },
  })),
})

const setupPluginHarness = async (opts: PluginHarnessOptions = {}): Promise<PluginHarness> => {
  const oldFetch = globalThis.fetch
  const oldHome = process.env.HOME
  const oldRecallMode = process.env.WEVIBE_RECALL_MODE
  const oldMcpUrl = process.env.WEVIBE_MCP_HTTP_URL
  const oldSensors = process.env.WEVIBE_GSTV_SENSORS
  const oldWeVibeRoot = process.env.WEVIBE_ROOT

  const calls: FetchCall[] = []
  const logs: string[] = []
  const homeDir = mkdtempSync(join(tmpdir(), "gstv-plugin-home-"))
  const worktree = mkdtempSync(join(tmpdir(), "gstv-plugin-worktree-"))
  const rootOverride = opts.wevibeRoot ?? mkdtempSync(join(tmpdir(), "gstv-plugin-root-"))

  writeBoundMarker(worktree)
  writeSessionToken(homeDir)
  writePluginConfig(homeDir)

  process.env.HOME = homeDir
  process.env.WEVIBE_RECALL_MODE = "test"
  process.env.WEVIBE_MCP_HTTP_URL = "http://wevibe-mock:4450"
  process.env.WEVIBE_ROOT = rootOverride
  if (opts.sensorsEnv === undefined) {
    delete process.env.WEVIBE_GSTV_SENSORS
  } else {
    process.env.WEVIBE_GSTV_SENSORS = opts.sensorsEnv
  }

  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const method = (init?.method ?? (typeof input === "string" || input instanceof URL ? "GET" : input.method) ?? "GET").toUpperCase()
    const headers = new Headers(init?.headers)
    const bodyText = typeof init?.body === "string" ? init.body : undefined
    calls.push({ url, method, headers, bodyText })

    if (url.endsWith("/v1/health")) {
      return toJsonResponse(200, { status: "ok" })
    }
    if (url.endsWith("/v1/recall")) {
      return toJsonResponse(200, recallPayload(opts.memories ?? [{ cid: "cid-a", text: "Memory A" }]))
    }
    if (url.includes("/v1/gstv/goal")) {
      if (opts.gstvGoalMode === "open") {
        return toJsonResponse(200, {
          open: true,
          goal_id: "goal-1",
          goal_text_fp: "goal-fp-1",
          predicate: {
            command: "npm test",
            file_paths: ["plugins/wevibe-plugin.ts"],
          },
          needs_boundary_run: true,
          boundary_reason: "run once",
        })
      }
      if (opts.gstvGoalMode === "closed") {
        return toJsonResponse(200, { open: false })
      }
      return new Response("", { status: 404 })
    }
    if (url.endsWith("/v1/serves")) {
      if (opts.servesMode === "status400") {
        return new Response("bad receipt", { status: 400 })
      }
      if (opts.servesMode === "reject") {
        throw new Error("network down")
      }
      return toJsonResponse(200, { status: "ok" })
    }
    if (url.endsWith("/v1/shutdown")) {
      return toJsonResponse(200, { status: "ok" })
    }

    throw new Error(`Unexpected fetch: ${method} ${url}`)
  }) as typeof fetch

  const plugin = await WeVibeMemoryPlugin({
    directory: worktree,
    worktree,
    client: {
      app: {
        log: async ({ body }: { body: { message?: unknown } }) => {
          if (typeof body.message === "string") {
            logs.push(body.message)
          }
        },
      },
      tui: {
        showToast: async () => {},
      },
    },
    $: {
      nothrow: () => ({
        cwd: () => (_strings: TemplateStringsArray, ..._exprs: unknown[]) => ({
          quiet: () => Promise.resolve({ exitCode: 0 }),
        }),
      }),
    },
  } as never)

  const cleanup = (): void => {
    globalThis.fetch = oldFetch
    if (oldHome === undefined) delete process.env.HOME
    else process.env.HOME = oldHome
    if (oldRecallMode === undefined) delete process.env.WEVIBE_RECALL_MODE
    else process.env.WEVIBE_RECALL_MODE = oldRecallMode
    if (oldMcpUrl === undefined) delete process.env.WEVIBE_MCP_HTTP_URL
    else process.env.WEVIBE_MCP_HTTP_URL = oldMcpUrl
    if (oldSensors === undefined) delete process.env.WEVIBE_GSTV_SENSORS
    else process.env.WEVIBE_GSTV_SENSORS = oldSensors
    if (oldWeVibeRoot === undefined) delete process.env.WEVIBE_ROOT
    else process.env.WEVIBE_ROOT = oldWeVibeRoot
    rmSync(homeDir, { recursive: true, force: true })
    rmSync(worktree, { recursive: true, force: true })
    if (!opts.wevibeRoot) {
      rmSync(rootOverride, { recursive: true, force: true })
    }
  }

  return {
    hooks: plugin as unknown as Record<string, (input: any, output: any) => Promise<void>>,
    calls,
    logs,
    worktree,
    homeDir,
    cleanup,
  }
}

const failOutput = () => ({
  title: "",
  output: "error TS1234: broken",
  metadata: { exit: 1, exit_code: 1 },
})

const emitFileEdit = async (
  hooks: Record<string, (input: any, output: any) => Promise<void>>,
  sessionID: string,
): Promise<void> => {
  await hooks["event"]({ event: { type: "file.edited", properties: { sessionID, file: "src/x.ts" } } }, undefined)
}

// C3 trigger rework: the sole recall trigger is a REPEAT failure under a stable
// failureKey (D-RECALL-TRIGGER-REPEAT). Drive the repeat-failure pattern: first
// red opens the episode, a file.edited between reds arms the C3b flake guard,
// and the second red arms the recall. Polls until the recall fetch lands so
// binding/wevibe warm-up is absorbed, like the old chat.message loop.
const driveRepeatFailure = async (
  hooks: Record<string, (input: any, output: any) => Promise<void>>,
  calls: FetchCall[],
  sessionID: string,
): Promise<void> => {
  const recallBefore = calls.filter(call => call.url.endsWith("/v1/recall")).length
  await hooks["tool.execute.after"](
    { sessionID, callID: `${sessionID}-fail-1`, tool: "bash", args: { command: "npm run build" } },
    failOutput(),
  )
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await emitFileEdit(hooks, sessionID)
    await hooks["tool.execute.after"](
      { sessionID, callID: `${sessionID}-fail-${attempt + 2}`, tool: "bash", args: { command: "npm run build" } },
      failOutput(),
    )
    if (calls.filter(call => call.url.endsWith("/v1/recall")).length > recallBefore) {
      return
    }
    await sleep(25)
  }
  throw new Error("Timed out waiting for repeat-failure recall")
}

test("gstv hooks: closed goal records nothing", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "gstv-hooks-closed-"))
  try {
    const spool = createSpool({ stateDir })
    const fetchCalls: Array<{ url: string }> = []
    await onSessionCreated({
      spool,
      mcpBase: "http://wevibe-mock:4450",
      repoRoot: "/repo",
      token: "tok",
      newTrace: () => "trace-1",
      runCommand: async () => ({ exitCode: 0, durationMs: 1 }),
      fetchFn: async (input) => {
        fetchCalls.push({ url: String(input) })
        return toJsonResponse(200, { open: false })
      },
    }, "sid-1")
    await spool.flush()

    assert.equal(fetchCalls.length, 1)
    assert.equal(readSpoolRecords(stateDir).filter(record => record.event.startsWith("gstv.")).length, 0)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test("gstv hooks: 404 route is treated as absent and records nothing", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "gstv-hooks-404-"))
  try {
    const spool = createSpool({ stateDir })
    await onSessionCreated({
      spool,
      mcpBase: "http://wevibe-mock:4450",
      repoRoot: "/repo",
      newTrace: () => "trace-2",
      runCommand: async () => ({ exitCode: 0, durationMs: 1 }),
      fetchFn: async () => new Response("", { status: 404 }),
    }, "sid-1")
    await spool.flush()

    assert.equal(readSpoolRecords(stateDir).filter(record => record.event.startsWith("gstv.")).length, 0)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test("gstv hooks: fetch rejection does not throw and records nothing", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "gstv-hooks-reject-"))
  try {
    const spool = createSpool({ stateDir })
    await onSessionCreated({
      spool,
      mcpBase: "http://wevibe-mock:4450",
      repoRoot: "/repo",
      newTrace: () => "trace-3",
      runCommand: async () => ({ exitCode: 0, durationMs: 1 }),
      fetchFn: async () => {
        throw new Error("down")
      },
    }, "sid-1")
    await spool.flush()

    assert.equal(readSpoolRecords(stateDir).filter(record => record.event.startsWith("gstv.")).length, 0)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test("gstv hooks: open goal emits attach attempt with trace header", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "gstv-hooks-open-"))
  try {
    const spool = createSpool({ stateDir })
    const seenHeaders: string[] = []
    await onSessionCreated({
      spool,
      mcpBase: "http://wevibe-mock:4450",
      repoRoot: "/repo",
      token: "tok",
      newTrace: () => "trace-open",
      runCommand: async () => ({ exitCode: 0, durationMs: 1 }),
      fetchFn: async (_input, init) => {
        const headers = new Headers(init?.headers)
        seenHeaders.push(headers.get("X-WeVibe-Trace-Id") ?? "")
        return toJsonResponse(200, {
          open: true,
          goal_id: "goal-123",
          goal_text_fp: "fp",
          predicate: { command: "echo hi", file_paths: ["a.ts"] },
          needs_boundary_run: false,
          boundary_reason: "n/a",
        })
      },
    }, "sid-open")
    await spool.flush()

    const records = readSpoolRecords(stateDir).filter(record => record.event === "gstv.attach.attempt")
    assert.equal(records.length, 1)
    assert.equal(records[0]?.session_id, "sid-open")
    assert.equal(records[0]?.trace_id, "trace-open")
    assert.equal(records[0]?.payload.goal_id, "goal-123")
    assert.equal(seenHeaders[0], "trace-open")
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test("gstv hooks: idle boundary run executes once with pinned timeout and records run", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "gstv-hooks-idle-"))
  try {
    const spool = createSpool({ stateDir })
    const calls: Array<{ command: string; timeoutMs: number }> = []
    const boundaryRan = new Set<string>()
    await onSessionIdle({
      spool,
      mcpBase: "http://wevibe-mock:4450",
      repoRoot: "/repo",
      newTrace: () => "trace-idle",
      runCommand: async (command, timeoutMs) => {
        calls.push({ command, timeoutMs })
        return { exitCode: 17, durationMs: 456 }
      },
      fetchFn: async () => toJsonResponse(200, {
        open: true,
        goal_id: "goal-1",
        goal_text_fp: "fp",
        predicate: { command: "npm run test", file_paths: ["p.ts"] },
        needs_boundary_run: true,
        boundary_reason: "once",
      }),
    }, "sid-idle", boundaryRan)
    await spool.flush()

    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.command, "npm run test")
    assert.equal(calls[0]?.timeoutMs, 120000)
    const runs = readSpoolRecords(stateDir).filter(record => record.event === "gstv.boundary.run")
    assert.equal(runs.length, 1)
    assert.equal(runs[0]?.payload.goal_id, "goal-1")
    assert.equal(runs[0]?.payload.command, "npm run test")
    assert.equal(runs[0]?.payload.exit_code, 17)
    assert.equal(runs[0]?.payload.duration_ms, 456)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test("gstv hooks: idle same goal twice runs boundary once", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "gstv-hooks-once-"))
  try {
    const spool = createSpool({ stateDir })
    const boundaryRan = new Set<string>()
    let runCount = 0
    const deps = {
      spool,
      mcpBase: "http://wevibe-mock:4450",
      repoRoot: "/repo",
      newTrace: () => "trace-once",
      runCommand: async () => {
        runCount += 1
        return { exitCode: 0, durationMs: 10 }
      },
      fetchFn: async () => toJsonResponse(200, {
        open: true,
        goal_id: "goal-once",
        goal_text_fp: "fp",
        predicate: { command: "echo once", file_paths: ["a"] },
        needs_boundary_run: true,
        boundary_reason: "once",
      }),
    }

    await onSessionIdle(deps, "sid-once", boundaryRan)
    await onSessionIdle(deps, "sid-once", boundaryRan)
    await spool.flush()

    assert.equal(runCount, 1)
    assert.equal(readSpoolRecords(stateDir).filter(record => record.event === "gstv.boundary.run").length, 1)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test("gstv hooks: open goal without boundary run records nothing", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "gstv-hooks-no-boundary-"))
  try {
    const spool = createSpool({ stateDir })
    let runCount = 0
    await onSessionIdle({
      spool,
      mcpBase: "http://wevibe-mock:4450",
      repoRoot: "/repo",
      newTrace: () => "trace-none",
      runCommand: async () => {
        runCount += 1
        return { exitCode: 0, durationMs: 1 }
      },
      fetchFn: async () => toJsonResponse(200, {
        open: true,
        goal_id: "goal-no",
        goal_text_fp: "fp",
        predicate: { command: "echo no", file_paths: ["a"] },
        needs_boundary_run: false,
        boundary_reason: "no",
      }),
    }, "sid-no", new Set())
    await spool.flush()

    assert.equal(runCount, 0)
    assert.equal(readSpoolRecords(stateDir).filter(record => record.event === "gstv.boundary.run").length, 0)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test("gstv hooks: malformed open goal is ignored", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "gstv-hooks-malformed-"))
  try {
    const spool = createSpool({ stateDir })
    await onSessionCreated({
      spool,
      mcpBase: "http://wevibe-mock:4450",
      repoRoot: "/repo",
      newTrace: () => "trace-malformed",
      runCommand: async () => ({ exitCode: 0, durationMs: 1 }),
      fetchFn: async () => toJsonResponse(200, {
        open: true,
        goal_id: "goal-bad",
        goal_text_fp: "fp",
        needs_boundary_run: true,
        boundary_reason: "bad",
      }),
    }, "sid-bad")
    await spool.flush()

    assert.equal(readSpoolRecords(stateDir).filter(record => record.event.startsWith("gstv.")).length, 0)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test("plugin sensors: zero-delta output across sensors on/off with spool only in on arm", { concurrency: false }, async (t) => {
  const rootOn = mkdtempSync(join(tmpdir(), "gstv-root-on-"))
  const rootOff = mkdtempSync(join(tmpdir(), "gstv-root-off-"))
  const on = await setupPluginHarness({ sensorsEnv: undefined, wevibeRoot: rootOn })
  let off: PluginHarness | undefined
  t.after(() => {
    on.cleanup()
    off?.cleanup()
    rmSync(rootOn, { recursive: true, force: true })
    rmSync(rootOff, { recursive: true, force: true })
  })

  const sessionID = "sid-zero-delta"
  await on.hooks.event({ event: { type: "session.created", properties: { sessionID, info: { id: sessionID, directory: on.worktree } } } }, {})
  await driveRepeatFailure(on.hooks, on.calls, sessionID)

  const onTransform = { system: ["seed-system"] as string[] }
  await on.hooks["experimental.chat.system.transform"]({ sessionID, model: { id: "m" } }, onTransform)

  const onCompacting = { context: ["c0"] as string[] }
  await on.hooks["experimental.session.compacting"]({ sessionID }, onCompacting)
  await sleep(35)

  off = await setupPluginHarness({ sensorsEnv: "0", wevibeRoot: rootOff })
  await off.hooks.event({ event: { type: "session.created", properties: { sessionID, info: { id: sessionID, directory: off.worktree } } } }, {})
  await driveRepeatFailure(off.hooks, off.calls, sessionID)
  const offTransform = { system: ["seed-system"] as string[] }
  await off.hooks["experimental.chat.system.transform"]({ sessionID, model: { id: "m" } }, offTransform)
  const offCompacting = { context: ["c0"] as string[] }
  await off.hooks["experimental.session.compacting"]({ sessionID }, offCompacting)
  await sleep(35)

  assert.deepEqual(onTransform, offTransform)
  assert.equal(JSON.stringify(onTransform), JSON.stringify(offTransform))
  assert.deepEqual(onCompacting, offCompacting)

  const onSpoolPath = join(on.worktree, ".wevibe", "state", SPOOL_SUBDIR, SPOOL_FILENAME)
  const offSpoolPath = join(off.worktree, ".wevibe", "state", SPOOL_SUBDIR, SPOOL_FILENAME)
  assert.equal(existsSync(onSpoolPath), true)
  assert.ok(readFileSync(onSpoolPath, "utf8").trim().length > 0)
  assert.equal(existsSync(offSpoolPath), false)
})

test("plugin sensors: event feed and tool before/after records are appended", { concurrency: false }, async (t) => {
  const harness = await setupPluginHarness({ sensorsEnv: undefined })
  t.after(() => harness.cleanup())

  const sessionID = "sid-event"
  await harness.hooks.event({ event: { type: "session.created", properties: { sessionID, info: { id: sessionID, directory: harness.worktree } } } }, {})
  await harness.hooks["tool.execute.before"]({ sessionID, callID: "call-1", tool: "bash" }, { args: { cmd: "pwd" } })
  await sleep(15)
  await harness.hooks["tool.execute.after"](
    { sessionID, callID: "call-1", tool: "bash", args: { cmd: "pwd" } },
    { title: "bash", output: "ok", metadata: { exit_code: 0 } },
  )
  await sleep(35)

  const records = readSpoolRecords(join(harness.worktree, ".wevibe", "state"))
  const created = records.find(record => record.event === "session.created")
  const before = records.find(record => record.event === "tool.execute.before")
  const after = records.find(record => record.event === "tool.execute.after")

  assert.equal(created?.payload.directory, harness.worktree)
  assert.equal(before?.payload.call_id, "call-1")
  assert.equal(before?.payload.tool, "bash")
  assert.equal(after?.payload.call_id, "call-1")
  assert.equal(after?.payload.tool, "bash")
  assert.equal(typeof after?.payload.duration_ms, "number")
})

test("plugin sensors: inject logs carry cadence/top_k/block_tokens and compacting logs restores count", { concurrency: false }, async (t) => {
  const harness = await setupPluginHarness({ sensorsEnv: undefined, memories: [{ cid: "cid-inject", text: "Memory Inject", matched_keywords: ["alpha", "beta"] }] })
  t.after(() => harness.cleanup())

  const sessionID = "sid-inject-log"
  await driveRepeatFailure(harness.hooks, harness.calls, sessionID)
  const transformOutput = { system: ["seed"] as string[] }
  await harness.hooks["experimental.chat.system.transform"]({ sessionID, model: { id: "m" } }, transformOutput)
  await harness.hooks["experimental.session.compacting"]({ sessionID }, { context: [] as string[] })
  await sleep(35)

  const injectedLine = harness.logs.find(line => line.includes("[inject] injected"))
  const restoredLine = harness.logs.find(line => line.includes("[inject] restored"))
  const perMemoryLine = harness.logs.find(line => line.includes("present_this_turn"))
  assert.ok(injectedLine)
  assert.ok(injectedLine?.includes("cadence=once"))
  assert.ok(injectedLine?.includes("block_tokens="))
  assert.ok(injectedLine?.includes("top_k="))
  assert.ok(perMemoryLine)
  assert.ok(perMemoryLine?.includes("kw=[alpha,beta]"))
  assert.ok(restoredLine)
  assert.ok(restoredLine?.includes("compaction_restores=1"))
})

test("plugin sensors: serve receipt failures log status and reason with cid fingerprint", { concurrency: false }, async (t) => {
  const statusHarness = await setupPluginHarness({ sensorsEnv: undefined, servesMode: "status400", memories: [{ cid: "cid-serve-400", text: "Memory 400" }] })
  let rejectHarness: PluginHarness | undefined
  t.after(() => {
    statusHarness.cleanup()
    rejectHarness?.cleanup()
  })

  const session400 = "sid-serve-400"
  await driveRepeatFailure(statusHarness.hooks, statusHarness.calls, session400)
  await statusHarness.hooks["experimental.chat.system.transform"]({ sessionID: session400, model: { id: "m" } }, { system: ["seed"] as string[] })
  await sleep(35)
  const failedStatus = statusHarness.logs.find(line => line.includes("[serve] receipt failed"))
  assert.ok(failedStatus)
  assert.ok(failedStatus?.includes("status=400"))
  assert.ok(failedStatus?.includes(`cid_fp=${fp8("cid-serve-400")}`))

  rejectHarness = await setupPluginHarness({ sensorsEnv: undefined, servesMode: "reject", memories: [{ cid: "cid-serve-reject", text: "Memory reject" }] })
  const sessionReject = "sid-serve-reject"
  await driveRepeatFailure(rejectHarness.hooks, rejectHarness.calls, sessionReject)
  await rejectHarness.hooks["experimental.chat.system.transform"]({ sessionID: sessionReject, model: { id: "m" } }, { system: ["seed"] as string[] })
  await sleep(35)
  const failedReason = rejectHarness.logs.find(line => line.includes("[serve] receipt failed") && line.includes("reason="))
  assert.ok(failedReason)
  assert.ok(failedReason?.includes(`cid_fp=${fp8("cid-serve-reject")}`))
})
