import { type Plugin } from "@opencode-ai/plugin"
import { join, resolve, dirname, homedir } from "path"

interface CachedMemory {
  cid: string
  text: string
  score: number
  keywords: string[]
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
  const fs = await import("fs")
  const { existsSync, appendFileSync, readFileSync, writeFileSync, mkdirSync } = fs

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
    const dir = dirname(filePath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    if (!existsSync(filePath)) {
      writeFileSync(filePath, defaultContents)
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

    push(process.env.WEVIBE_ROOT ?? undefined)
    push(worktree)
    push(join(worktree, "WeVibe"))
    push(directory)
    push(join(directory, ".."))
    push(join(directory, "..", ".."))
    push(process.cwd())
    push(join(process.cwd(), "WeVibe"))

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

  const safeWorktree = (typeof worktree === "string" && worktree.length > 0 && existsSync(worktree))
    ? worktree
    : undefined
  const safeDirectory = (typeof directory === "string" && directory.length > 0 && existsSync(directory))
    ? directory
    : undefined
  const errorLogRoot = resolvedWeVibeRoot ?? safeWorktree ?? safeDirectory ?? process.cwd()
  const errorLogPath = join(errorLogRoot, "wevibe-plugin-errors.log")

  const stateRoot = safeWorktree ?? safeDirectory ?? process.cwd()
  const stateDir = join(stateRoot, STATE_DIRNAME)
  const queuePath = join(stateDir, QUEUE_FILENAME)
  const decisionPath = join(stateDir, DECISIONS_FILENAME)
  const statusPath = join(stateDir, STATUS_FILENAME)

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
    const headers = token ? { 'Authorization': `Bearer ${token}` } : {}
    try {
      const healthRes = await fetch(`${WEVIBE_MCP_HTTP}/v1/health`, { headers, signal: AbortSignal.timeout(2000) })
      if (healthRes.ok) return true
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
        WEVIBE_AUTO_CONTRIBUTE: "1",
        WEVIBE_ALLOW_UNREVIEWED: "1",
      }

      const child = spawn(process.execPath, [wevibeMcpBin], {
        detached: true,
        stdio: "ignore",
        env,
      })
      child.unref()

      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 500))
        const retryToken = readWeVibeMcpToken()
        const retryHeaders = retryToken ? { 'Authorization': `Bearer ${retryToken}` } : {}
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
    try {
      const now = Date.now()
      if (query === memoryCacheKey && cachedMemories.length > 0 && (now - memoryCacheTimestamp) < MEMORY_CACHE_TTL_MS) {
        logPlugin("info", `loadMemories cache hit for "${query.slice(0, 40)}..." (age=${Math.round((now - memoryCacheTimestamp) / 1000)}s)`)
        return
      }

      const token = readWeVibeMcpToken()
      if (!token) {
        logPlugin("warn", "loadMemories: wevibe-mcp token not available")
        return
      }
      const res = await fetch(`${WEVIBE_MCP_HTTP}/v1/recall`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ query, limit: 10 }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })

      if (!res.ok) {
        logPlugin("error", `recall request failed: status=${res.status}`)
        return
      }

      const data = await res.json() as { status?: string; memories?: Array<{ cid: string; text: string; score: number; breakdown?: { keyword_matches?: Array<{ keyword: string }> }; source?: string; memory_type?: string; guard?: { passed: boolean; detections?: Array<{ field: string; scanner: string; rule: string }>; flags?: string[] } }> }
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
      logPlugin("error", `memory load failed: ${e instanceof Error ? e.message : String(e)}`)
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
  if (wevibeAvailable) {
    await loadMemories(queryToUse)
  }

  return {
    "tool.execute.before": async (input, output) => {
      const args = output.args as Record<string, unknown>
      const filePath = (args.filePath ?? args.path ?? args.file) as string | undefined
      if (filePath && typeof filePath === "string") {
        contextPaths.add(filePath)
      }
    },

    "chat.message": async (input, output) => {
      if (input.parts) {
        for (const part of input.parts as Array<{ type: string; content?: string; text?: string }>) {
          if (part.type === "text") {
            lastPrompt = (part.content ?? part.text ?? "").toLowerCase()
          }
        }
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      await drainDecisions()

      const appetite = getRiskAppetite()
      if (appetite === "lowest") {
        logPlugin("info", "risk appetite set to lowest — filtering to negative_signal only")
      }
      const eligible = cachedMemories.filter(m => {
        if (m.blocked || !approvedCids.has(m.cid)) return false
        if (appetite === "lowest" && m.memoryType !== "negative_signal") return false
        return true
      })
      if (eligible.length === 0) return

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
      if (toInject.length === 0) return

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
