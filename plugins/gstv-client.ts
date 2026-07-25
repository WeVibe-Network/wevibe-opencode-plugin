export interface GstvGoalOpen {
  open: true
  goal_id: string
  goal_text_fp: string
  predicate: {
    command: string
    file_paths: string[]
  }
  needs_boundary_run: boolean
  boundary_reason: string
}

export interface GstvGoalClosed {
  open: false
}

export type GstvGoal = GstvGoalOpen | GstvGoalClosed

export const GSTV_GOAL_TIMEOUT_MS = 2000

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0

const stringValue = (value: unknown): value is string => typeof value === "string"

const stringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string")

export async function fetchGstvGoal(opts: {
  mcpBase: string
  repoRoot: string
  token?: string | null
  traceId: string
  timeoutMs?: number
  fetchFn?: typeof fetch
}): Promise<GstvGoal | null> {
  const fetchImpl = opts.fetchFn ?? fetch
  const url = `${opts.mcpBase}/v1/gstv/goal?repo_root=${encodeURIComponent(opts.repoRoot)}`
  const headers: Record<string, string> = {
    "Accept": "application/json",
    "X-WeVibe-Trace-Id": opts.traceId,
  }
  if (opts.token && opts.token.length > 0) {
    headers.Authorization = `Bearer ${opts.token}`
  }

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(opts.timeoutMs ?? GSTV_GOAL_TIMEOUT_MS),
    })

    // Canonical production MCP does not expose this route; 404 is an honest
    // "GSTV unavailable in this session" signal, not a plugin error.
    if (response.status === 404) {
      return null
    }

    if (response.status !== 200) {
      return null
    }

    const payload = await response.json() as Record<string, unknown>
    if (payload.open === false) {
      return { open: false }
    }

    if (payload.open !== true) {
      return null
    }

    const predicateRaw = payload.predicate
    if (!predicateRaw || typeof predicateRaw !== "object") {
      return null
    }

    const predicate = predicateRaw as { command?: unknown; file_paths?: unknown }
    if (!nonEmptyString(payload.goal_id)) {
      return null
    }
    if (!stringValue(payload.goal_text_fp)) {
      return null
    }
    if (!stringValue(predicate.command)) {
      return null
    }
    if (!stringArray(predicate.file_paths)) {
      return null
    }
    if (typeof payload.needs_boundary_run !== "boolean") {
      return null
    }
    if (!stringValue(payload.boundary_reason)) {
      return null
    }

    return {
      open: true,
      goal_id: payload.goal_id,
      goal_text_fp: payload.goal_text_fp,
      predicate: {
        command: predicate.command,
        file_paths: predicate.file_paths,
      },
      needs_boundary_run: payload.needs_boundary_run,
      boundary_reason: payload.boundary_reason,
    }
  } catch {
    return null
  }
}
