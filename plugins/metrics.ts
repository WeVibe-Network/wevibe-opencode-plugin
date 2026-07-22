// plugins/metrics.ts
//
// Additive session-benchmark recorder for the WeVibe OpenCode plugin.
// Computes objective per-session metrics from OpenCode telemetry and writes a
// timestamped JSONL live-log under runs/ (R-31 live-log convention). Additive
// only: it observes events + tool outputs and never influences recall/injection.
//
// No secrets/PII: only booleans, counts, sessionID, timestamps and a coarse
// detection category are logged — never raw commands or tool output.

import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import type { Event, Part } from "@opencode-ai/sdk"

type CommandCategory = "build" | "test" | "server"
type DetectResult = "success" | "failure" | "unknown"

interface SessionState {
  sessionID: string
  startedAt: string
  logFile: string
  turnCount: number
  turnsToGreen: number | null
  buildSuccess: boolean | null
  testPass: boolean | null
  serverStart: boolean
  errorCount: number
  erroredCallIDs: Set<string>
  recentErrors: string[]
  editedFiles: string[]
}

interface RecorderOptions {
  runsDir: string
  log?: (message: string) => void
}

const sanitize = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80)
const MAX_RECENT_ERRORS = 8
const MAX_EDITED_FILES = 15
const MAX_SIGNAL_CHARS = 300

const sanitizeSignal = (s: string): string => {
  const newlineToken = sanitize("\n").slice(0, 1) || "_"
  return s
    .replace(/\r?\n+/g, ` ${newlineToken} `)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SIGNAL_CHARS)
}

// --- bash-output classification (exit-code authoritative, head-anchored command parse) ------

const COMMAND_PATTERNS: Array<{ category: CommandCategory; re: RegExp }> = [
  // server first: `next dev` must not be mistaken for a build. Anchored at the
  // start of a command segment so a mere mention (e.g. `git commit -m "fix vitest"`)
  // never triggers a category — an unrecognized leading program => MISS, not a false.
  { category: "server", re: /^\b(next\s+dev|npm\s+(run\s+)?(dev|start)|yarn\s+(dev|start)|pnpm\s+(dev|start)|vite(\s|$)|nodemon)\b/i },
  { category: "test", re: /^\b(go\s+test|cargo\s+test|vitest|jest|playwright\s+test|npm\s+(run\s+)?test|pnpm\s+test|yarn\s+test|pytest)\b/i },
  { category: "build", re: /^\b(go\s+build|go\s+vet|cargo\s+(build|check)|tsc|next\s+build|npm\s+run\s+build|pnpm\s+build|yarn\s+build)\b/i },
]

const FAILURE_RE = /(error\s+TS\d+|error\[E?\d+\]|error:\s|could not compile|cannot find|undefined:|Failed to compile|Type error:|test result:\s*FAILED|--- FAIL|\bFAIL\b|panic:|EADDRINUSE|build failed|\d+\s+fail(ed|ing)\b|✗|✘)/i

const SUCCESS_RE = /(compiled successfully|✓\s*compiled|build succeeded|test result:\s*ok|\bok\b\s|no test files|\bPASS\b|\d+\s+passed|tests?\s+passed|Finished\b)/i

const SERVER_UP_RE = /(listening on|ready on|ready in\b|started server|server (started|listening|running)|Local:\s*https?:\/\/|running at|https?:\/\/localhost|✓ Ready)/i

// A command is categorized by the PROGRAM ACTUALLY INVOKED at the head of a
// segment — not by any word that merely appears in it. Split on shell separators,
// strip leading env-assignments and known exec wrappers, then match COMMAND_PATTERNS
// anchored at the segment start. Package-manager script forms (`yarn test`,
// `pnpm build`, `npm run test`) match directly BEFORE any wrapper strip, so they
// keep their category; a bare wrapper (`npx vitest`, `sudo go test`) is peeled to
// expose the runner. Unknown leading program => null => the safe MISS (no record).
const SEGMENT_SPLIT = /&&|\|\||;|\|/
const ENV_ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/
const WRAPPER_TWO: RegExp[] = [/^pnpm\s+exec\s+/i, /^pnpm\s+dlx\s+/i, /^bun\s+run\s+/i]
const WRAPPER_ONE = /^(npx|yarn|bunx|sudo|time|env|command)\s+/i

