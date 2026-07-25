import type { Spool } from "./gstv-spool"
import { fetchGstvGoal } from "./gstv-client"

export const GSTV_BOUNDARY_TIMEOUT_MS = 120_000

export interface GstvHookDeps {
  spool: Spool
  mcpBase: string
  repoRoot: string
  token?: string | null
  newTrace: () => string
  runCommand: (command: string, timeoutMs: number) => Promise<{ exitCode: number; durationMs: number }>
  fetchFn?: typeof fetch
}

export async function onSessionCreated(deps: GstvHookDeps, sessionId: string): Promise<void> {
  try {
    const trace = deps.newTrace()
    const goal = await fetchGstvGoal({
      mcpBase: deps.mcpBase,
      repoRoot: deps.repoRoot,
      token: deps.token,
      traceId: trace,
      fetchFn: deps.fetchFn,
    })

    if (goal?.open) {
      deps.spool.append({
        sessionId,
        traceId: trace,
        event: "gstv.attach.attempt",
        payload: { goal_id: goal.goal_id },
      })
    }
  } catch {
    // Never throw from passive sensor hooks.
  }
}

export async function onSessionIdle(deps: GstvHookDeps, sessionId: string, boundaryRan: Set<string>): Promise<void> {
  try {
    const trace = deps.newTrace()
    const goal = await fetchGstvGoal({
      mcpBase: deps.mcpBase,
      repoRoot: deps.repoRoot,
      token: deps.token,
      traceId: trace,
      fetchFn: deps.fetchFn,
    })

    if (!goal?.open || !goal.needs_boundary_run || boundaryRan.has(goal.goal_id)) {
      return
    }

    boundaryRan.add(goal.goal_id)
    let result: { exitCode: number; durationMs: number }
    try {
      result = await deps.runCommand(goal.predicate.command, GSTV_BOUNDARY_TIMEOUT_MS)
    } catch {
      result = { exitCode: -1, durationMs: 0 }
    }

    deps.spool.append({
      sessionId,
      traceId: trace,
      event: "gstv.boundary.run",
      payload: {
        goal_id: goal.goal_id,
        command: goal.predicate.command,
        exit_code: result.exitCode,
        duration_ms: result.durationMs,
      },
    })
  } catch {
    // Never throw from passive sensor hooks.
  }
}
