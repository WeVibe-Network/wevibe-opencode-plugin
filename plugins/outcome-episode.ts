// plugins/outcome-episode.ts
//
// Pure outcome episode tracker for the WeVibe OpenCode plugin use-leg harvester.
// D-MISSION-INVARIANT: refs are deterministic and content-free by construction.
// Hash inputs may include a failure key and command/file fingerprints, but the
// exported refs are opaque sha256 hex strings and never raw retrieved content.
// D-RECALL-EPISODE-IS-A-FAILURE (2026-08-08): an episode opens on the first red
// under a stable failureKey, accumulates attempts on each repeat red, and closes
// on green under the same key (worked) or on session end/idle (unobserved). A
// change of need signature no longer expires an episode — that single change is
// what makes repeats visible. Episodes are single-test-granular: the failureKey
// is per failing test, so partial progress opens one episode per still-failing
// test, and a green closes only the episodes whose stored testId is in the
// structured passing set (test-scoped); tripwire episodes (no test id) close
// only on the predicate-scoped fallback. Deterministic nonce derivation exists
// for retry idempotency: the same observed outcome yields the same nonce,
// therefore the same chain fingerprint, letting the hub deduplicate retries
// without changing the event identity.

import { createHash } from "node:crypto"

export type OutcomeResolutionKind = "build_green" | "test_green" | "command_green" | "episode_expired"

// E3 tri-state (WO-ATTRIB 2026-08-07): an episode that closes with no observed
// resolution emits "unobserved" — an observed fact about the close, never an
// inferred failure. Silence is not a vote.
export type OutcomeResolution = "worked" | "didnt_work" | "unobserved"

export interface OutcomeEvidence {
  kind: OutcomeResolutionKind
  tool: string
  commandFp8: string
  preBuildFailing: boolean
  preTestFailing: boolean
  postBuildFailing: boolean
  postTestFailing: boolean
  exitCode: number | null
}

export interface HarvestedOutcome {
  orgId: string
  sessionId: string
  episodeRef: string
  evidenceRef: string
  memoryHash: string
  resolution: OutcomeResolution
  needSignature: string
  // Defaults to "harvested" when absent. "user" marks a scripted gate / human
  // TUI verdict, not a harvested episode close.
  source?: "harvested" | "user"
}

interface EpisodeTrackerOptions {
  onDrop?: (cid: string, reason: string) => void
}

interface EpisodeState {
  orgId: string
  sessionId: string
  failureKey: string
  predicateId: string
  // Test identity this episode's failureKey was derived from. null = tripwire
  // (no structured failing test id, failureKey fell back to the command fp).
  testId: string | null
  episodeRef: string
  needSignature: string
  servedCids: string[]
  triggers: string[]
  openedAtTurn: number
  attempts: number
  fired: boolean
  idleTurns: number
  lastEvidence: OutcomeEvidence
}

const HASH_HEX_RE = /^[0-9a-f]{64}$/
const MAX_EPISODE_CIDS = 32
const EXPIRY_IDLE_TURNS = 2
const MAX_OPEN_EPISODES_PER_SESSION = 8

function sha256Hex(preimage: string): string {
  return createHash("sha256").update(preimage, "utf8").digest("hex")
}

function boolString(value: boolean): string {
  return value ? "true" : "false"
}

function evidencePreimage(evidence: OutcomeEvidence): string {
  // Fixed evidence preimage order:
  // kind, tool, commandFp8, preBuildFailing, preTestFailing,
  // postBuildFailing, postTestFailing, exitCode. Booleans are true/false;
  // absent/null exitCode is encoded as the empty string.
  return [
    "wevibe-evidence-v1",
    evidence.kind,
    evidence.tool,
    evidence.commandFp8,
    boolString(evidence.preBuildFailing),
    boolString(evidence.preTestFailing),
    boolString(evidence.postBuildFailing),
    boolString(evidence.postTestFailing),
    evidence.exitCode === null ? "" : String(evidence.exitCode),
  ].join("\n")
}

// episodeRef = f(org, session, failureKey) — the serve↔outcome pairing token
// (D-RECALL-PAIRING-TOKEN). sessionId stays in the preimage so the
// deterministic outcome nonce (org+memory+episodeRef+resolution) remains
// unique when two sessions of one org close the same failure.
export function computeEpisodeRef(orgId: string, sessionId: string, failureKey: string): string {
  return sha256Hex(`wevibe-episode-v2\n${orgId}\n${sessionId}\n${failureKey}`)
}

export function computeEvidenceRef(evidence: OutcomeEvidence): string {
  return sha256Hex(evidencePreimage(evidence))
}

