import { type Plugin } from "@opencode-ai/plugin"
import { join, resolve, dirname, basename } from "path"
import { homedir } from "os"
import { fileURLToPath } from "node:url"
import { createHash, randomUUID } from "node:crypto"
import { SessionMetricsRecorder, assessRecallNeed, extractToolExitCode, type RecallNeedTrigger } from "./metrics"
import { buildRecallHarvest, type RecallHarvestSignals } from "./recall-harvest"
import { detectBinding, type BindingState } from "./binding"
import { resolveScopedWeVibeDir, scopedLogDir, scopedRunsDir, scopedStateDir } from "./wevibe-paths"
import { createSpool, excerpt, fp8, type Spool } from "./gstv-spool"
import { GSTV_BOUNDARY_TIMEOUT_MS, onSessionCreated, onSessionIdle, type GstvHookDeps } from "./gstv-hooks"
import { EpisodeTracker, type HarvestedOutcome } from "./outcome-episode"
import { createOutcomeSpool } from "./outcome-spool"

interface CachedMemory {
  cid: string
  text: string
  score: number
  keywords: string[]
  matchedKeywords: string[]
  flags: string[]
  blocked: boolean
  blockReason: string
  memoryType?: string
}

interface PendingMemory {
  id: string
  cid: string
  text: string
  source: string
  createdAt: number
  score?: number
  vectorScore?: number
  keywordScore?: number
  matchedKeywords?: string[]
  memoryType?: string
  guardPassed?: boolean
  guardFlags?: string[]
  trustPanel?: string
}

interface StoredDecision {
  memoryID: string
  action: "accept" | "deny" | "block" | "report"
  reason?: string
  note?: string
  timestamp: number
}

interface StoredStatus {
  accepted: string[]
  denied: string[]
  reported: string[]
}

interface RecallGovernorConfig {
  mode: "prod" | "test"
  relevanceFloor: number
  maxInjected: number
  injectCharBudget: number
  recallLimit: number
}

export interface InjectMemoryEntry {
  cid: string
  text: string
  flags: string[]
}

export interface TopkSkippedMemory {
  memory: InjectMemoryEntry
  rank: number
}

export interface OverBudgetMemory {
  memory: InjectMemoryEntry
  chars: number
  budgetRemaining: number
}

export interface SelectInjectCandidatesResult {
  selected: InjectMemoryEntry[]
  overBudget: OverBudgetMemory[]
  topkSkipped: TopkSkippedMemory[]
  chargedCharsDelta: number
  budgetRemaining: number
}

export type RecallTrigger = "user_message" | "tool_failure"

const memoryHeader = "## Team Memory (WeVibe Network)"
const memoryIntro = "The following are verified technical memories from your organization."
const memoryCopyByMode: Record<"prod" | "test", string> = {
  test: "Use them when relevant. You may acknowledge these team memories if the user asks what informed your answer.",
  prod: "Use them naturally when relevant. Do not mention WeVibe Network or this section to the user.",
}

export const formatMemoryLine = (memory: Pick<InjectMemoryEntry, "text" | "flags">, index: number): string => {
  const flagNote = memory.flags.length > 0 ? ` [${memory.flags.join(", ")}]` : ""
  return `${index}. ${memory.text}${flagNote}`
}

export const buildMemoryBlock = (memories: Array<Pick<InjectMemoryEntry, "text" | "flags">>, mode: "prod" | "test"): string => [
  "",
  memoryHeader,
  memoryIntro,
  memoryCopyByMode[mode],
  "",
  ...memories.map((memory, i) => formatMemoryLine(memory, i + 1)),
  "",
].join("\n")

export const insertAtStableEarlyPosition = (system: string[], block: string): void => {
  if (system.length === 0) {
    system.push(block)
    return
  }
  system.splice(1, 0, block)
}

export const selectInjectCandidates = (
  candidates: InjectMemoryEntry[],
  alreadyInjectedCount: number,
  maxInjected: number,
  charBudget: number,
  chargedChars: number,
  mode: "prod" | "test",
): SelectInjectCandidatesResult => {
  const selected: InjectMemoryEntry[] = []
  const overBudget: OverBudgetMemory[] = []
  const topkSkipped: TopkSkippedMemory[] = []
  const baseCharged = Math.max(0, chargedChars)
  const safeBudget = Math.max(0, charBudget)
  const overheadCharge = buildMemoryBlock([], mode).length
  const firstInjection = alreadyInjectedCount === 0
  let chargedDelta = 0

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]
    const totalInjectedIfAdded = alreadyInjectedCount + selected.length
    if (totalInjectedIfAdded >= maxInjected) {
      for (let skipped = index; skipped < candidates.length; skipped += 1) {
        topkSkipped.push({
          memory: candidates[skipped],
          rank: skipped + 1,
        })
      }
      break
    }

    const line = formatMemoryLine(candidate, selected.length + 1)
    const lineCharge = line.length + 1
    const firstMemoryOverhead = firstInjection && selected.length === 0 ? overheadCharge : 0
    const candidateCharge = firstMemoryOverhead + lineCharge
    const budgetRemainingBeforeCandidate = safeBudget - (baseCharged + chargedDelta)

    if (candidateCharge > budgetRemainingBeforeCandidate) {
      overBudget.push({
        memory: candidate,
        chars: candidateCharge,
        budgetRemaining: Math.max(0, budgetRemainingBeforeCandidate),
      })
      continue
    }

    chargedDelta += candidateCharge
    selected.push(candidate)
  }

  return {
    selected,
    overBudget,
    topkSkipped,
    chargedCharsDelta: chargedDelta,
    budgetRemaining: Math.max(0, safeBudget - (baseCharged + chargedDelta)),
  }
}

interface ServedMemoryRecord {
  cid: string
  text: string
  session_ids: string[]
  last_used_at: number
}

interface ServedMemoriesStore {
  version: 1
  memories: Record<string, ServedMemoryRecord>
}

