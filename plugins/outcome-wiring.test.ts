import assert from "node:assert/strict"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

// @ts-expect-error tsx test runner resolves .ts extension imports.
import { WeVibeMemoryPlugin } from "./wevibe-plugin.ts"
// @ts-expect-error tsx test runner resolves .ts extension imports.
import { OUTCOME_SPOOL_FILENAME, OUTCOME_SPOOL_SUBDIR, type OutcomeSpoolRecord } from "./outcome-spool.ts"

type FetchCall = {
  url: string
  method: string
  bodyText?: string
}

type Harness = {
  hooks: Record<string, (input: any, output: any) => Promise<void>>
  calls: FetchCall[]
  logs: string[]
  worktree: string
  cleanup: () => void
}

const sleep = async (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const toJsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })

const hexCid = (ch: string): string => ch.repeat(64)

const readBodyText = (body: unknown): string | undefined => {
  if (typeof body === "string") return body
  if (body === undefined || body === null) return undefined
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8")
  return String(body)
}

const writeBoundMarker = (worktree: string): void => {
  const markerDir = join(worktree, ".wevibe")
  mkdirSync(markerDir, { recursive: true })
  writeFileSync(join(markerDir, "org.json"), JSON.stringify({
    org_id: "org-test",
    project_fingerprint: hexCid("a"),
    fingerprint_source: "origin",
  }), "utf8")
}

const writeSessionToken = (homeDir: string): void => {
  const wevibeDir = join(homeDir, ".wevibe")
  mkdirSync(wevibeDir, { recursive: true })
  writeFileSync(join(wevibeDir, "mcp-session-token"), "token-test", "utf8")
}

const writePluginConfig = (homeDir: string): void => {
  const wevibeDir = join(homeDir, ".wevibe")
  mkdirSync(wevibeDir, { recursive: true })
  writeFileSync(join(wevibeDir, "plugin-config.json"), JSON.stringify({ recall_max_injected: 10, inject_char_budget: 8000 }), "utf8")
}

const recallPayload = (cid: string): Record<string, unknown> => ({
  status: "ok",
  memories: [{
    cid,
    text: "Use the known fix for this failing build",
    score: 0.97,
    matched_keywords: ["build"],
    memory_type: "correct_implementation",
    guard: { passed: true, flags: [] },
  }],
})

  const setupHarness = async (opts: { bound: boolean; cid?: string }): Promise<Harness> => {
  const oldFetch = globalThis.fetch
  const oldHome = process.env.HOME
  const oldRecallMode = process.env.WEVIBE_RECALL_MODE
  const oldMcpUrl = process.env.WEVIBE_MCP_HTTP_URL
  const oldSensors = process.env.WEVIBE_GSTV_SENSORS
  const oldRoot = process.env.WEVIBE_ROOT

  const homeDir = mkdtempSync(join(tmpdir(), "outcome-plugin-home-"))
  const worktree = mkdtempSync(join(tmpdir(), "outcome-plugin-worktree-"))
  const rootOverride = mkdtempSync(join(tmpdir(), "outcome-plugin-root-"))
  const calls: FetchCall[] = []
  const logs: string[] = []
  const cid = opts.cid ?? hexCid("b")

  if (opts.bound) writeBoundMarker(worktree)
  writeSessionToken(homeDir)
  writePluginConfig(homeDir)

  process.env.HOME = homeDir
  process.env.WEVIBE_RECALL_MODE = "test"
  process.env.WEVIBE_MCP_HTTP_URL = "http://wevibe-mock:4450"
  process.env.WEVIBE_ROOT = rootOverride
  delete process.env.WEVIBE_GSTV_SENSORS

  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const method = (init?.method ?? (typeof input === "string" || input instanceof URL ? "GET" : input.method) ?? "GET").toUpperCase()
    const bodyText = readBodyText(init?.body)
    calls.push({ url, method, bodyText })

    if (url.endsWith("/v1/health")) return toJsonResponse(200, { status: "ok" })
    if (url.endsWith("/v1/recall")) return toJsonResponse(200, recallPayload(cid))
    if (url.endsWith("/v1/serves")) return toJsonResponse(200, { status: "ok" })
    if (url.includes("/v1/gstv/goal")) return new Response("", { status: 404 })
    if (url.includes("/outcome-events")) return toJsonResponse(200, { status: "ok" })
    if (url.endsWith("/v1/shutdown")) return toJsonResponse(200, { status: "ok" })
    throw new Error(`Unexpected fetch: ${method} ${url}`)
  }) as typeof fetch

  const plugin = await WeVibeMemoryPlugin({
    directory: worktree,
    worktree,
    client: {
      app: { log: async ({ body }: { body?: { message?: unknown } }) => {
        if (typeof body?.message === "string") logs.push(body.message)
      } },
      tui: { showToast: async () => {} },
    },
    $: {
      nothrow: () => ({
        cwd: () => (_strings: TemplateStringsArray, ..._exprs: unknown[]) => ({
          quiet: () => Promise.resolve({ exitCode: 0 }),
        }),
      }),
    },
  } as never)

  if (opts.bound) {
    await (plugin as unknown as Harness["hooks"]).event({ event: { type: "session.created", properties: { sessionID: "bootstrap" } } }, undefined)
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (calls.some(call => call.url.endsWith("/v1/health"))) break
      await sleep(25)
    }
  }

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
    if (oldRoot === undefined) delete process.env.WEVIBE_ROOT
    else process.env.WEVIBE_ROOT = oldRoot
    rmSync(homeDir, { recursive: true, force: true })
    rmSync(worktree, { recursive: true, force: true })
    rmSync(rootOverride, { recursive: true, force: true })
  }

  return { hooks: plugin as unknown as Harness["hooks"], calls, logs, worktree, cleanup }
}