// USER-VERDICT NAMESPACE (D3): a scripted gate answerer in a bench cell, or a
// human TUI review verdict, is a distinct USER-VERDICT event — NOT an episode
// close. Real episode refs live under the `wevibe-episode-v2` namespace keyed
// by (org, session, failureKey); that namespace must never be reused for a gate
// verdict because the deterministic outcome nonce (org + memoryHash +
// episodeRef + resolution) treats episodeRef as part of the event identity, so
// a collision would merge an episode close with a user verdict. This helper
// derives a ref under a disjoint namespace `wevibe-user-verdict-v1` whose
// preimage binds org + session + memoryHash + action. It is pure,
// deterministic, and provably cannot collide with any `wevibe-episode-v2` ref
// (different leading namespace token => different preimage => different hash).
export function computeUserVerdictRef(
  orgId: string,
  sessionId: string,
  memoryHash: string,
  action: "accept" | "deny",
): string {
  return sha256Hex(`wevibe-user-verdict-v1\n${orgId}\n${sessionId}\n${memoryHash}\n${action}`)
}

// Deterministic evidence ref for a user verdict. Real evidence refs derive
// from an OutcomeEvidence (kind/tool/commandFp8/failing flags/exitCode) via
// `wevibe-evidence-v1`; a gate verdict carries no such evidence, so faking an
// OutcomeEvidence would fabricate a command observation. This helper instead
// hashes a stable preimage under its own namespace token
// `wevibe-user-verdict-evidence-v1` binding the same decision identity (org,
// session, memoryHash, action) plus the decision timestamp.
export function computeUserVerdictEvidenceRef(
  orgId: string,
  sessionId: string,
  memoryHash: string,
  action: "accept" | "deny",
  timestampMs: number,
): string {
  return sha256Hex(
    `wevibe-user-verdict-evidence-v1\n${orgId}\n${sessionId}\n${memoryHash}\n${action}\n${timestampMs}`,
  )
}

export function deriveDeterministicNonceHex(
  orgId: string,
  memoryHashHex: string,
  episodeRefHex: string,
  resolution: OutcomeResolution,
): string {
  const preimage = `wevibe-event-nonce-v1\n${orgId}\n${memoryHashHex}\n${episodeRefHex}\nresolution=${resolution}`
  return sha256Hex(preimage).slice(0, 16)
}

export class EpisodeTracker {
  private episodes = new Map<string, EpisodeState>()
  private onDrop: (cid: string, reason: string) => void

  constructor(options: EpisodeTrackerOptions = {}) {
    this.onDrop = options.onDrop ?? (() => {})
  }

  private compositeKey(sessionId: string, failureKey: string): string {
    return `${sessionId}\n${failureKey}`
  }

  // First red under a failureKey opens the episode; a repeat red under the
  // same key accumulates an attempt and never expires the prior episode.
  openOrTouch(input: {
    orgId: string
    sessionId: string
    failureKey: string
    predicateId: string
    testId?: string | null
    needSignature: string
    triggers: string[]
    failing: { build: boolean; test: boolean }
    tool: string
    commandFp8: string
    exitCode: number | null
    openedAtTurn: number
  }): { opened: boolean; fired: boolean; episodeRef: string; attempts: number; expired: HarvestedOutcome[] } {
    const testId = input.testId ?? null
    const key = this.compositeKey(input.sessionId, input.failureKey)
    const evidence: OutcomeEvidence = {
      kind: "episode_expired",
      tool: input.tool,
      commandFp8: input.commandFp8,
      preBuildFailing: input.failing.build,
      preTestFailing: input.failing.test,
      postBuildFailing: input.failing.build,
      postTestFailing: input.failing.test,
      exitCode: input.exitCode,
    }

    const existing = this.episodes.get(key)
    if (existing) {
      existing.attempts += 1
      existing.needSignature = input.needSignature
      existing.testId = testId
      existing.idleTurns = 0
      existing.lastEvidence = evidence
      return { opened: false, fired: existing.fired, episodeRef: existing.episodeRef, attempts: existing.attempts, expired: [] }
    }

    const expired: HarvestedOutcome[] = []
    const sessionEpisodes = [...this.episodes.values()].filter((episode) => episode.sessionId === input.sessionId)
    if (sessionEpisodes.length >= MAX_OPEN_EPISODES_PER_SESSION) {
      const oldest = sessionEpisodes.reduce((a, b) => (a.openedAtTurn <= b.openedAtTurn ? a : b))
      expired.push(...this.expire(oldest))
    }

    const episodeRef = computeEpisodeRef(input.orgId, input.sessionId, input.failureKey)
    this.episodes.set(key, {
      orgId: input.orgId,
      sessionId: input.sessionId,
      failureKey: input.failureKey,
      predicateId: input.predicateId,
      testId,
      episodeRef,
      needSignature: input.needSignature,
      servedCids: [],
      triggers: [...input.triggers],
      openedAtTurn: input.openedAtTurn,
      attempts: 1,
      fired: false,
      idleTurns: 0,
      lastEvidence: evidence,
    })

    return { opened: true, fired: false, episodeRef, attempts: 1, expired }
  }