function categorize(command: string): CommandCategory | null {
  for (const rawSeg of command.split(SEGMENT_SPLIT)) {
    let seg = rawSeg.trim()
    // Peel env-assignments + one wrapper token per pass; match at each level.
    // Bounded (max 5 passes) so a pathological input can never loop.
    for (let pass = 0; pass < 5 && seg; pass++) {
      seg = seg.replace(ENV_ASSIGN, "").trimStart()
      for (const p of COMMAND_PATTERNS) {
        if (p.re.test(seg)) return p.category
      }
      let next = seg
      for (const w of WRAPPER_TWO) {
        const r = seg.replace(w, "")
        if (r !== seg) {
          next = r
          break
        }
      }
      if (next === seg) next = seg.replace(WRAPPER_ONE, "")
      if (next === seg) break // no runner/wrapper at head → try next segment
      seg = next.trimStart()
    }
  }
  return null
}

function classify(
  command: string,
  output: string,
  exitCode: number | null | undefined,
): { category: CommandCategory | null; result: DetectResult } {
  const category = categorize(command)
  if (!category) return { category: null, result: "unknown" }

  const text = output.length > 40000 ? output.slice(0, 20000) + "\n" + output.slice(-20000) : output

  if (category === "server") {
    if (FAILURE_RE.test(text)) return { category, result: "failure" }
    if (SERVER_UP_RE.test(text)) return { category, result: "success" }
    return { category, result: "unknown" }
  }

  // build/test: opencode's bash tool exposes the real process exit code as
  // output.metadata.exit (a number on any normal exit incl. nonzero; null only on
  // abort/timeout). It is the authoritative pass/fail signal — and the only one that
  // works for a SILENT green build (`tsc --noEmit` / `go build ./...`), whose stdout
  // opencode renders as the literal "(no output)" placeholder. Pure exit-code trust:
  // exit 0 = success unqualified (no output recheck), any nonzero = failure.
  if (typeof exitCode === "number") {
    return { category, result: exitCode === 0 ? "success" : "failure" }
  }

  // Exit code unavailable (abort/timeout → null): fall back to text heuristics.
  if (FAILURE_RE.test(text)) return { category, result: "failure" }
  if (SUCCESS_RE.test(text)) return { category, result: "success" }
  return { category, result: "unknown" }
}

// --- recorder ----------------------------------------------------------------

export class SessionMetricsRecorder {
  private sessions = new Map<string, SessionState>()
  private runsDir: string
  private log: (message: string) => void

  constructor(options: RecorderOptions) {
    this.runsDir = options.runsDir
    this.log = options.log ?? (() => {})
  }

  private pushRecentError(s: SessionState, text: string): void {
    const value = sanitizeSignal(text)
    if (!value) return
    s.recentErrors.push(value)
    if (s.recentErrors.length > MAX_RECENT_ERRORS) {
      s.recentErrors.splice(0, s.recentErrors.length - MAX_RECENT_ERRORS)
    }
  }

  private pushEditedFile(s: SessionState, filePath: string): void {
    const value = filePath.trim()
    if (!value) return
    const existing = s.editedFiles.indexOf(value)
    if (existing >= 0) s.editedFiles.splice(existing, 1)
    s.editedFiles.push(value)
    if (s.editedFiles.length > MAX_EDITED_FILES) {
      s.editedFiles.splice(0, s.editedFiles.length - MAX_EDITED_FILES)
    }
  }