const waitForRecall = async (calls: FetchCall[]): Promise<void> => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (calls.some(call => call.url.endsWith("/v1/recall"))) return
    await sleep(25)
  }
  throw new Error("Timed out waiting for recall")
}

const waitForLog = async (logs: string[], pattern: RegExp): Promise<void> => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (logs.some(message => pattern.test(message))) return
    await sleep(25)
  }
  throw new Error(`Timed out waiting for log ${pattern}`)
}

const waitForSpoolRecords = async (worktree: string, count: number): Promise<OutcomeSpoolRecord[]> => {
  const path = join(worktree, ".wevibe", "state", OUTCOME_SPOOL_SUBDIR, OUTCOME_SPOOL_FILENAME)
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (existsSync(path)) {
      const text = readFileSync(path, "utf8").trim()
      const records = text.length === 0 ? [] : text.split("\n").map(line => JSON.parse(line) as OutcomeSpoolRecord)
      if (records.length >= count) return records
    }
    await sleep(25)
  }
  return []
}

const driveNeedAndInject = async (harness: Harness, sessionID: string): Promise<void> => {
  await waitForLog(harness.logs, /\[recall\] init wevibeAvailable=true/)
  await waitForLog(harness.logs, /\[binding\] session bind: active=true/)
  await harness.hooks["tool.execute.after"](
    { sessionID, callID: `${sessionID}-fail`, tool: "bash", args: { command: "npm run build" } },
    { title: "", output: "error TS1234: broken", metadata: { exit: 1, exit_code: 1 } },
  )
  await waitForRecall(harness.calls)
  const output = { system: ["base system"] }
  await harness.hooks["experimental.chat.system.transform"]({ sessionID }, output)
  assert.equal(output.system.length, 2)
}

test("outcome wiring harvests worked=true when injected memory precedes red-to-green build", { concurrency: false }, async (t) => {
  const cid = hexCid("c")
  const harness = await setupHarness({ bound: true, cid })
  t.after(() => harness.cleanup())

  const sessionID = "session-outcome-green"
  await driveNeedAndInject(harness, sessionID)
  await harness.hooks["tool.execute.after"](
    { sessionID, callID: "green-build", tool: "bash", args: { command: "npm run build" } },
    { title: "", output: "", metadata: { exit: 0, exit_code: 0 } },
  )

  const records = await waitForSpoolRecords(harness.worktree, 1)
  assert.equal(records.length, 1)
  assert.equal(records[0].resolution, "worked")
  assert.equal(records[0].memory_hash, cid)
  assert.equal(records[0].session_id, sessionID)
})

test("outcome wiring expires an injected episode after two idle events", { concurrency: false }, async (t) => {
  const cid = hexCid("d")
  const harness = await setupHarness({ bound: true, cid })
  t.after(() => harness.cleanup())

  const sessionID = "session-outcome-expiry"
  await driveNeedAndInject(harness, sessionID)
  await harness.hooks.event({ event: { type: "session.idle", properties: { sessionID } } }, undefined)
  assert.equal((await waitForSpoolRecords(harness.worktree, 1)).length, 0)
  await harness.hooks.event({ event: { type: "session.idle", properties: { sessionID } } }, undefined)

  const records = await waitForSpoolRecords(harness.worktree, 1)
  assert.equal(records.length, 1)
  assert.equal(records[0].resolution, "unobserved")
  assert.equal(records[0].memory_hash, cid)
})

test("outcome wiring skips episode opening for unbound sessions", { concurrency: false }, async (t) => {
  const harness = await setupHarness({ bound: false, cid: hexCid("e") })
  t.after(() => harness.cleanup())

  const sessionID = "session-outcome-no-org"
  await harness.hooks["tool.execute.after"](
    { sessionID, callID: "fail-unbound", tool: "bash", args: { command: "npm run build" } },
    { title: "", output: "error TS1234: broken", metadata: { exit: 1, exit_code: 1 } },
  )
  await harness.hooks["experimental.chat.system.transform"]({ sessionID }, { system: ["base system"] })
  await harness.hooks.event({ event: { type: "session.idle", properties: { sessionID } } }, undefined)
  await harness.hooks.event({ event: { type: "session.idle", properties: { sessionID } } }, undefined)

  const records = await waitForSpoolRecords(harness.worktree, 1)
  assert.equal(records.length, 0)
})
