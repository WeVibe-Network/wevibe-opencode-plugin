/**
 * Purpose: Generate the SPOOL-V1 cross-repo conformance fixture from REAL plugin-produced bytes.
 * Regen:   npx tsx plugins/gen-spool-v1-fixture.ts [--out <path>]
 * Consumers/tripwires: clone tests/gstv-spool-conformance.test.ts and
 * bench tests/test_spool_v1_conformance.py. Contract: wevibe-meta/workspace/docs/SPOOL-V1.md.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// @ts-expect-error tsx resolves .ts extension imports.
import { WeVibeMemoryPlugin } from "./wevibe-plugin.ts"

type HookFn = (input: any, output: any) => Promise<void>

type SpoolRecord = {
  v: string
  seq: number
  ts: string
  session_id: string
  trace_id: string | null
  event: string
  payload: Record<string, unknown>
}

const SESSION_ID = "ses_conformance_fixture"
const TRUNCATION_MARKER = "…[truncated]"
const TRUNCATED_EXCERPT_LEN = 2048 + TRUNCATION_MARKER.length
const EXPECTED_KEYS = ["v", "seq", "ts", "session_id", "trace_id", "event", "payload"]
const EXPECTED_EVENTS = new Set([
  "session.created",
  "session.idle",
  "session.error",
  "tool.execute.before",
  "tool.execute.after",
  "file.edited",
  "file.watcher.updated",
  "lsp.client.diagnostics",
  "command.executed",
  "gstv.attach.attempt",
  "gstv.boundary.run",
])

const sleep = async (ms: number): Promise<void> => new Promise(resolveSleep => setTimeout(resolveSleep, ms))

const toJsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  })

const writeBoundMarker = (worktree: string): void => {
  const markerDir = join(worktree, ".wevibe")
  mkdirSync(markerDir, { recursive: true })
  writeFileSync(
    join(markerDir, "org.json"),
    `${JSON.stringify(
      {
        org_id: "org-test",
        project_fingerprint: "a".repeat(64),
        fingerprint_source: "origin",
      },
      null,
      2,
    )}\n`,
    "utf8",
  )
}

const writePluginConfig = (homeDir: string): void => {
  const wevibeDir = join(homeDir, ".wevibe")
  mkdirSync(wevibeDir, { recursive: true })
  writeFileSync(
    join(wevibeDir, "plugin-config.json"),
    JSON.stringify({ recall_max_injected: 10, inject_char_budget: 8000 }, null, 2),
    "utf8",
  )
}

const writeSessionToken = (homeDir: string): void => {
  const wevibeDir = join(homeDir, ".wevibe")
  mkdirSync(wevibeDir, { recursive: true })
  writeFileSync(join(wevibeDir, "mcp-session-token"), "token-test", "utf8")
}

const readSpoolRecords = (spoolPath: string): SpoolRecord[] => {
  try {
    const text = readFileSync(spoolPath, "utf8")
    const trimmed = text.trim()
    if (trimmed.length === 0) {
      return []
    }
    return trimmed.split("\n").map(line => JSON.parse(line) as SpoolRecord)
  } catch {
    return []
  }
}

const pollForAsyncGstvRecords = async (spoolPath: string): Promise<void> => {
  const deadline = Date.now() + 10_000
  for (;;) {
    const records = readSpoolRecords(spoolPath)
    const kinds = new Set(records.map(record => record.event))
    if (kinds.has("gstv.attach.attempt") && kinds.has("gstv.boundary.run")) {
      return
    }
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for async GSTV spool records (gstv.attach.attempt + gstv.boundary.run)")
    }
    await sleep(50)
  }
}

const parseSpoolRawLines = (spoolBytes: string): string[] => {
  const lines = spoolBytes.split("\n")
  if (lines[lines.length - 1] === "") {
    lines.pop()
  }
  return lines
}

const ensure = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new Error(message)
  }
}

const selfCheck = (rawSpoolText: string, records: SpoolRecord[]): void => {
  ensure(records.length === 13, `Self-check failed: expected exactly 13 records, got ${records.length}`)

  for (let index = 0; index < records.length; index += 1) {
    ensure(records[index].seq === index, `Self-check failed: seq mismatch at index ${index}; got ${records[index].seq}`)
  }

  const kinds = new Set(records.map(record => record.event))
  ensure(kinds.size === 11, `Self-check failed: expected 11 unique event kinds, got ${kinds.size}`)
  for (const kind of EXPECTED_EVENTS) {
    ensure(kinds.has(kind), `Self-check failed: missing event kind ${kind}`)
  }

  const rawLines = parseSpoolRawLines(rawSpoolText)
  ensure(rawLines.length === 13, `Self-check failed: expected 13 JSONL lines, got ${rawLines.length}`)
  for (let index = 0; index < rawLines.length; index += 1) {
    const parsed = JSON.parse(rawLines[index]) as Record<string, unknown>
    const keys = Object.keys(parsed)
    ensure(
      keys.length === EXPECTED_KEYS.length && keys.every((key, keyIndex) => key === EXPECTED_KEYS[keyIndex]),
      `Self-check failed: key order mismatch at line ${index + 1}; got [${keys.join(",")}], expected [${EXPECTED_KEYS.join(",")}]`,
    )
  }

  const truncatedBefore = records.find(
    record =>
      record.event === "tool.execute.before" &&
      record.payload.call_id === "call-2" &&
      typeof record.payload.args_excerpt === "string",
  )
  ensure(Boolean(truncatedBefore), "Self-check failed: missing tool.execute.before truncation record for call-2")
  const argsExcerpt = truncatedBefore?.payload.args_excerpt as string | undefined
  ensure(typeof argsExcerpt === "string", "Self-check failed: truncation args_excerpt is missing")
  const argsExcerptValue = argsExcerpt as string
  ensure(
    argsExcerptValue.length === TRUNCATED_EXCERPT_LEN,
    `Self-check failed: truncation args_excerpt length ${argsExcerptValue.length} != ${TRUNCATED_EXCERPT_LEN}`,
  )
  ensure(
    argsExcerptValue.endsWith(TRUNCATION_MARKER),
    `Self-check failed: truncation args_excerpt missing marker ${TRUNCATION_MARKER}`,
  )

  const commandRecord = records.find(record => record.event === "command.executed")
  ensure(Boolean(commandRecord), "Self-check failed: missing command.executed record")
  ensure(
    commandRecord !== undefined && !("exit_code" in commandRecord.payload),
    "Self-check failed: command.executed payload unexpectedly has exit_code",
  )
  ensure(
    typeof commandRecord?.payload.args_excerpt === "string",
    "Self-check failed: command.executed missing args_excerpt",
  )

  for (const record of records) {
    const isGstv = record.event.startsWith("gstv.")
    if (isGstv) {
      ensure(record.trace_id !== null, `Self-check failed: ${record.event} trace_id must be non-null`)
    } else {
      ensure(record.trace_id === null, `Self-check failed: ${record.event} trace_id must be null`)
    }
    ensure(record.v === "spool-v1", `Self-check failed: record seq=${record.seq} has invalid v=${record.v}`)
    ensure(record.session_id === SESSION_ID, `Self-check failed: record seq=${record.seq} has session_id=${record.session_id}`)
  }
}

const parseArgs = (argv: string[]): { outPath: string } => {
  let outFlag: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === "--out") {
      const candidate = argv[index + 1]
      if (!candidate || candidate.startsWith("--")) {
        throw new Error("Invalid usage: --out requires a path value")
      }
      outFlag = candidate
      index += 1
      continue
    }
    throw new Error(`Invalid usage: unknown argument ${value}`)
  }

  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const repoRoot = resolve(scriptDir, "..")
  const defaultOut = "../wevibe-bench/scaffold/wevibe-mcp-clone/tests/fixtures/spool-v1.plugin-produced.jsonl"
  const requested = outFlag ?? defaultOut
  const outPath = resolve(repoRoot, requested)
  return { outPath }
}

const run = async (): Promise<void> => {
  const { outPath } = parseArgs(process.argv.slice(2))

  const oldFetch = globalThis.fetch
  const oldHome = process.env.HOME
  const oldRecallMode = process.env.WEVIBE_RECALL_MODE
  const oldMcpUrl = process.env.WEVIBE_MCP_HTTP_URL
  const oldSensors = process.env.WEVIBE_GSTV_SENSORS
  const oldWeVibeRoot = process.env.WEVIBE_ROOT

  const homeDir = mkdtempSync(join(tmpdir(), "gstv-fixture-home-"))
  const worktree = mkdtempSync(join(tmpdir(), "gstv-fixture-worktree-"))
  const rootOverride = mkdtempSync(join(tmpdir(), "gstv-fixture-root-"))
  const spoolPath = join(worktree, ".wevibe", "state", "spool", "spool-v1.jsonl")

  try {
    writeBoundMarker(worktree)
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

      if (url.endsWith("/v1/health")) {
        return toJsonResponse(200, { status: "ok" })
      }
      if (url.endsWith("/v1/recall")) {
        return toJsonResponse(200, { status: "ok", memories: [] })
      }
      if (url.includes("/v1/gstv/goal")) {
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
      if (url.endsWith("/v1/serves")) {
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
          log: async () => {},
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
    const hooks = plugin as unknown as Record<string, HookFn>

    await hooks.event(
      {
        event: {
          type: "session.created",
          properties: {
            sessionID: SESSION_ID,
            info: {
              id: SESSION_ID,
              directory: worktree,
            },
          },
        },
      },
      {},
    )

    await hooks.event(
      {
        event: {
          type: "session.error",
          properties: {
            sessionID: SESSION_ID,
            error: {
              message: "synthetic boom",
            },
          },
        },
      },
      {},
    )

    await hooks.event(
      {
        event: {
          type: "session.error",
          properties: {
            sessionID: SESSION_ID,
            error: undefined,
          },
        },
      },
      {},
    )

    await hooks["tool.execute.before"](
      {
        sessionID: SESSION_ID,
        callID: "call-1",
        tool: "bash",
      },
      {
        args: {
          cmd: "pwd",
        },
      },
    )

    await hooks["tool.execute.after"](
      {
        sessionID: SESSION_ID,
        callID: "call-1",
        tool: "bash",
        args: {
          cmd: "pwd",
        },
      },
      {
        title: "bash",
        output: "ok",
        metadata: {
          exit_code: 0,
          error: "synthetic stderr",
        },
      },
    )

    await hooks["tool.execute.before"](
      {
        sessionID: SESSION_ID,
        callID: "call-2",
        tool: "bash",
      },
      {
        args: {
          cmd: "x".repeat(3000),
        },
      },
    )

    await hooks.event(
      {
        event: {
          type: "file.edited",
          properties: {
            sessionID: SESSION_ID,
            file: "src/a.ts",
          },
        },
      },
      {},
    )

    await hooks.event(
      {
        event: {
          type: "file.watcher.updated",
          properties: {
            sessionID: SESSION_ID,
            file: "src/b.ts",
          },
        },
      },
      {},
    )

    await hooks.event(
      {
        event: {
          type: "lsp.client.diagnostics",
          properties: {
            sessionID: SESSION_ID,
            path: "src/a.ts",
            serverID: "typescript",
          },
        },
      },
      {},
    )

    await hooks.event(
      {
        event: {
          type: "command.executed",
          properties: {
            sessionID: SESSION_ID,
            name: "npm test",
            arguments: "--run",
          },
        },
      },
      {},
    )

    await hooks.event(
      {
        event: {
          type: "session.idle",
          properties: {
            sessionID: SESSION_ID,
          },
        },
      },
      {},
    )

    await pollForAsyncGstvRecords(spoolPath)
    await sleep(100)

    const rawSpoolText = readFileSync(spoolPath, "utf8")
    const records = parseSpoolRawLines(rawSpoolText).map(line => JSON.parse(line) as SpoolRecord)
    selfCheck(rawSpoolText, records)

    await fs.mkdir(dirname(outPath), { recursive: true })
    const tempOut = `${outPath}.tmp-${process.pid}-${Date.now()}`
    await fs.writeFile(tempOut, rawSpoolText)
    await fs.rename(tempOut, outPath)

    const kinds = Array.from(new Set(records.map(record => record.event))).sort((a, b) => a.localeCompare(b))
    console.log(`[gen-spool-v1-fixture] records=${records.length}`)
    console.log(`[gen-spool-v1-fixture] kinds=${kinds.join(",")}`)
    console.log(`[gen-spool-v1-fixture] out=${outPath}`)
  } finally {
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
    rmSync(rootOverride, { recursive: true, force: true })
  }
}

void run().catch(err => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err)
  console.error(`[gen-spool-v1-fixture] ERROR: ${message}`)
  process.exitCode = 1
})
