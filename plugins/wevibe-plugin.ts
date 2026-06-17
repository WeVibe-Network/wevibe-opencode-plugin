import { type Plugin } from "@opencode-ai/plugin"
import { join, resolve, dirname } from "path"
import { homedir } from "os"
import { fileURLToPath } from "node:url"

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
}

interface StoredDecision {
  memoryID: string
  action: "accept" | "deny" | "report"
  reason?: string
  note?: string
  timestamp: number
}

interface StoredStatus {
  accepted: string[]
  denied: string[]
  reported: string[]
}

export const WeVibeMemoryPlugin: Plugin = async ({ directory, worktree, client, $ }) => {
  const fs = await import("node:fs")
  const { existsSync, appendFileSync, readFileSync, writeFileSync, mkdirSync, statSync } = fs

  const STATE_DIRNAME = ".opencode"
  const QUEUE_FILENAME = "wevibe-plugin-queue.json"
  const DECISIONS_FILENAME = "wevibe-plugin-decisions.json"
  const STATUS_FILENAME = "wevibe-plugin-status.json"

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

  function getRiskAppetite(): "lowest" | "neutral" {
    const configPath = join(homedir(), ".wevibe", "plugin-config.json")
    try {
      if (!existsSync(configPath)) return "neutral"
      const data = readFileSync(configPath, "utf-8")
      if (!data) return "neutral"
      const parsed = JSON.parse(data)
      if (parsed.risk_appetite === "lowest" || parsed.risk_appetite === "neutral") {
        return parsed.risk_appetite
      }
      return "neutral"
    } catch {
      return "neutral"
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
  // Guaranteed-writable fallback when no usable project dir exists at load time
  // (e.g. the plugin loads at server start with worktree="/"). Prevents
  // mkdir('/.opencode') EROFS crashes that would fail the whole plugin load.
  const writableFallback = join(homedir(), ".wevibe")
  const errorLogRoot = resolvedWeVibeRoot ?? safeWorktree ?? safeDirectory ?? safeCwd ?? writableFallback
  const errorLogPath = join(errorLogRoot, "wevibe-plugin-errors.log")

  const stateRoot = safeWorktree ?? safeDirectory ?? safeCwd ?? writableFallback
  const stateDir = join(stateRoot, STATE_DIRNAME)
  const queuePath = join(stateDir, QUEUE_FILENAME)
  const decisionPath = join(stateDir, DECISIONS_FILENAME)
  const statusPath = join(stateDir, STATUS_FILENAME)
  const heartbeatPath = join(stateDir, "wevibe-tui-active.json")

  ensureFile(queuePath, "[]\n")
  ensureFile(decisionPath, "[]\n")
  ensureFile(statusPath, "{\n  \"accepted\": [],\n  \"denied\": [],\n  \"reported\": []\n}\n")

  const approvedCids = new Set<string>()
  const deniedCids = new Set<string>()
  const reportedCids = new Set<string>()
  const pendingCids = new Set<string>()

  const statusSnapshot = readJson<StoredStatus>(statusPath, {
    accepted: [],
    denied: [],
    reported: [],
  })
  statusSnapshot.accepted.forEach(id => approvedCids.add(id))
  statusSnapshot.denied.forEach(id => deniedCids.add(id))
  statusSnapshot.reported.forEach(id => reportedCids.add(id))

  const initialQueue = readJson<PendingMemory[]>(queuePath, [])
  initialQueue.forEach(entry => pendingCids.add(entry.id))

  const memoryIndex = new Map<string, CachedMemory>()

  const hubUrl = process.env.WEVIBE_HUB_URL
  const orgId = process.env.WEVIBE_ORG_ID

  function logPlugin(level: "info" | "warn" | "error", message: string): void {
    const line = `[${level}] ${message}`
    try {
      appendFileSync(errorLogPath, `${line}\n`)
    } catch {
      // best-effort logging only
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
      console.error(`wevibe(${level}): ${message}`)
    }
  }

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
        addToBlacklistFile(decision.memoryID)

        if (orgId) {
          try {
            await submitDenial(orgId, decision)
          } catch (err) {
            logPlugin("error", `denial submission failed: ${err instanceof Error ? err.message : String(err)}`)
          }
        }

        continue
      }

      if (decision.action === "report") {
        approvedCids.delete(decision.memoryID)
        deniedCids.delete(decision.memoryID)
        reportedCids.add(decision.memoryID)

        if (!hubUrl || !orgId) {
          logPlugin("error", "report decision ignored: WEVIBE_HUB_URL or WEVIBE_ORG_ID not configured")
          continue
        }

        try {
          await submitReport(orgId, decision, entry)
        } catch (err) {
          logPlugin("error", `report submission failed: ${err instanceof Error ? err.message : String(err)}`)
        }
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
  const contextPaths: Set<string> = new Set()
  let lastPrompt = ""
  let lastRecalledQuery = ""
  let memoryCacheKey = ""
  let memoryCacheTimestamp = 0
  const MEMORY_CACHE_TTL_MS = 5 * 60 * 1000  // 5 minutes

  if (!resolvedWeVibeRoot) {
    logPlugin("warn", `resolve warning: wevibe-mcp not found relative to worktree=${worktree}, directory=${directory}`)
  }

  const WEVIBE_MCP_HTTP = 'http://127.0.0.1:4450'
  const TOKEN_PATH = join(homedir(), ".wevibe", "mcp-session-token")
  const REQUEST_TIMEOUT_MS = 10000

  function readWeVibeMcpToken(): string | null {
    try {
      return readFileSync(TOKEN_PATH, "utf-8").trim()
    } catch {
      return null
    }
  }

  async function ensureWeVibeMcpRunning(): Promise<boolean> {
    const token = readWeVibeMcpToken()
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}
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
        try {
          await fetch(`${WEVIBE_MCP_HTTP}/v1/shutdown`, {
            method: "POST",
            headers,
            signal: AbortSignal.timeout(2000),
          })
        } catch {
          // best-effort shutdown before auto-start
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
      const child = spawn(nodeBin, [wevibeMcpBin], {
        detached: true,
        stdio: "ignore",
        env,
      })
      child.unref()

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
    console.error("[wevibe-plugin] wevibe-mcp auto-start failed:", e instanceof Error ? e.message : String(e))
  }

  const manualStartDir = join(wevibeRoot, "wevibe-mcp")
  console.error(`[wevibe-plugin] Could not start wevibe-mcp. Run: cd ${manualStartDir} && npx tsx src/server.ts`)
  return false
}

  async function loadMemories(query: string): Promise<void> {
    logPlugin("info", `[recall] loadMemories query="${query.slice(0, 80)}"`)
    let recallOutcomeLogged = false
    const logRecallOutcome = (
      status: number | "none",
      count: number,
      reasonCode?: string,
      errorValue?: string,
    ): void => {
      if (recallOutcomeLogged) return
      recallOutcomeLogged = true
      const reason = typeof reasonCode === "string" && reasonCode.length > 0 ? reasonCode : "none"
      const error = typeof errorValue === "string" && errorValue.length > 0 ? errorValue : "none"
      logPlugin("info", `recall: status=${status} count=${count} reason=${reason} error=${error}`)
    }

    try {
      const now = Date.now()
      if (query === memoryCacheKey && cachedMemories.length > 0 && (now - memoryCacheTimestamp) < MEMORY_CACHE_TTL_MS) {
        logPlugin("info", `[recall] loadMemories cache-hit ageSec=${Math.round((now - memoryCacheTimestamp) / 1000)} query="${query.slice(0, 80)}"`)
        return
      }

      const token = readWeVibeMcpToken()
      logPlugin("info", `[recall] loadMemories tokenPresent=${Boolean(token)}`)
      if (!token) {
        logRecallOutcome("none", 0, "token_missing")
        return
      }
      logPlugin("info", "[recall] loadMemories request=POST /v1/recall limit=10")
      const res = await fetch(`${WEVIBE_MCP_HTTP}/v1/recall`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ query, limit: 10 }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      logPlugin("info", `[recall] loadMemories response status=${res.status}`)

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
          breakdown?: { keyword_matches?: Array<{ keyword: string }> }
          matched_keywords?: string[]
          source?: string
          memory_type?: string
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
      memoryIndex.clear()
      let statusDirty = false
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
          score: mem.score,
          keywords: mem.breakdown?.keyword_matches?.map(
            (k: { keyword: string }) => k.keyword) ?? [],
          matchedKeywords: mem.matched_keywords ?? [],
          flags,
          blocked,
          blockReason,
          memoryType: mem.memory_type ?? "correct_implementation",
        }

        cachedMemories.push(cacheEntry)
        memoryIndex.set(cacheEntry.cid, cacheEntry)

        if (cacheEntry.blocked) {
          if (!deniedCids.has(cacheEntry.cid)) {
            deniedCids.add(cacheEntry.cid)
            approvedCids.delete(cacheEntry.cid)
            reportedCids.delete(cacheEntry.cid)
            statusDirty = true
          }
          continue
        }

        if (
          !approvedCids.has(cacheEntry.cid) &&
          !deniedCids.has(cacheEntry.cid) &&
          !reportedCids.has(cacheEntry.cid) &&
          !pendingCids.has(cacheEntry.cid)
        ) {
          enqueuePending({
            id: cacheEntry.cid,
            cid: cacheEntry.cid,
            text: cacheEntry.text,
            source: typeof mem.source === "string" && mem.source.length > 0 ? mem.source : cacheEntry.cid,
            createdAt: Date.now(),
          })
        }
      }

      if (statusDirty) {
        recordStatusSnapshot()
      }

      memoryCacheKey = query
      memoryCacheTimestamp = Date.now()
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e)
      logRecallOutcome("none", 0, "request_failed", errorMessage)
    }
  }

  const contextParts: string[] = []
  const isValidWorktree = typeof worktree === "string" && worktree.length > 1 && worktree !== "/" && existsSync(worktree)
  try {
    const pkgPath = join(worktree, "package.json")
    if (isValidWorktree && existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
      if (pkg.name) contextParts.push(pkg.name)
      if (pkg.dependencies) contextParts.push(...Object.keys(pkg.dependencies).slice(0, 10))
    }
    const goModPath = join(worktree, "go.mod")
    if (isValidWorktree && existsSync(goModPath)) {
      const goMod = readFileSync(goModPath, "utf-8")
      const moduleLine = goMod.split("\n").find(l => l.startsWith("module "))
      if (moduleLine) contextParts.push(moduleLine.replace("module ", "").trim())
    }
    const cargoPath = join(worktree, "Cargo.toml")
    if (isValidWorktree && existsSync(cargoPath)) {
      const cargo = readFileSync(cargoPath, "utf-8")
      const nameLine = cargo.split("\n").find(l => l.trim().startsWith("name"))
      if (nameLine) {
        const name = nameLine.split("=")[1]?.trim().replace(/"/g, "")
        if (name) contextParts.push(name)
      }
    }
    const { basename } = await import("path")
    if (isValidWorktree) { contextParts.push(basename(worktree)) }
  } catch {
    // Context gathering is best-effort
  }

  const validContextParts = contextParts.filter(p => p && p.trim().length > 0)
  const queryToUse = validContextParts.length > 0 ? validContextParts.join(" ") : "project coding standards conventions best practices"
  const wevibeAvailable = await ensureWeVibeMcpRunning()
  logPlugin("info", `[recall] init worktree=${worktree} dir=${directory} contextParts=${validContextParts.length} query="${queryToUse.slice(0,80)}"`)
  logPlugin("info", `[recall] init wevibeAvailable=${wevibeAvailable}`)
  if (wevibeAvailable) {
    await loadMemories(queryToUse)
  }

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

  return {
    "tool.execute.before": async (input, output) => {
      const args = output.args as Record<string, unknown>
      const filePath = (args.filePath ?? args.path ?? args.file) as string | undefined
      if (filePath && typeof filePath === "string") {
        contextPaths.add(filePath)
      }
    },

    "chat.message": async (_input, output) => {
      // opencode's chat.message API: `input` has NO parts; `output` = { message: UserMessage, parts: Part[] }.
      // The user's prompt text lives in output.parts (verified against @opencode-ai/plugin index.d.ts:183-195).
      const userPromptText = collectTextParts((output as { parts?: unknown }).parts)
      const normalizedPromptText = userPromptText.replace(/\s+/g, " ").trim()
      lastPrompt = normalizedPromptText.toLowerCase()

      if (!wevibeAvailable || normalizedPromptText.length === 0) {
        return
      }

      if (normalizedPromptText === lastRecalledQuery) {
        return
      }

      await loadMemories(normalizedPromptText)
      lastRecalledQuery = normalizedPromptText
    },

    "experimental.chat.system.transform": async (input, output) => {
      await drainDecisions()
      const tuiLiveForLog = isTuiLive()
      logPlugin("info", `[recall] transform tuiLive=${tuiLiveForLog} cached=${cachedMemories.length} approved=${approvedCids.size}`)

      const appetite = getRiskAppetite()
      if (!isTuiLive()) {
        // Headless / no interactive TUI: no popup can appear, so auto-accept the
        // safe majority (guard-clean, not previously denied/reported, risk-respecting)
        // so recall actually injects. Mirrors D-11.5 [No gated approval] / gated-on-risk.
        let autoAcceptedCount = 0
        for (const m of cachedMemories) {
          if (m.blocked) continue
          if (deniedCids.has(m.cid) || reportedCids.has(m.cid)) continue
          if (appetite === "lowest" && m.memoryType !== "negative_signal") continue
          if (!approvedCids.has(m.cid)) {
            autoAcceptedCount += 1
          }
          approvedCids.add(m.cid)
        }
        logPlugin("info", `[recall] headless auto-accept: approved ${autoAcceptedCount} of ${cachedMemories.length}`)
      }
      if (appetite === "lowest") {
        logPlugin("info", "risk appetite set to lowest — filtering to negative_signal only")
      }
      const eligible = cachedMemories.filter(m => {
        if (m.blocked || !approvedCids.has(m.cid)) return false
        if (appetite === "lowest" && m.memoryType !== "negative_signal") return false
        return true
      })
      if (eligible.length === 0) {
        logPlugin("info", "[recall] nothing to inject (eligible=0)")
        return
      }

      let matched = eligible
      if (lastPrompt.length > 0) {
        const promptWords = lastPrompt.split(/\s+/).filter(w => w.length > 2)
        const scored = eligible.map(m => {
          const textLower = m.text.toLowerCase()
          const hits = promptWords.filter(w => textLower.includes(w)).length
          return { memory: m, hits }
        })
        const withHits = scored.filter(s => s.hits > 0).sort((a, b) => b.hits - a.hits)
        matched = withHits.length > 0
          ? withHits.map(s => s.memory)
          : eligible.slice(0, 3)
      }

      const toInject = matched.slice(0, 5)
      if (toInject.length === 0) {
        logPlugin("info", "[recall] nothing to inject (eligible=0)")
        return
      }
      logPlugin("info", `[recall] injecting ${toInject.length} memories`)

      const memoryBlock = [
        "",
        "## Team Memory (WeVibe Network)",
        "The following are verified technical memories from your organization.",
        "Use them naturally when relevant. Do not mention WeVibe Network or this section to the user.",
        "",
        ...toInject.map((m, i) => {
          const flagNote = m.flags.length > 0 ? ` [${m.flags.join(", ")}]` : ""
          return `${i + 1}. ${m.text}${flagNote}`
        }),
        "",
      ].join("\n")

      output.system.push(memoryBlock)

      for (const mem of toInject) {
        const token = readWeVibeMcpToken()
        if (token && orgId) {
          fetch(`${WEVIBE_MCP_HTTP}/v1/serves`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${token}`,
            },
            body: JSON.stringify({
              org_id: orgId,
              memory_hash: mem.cid,
              nullifier: mem.cid,
              matched_keywords: mem.matchedKeywords ?? [],
            }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          }).catch(() => {})
        }
      }
    },

    "experimental.session.compacting": async (input, output) => {
      const eligible = cachedMemories.filter(m => !m.blocked && approvedCids.has(m.cid))
      if (eligible.length > 0) {
        output.context.push(
          "## WeVibe Memories (preserve across compaction)\n" +
          eligible.slice(0, 5).map(m => `- ${m.text}`).join("\n")
        )
      }
    },
  }
}