  markFired(sessionId: string, failureKey: string): void {
    const episode = this.episodes.get(this.compositeKey(sessionId, failureKey))
    if (episode) {
      episode.fired = true
    }
  }

  episodeRefFor(sessionId: string, failureKey: string): string | undefined {
    return this.episodes.get(this.compositeKey(sessionId, failureKey))?.episodeRef
  }

  recordServe(sessionId: string, failureKey: string, cids: string[]): void {
    const episode = this.episodes.get(this.compositeKey(sessionId, failureKey))
    if (!episode) return
    for (const cid of cids) {
      if (!HASH_HEX_RE.test(cid)) {
        this.onDrop(cid, "invalid_cid")
        continue
      }
      if (episode.servedCids.includes(cid)) {
        continue
      }
      if (episode.servedCids.length >= MAX_EPISODE_CIDS) {
        this.onDrop(cid, "episode_cid_cap")
        continue
      }
      episode.servedCids.push(cid)
    }
  }

  // Green closes the episode worked. Scope depends on the structured passing
  // test ids: empty/undefined (tripwire) is predicate-scoped — every open
  // episode under (sessionId, predicateId) closes, EXACTLY as today. A non-empty
  // passingTestIds is TEST-SCOPED — only episodes whose stored testId is in the
  // passing set close; episodes with a different testId (or null testId, which
  // carries no test identity) stay open with attempts intact. This is the
  // partial-progress model: a green for testA must not silently close testB's
  // still-failing episode. The tripwire path is a distinct fallback and is
  // never swept up by a structured test-scoped green.
  observeToolResult(input: {
    sessionId: string
    tool: string
    predicateId: string
    commandFp8: string
    exitCode: number | null
    pre: { buildFailing: boolean; testFailing: boolean }
    post: { buildFailing: boolean; testFailing: boolean }
    passingTestIds?: string[]
  }): HarvestedOutcome[] {
    if (input.exitCode !== 0) return []

    const passingTestIds = input.passingTestIds ?? []
    const testScoped = passingTestIds.length > 0
    const passingSet = new Set(passingTestIds)

    const outcomes: HarvestedOutcome[] = []
    for (const episode of [...this.episodes.values()]) {
      if (episode.sessionId !== input.sessionId) continue
      if (episode.predicateId !== input.predicateId) continue
      if (testScoped && !passingSet.has(episode.testId ?? "")) continue
      outcomes.push(...this.close(episode, "worked", {
        kind: this.greenKind(input),
        tool: input.tool,
        commandFp8: input.commandFp8,
        preBuildFailing: input.pre.buildFailing,
        preTestFailing: input.pre.testFailing,
        postBuildFailing: input.post.buildFailing,
        postTestFailing: input.post.testFailing,
        exitCode: input.exitCode,
      }))
    }
    return outcomes
  }

  onSessionIdle(sessionId: string): HarvestedOutcome[] {
    const outcomes: HarvestedOutcome[] = []
    for (const episode of [...this.episodes.values()]) {
      if (episode.sessionId !== sessionId) continue
      episode.idleTurns += 1
      if (episode.idleTurns >= EXPIRY_IDLE_TURNS) {
        outcomes.push(...this.expire(episode))
      }
    }
    return outcomes
  }

  closeSession(sessionId: string): HarvestedOutcome[] {
    const outcomes: HarvestedOutcome[] = []
    for (const episode of [...this.episodes.values()]) {
      if (episode.sessionId !== sessionId) continue
      outcomes.push(...this.expire(episode))
    }
    return outcomes
  }

  private greenKind(input: {
    pre: { buildFailing: boolean; testFailing: boolean }
    post: { buildFailing: boolean; testFailing: boolean }
  }): OutcomeResolutionKind {
    if (input.pre.buildFailing && !input.post.buildFailing) return "build_green"
    if (input.pre.testFailing && !input.post.testFailing) return "test_green"
    return "command_green"
  }

  private expire(episode: EpisodeState): HarvestedOutcome[] {
    return this.close(episode, "unobserved", { ...episode.lastEvidence, kind: "episode_expired" })
  }

  private close(episode: EpisodeState, resolution: OutcomeResolution, evidence: OutcomeEvidence): HarvestedOutcome[] {
    this.episodes.delete(this.compositeKey(episode.sessionId, episode.failureKey))
    const evidenceRef = computeEvidenceRef(evidence)
    return episode.servedCids.map((memoryHash) => ({
      orgId: episode.orgId,
      sessionId: episode.sessionId,
      episodeRef: episode.episodeRef,
      evidenceRef,
      memoryHash,
      resolution,
      needSignature: episode.needSignature,
    }))
  }
}
