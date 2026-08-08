// Funnel per-session seam counters (WO-TRIGGER-BUILD A8).
//
// COUNTERS ONLY: fingerprints / counts / ms. No secrets, no plaintext memory
// content, no org/session identifiers inside the payload beyond the sessionID
// map key (which is internal to the tracker). Snapshot values are plain
// numbers. This module is the single importable read surface used identically
// by production and the bench worker (which runs a vendored plugin copy).

export type FunnelSeam =
  | "episode_opened"
  | "episode_armed"
  | "recall_fired"
  | "gate_shown"
  | "gate_decided"
  | "serve_sent"

export interface FunnelCounters {
  episode_opened: number
  episode_armed: number
  recall_fired: number
  gate_shown: number
  gate_decided: number
  serve_sent: number
  /** Serve receipts confirmed on-chain (status=='submitted' AND tx_hash present). */
  confirmed_on_chain: number
  /** Wall-clock ms from gate shown to gate decided; null until endGate. */
  gate_decision_ms: number | null
}

const ZERO: FunnelCounters = {
  episode_opened: 0,
  episode_armed: 0,
  recall_fired: 0,
  gate_shown: 0,
  gate_decided: 0,
  serve_sent: 0,
  confirmed_on_chain: 0,
  gate_decision_ms: null,
}

export class FunnelCountersTracker {
  private readonly bySession = new Map<string, FunnelCounters>()
  private readonly gateStartAt = new Map<string, number>()

  private countersFor(sessionId: string): FunnelCounters {
    let counters = this.bySession.get(sessionId)
    if (!counters) {
      counters = { ...ZERO }
      this.bySession.set(sessionId, counters)
    }
    return counters
  }

  record(sessionId: string, seam: FunnelSeam): void {
    const counters = this.countersFor(sessionId)
    counters[seam] += 1
  }

  episodeOpened(sessionId: string): void {
    this.record(sessionId, "episode_opened")
  }

  episodeArmed(sessionId: string): void {
    this.record(sessionId, "episode_armed")
  }

  recallFired(sessionId: string): void {
    this.record(sessionId, "recall_fired")
  }

  gateShown(sessionId: string): void {
    this.record(sessionId, "gate_shown")
  }

  gateDecided(sessionId: string): void {
    this.record(sessionId, "gate_decided")
  }

  serveSent(sessionId: string): void {
    this.record(sessionId, "serve_sent")
  }

  /** Accumulate serve receipts confirmed on-chain (batch count from a confirm read). */
  recordConfirmed(sessionId: string, count: number): void {
    const counters = this.countersFor(sessionId)
    counters.confirmed_on_chain += count
  }

  /** Stamp the gate-shown timestamp for a session. */
  beginGate(sessionId: string): void {
    this.countersFor(sessionId)
    this.gateStartAt.set(sessionId, Date.now())
  }

  /** Measure gate-shown->decided wall-clock and store into gate_decision_ms. */
  endGate(sessionId: string): void {
    const start = this.gateStartAt.get(sessionId)
    if (start === undefined) return
    const counters = this.countersFor(sessionId)
    const ms = Date.now() - start
    counters.gate_decision_ms = ms >= 0 ? ms : 0
    this.gateStartAt.delete(sessionId)
  }

  /** Read accessor — plain-object snapshot for one session, or undefined. */
  snapshot(sessionId: string): FunnelCounters | undefined {
    const counters = this.bySession.get(sessionId)
    return counters ? { ...counters } : undefined
  }

  /** Read accessor — per-session snapshot map (values are plain objects). */
  snapshotAll(): Map<string, FunnelCounters> {
    const out = new Map<string, FunnelCounters>()
    for (const [sid, counters] of this.bySession) {
      out.set(sid, { ...counters })
    }
    return out
  }
}

// --- Module-level read surface (identical for production and bench) ---
// Plugin instances register their per-plugin-instance tracker here so the
// funnel read accessor can be reached by import without threading a reference
// through every hook. snapshot/snapshotAll aggregate across registered
// trackers; reset clears the registry (test isolation).

const registeredTrackers = new Set<FunnelCountersTracker>()

/** Create a per-plugin-instance tracker and register it for the read surface. */
export function createFunnelCountersTracker(): FunnelCountersTracker {
  const tracker = new FunnelCountersTracker()
  registeredTrackers.add(tracker)
  return tracker
}

/** Test isolation: drop all registered trackers. */
export function resetFunnelCountersTrackers(): void {
  registeredTrackers.clear()
}

/** Read accessor — snapshot for a session across registered trackers. */
export function snapshot(sessionId: string): FunnelCounters | undefined {
  for (const tracker of registeredTrackers) {
    const s = tracker.snapshot(sessionId)
    if (s) return s
  }
  return undefined
}

/** Read accessor — per-session map aggregated across registered trackers. */
export function snapshotAll(): Map<string, FunnelCounters> {
  const merged = new Map<string, FunnelCounters>()
  for (const tracker of registeredTrackers) {
    for (const [sid, counters] of tracker.snapshotAll()) {
      merged.set(sid, counters)
    }
  }
  return merged
}

/**
 * Serialize the full funnel snapshot as a flat JSON object mapping
 * sessionId -> FunnelCounters (e.g.
 * {"sess-1":{"episode_opened":1,...,"confirmed_on_chain":0,"gate_decision_ms":null}}).
 * Counts/ms only — never any secrets or plaintext memory content.
 */
export function serializeFunnelSnapshot(): string {
  return JSON.stringify(Object.fromEntries(snapshotAll()))
}