  private pickErrorText(value: unknown): string {
    if (typeof value === "string") return value
    if (value instanceof Error) return value.message
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>
      if (typeof record.message === "string") return record.message
      if (typeof record.error === "string") return record.error
      if (typeof record.details === "string") return record.details
    }
    return ""
  }

  private state(sessionID: string): SessionState {
    let s = this.sessions.get(sessionID)
    if (!s) {
      const startedAt = new Date().toISOString()
      const fname = `session-${sanitize(sessionID)}-${sanitize(startedAt)}.jsonl`
      s = {
        sessionID,
        startedAt,
        logFile: join(this.runsDir, fname),
        turnCount: 0,
        turnsToGreen: null,
        buildSuccess: null,
        testPass: null,
        serverStart: false,
        errorCount: 0,
        erroredCallIDs: new Set<string>(),
        recentErrors: [],
        editedFiles: [],
      }
      this.sessions.set(sessionID, s)
    }
    return s
  }

  private snapshot(s: SessionState, trigger: string): void {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      trigger,
      sessionID: s.sessionID,
      startedAt: s.startedAt,
      turnCount: s.turnCount,
      turnsToGreen: s.turnsToGreen,
      buildSuccess: s.buildSuccess,
      testPass: s.testPass,
      serverStart: s.serverStart,
      errorCount: s.errorCount,
    })
    try {
      mkdirSync(this.runsDir, { recursive: true })
      appendFileSync(s.logFile, line + "\n")
    } catch (err) {
      this.log(`metrics: failed to write ${s.logFile}: ${String(err)}`)
    }
  }

  private maybeSetGreen(s: SessionState): void {
    // turns-to-green = 1-based index of the turn in which the FIRST build/test
    // success is observed. session.idle increments turnCount only at turn end,
    // so the in-progress turn is turnCount + 1.
    if (s.turnsToGreen === null && (s.buildSuccess === true || s.testPass === true)) {
      s.turnsToGreen = s.turnCount + 1
    }
  }

  getRecentErrors(sessionID: string): string[] {
    const s = this.sessions.get(sessionID)
    return s ? [...s.recentErrors] : []
  }

  getEditedFiles(sessionID: string): string[] {
    const s = this.sessions.get(sessionID)
    return s ? [...s.editedFiles] : []
  }

  getBuildTestSignals(sessionID: string): { buildFailing?: boolean; testFailing?: boolean } {
    const s = this.sessions.get(sessionID)
    if (!s) return {}

    const buildFailing = s.buildSuccess === false ? true : s.buildSuccess === true ? false : undefined
    const testFailing = s.testPass === false ? true : s.testPass === true ? false : undefined

    const signals: { buildFailing?: boolean; testFailing?: boolean } = {}
    if (buildFailing !== undefined) signals.buildFailing = buildFailing
    if (testFailing !== undefined) signals.testFailing = testFailing
    return signals
  }

  handleEvent(event: Event): void {
    try {
      // Cheap type filter FIRST: the event firehose fires very frequently.
      switch (event.type) {
        case "session.idle": {
          const s = this.state(event.properties.sessionID)
          s.turnCount += 1
          this.snapshot(s, "session.idle")
          break
        }
        case "session.error": {
          const sid = event.properties.sessionID
          if (!sid) return
          const s = this.state(sid)
          s.errorCount += 1
          const errorText = this.pickErrorText(event.properties)
          if (errorText) this.pushRecentError(s, errorText)
          this.snapshot(s, "session.error")
          break
        }
        case "message.part.updated": {
          const part: Part = event.properties.part
          if (part.type !== "tool") return
          if (part.state.status !== "error") return
          const s = this.state(part.sessionID)
          if (s.erroredCallIDs.has(part.callID)) return
          s.erroredCallIDs.add(part.callID)
          s.errorCount += 1
          const partState = part.state as { error?: unknown; message?: unknown } | null | undefined
          const errorText = this.pickErrorText(partState?.error) || this.pickErrorText(partState?.message)
          if (errorText) this.pushRecentError(s, errorText)
          this.snapshot(s, "tool.error")
          break
        }
        default:
          return
      }
    } catch (err) {
      this.log(`metrics: handleEvent error: ${String(err)}`)
    }
  }

  handleToolAfter(
    input: { tool: string; sessionID: string; callID: string; args: unknown },
    output: { output: string; metadata?: { exit?: number | null } },
  ): void {
    try {
      const tool = input.tool.toLowerCase()
      const argsRecord = input.args && typeof input.args === "object" ? (input.args as Record<string, unknown>) : null
      const filePath = typeof argsRecord?.filePath === "string" ? argsRecord.filePath : typeof argsRecord?.path === "string" ? argsRecord.path : ""
      const looksLikeFileTouch = tool.includes("edit") || tool.includes("write") || tool.includes("patch") || filePath.length > 0

      let s: SessionState | null = null
      if (looksLikeFileTouch && filePath) {
        s = this.state(input.sessionID)
        this.pushEditedFile(s, filePath)
      }

      if (input.tool !== "bash") return
      const args = input.args as { command?: unknown } | null | undefined
      const command = typeof args?.command === "string" ? args.command : ""
      if (!command) return
      const exitCode = typeof output.metadata?.exit === "number" ? output.metadata.exit : null
      const { category, result } = classify(command, output.output ?? "", exitCode)
      if (!category) return
      if (!s) s = this.state(input.sessionID)
      if (result === "failure") {
        const outputSlice = (output.output ?? "").trim().slice(0, 180)
        const summary = `${command.trim().slice(0, 100)} | exit=${exitCode === null ? "unknown" : String(exitCode)}${outputSlice ? ` | ${outputSlice}` : ""}`
        this.pushRecentError(s, summary)
      }
      if (category === "build") {
        if (result === "success") s.buildSuccess = true
        else if (result === "failure") s.buildSuccess = false
      } else if (category === "test") {
        if (result === "success") s.testPass = true
        else if (result === "failure") s.testPass = false
      } else if (category === "server") {
        if (result === "success") s.serverStart = true
      }
      this.maybeSetGreen(s)
      this.snapshot(s, `bash:${category}:${result}`)
    } catch (err) {
      this.log(`metrics: handleToolAfter error: ${String(err)}`)
    }
  }
}