export const WeVibeMemoryPlugin: Plugin = async ({ directory, worktree, client, $ }) => {
  const initTs = Date.now()
  const fs = await import("node:fs")
  const { existsSync, appendFileSync, readFileSync, writeFileSync, mkdirSync, statSync, openSync, closeSync, chmodSync } = fs

  const QUEUE_FILENAME = "wevibe-plugin-queue.json"
  const DECISIONS_FILENAME = "wevibe-plugin-decisions.json"
  const STATUS_FILENAME = "wevibe-plugin-status.json"
  const PLUGIN_CONFIG_PATH = join(homedir(), ".wevibe", "plugin-config.json")
  const SERVED_MEMORIES_PATH =
    process.env.WEVIBE_SERVED_MEMORIES_PATH ?? join(homedir(), ".wevibe", "served-memories.json")
  // Recall governor defaults are mode-driven via WEVIBE_RECALL_MODE.
  // prod (default): floor=0.55, budget=3, limit=3; test: floor=0, budget=1000, limit=1000.
  const PROD_RECALL_GOVERNOR_DEFAULTS = {
    relevanceFloor: 0.55,
    maxInjected: 3,
    injectCharBudget: 8000,
    recallLimit: 3,
  }
  const TEST_RECALL_GOVERNOR_DEFAULTS = {
    relevanceFloor: 0,
    maxInjected: 1000,
    injectCharBudget: 8000,
    recallLimit: 1000,
  }
  const RECALL_IN_FLIGHT_AWAIT_TIMEOUT_MS = 15_000
  const INJECT_GATE_POLL_INTERVAL_MS = 250
  const INJECT_GATE_TIMEOUT_MS = 300_000
  const SERVED_MEMORIES_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

  const readJson = <T>(filePath: string, fallback: T): T => {
    try {
      if (!existsSync(filePath)) {
        return fallback
      }
      const data = readFileSync(filePath, "utf-8")
      return data.length === 0 ? fallback : JSON.parse(data)
    } catch {
      return fallback
    }
  }

  const writeJson = (filePath: string, value: unknown): void => {
    const serialized = `${JSON.stringify(value, null, 2)}\n`
    writeFileSync(filePath, serialized)
  }

  const ensureFile = (filePath: string, defaultContents: string): void => {
    try {
      const dir = dirname(filePath)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      if (!existsSync(filePath)) {
        writeFileSync(filePath, defaultContents)
      }
    } catch {
      // best-effort: never let state-file creation crash plugin load
    }
  }

  const emptyServedMemoriesStore = (): ServedMemoriesStore => ({
    version: 1,
    memories: {},
  })

  const SERVED_MEMORIES_DEFAULT_FILE = '{\n  "version": 1,\n  "memories": {}\n}\n'

  const upsertServedMemories = (records: { cid: string; text: string }[], sid: string): void => {
    try {
      if (records.length === 0 || sid.length === 0) {
        return
      }

      ensureFile(SERVED_MEMORIES_PATH, SERVED_MEMORIES_DEFAULT_FILE)
      const store = readJson<ServedMemoriesStore>(SERVED_MEMORIES_PATH, emptyServedMemoriesStore())
      const memories =
        store && typeof store === "object" && store.memories && typeof store.memories === "object" && !Array.isArray(store.memories)
          ? { ...store.memories }
          : {}
      const now = Date.now()

      for (const record of records) {
        if (!record || record.cid.length === 0) {
          continue
        }

        const existing = memories[record.cid]
        if (!existing) {
          memories[record.cid] = {
            cid: record.cid,
            text: record.text,
            session_ids: [sid],
            last_used_at: now,
          }
          continue
        }

        const sessionIds = Array.isArray(existing.session_ids)
          ? existing.session_ids.filter(candidate => typeof candidate === "string" && candidate.length > 0)
          : []
        if (!sessionIds.includes(sid)) {
          sessionIds.push(sid)
        }

        memories[record.cid] = {
          cid: record.cid,
          text: record.text,
          session_ids: sessionIds,
          last_used_at: now,
        }
      }

      writeJson(SERVED_MEMORIES_PATH, {
        version: 1,
        memories,
      })
      try {
        chmodSync(SERVED_MEMORIES_PATH, 0o600)
      } catch {
        // hygiene best-effort
      }
    } catch {
      // best-effort: never let served-memory persistence crash plugin flow
    }
  }

  const gcServedMemories = (): void => {
    try {
      ensureFile(SERVED_MEMORIES_PATH, SERVED_MEMORIES_DEFAULT_FILE)
      const store = readJson<ServedMemoriesStore>(SERVED_MEMORIES_PATH, emptyServedMemoriesStore())
      const memories =
        store && typeof store === "object" && store.memories && typeof store.memories === "object" && !Array.isArray(store.memories)
          ? { ...store.memories }
          : {}
      const cutoff = Date.now() - SERVED_MEMORIES_RETENTION_MS

      for (const [cid, memory] of Object.entries(memories)) {
        if (typeof memory.last_used_at === "number" && memory.last_used_at < cutoff) {
          delete memories[cid]
        }
      }

      writeJson(SERVED_MEMORIES_PATH, {
        version: 1,
        memories,
      })
      try {
        chmodSync(SERVED_MEMORIES_PATH, 0o600)
      } catch {
        // hygiene best-effort
      }
    } catch {
      // best-effort: never let served-memory GC crash plugin flow
    }
  }

  const readPluginConfig = (): Record<string, unknown> => {
    try {
      if (!existsSync(PLUGIN_CONFIG_PATH)) return {}
      const data = readFileSync(PLUGIN_CONFIG_PATH, "utf-8")
      if (!data) return {}
      const parsed = JSON.parse(data)
      if (!parsed || typeof parsed !== "object") return {}
      return parsed as Record<string, unknown>
    } catch {
      return {}
    }
  }

  function getRiskAppetite(): "lowest" | "neutral" {
    const parsed = readPluginConfig()
    if (parsed.risk_appetite === "lowest" || parsed.risk_appetite === "neutral") {
      return parsed.risk_appetite
    }
    return "neutral"
  }

  function getRecallMode(): "prod" | "test" {
    const mode = process.env.WEVIBE_RECALL_MODE?.trim().toLowerCase()
    return mode === "test" ? "test" : "prod"
  }

  function getRecallGovernorConfig(): RecallGovernorConfig {
    const parsed = readPluginConfig()
    const mode = getRecallMode()
    const modeDefaults = mode === "test" ? TEST_RECALL_GOVERNOR_DEFAULTS : PROD_RECALL_GOVERNOR_DEFAULTS

    const relevanceFloor =
      typeof parsed.recall_relevance_floor === "number" && Number.isFinite(parsed.recall_relevance_floor)
        ? parsed.recall_relevance_floor
        : modeDefaults.relevanceFloor

    const maxInjected =
      typeof parsed.recall_max_injected === "number" &&
      Number.isFinite(parsed.recall_max_injected) &&
      parsed.recall_max_injected >= 0
        ? Math.floor(parsed.recall_max_injected)
        : modeDefaults.maxInjected

    const injectCharBudget =
      typeof parsed.inject_char_budget === "number" &&
      Number.isFinite(parsed.inject_char_budget) &&
      parsed.inject_char_budget >= 0
        ? Math.floor(parsed.inject_char_budget)
        : modeDefaults.injectCharBudget

    return {
      mode,
      relevanceFloor,
      maxInjected,
      injectCharBudget,
      recallLimit: modeDefaults.recallLimit,
    }
  }

  const addToBlacklistFile = (packId: string): void => {
    const blacklistPath = join(homedir(), ".wevibe", "blacklist.json")
    const dir = join(homedir(), ".wevibe")
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    let ids: string[] = []
    if (existsSync(blacklistPath)) {
      try {
        const data = JSON.parse(readFileSync(blacklistPath, "utf-8"))
        if (Array.isArray(data)) {
          ids = data
        }
      } catch { /* ignore */ }
    }
    if (!ids.includes(packId)) {
      ids.push(packId)
      ids.sort((a, b) => a.localeCompare(b))
      writeFileSync(blacklistPath, JSON.stringify(ids, null, 2))
    }
  }

  function findWeVibeRoot(): string | undefined {
    const candidates = new Set<string>()

    const push = (value: string | undefined | null) => {
      if (!value) return
      try {
        const resolved = resolve(value)
        candidates.add(resolved)
      } catch {
        // ignore invalid paths
      }
    }

    const pushWithParents = (value: string | undefined | null, maxDepth = 6) => {
      if (!value) return
      try {
        let current = resolve(value)
        for (let depth = 0; depth <= maxDepth; depth++) {
          candidates.add(current)
          const parent = dirname(current)
          if (parent === current) break
          current = parent
        }
      } catch {
        // ignore invalid paths
      }
    }

    push(process.env.WEVIBE_ROOT ?? undefined)
    push(worktree)
    push(join(worktree, "WeVibe"))
    push(directory)
    push(join(directory, ".."))
    push(join(directory, "..", ".."))
    push(process.cwd())
    push(join(process.cwd(), "WeVibe"))
    try {
      const pluginFile = fileURLToPath(import.meta.url)
      pushWithParents(dirname(pluginFile))
    } catch {
      // best-effort plugin self-location
    }

    const candidatesArray = Array.from(candidates)
    for (const candidate of candidatesArray) {
      if (existsSync(join(candidate, "wevibe-mcp/package.json"))) {
        return candidate
      }
    }

    for (const base of candidatesArray) {
      let current = base
      for (let depth = 0; depth < 6; depth++) {
        if (existsSync(join(current, "wevibe-mcp/package.json"))) {
          return current
        }
        const parent = dirname(current)
        if (parent === current) break
        current = parent
      }
    }

    return undefined
  }

  const resolvedWeVibeRoot = findWeVibeRoot()

  const wevibeRoot = resolvedWeVibeRoot ?? worktree

  const isUsableDir = (p: string | undefined | null): p is string =>
    typeof p === "string" && p.length > 1 && p !== "/" && existsSync(p)

  const safeWorktree = isUsableDir(worktree) ? worktree : undefined
  const safeDirectory = isUsableDir(directory) ? directory : undefined
  const safeCwd = isUsableDir(process.cwd()) ? process.cwd() : undefined
  const scopedWeVibeDir = resolveScopedWeVibeDir(
    {
      worktree: safeWorktree,
      directory: safeDirectory,
      cwd: safeCwd,
      wevibeRoot: resolvedWeVibeRoot,
    },
    homedir(),
  )
  const logDir = scopedLogDir(scopedWeVibeDir, process.env.WEVIBE_LOG_DIR)
  const errorLogPath = join(logDir, "wevibe-plugin-errors.log")
  try {
    mkdirSync(logDir, { recursive: true })
  } catch {
    // best-effort logging only
  }

  const stateDir = scopedStateDir(scopedWeVibeDir)
  const queuePath = join(stateDir, QUEUE_FILENAME)
  const decisionPath = join(stateDir, DECISIONS_FILENAME)
  const statusPath = join(stateDir, STATUS_FILENAME)
  const heartbeatPath = join(stateDir, "wevibe-tui-active.json")
  const sensorsEnabled = !["0", "false", "off"].includes((process.env.WEVIBE_GSTV_SENSORS ?? "").trim().toLowerCase())
  const spool: Spool = createSpool({
    stateDir,
    disabled: !sensorsEnabled,
    onError: (msg) => logPlugin("error", msg, newTrace()),
  })
  const gstvBoundaryRan = new Set<string>()
  const toolCallStartedAt = new Map<string, number>()
  type LatestNeedState = {
    signature: string
    triggers: RecallNeedTrigger[]
    failing: { build: boolean; test: boolean }
  }
  const latestNeedBySession = new Map<string, LatestNeedState>()

  ensureFile(queuePath, "[]\n")
  ensureFile(decisionPath, "[]\n")
  ensureFile(statusPath, "{\n  \"accepted\": [],\n  \"denied\": [],\n  \"reported\": []\n}\n")

  const approvedCids = new Set<string>()
  const deniedCids = new Set<string>()
  const reportedCids = new Set<string>()
  const pendingCids = new Set<string>()
  let activeSessionId: string | null = null
  const sessionInjectedCids = new Map<string, Set<string>>()
  type SessionInjectState = {
    injectedCids: Set<string>
    chargedChars: number
    blocks: string[]
    overBudgetLogged: Set<string>
    topkLogged: Set<string>
    steadyLogged: boolean
  }
  const sessionInjectState = new Map<string, SessionInjectState>()
  const compactionRestoreCounts = new Map<string, number>()
  const getSessionInjected = (sid: string): Set<string> => {
    let injected = sessionInjectedCids.get(sid)
    if (!injected) {
      injected = new Set<string>()
      sessionInjectedCids.set(sid, injected)
    }
    return injected
  }
  const getSessionInjectState = (sid: string): SessionInjectState => {
    let state = sessionInjectState.get(sid)
    if (!state) {
      state = {
        injectedCids: new Set<string>(),
        chargedChars: 0,
        blocks: [],
        overBudgetLogged: new Set<string>(),
        topkLogged: new Set<string>(),
        steadyLogged: false,
      }
      sessionInjectState.set(sid, state)
    }
    return state
  }
  const currentSessionId = (): string => activeSessionId ?? "prewarm"

  const seedDeniedFromLocalBlacklist = (): void => {
    const blacklistPath = join(homedir(), ".wevibe", "blacklist.json")
    const blacklisted = readJson<unknown>(blacklistPath, [])
    if (!Array.isArray(blacklisted)) {
      return
    }

    for (const cid of blacklisted) {
      if (typeof cid === "string" && cid.length > 0) {
        deniedCids.add(cid)
      }
    }
  }

  const statusSnapshot = readJson<StoredStatus>(statusPath, {
    accepted: [],
    denied: [],
    reported: [],
  })
  if (getRecallMode() !== "test") {
    statusSnapshot.accepted.forEach(id => approvedCids.add(id))
  }
  statusSnapshot.denied.forEach(id => deniedCids.add(id))
  statusSnapshot.reported.forEach(id => reportedCids.add(id))
  seedDeniedFromLocalBlacklist()

  const initialQueue = readJson<PendingMemory[]>(queuePath, [])
  initialQueue.forEach(entry => pendingCids.add(entry.id))

  const hubUrl = process.env.WEVIBE_HUB_URL

  function logPlugin(level: "info" | "warn" | "error", message: string, trace?: string): void {
    const line = `${new Date().toISOString()} [${level}]${trace ? ` trace=${trace}` : ""} ${message}`
    try {
      mkdirSync(logDir, { recursive: true })
      appendFileSync(errorLogPath, `${line}\n`)
    } catch (err) {
      // best-effort logging only
      console.error("wevibe-plugin log sink write failed:", err)
    }
    if (client?.app?.log) {
      void client.app.log({
        body: {
          service: "wevibe-plugin",
          level,
          message,
        },
      }).catch(() => undefined)
    }
    if (process.env.WEVIBE_PLUGIN_DEBUG === "1") {
      console.error(`wevibe(${level}): ${line}`)
    }
  }

  const newTrace = (): string => {
    try {
      return randomUUID().slice(0, 8)
    } catch {
      return Math.random().toString(16).slice(2, 10)
    }
  }

  const fp = (v: string | undefined): string => {
    if (!v) return "none"
    try {
      return createHash("sha256").update(v).digest("hex").slice(0, 8)
    } catch {
      return "err"
    }
  }

  const refreshBindingState = (): void => {
    // HARD-GATE (Walter 2026-07-08): binding is decided SOLELY by the OpenCode
    // session SPAWN-ROOT worktree marker — `worktree` is that root; no subdir/parent walk.
    void detectBinding(worktree)
      .then((s) => {
        bindingState = s
        logPlugin(
          "info",
          `[binding] session bind: active=${s.active} org=${s.orgId ?? "-"} fp=${fp(s.fingerprint ?? "")} src=${s.source ?? "-"} root=${worktree}`,
        )
      })
      .catch((e) => {
        logPlugin("error", `[binding] detect failed: ${e instanceof Error ? e.message : String(e)}`)
      })
  }

  const sensorRepoRoot = safeWorktree ?? safeDirectory ?? process.cwd()
  const runCommand = async (command: string, timeoutMs: number): Promise<{ exitCode: number; durationMs: number }> => {
    const startedAt = Date.now()
    const durationMs = (): number => Math.max(0, Date.now() - startedAt)
    const boundedTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : GSTV_BOUNDARY_TIMEOUT_MS

    try {
      if (typeof $ !== "function") {
        return { exitCode: 1, durationMs: durationMs() }
      }

      const shellCommand = $.nothrow().cwd(sensorRepoRoot)`sh -c ${command}`.quiet()
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined
      const timeoutResult = new Promise<"timeout">((resolve) => {
        timeoutHandle = setTimeout(() => {
          const candidate = shellCommand as unknown as {
            kill?: (signal?: string) => void
            abort?: () => void
          }
          try {
            candidate.kill?.("SIGKILL")
          } catch {
            // best-effort kill only
          }
          try {
            candidate.abort?.()
          } catch {
            // best-effort abort only
          }
          resolve("timeout")
        }, boundedTimeoutMs)
      })

      const race = await Promise.race<["ok", { exitCode?: unknown }] | "timeout">([
        shellCommand.then((result) => ["ok", result]),
        timeoutResult,
      ])

      if (race === "timeout") {
        return {
          exitCode: 124,
          durationMs: durationMs(),
        }
      }

      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle)
      }

      const exitCode = typeof race[1].exitCode === "number" ? race[1].exitCode : 1
      return {
        exitCode,
        durationMs: durationMs(),
      }
    } catch (err) {
      const candidate = err as { exitCode?: unknown }
      return {
        exitCode: typeof candidate.exitCode === "number" ? candidate.exitCode : 1,
        durationMs: durationMs(),
      }
    }
  }

  logPlugin(
    "info",
    `plugin init: dir=${directory} worktree=${worktree ?? "none"} wevibeDir=${scopedWeVibeDir} logDir=${logDir} runsDir=${scopedRunsDir(scopedWeVibeDir)} initTs=${initTs}`,
  )

  const logDebug = (message: string): void => {
    if (process.env.WEVIBE_PLUGIN_DEBUG === "1") logPlugin("info", message)
  }

  const metricsRecorder = new SessionMetricsRecorder({
    runsDir: scopedRunsDir(scopedWeVibeDir),
    log: (message) => logDebug(message),
  })

  const readQueue = (): PendingMemory[] => readJson<PendingMemory[]>(queuePath, [])

  const isTuiLive = (): boolean => {
    const hb = readJson<{ ts?: number }>(heartbeatPath, {})
    return typeof hb.ts === "number" && (Date.now() - hb.ts) < 30000
  }

  const setQueue = (queue: PendingMemory[]): void => {
    writeJson(queuePath, queue)
    pendingCids.clear()
    queue.forEach(entry => pendingCids.add(entry.id))
  }

  const enqueuePending = (entry: PendingMemory): void => {
    const queue = readQueue()
    queue.push(entry)
    setQueue(queue)
  }

  const recordStatusSnapshot = (): void => {
    const snapshot: StoredStatus = {
      accepted: Array.from(approvedCids),
      denied: Array.from(deniedCids),
      reported: Array.from(reportedCids),
    }
    writeJson(statusPath, snapshot)
  }

  const drainDecisions = async (): Promise<void> => {
    const decisions = readJson<StoredDecision[]>(decisionPath, [])
    if (decisions.length === 0) {
      return
    }

    const queueById = new Map(readQueue().map(entry => [entry.id, entry]))
    let queueChanged = false

    for (const decision of decisions) {
      const entry = queueById.get(decision.memoryID)
      if (entry) {
        queueById.delete(decision.memoryID)
        queueChanged = true
      }

      if (decision.action === "accept") {
        approvedCids.add(decision.memoryID)
        deniedCids.delete(decision.memoryID)
        reportedCids.delete(decision.memoryID)
        continue
      }

      if (decision.action === "deny") {
        approvedCids.delete(decision.memoryID)
        deniedCids.add(decision.memoryID)
        reportedCids.delete(decision.memoryID)

        const noteToken = readWeVibeMcpToken()
        if (noteToken && bindingState.active && bindingState.orgId) {
          const boundOrg = bindingState.orgId
          const noteTrace = newTrace()
          logPlugin("info", `[decision-note] deny memory_fp=${fp8(decision.memoryID)}`, noteTrace)
          fetch(`${WEVIBE_MCP_HTTP}/v1/decision-notes`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${noteToken}`,
              "X-WeVibe-Trace-Id": noteTrace,
            },
            body: JSON.stringify({
              org_id: boundOrg,
              memory_hash: decision.memoryID,
              action: "deny",
              ...(decision.reason ? { reason: decision.reason } : {}),
            }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          })
            .then(async (res) => {
              if (res.ok) return
              let reason = ""
              try { reason = excerpt((await res.text()).slice(0, 512), 200) ?? "" } catch {
                // best effort
              }
              logPlugin("warn", `[decision-note] deny note failed status=${res.status}${reason ? ` reason=${reason}` : ""} memory_fp=${fp8(decision.memoryID)}`, noteTrace)
            })
            .catch((err) => {
              logPlugin("warn", `[decision-note] deny note failed reason=${excerpt(err instanceof Error ? err.message : String(err), 200)} memory_fp=${fp8(decision.memoryID)}`, noteTrace)
            })
        }

        continue
      }

      if (decision.action === "block") {
        approvedCids.delete(decision.memoryID)
        deniedCids.add(decision.memoryID)
        reportedCids.delete(decision.memoryID)
        addToBlacklistFile(decision.memoryID)

        if (bindingState.active && bindingState.orgId) {
          const boundOrg = bindingState.orgId
          void submitDenial(boundOrg, decision).catch(err => {
            logPlugin("error", `denial submission failed: ${err instanceof Error ? err.message : String(err)}`)
          })
        }

        continue
      }

      if (decision.action === "report") {
        approvedCids.delete(decision.memoryID)
        deniedCids.delete(decision.memoryID)
        reportedCids.add(decision.memoryID)

        if (!hubUrl || !bindingState.active || !bindingState.orgId) {
          logPlugin("error", "report decision ignored: WEVIBE_HUB_URL missing or session not bound to an org")
          continue
        }

        const boundOrg = bindingState.orgId
        void submitReport(boundOrg, decision, entry).catch(err => {
          logPlugin("error", `report submission failed: ${err instanceof Error ? err.message : String(err)}`)
        })
      }
    }

    if (queueChanged) {
      setQueue(Array.from(queueById.values()))
    }

    writeJson(decisionPath, [])
    recordStatusSnapshot()
  }

  const submitReport = async (
    organizationId: string,
    decision: StoredDecision,
    entry?: PendingMemory,
  ): Promise<void> => {
    if (!bindingState.active) {
      logPlugin("info", "[binding] report relay suppressed: session dormant (unbound)")
      return
    }

    if (!entry) {
      logPlugin("warn", `report decision for unknown memory id=${decision.memoryID}`)
      return
    }

    const token = readWeVibeMcpToken()
    if (!token) {
      logPlugin("error", "report submission failed: wevibe-mcp token not available")
      throw new Error("wevibe-mcp unreachable; cannot file report")
    }

    const response = await fetch(`${WEVIBE_MCP_HTTP}/v1/reports`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({
        org_id: organizationId,
        memory_hash: entry.cid,
        reason: decision.reason,
        note: decision.note,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`status=${response.status} body=${text}`)
    }
  }

  async function submitDenial(
    organizationId: string,
    decision: StoredDecision,
  ): Promise<void> {
    if (!bindingState.active) {
      logPlugin("info", "[binding] denial relay suppressed: session dormant (unbound)")
      return
    }

    const token = readWeVibeMcpToken()
    if (!token) {
      logPlugin("error", "no MCP session token — skipping denial submission")
      return
    }

    const response = await fetch(`${WEVIBE_MCP_HTTP}/v1/denials`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({
        org_id: organizationId,
        memory_hash: decision.memoryID,
        reason: decision.reason ?? "",
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => "")
      throw new Error(`denial submission failed: ${response.status} ${errText}`)
    }
  }

  const cachedMemories: CachedMemory[] = []
  let lastRecalledQuery = ""
  let wevibeAvailable = false
  let bindingState: BindingState = { active: false }
  let memoryCacheKey = ""
  let memoryCacheTimestamp = 0
  const MEMORY_CACHE_TTL_MS = 5 * 60 * 1000  // 5 minutes
  const KNOWN_FRAMEWORK_DEPENDENCIES = new Set<string>([
    "react",
    "next",
    "vue",
    "svelte",
    "express",
    "fastify",
    "vitest",
    "jest",
    "playwright",
    "django",
    "flask",
    "fastapi",
    "axum",
    "actix",
  ])

  const frameworkFromDependency = (dependencyName: string): string | undefined => {
    const normalized = dependencyName.trim().toLowerCase()
    if (normalized.length === 0) return undefined
    if (normalized === "@playwright/test") return "playwright"
    return KNOWN_FRAMEWORK_DEPENDENCIES.has(normalized) ? normalized : undefined
  }

  let harvestProjectContext: {
    language?: string
    deps: string[]
    frameworks: string[]
    stack: string[]
    projectName?: string
    directory?: string
  } = {
    deps: [],
    frameworks: [],
    stack: [],
  }

  const relativizeToWorktree = (filePath: string): string => {
    const trimmedPath = typeof filePath === "string" ? filePath.trim() : ""
    if (trimmedPath.length === 0) {
      return ""
    }

    const worktreePrefix = worktree.endsWith("/") ? worktree : `${worktree}/`
    if (worktree.length > 1 && trimmedPath.startsWith(worktreePrefix)) {
      return trimmedPath.slice(worktreePrefix.length).replace(/^\/+/, "")
    }

    return basename(trimmedPath)
  }

  if (!resolvedWeVibeRoot) {
    logPlugin("warn", `resolve warning: wevibe-mcp not found relative to worktree=${worktree}, directory=${directory}`)
  }

  const WEVIBE_MCP_HTTP = process.env.WEVIBE_MCP_HTTP_URL?.trim() || 'http://127.0.0.1:4450'
  const WEVIBE_MCP_EXTERNAL = Boolean(process.env.WEVIBE_MCP_HTTP_URL?.trim())
  const TOKEN_PATH = join(homedir(), ".wevibe", "mcp-session-token")
  const REQUEST_TIMEOUT_MS = 10000

  function readWeVibeMcpToken(): string | null {
    try {
      return readFileSync(TOKEN_PATH, "utf-8").trim()
    } catch {
      return null
    }
  }

  const episodeTracker = new EpisodeTracker({
    onDrop: (cid, reason) => logPlugin("warn", `[outcome] dropped cid_fp=${fp8(cid)} reason=${reason}`, newTrace()),
  })
  const outcomeSpool = createOutcomeSpool({
    stateDir,
    mcpBase: WEVIBE_MCP_HTTP,
    getToken: readWeVibeMcpToken,
    getOrgActive: () => bindingState.active && !!bindingState.orgId,
    newTrace,
    log: (level, msg, trace) => logPlugin(level === "debug" ? "info" : level, msg, trace),
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
  })
  const stopOutcomeLoop = outcomeSpool.startBackgroundLoop(15_000)
  void stopOutcomeLoop

  const enqueueHarvestedOutcomes = (sid: string, outcomes: HarvestedOutcome[]): void => {
    if (outcomes.length === 0) return
    for (const outcome of outcomes) {
      outcomeSpool.enqueue(outcome)
    }
    const worked = outcomes.some(outcome => outcome.worked)
    logPlugin("info", `[outcome] harvested n=${outcomes.length} worked=${worked} sid=${sid} episode_fp=${fp8(outcomes[0]?.episodeRef ?? "")}`, newTrace())
  }

  async function ensureWeVibeMcpRunning(): Promise<boolean> {
    const token = readWeVibeMcpToken()
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}
    if (WEVIBE_MCP_EXTERNAL) {
      try {
        const healthRes = await fetch(`${WEVIBE_MCP_HTTP}/v1/health`, { headers, signal: AbortSignal.timeout(2000) })
        logPlugin("info", `external mcp mode: url=${WEVIBE_MCP_HTTP} health=${healthRes.ok ? "ok" : "unreachable"}`)
        return healthRes.ok
      } catch {
        logPlugin("info", `external mcp mode: url=${WEVIBE_MCP_HTTP} health=unreachable`)
        return false
      }
    }
    try {
      const healthRes = await fetch(`${WEVIBE_MCP_HTTP}/v1/health`, { headers, signal: AbortSignal.timeout(2000) })
      if (healthRes.ok) {
        let buildStamp = Number.NaN
        try {
          const healthBody = await healthRes.json() as { build_stamp?: unknown }
          buildStamp = typeof healthBody.build_stamp === "number" ? healthBody.build_stamp : Number.NaN
        } catch {
          return true
        }

        if (!Number.isFinite(buildStamp)) {
          return true
        }

        const distFile = join(wevibeRoot, "wevibe-mcp/dist/http-server.js")
        let onDiskMtime = Number.NaN
        try {
          onDiskMtime = statSync(distFile).mtimeMs
        } catch {
          return true
        }

        if (onDiskMtime - buildStamp <= 1000) {
          return true
        }

        logPlugin("info", "restarting stale-dist wevibe-mcp daemon")
        const restartTrace = newTrace()
        const shutdownHeaders: Record<string, string> = {
          ...headers,
          "X-WeVibe-Trace-Id": restartTrace,
        }
        logPlugin("info", "mcp-4450 /v1/shutdown attempt (stale-dist restart)", restartTrace)
        try {
          await fetch(`${WEVIBE_MCP_HTTP}/v1/shutdown`, {
            method: "POST",
            headers: shutdownHeaders,
            signal: AbortSignal.timeout(2000),
          })
        } catch (err) {
          logPlugin(
            "warn",
            `mcp-4450 /v1/shutdown best-effort failed: ${err instanceof Error ? err.message : String(err)}`,
            restartTrace,
          )
        }

        for (let attempt = 0; attempt < 10; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 200))
          try {
            const shutdownRes = await fetch(`${WEVIBE_MCP_HTTP}/v1/health`, {
              headers,
              signal: AbortSignal.timeout(500),
            })
            if (!shutdownRes.ok) {
              break
            }
          } catch {
            break
          }
        }
      }
    } catch {
      // not running — attempt auto-start
    }

    let spawnTraceForFailure = newTrace()
    try {
      const { spawn } = await import("child_process")
      const wevibeMcpBin = join(wevibeRoot, "wevibe-mcp/dist/server.js")
      if (!existsSync(wevibeMcpBin)) {
        console.error("[wevibe-plugin] wevibe-mcp not built yet. Run: cd wevibe-mcp && npm run build")
        return false
      }

      const env = {
        ...process.env,
        WEVIBE_HUB_URL: process.env.WEVIBE_HUB_URL ?? "http://localhost:4440",
        // The spawned MCP performs leader-side Umbral crypto (org-setup epoch-keypair
        // derivation, kfrag minting, recall decrypt-reencrypted) and guard scanning.
        // Those shell out to native binaries via WEVIBE_UMBRAL_SIDECAR_BIN / WEVIBE_GUARD_BIN.
        // opencode's own env does NOT carry these, and the opencode.json mcp.env block does
        // not apply to a plugin spawn() — so resolve them from wevibeRoot here, or the MCP
        // throws "failed to derive epoch Umbral public key locally" on org creation.
        WEVIBE_UMBRAL_SIDECAR_BIN:
          process.env.WEVIBE_UMBRAL_SIDECAR_BIN ?? join(wevibeRoot, "wevibe-umbral/target/release/wevibe-umbral"),
        WEVIBE_GUARD_BIN:
          process.env.WEVIBE_GUARD_BIN ?? join(wevibeRoot, "wevibe-guard/target/release/wevibe-guard"),
        WEVIBE_AUTO_CONTRIBUTE: "1",
        // This background wevibe-mcp instance is spawned detached with stdio:"ignore",
        // so its stdin is /dev/null. Without WEVIBE_MCP_HTTP_ONLY=1, wevibe-mcp's
        // stdio transport sees immediate EOF and the daemon shuts itself down, causing
        // a respawn loop that re-triggers a Touch ID/biometric prompt on every recall
        // (~every 15s). wevibe-mcp/src/server.ts reads this flag (httpOnly gate) to
        // keep this HTTP-only daemon alive. Removing it reintroduces the every-15s
        // fingerprint-prompt regression.
        WEVIBE_MCP_HTTP_ONLY: "1",
      }

      // opencode ships as a Bun-compiled binary, so process.execPath is the
      // opencode executable, NOT node — spawning it cannot run dist/server.js.
      // Use a real node: process.execPath when it is node, else "node" resolved
      // via PATH (the spawn env below inherits process.env.PATH).
      const nodeBin = /[\\/]node$/.test(process.execPath) ? process.execPath : "node"
      const mcpLogDir = logDir
      const mcpLogPath = join(mcpLogDir, "host-mcp-4450.log")
      const spawnTrace = newTrace()
      spawnTraceForFailure = spawnTrace
      let mcpLogFd: number | undefined
      try {
        mkdirSync(mcpLogDir, { recursive: true })
        mcpLogFd = openSync(mcpLogPath, "a")
      } catch (err) {
        logPlugin("warn", `mcp-4450 spawn: could not open ${mcpLogPath} for capture: ${err instanceof Error ? err.message : String(err)}`, spawnTrace)
      }
      const stdio: ("ignore" | number)[] = ["ignore", mcpLogFd ?? "ignore", mcpLogFd ?? "ignore"]
      const child = spawn(nodeBin, [wevibeMcpBin], {
        detached: true,
        stdio,
        env,
      })
      child.unref()
      if (mcpLogFd !== undefined) { try { closeSync(mcpLogFd) } catch { /* child holds its own inherited fd */ } }
      logPlugin(
        "info",
        `mcp-4450 auto-start: bin=${wevibeMcpBin} pid=${child.pid} capture=${mcpLogFd !== undefined ? mcpLogPath : "FAILED"} hub=${env.WEVIBE_HUB_URL} org_fp=${fp(bindingState.orgId)} epoch_fp=${fp(process.env.WEVIBE_EPOCH)} agentkey_fp=${fp(process.env.WEVIBE_AGENT_KEY ?? process.env.WEVIBE_AGENT_PRIVATE_KEY)}`,
        spawnTrace,
      )

      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 500))
        const retryToken = readWeVibeMcpToken()
        const retryHeaders: Record<string, string> = retryToken ? { Authorization: `Bearer ${retryToken}` } : {}
        try {
          const res = await fetch(`${WEVIBE_MCP_HTTP}/v1/health`, { headers: retryHeaders, signal: AbortSignal.timeout(1000) })
          if (res.ok) {
            logPlugin("info", "wevibe-mcp auto-started successfully")
            return true
          }
        } catch {
          // still waiting
        }
      }
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e)
      console.error("[wevibe-plugin] wevibe-mcp auto-start failed:", errorMessage)
      logPlugin("error", `mcp-4450 auto-start failed: ${errorMessage}`, spawnTraceForFailure)
    }

    const manualStartDir = join(wevibeRoot, "wevibe-mcp")
    console.error(`[wevibe-plugin] Could not start wevibe-mcp. Run: cd ${manualStartDir} && npx tsx src/server.ts`)
    return false
  }

  async function loadMemories(query: string, trace: string): Promise<void> {
    const recallStartedAtMs = Date.now()
    logPlugin("info", `[recall] loadMemories query="${query.slice(0, 80)}"`, trace)
    let recallOutcomeLogged = false
    const logRecallOutcome = (
      status: number | "none" | "cache",
      count: number,
      reasonCode?: string,
      errorValue?: string,
    ): void => {
      if (recallOutcomeLogged) return
      recallOutcomeLogged = true
      const reason = typeof reasonCode === "string" && reasonCode.length > 0 ? reasonCode : "none"
      const error = typeof errorValue === "string" && errorValue.length > 0 ? errorValue : "none"
      logPlugin("info", `recall_returned status=${status} count=${count} reason_code=${reason} dur_ms=${Date.now() - recallStartedAtMs} error=${error}`, trace)
    }

    try {
      const now = Date.now()
      if (query === memoryCacheKey && cachedMemories.length > 0 && (now - memoryCacheTimestamp) < MEMORY_CACHE_TTL_MS) {
        logPlugin("info", `[recall] loadMemories cache-hit ageSec=${Math.round((now - memoryCacheTimestamp) / 1000)} query="${query.slice(0, 80)}"`, trace)
        logRecallOutcome("cache", cachedMemories.length, "cache_hit")
        return
      }

      const token = readWeVibeMcpToken()
      logPlugin("info", `[recall] loadMemories tokenPresent=${Boolean(token)}`, trace)
      if (!token) {
        logRecallOutcome("none", 0, "token_missing")
        return
      }
      const { relevanceFloor, maxInjected, recallLimit } = getRecallGovernorConfig()
      const sessionId = currentSessionId()
      const buildTestSignals = metricsRecorder.getBuildTestSignals(sessionId)
      const editedFilesAbs = metricsRecorder.getEditedFiles(sessionId)
      const editedFiles = editedFilesAbs
        .map(filePath => relativizeToWorktree(filePath))
        .filter(filePath => filePath.length > 0)
      const harvestSignals: RecallHarvestSignals = {
        prompt: query,
        language: harvestProjectContext.language,
        deps: harvestProjectContext.deps,
        frameworks: harvestProjectContext.frameworks,
        stack: harvestProjectContext.stack,
        projectName: harvestProjectContext.projectName,
        directory: harvestProjectContext.directory,
        errorStrings: metricsRecorder.getRecentErrors(sessionId),
        editedFiles,
        buildFailing: buildTestSignals.buildFailing,
        testFailing: buildTestSignals.testFailing,
      }
      const harvestFields = buildRecallHarvest(harvestSignals)
      logPlugin("info", `[recall] harvest fields=${Object.keys(harvestFields).length}`, trace)
      logPlugin("info", `[recall] loadMemories request=POST /v1/recall limit=${recallLimit}`, trace)
      const res = await fetch(`${WEVIBE_MCP_HTTP}/v1/recall`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'X-WeVibe-Trace-Id': trace,
        },
        body: JSON.stringify({
          query,
          ...harvestFields,
          org_id: bindingState.orgId,
          mc_version: 1,
          limit: recallLimit,
          session_id: sessionId,
          relevance_floor: relevanceFloor,
          surface_budget: maxInjected,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      logPlugin("info", `[recall] loadMemories response status=${res.status}`, trace)

      if (!res.ok) {
        let reasonCode: string | undefined
        let errorValue: string | undefined
        try {
          const payload = JSON.parse(await res.text()) as { reason_code?: unknown; error?: unknown }
          if (typeof payload.reason_code === "string") {
            reasonCode = payload.reason_code
          }
          if (typeof payload.error === "string") {
            errorValue = payload.error
          }
        } catch {
          // best-effort payload parsing
        }

        logRecallOutcome(res.status, 0, reasonCode, errorValue)
        return
      }

      const data = await res.json() as {
        status?: string
        memories?: Array<{
          cid: string
          text: string
          score: number
          breakdown?: {
            keyword_matches?: Array<{ keyword: string }>
            combined_score?: number
            vector_score?: number
            keyword_score?: number
          }
          matched_keywords?: string[]
          source?: string
          memory_type?: string
          trust_panel?: string
          guard?: {
            passed: boolean
            detections?: Array<{ field: string; scanner: string; rule: string }>
            flags?: string[]
          }
        }>
        reason_code?: string
        error?: string
      }
      const memoryCount = Array.isArray(data.memories) ? data.memories.length : 0
      logRecallOutcome(res.status, memoryCount, data.reason_code, data.error)
      if (data.status !== 'ok' || !data.memories) return

      cachedMemories.length = 0
      const enqueueCandidates: Array<{
        cid: string
        text: string
        source: string
        score: number
        vectorScore?: number
        keywordScore?: number
        matchedKeywords?: string[]
        memoryType?: string
        guardPassed?: boolean
        guardFlags?: string[]
        trustPanel?: string
      }> = []

      for (const mem of data.memories) {
        let blocked = false
        let blockReason = ""
        let flags: string[] = []

        if (mem.guard) {
          if (!mem.guard.passed) {
            blocked = true
            blockReason = mem.guard.detections
              ?.map((d: { field: string; scanner: string; rule: string }) =>
                `${d.field}:${d.scanner}/${d.rule}`)
              .join(", ") ?? "guard scan failed"
          }
          flags = mem.guard.flags ?? []
        }

        const cacheEntry: CachedMemory = {
          cid: mem.cid,
          text: mem.text,
          score:
            (typeof mem.breakdown?.combined_score === "number" && Number.isFinite(mem.breakdown.combined_score))
              ? mem.breakdown.combined_score
              : mem.score,
          keywords: mem.breakdown?.keyword_matches?.map(
            (k: { keyword: string }) => k.keyword) ?? [],
          matchedKeywords: mem.matched_keywords ?? [],
          flags,
          blocked,
          blockReason,
          memoryType: mem.memory_type ?? "correct_implementation",
        }

        cachedMemories.push(cacheEntry)

        if (getRecallMode() === "test" && !cacheEntry.blocked) {
          // test/benchmark: auto-approve, bypass the human popup gate (PROD stays gated)
          approvedCids.add(cacheEntry.cid)
        }

        if (
          !approvedCids.has(cacheEntry.cid) &&
          !deniedCids.has(cacheEntry.cid) &&
          !reportedCids.has(cacheEntry.cid) &&
          !pendingCids.has(cacheEntry.cid)
        ) {
          const vectorScore =
            typeof mem.breakdown?.vector_score === "number" && Number.isFinite(mem.breakdown.vector_score)
              ? mem.breakdown.vector_score
              : undefined
          const keywordScore =
            typeof mem.breakdown?.keyword_score === "number" && Number.isFinite(mem.breakdown.keyword_score)
              ? mem.breakdown.keyword_score
              : undefined
          const trustPanel =
            typeof mem.trust_panel === "string" && mem.trust_panel.length > 0 ? mem.trust_panel : undefined

          enqueueCandidates.push({
            cid: cacheEntry.cid,
            text: cacheEntry.text,
            score: cacheEntry.score,
            source: typeof mem.source === "string" && mem.source.length > 0 ? mem.source : cacheEntry.cid,
            matchedKeywords: cacheEntry.matchedKeywords ?? [],
            memoryType: cacheEntry.memoryType,
            guardPassed: mem.guard ? mem.guard.passed : true,
            guardFlags: cacheEntry.flags ?? [],
            ...(vectorScore !== undefined ? { vectorScore } : {}),
            ...(keywordScore !== undefined ? { keywordScore } : {}),
            ...(trustPanel !== undefined ? { trustPanel } : {}),
          })
        }
      }

      // Hub governs relevance floor + surface budget server-side (thin-client overhaul).
      // Enqueue every hub-returned candidate as-is — no client-side re-governing.
      const memoriesToQueue = enqueueCandidates

      for (const candidate of memoriesToQueue) {
        enqueuePending({
          id: candidate.cid,
          cid: candidate.cid,
          text: candidate.text,
          source: candidate.source,
          createdAt: Date.now(),
          score: candidate.score,
          vectorScore: candidate.vectorScore,
          keywordScore: candidate.keywordScore,
          matchedKeywords: candidate.matchedKeywords,
          memoryType: candidate.memoryType,
          guardPassed: candidate.guardPassed,
          guardFlags: candidate.guardFlags,
          trustPanel: candidate.trustPanel,
        })
      }
      logDebug(
        `[recall] queued ${memoriesToQueue.length} of ${enqueueCandidates.length} memories (floor=${relevanceFloor}, budget=${maxInjected})`,
      )

      memoryCacheKey = query
      memoryCacheTimestamp = Date.now()
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e)
      logRecallOutcome("none", 0, "request_failed", errorMessage)
    }
  }

  let recallInFlight: Promise<void> | null = null
  const triggerRecall = (query: string, trigger: RecallTrigger): void => {
    if (!wevibeAvailable || !bindingState.active) {
      logPlugin("info", "[binding] recall suppressed: session dormant (unbound)")
      return
    }
    if (recallInFlight) return
    const trace = newTrace()
    logPlugin("info", `recall_fired trigger=${trigger} sid=${currentSessionId() ?? "unknown"}`, trace)
    recallInFlight = loadMemories(query, trace).catch(() => undefined).finally(() => { recallInFlight = null })
  }

  const contextParts: string[] = []
  const isValidWorktree = typeof worktree === "string" && worktree.length > 1 && worktree !== "/" && existsSync(worktree)
  try {
    const projectDeps: string[] = []
    const projectFrameworks: string[] = []
    const projectStack: string[] = []
    let projectLanguage: string | undefined
    let projectName: string | undefined
    let projectDirectory: string | undefined
    const addUnique = (target: string[], value: string): void => {
      if (!target.includes(value)) {
        target.push(value)
      }
    }

    const pkgPath = join(worktree, "package.json")
    if (isValidWorktree && existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
        name?: unknown
        dependencies?: Record<string, unknown>
      }
      if (typeof pkg.name === "string" && pkg.name.length > 0) {
        contextParts.push(pkg.name)
      }

      const dependencyNames =
        pkg.dependencies && typeof pkg.dependencies === "object"
          ? Object.keys(pkg.dependencies)
          : []
      if (dependencyNames.length > 0) {
        contextParts.push(...dependencyNames.slice(0, 10))
        for (const dependencyName of dependencyNames.slice(0, 20)) {
          addUnique(projectDeps, dependencyName)
        }
        for (const dependencyName of dependencyNames) {
          const framework = frameworkFromDependency(dependencyName)
          if (framework) {
            addUnique(projectFrameworks, framework)
          }
        }
      }

      addUnique(projectStack, "Node.js")
      addUnique(projectStack, "TypeScript")
      if (!projectLanguage) {
        projectLanguage = "TypeScript"
      }
    }
    const goModPath = join(worktree, "go.mod")
    if (isValidWorktree && existsSync(goModPath)) {
      const goMod = readFileSync(goModPath, "utf-8")
      const moduleLine = goMod.split("\n").find(l => l.startsWith("module "))
      if (moduleLine) contextParts.push(moduleLine.replace("module ", "").trim())
      addUnique(projectStack, "Go")
      if (!projectLanguage) {
        projectLanguage = "Go"
      }
    }
    const cargoPath = join(worktree, "Cargo.toml")
    if (isValidWorktree && existsSync(cargoPath)) {
      const cargo = readFileSync(cargoPath, "utf-8")
      const nameLine = cargo.split("\n").find(l => l.trim().startsWith("name"))
      if (nameLine) {
        const name = nameLine.split("=")[1]?.trim().replace(/"/g, "")
        if (name) contextParts.push(name)
      }
      addUnique(projectStack, "Rust")
      if (!projectLanguage) {
        projectLanguage = "Rust"
      }
    }
    if (isValidWorktree) {
      const worktreeBasename = basename(worktree)
      contextParts.push(worktreeBasename)
      projectName = worktreeBasename
      projectDirectory = worktreeBasename
    }

    harvestProjectContext = {
      language: projectLanguage,
      deps: projectDeps,
      frameworks: projectFrameworks,
      stack: projectStack,
      projectName,
      directory: projectDirectory,
    }
  } catch {
    // Context gathering is best-effort
  }

  refreshBindingState()

  void (async () => {
    try {
      const recallMode = getRecallMode()
      logPlugin("info", `[recall] mode=${recallMode}`)
      if (recallMode === "test") {
        logPlugin("warn", "TEST MODE — recall governor bypassed (floor=0 budget=1000 limit=1000)")
      }
      wevibeAvailable = await ensureWeVibeMcpRunning()
      gcServedMemories()
      logPlugin("info", `[recall] init worktree=${worktree} dir=${directory} contextParts=${contextParts.length}`)
      logPlugin("info", `[recall] init wevibeAvailable=${wevibeAvailable}`)
    } catch (e) {
      logPlugin("error", `[recall] background init failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  })()

  const collectTextParts = (parts: unknown): string => {
    if (!Array.isArray(parts)) {
      return ""
    }

    const textParts: string[] = []
    for (const part of parts) {
      if (!part || typeof part !== "object") {
        continue
      }

      const candidate = part as { type?: unknown; text?: unknown }
      if (candidate.type !== "text" || typeof candidate.text !== "string") {
        continue
      }

      const text = candidate.text.trim()
      if (text.length > 0) {
        textParts.push(text)
      }
    }

    return textParts.join("\n").trim()
  }

  const spoolFromEvent = (evt: unknown): void => {
    if (!sensorsEnabled) {
      return
    }

    const event = evt as { type?: unknown; properties?: Record<string, unknown> } | undefined
    const eventType = typeof event?.type === "string" ? event.type : undefined
    if (!eventType) {
      return
    }

    const properties = event?.properties && typeof event.properties === "object"
      ? event.properties
      : {}
    const info = properties.info && typeof properties.info === "object"
      ? properties.info as Record<string, unknown>
      : undefined
    const sessionIdRaw = properties.sessionID ?? info?.id
    const sessionId = typeof sessionIdRaw === "string" && sessionIdRaw.length > 0
      ? sessionIdRaw
      : currentSessionId()

    switch (eventType) {
      case "session.created": {
        spool.append({
          sessionId,
          event: "session.created",
          payload: {
            directory: String(info?.directory ?? safeDirectory),
            ...(safeWorktree ? { worktree: safeWorktree } : {}),
          },
        })
        return
      }
      case "session.idle": {
        spool.append({
          sessionId,
          event: "session.idle",
          payload: {},
        })
        return
      }
      case "session.error": {
        const errorValue = properties.error as { message?: unknown } | string | undefined
        const message =
          (typeof errorValue === "object" && errorValue && typeof errorValue.message === "string")
            ? errorValue.message
            : (typeof errorValue === "string" ? errorValue : undefined)
        spool.append({
          sessionId,
          event: "session.error",
          payload: {
            ...(message ? { message_excerpt: excerpt(message) } : {}),
          },
        })
        return
      }
      case "file.edited": {
        spool.append({
          sessionId,
          event: "file.edited",
          payload: {
            path: String(properties.file),
          },
        })
        return
      }
      case "file.watcher.updated": {
        spool.append({
          sessionId,
          event: "file.watcher.updated",
          payload: {
            path: String(properties.file),
          },
        })
        return
      }
      case "lsp.client.diagnostics": {
        spool.append({
          sessionId,
          event: "lsp.client.diagnostics",
          payload: {
            path: String(properties.path),
            serverID: String(properties.serverID),
            // opencode 1.4.10/1.18.1 emits no diagnostic bodies here.
            diagnostics: [],
          },
        })
        return
      }
      case "command.executed": {
        // command.executed event does not carry exit_code in payload.
        const argsExcerpt = excerpt(properties.arguments)
        spool.append({
          sessionId,
          event: "command.executed",
          payload: {
            command: String(properties.name),
            ...(argsExcerpt ? { args_excerpt: argsExcerpt } : {}),
          },
        })
        return
      }
      default:
        return
    }
  }

  return {
    "chat.message": async (input, output) => {
      if (input?.sessionID) activeSessionId = input.sessionID

      // opencode's chat.message API: `input` has NO parts; `output` = { message: UserMessage, parts: Part[] }.
      // The user's prompt text lives in output.parts (verified against @opencode-ai/plugin index.d.ts:183-195).
      const userPromptText = collectTextParts((output as { parts?: unknown }).parts)
      const normalizedPromptText = userPromptText.replace(/\s+/g, " ").trim()

      if (normalizedPromptText.length === 0) {
        return
      }

      if (normalizedPromptText === lastRecalledQuery) {
        return
      }

      if (!wevibeAvailable) {
        return
      }

      lastRecalledQuery = normalizedPromptText
      triggerRecall(normalizedPromptText, "user_message")
    },

    "experimental.chat.system.transform": async (input, output) => {
      if (input?.sessionID) activeSessionId = input.sessionID

      if (recallInFlight) {
        let recallWaitTimedOut = false
        await Promise.race([
          recallInFlight,
          new Promise<void>(resolve => {
            setTimeout(() => {
              recallWaitTimedOut = true
              resolve()
            }, RECALL_IN_FLIGHT_AWAIT_TIMEOUT_MS)
          }),
        ])

        if (recallWaitTimedOut) {
          logDebug(`[recall] transform recall wait timeout after ${RECALL_IN_FLIGHT_AWAIT_TIMEOUT_MS}ms`)
        }
      }

      await drainDecisions()
      seedDeniedFromLocalBlacklist()

      const getPendingUndecidedCids = (): Set<string> => {
        const pending = new Set<string>()

        for (const memory of cachedMemories) {
          if (approvedCids.has(memory.cid)) continue
          if (deniedCids.has(memory.cid)) continue
          if (reportedCids.has(memory.cid)) continue
          pending.add(memory.cid)
        }

        return pending
      }

      let pendingUndecidedCids = getPendingUndecidedCids()
      if (isTuiLive() && pendingUndecidedCids.size > 0) {
        const gateStartedAt = Date.now()

        while (pendingUndecidedCids.size > 0) {
          if (!isTuiLive()) {
            break
          }

          if (Date.now() - gateStartedAt >= INJECT_GATE_TIMEOUT_MS) {
            logDebug(`[recall] transform gate timeout pending=${pendingUndecidedCids.size}`)
            break
          }

          await new Promise(resolve => setTimeout(resolve, INJECT_GATE_POLL_INTERVAL_MS))
          await drainDecisions()
          pendingUndecidedCids = getPendingUndecidedCids()
        }
      }

      const tuiLiveForLog = isTuiLive()
      logDebug(`[recall] transform tuiLive=${tuiLiveForLog} cached=${cachedMemories.length} approved=${approvedCids.size}`)

      const appetite = getRiskAppetite()
      if (appetite === "lowest") {
        logDebug("risk appetite set to lowest — filtering to negative_signal only")
      }
      const eligible = cachedMemories.filter(m => {
        if (deniedCids.has(m.cid) || !approvedCids.has(m.cid)) return false
        if (appetite === "lowest" && m.memoryType !== "negative_signal") return false
        return true
      })

      const { mode, maxInjected, injectCharBudget, recallLimit } = getRecallGovernorConfig()

      // Hub already governed relevance + budget; inject every approved-eligible memory as-is.
      if (eligible.length === 0) {
        logPlugin(
          "info",
          `[inject] ${new Date().toISOString()} nothing injected (cached=${cachedMemories.length} approved=${approvedCids.size} denied=${deniedCids.size} appetite=${appetite}) cadence=once`,
        )
        return
      }

      const sid = currentSessionId()
      const injectState = getSessionInjectState(sid)
      const injectedSet = getSessionInjected(sid)
      const candidates = eligible.filter(m => !injectState.injectedCids.has(m.cid))
      if (candidates.length === 0) {
        if (injectState.injectedCids.size > 0) {
          if (!injectState.steadyLogged) {
            const budgetRemaining = Math.max(0, injectCharBudget - injectState.chargedChars)
              logPlugin(
                "info",
                `[inject] steady_state sid=${sid} injected_total=${injectState.injectedCids.size} budget_remaining=${budgetRemaining} cadence=once`,
              )
              injectState.steadyLogged = true
            }
          return
        }

        logPlugin(
          "info",
          `[inject] ${new Date().toISOString()} nothing injected (cached=${cachedMemories.length} approved=${approvedCids.size} denied=${deniedCids.size} appetite=${appetite}) cadence=once`,
        )
        return
      }

      const injectTrace = newTrace()
      logPlugin("info", `[inject] start sid=${sid} eligible=${eligible.length} cadence=once`, injectTrace)

      const selection = selectInjectCandidates(
        candidates.map(candidate => ({
          cid: candidate.cid,
          text: candidate.text,
          flags: candidate.flags,
        })),
        injectState.injectedCids.size,
        maxInjected,
        injectCharBudget,
        injectState.chargedChars,
        mode,
      )

      for (const skipped of selection.overBudget) {
        if (injectState.overBudgetLogged.has(skipped.memory.cid)) {
          continue
        }
        injectState.overBudgetLogged.add(skipped.memory.cid)
        logPlugin(
          "info",
          `[inject] over_budget sid=${sid} cid=${skipped.memory.cid.slice(0, 12)} chars=${skipped.chars} budget_remaining=${skipped.budgetRemaining} cadence=once`,
          injectTrace,
        )
      }

      for (const skipped of selection.topkSkipped) {
        if (injectState.topkLogged.has(skipped.memory.cid)) {
          continue
        }
        injectState.topkLogged.add(skipped.memory.cid)
        logPlugin(
          "info",
          `[inject] topk_skipped sid=${sid} cid=${skipped.memory.cid.slice(0, 12)} rank=${skipped.rank} max_injected=${maxInjected} cadence=once`,
          injectTrace,
        )
      }

      if (selection.selected.length === 0) {
        return
      }

      const selectedCidSet = new Set(selection.selected.map(memory => memory.cid))
      const newlyServed = candidates.filter(memory => selectedCidSet.has(memory.cid))

      const memoryBlock = buildMemoryBlock(newlyServed, mode)

      insertAtStableEarlyPosition(output.system, memoryBlock)
      injectState.chargedChars += selection.chargedCharsDelta
      injectState.steadyLogged = false
      for (const memory of newlyServed) {
        injectState.injectedCids.add(memory.cid)
      }
      injectState.blocks.push(memoryBlock)

      logPlugin(
        "info",
        `[inject] injected count=${newlyServed.length} block_chars=${memoryBlock.length} block_tokens=${Math.round(memoryBlock.length / 4)} top_k=${recallLimit} sid=${sid} newly_served=${newlyServed.length} injected_once=${injectState.injectedCids.size} budget_remaining=${selection.budgetRemaining} cadence=once`,
        injectTrace,
      )
      logPlugin(
        "info",
        `[inject] ${new Date().toISOString()} sid=${sid} present_this_turn=${newlyServed.length} newly_served=${newlyServed.length}: ` +
          newlyServed
            .map(m => `${m.cid.slice(0, 12)}(score=${m.score.toFixed(3)}, "${m.text.slice(0, 60).replace(/\s+/g, " ")}", kw=[${(m.matchedKeywords ?? []).join(",")}])`)
            .join(" | ") +
          " cadence=once",
        injectTrace,
      )

      const latestNeed = latestNeedBySession.get(sid)
      if (!bindingState.orgId) {
        logDebug(`[outcome] open skipped org=missing sid=${sid}`)
      } else if (latestNeed) {
        enqueueHarvestedOutcomes(sid, episodeTracker.openEpisode({
          orgId: bindingState.orgId,
          sessionId: sid,
          needSignature: latestNeed.signature,
          injectedCids: newlyServed.map(memory => memory.cid),
          triggers: latestNeed.triggers,
          failing: latestNeed.failing,
          openedAtTurn: 0,
        }))
      } else {
        logDebug(`[outcome] open skipped need=missing sid=${sid}`)
      }

      if (getRecallMode() === "test" && newlyServed.length > 0) {
        void client?.tui?.showToast?.({
          body: {
            title: "WeVibe",
            message: `${newlyServed.length} memories injected`,
            variant: "info",
            duration: 4000,
          },
        })?.catch(() => undefined)
      }

      if (!bindingState.active) {
        logPlugin("info", "[binding] serve relay suppressed: session dormant (unbound)")
        upsertServedMemories(newlyServed.map(m => ({ cid: m.cid, text: m.text })), sid)
        return
      }

      for (const mem of newlyServed) {
        injectedSet.add(mem.cid)
        const token = readWeVibeMcpToken()
        if (token && bindingState.active && bindingState.orgId) {
          const boundOrg = bindingState.orgId
          const serveTrace = newTrace()
          logPlugin("info", `[serve] upsert cid=${mem.cid} sid=${sid}`, serveTrace)
          fetch(`${WEVIBE_MCP_HTTP}/v1/serves`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${token}`,
              "X-WeVibe-Trace-Id": serveTrace,
            },
            body: JSON.stringify({
              org_id: boundOrg,
              memory_hash: mem.cid,
              nullifier: mem.cid,
              matched_keywords: mem.matchedKeywords ?? [],
              session_id: sid,
            }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          })
            .then(async (res) => {
              if (res.ok) return
              let reason = ""
              try { reason = excerpt((await res.text()).slice(0, 512), 200) ?? "" } catch {
                // best effort
              }
              logPlugin("warn", `[serve] receipt failed status=${res.status}${reason ? ` reason=${reason}` : ""} cid_fp=${fp8(mem.cid)}`, serveTrace)
            })
            .catch((err) => {
              logPlugin("warn", `[serve] receipt failed reason=${excerpt(err instanceof Error ? err.message : String(err), 200)} cid_fp=${fp8(mem.cid)}`, serveTrace)
            })
        }
      }
      upsertServedMemories(newlyServed.map(m => ({ cid: m.cid, text: m.text })), sid)
    },

    "experimental.session.compacting": async (input, output) => {
      const sid = input?.sessionID ?? currentSessionId()
      const injectState = getSessionInjectState(sid)
      const restoredBlocks = injectState.blocks.length
      const restoredChars = injectState.blocks.reduce((sum, block) => sum + block.length, 0)
      logPlugin("info", `[lifecycle] compacting sid=${sid} restored_blocks=${restoredBlocks} restored_chars=${restoredChars}`, newTrace())
      if (restoredBlocks > 0) {
        for (let index = injectState.blocks.length - 1; index >= 0; index -= 1) {
          output.context.unshift(injectState.blocks[index])
        }
      }
      const restoreCount = (compactionRestoreCounts.get(sid) ?? 0) + 1
      compactionRestoreCounts.set(sid, restoreCount)
      logPlugin(
        "info",
        `[inject] restored count=${restoredBlocks} block_chars=${restoredChars} sid=${sid} cadence=once compaction_restores=${restoreCount}`,
        newTrace(),
      )
    },

    event: async (input) => {
      metricsRecorder.handleEvent(input.event)
      const eventType = (input.event as { type?: unknown } | undefined)?.type
      if (eventType === "session.created") {
        refreshBindingState()
      }
      if (typeof eventType === "string") {
        const lower = eventType.toLowerCase()
        if (lower.includes("session") || lower.includes("idle") || lower.includes("exit")) {
          logPlugin("info", `[lifecycle] event type=${eventType}`, newTrace())
        }
      }

      if (sensorsEnabled) {
        spoolFromEvent(input.event)

        const properties = (input.event as { properties?: Record<string, unknown> } | undefined)?.properties
        const info = properties?.info && typeof properties.info === "object"
          ? properties.info as Record<string, unknown>
          : undefined
        const sidRaw = properties?.sessionID ?? info?.id
        const sid = typeof sidRaw === "string" && sidRaw.length > 0 ? sidRaw : currentSessionId()
        const gstvDeps: GstvHookDeps = {
          spool,
          mcpBase: WEVIBE_MCP_HTTP,
          repoRoot: sensorRepoRoot,
          token: readWeVibeMcpToken(),
          newTrace,
          runCommand,
          log: logPlugin,
        }

        if (eventType === "session.created") {
          void onSessionCreated(gstvDeps, sid).catch(err => {
            logPlugin("error", `[gstv] session.created hook failed: ${excerpt(err instanceof Error ? err.message : String(err), 200)}`, newTrace())
          })
        }

        if (eventType === "session.idle") {
          enqueueHarvestedOutcomes(sid, episodeTracker.onSessionIdle(sid))
          void onSessionIdle(gstvDeps, sid, gstvBoundaryRan).catch(err => {
            logPlugin("error", `[gstv] session.idle hook failed: ${excerpt(err instanceof Error ? err.message : String(err), 200)}`, newTrace())
          })
        }
      }
    },

    "tool.execute.before": async (input, output) => {
      if (!sensorsEnabled) {
        return
      }

      if (toolCallStartedAt.size > 4096) {
        toolCallStartedAt.clear()
      }
      toolCallStartedAt.set(input.callID, Date.now())
      const argsExcerpt = excerpt(output?.args)
      spool.append({
        sessionId: input.sessionID ?? currentSessionId(),
        event: "tool.execute.before",
        payload: {
          call_id: input.callID,
          tool: input.tool,
          ...(argsExcerpt ? { args_excerpt: argsExcerpt } : {}),
        },
      })
    },

    "tool.execute.after": async (input, output) => {
      const needSessionId = input.sessionID ?? currentSessionId()
      const preNeedSignals = metricsRecorder.getBuildTestSignals(needSessionId)
      metricsRecorder.handleToolAfter(input, output)
      const postNeedSignals = metricsRecorder.getBuildTestSignals(needSessionId)
      const argsRecord = input.args as { command?: unknown } | undefined
      const command = typeof argsRecord?.command === "string" ? argsRecord.command : ""
      const exitCode = extractToolExitCode(output?.metadata)

      // Need-gated recall firing: failure signals only; dedup via recallInFlight + lastRecalledQuery.
      if (wevibeAvailable && bindingState.active && !recallInFlight) {
        const need = assessRecallNeed({
          tool: input.tool,
          command: command || undefined,
          exitCode,
          pre: preNeedSignals,
          post: postNeedSignals,
          recentErrors: metricsRecorder.getRecentErrors(needSessionId),
          lastFiredSignature: lastRecalledQuery,
        })
        if (need.needed && need.signature !== lastRecalledQuery) {
          latestNeedBySession.set(needSessionId, {
            signature: need.signature,
            triggers: need.triggers,
            failing: {
              build: postNeedSignals.buildFailing === true,
              test: postNeedSignals.testFailing === true,
            },
          })
          lastRecalledQuery = need.signature
          triggerRecall(need.query, "tool_failure")
        }
      }

      enqueueHarvestedOutcomes(needSessionId, episodeTracker.observeToolResult({
        sessionId: needSessionId,
        tool: input.tool,
        commandFp8: fp8(command || ""),
        exitCode,
        pre: {
          buildFailing: preNeedSignals.buildFailing === true,
          testFailing: preNeedSignals.testFailing === true,
        },
        post: {
          buildFailing: postNeedSignals.buildFailing === true,
          testFailing: postNeedSignals.testFailing === true,
        },
      }))

      if (!sensorsEnabled) {
        return
      }

      const startedAt = toolCallStartedAt.get(input.callID)
      toolCallStartedAt.delete(input.callID)
      const durationMs = typeof startedAt === "number" ? Math.max(0, Date.now() - startedAt) : undefined
      const metadata = output?.metadata as { exit_code?: unknown; exitCode?: unknown; error?: unknown } | undefined
      const exitCodeRaw = metadata?.exit_code ?? metadata?.exitCode
      const outputExcerpt = excerpt(output?.output)
      const errorExcerpt = typeof metadata?.error === "string" && metadata.error.trim().length > 0
        ? excerpt(metadata.error)
        : undefined
      spool.append({
        sessionId: input.sessionID ?? currentSessionId(),
        event: "tool.execute.after",
        payload: {
          call_id: input.callID,
          tool: input.tool,
          ...(typeof durationMs === "number" ? { duration_ms: durationMs } : {}),
          ...(typeof exitCodeRaw === "number" ? { exit_code: exitCodeRaw } : {}),
          ...(outputExcerpt ? { output_excerpt: outputExcerpt } : {}),
          ...(errorExcerpt ? { error_excerpt: errorExcerpt } : {}),
        },
      })
    },
  }
}
