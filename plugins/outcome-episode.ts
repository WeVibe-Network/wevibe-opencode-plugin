// plugins/outcome-episode.ts
//
// Pure outcome episode tracker for the WeVibe OpenCode plugin use-leg harvester.
// D-MISSION-INVARIANT: refs are deterministic and content-free by construction.
// Hash inputs may include a need signature and command/file fingerprints, but the
// exported refs are opaque sha256 hex strings and never raw retrieved content.
// Deterministic nonce derivation exists for retry idempotency: the same observed
// outcome yields the same nonce, therefore the same chain fingerprint, letting
// the hub deduplicate retries without changing the event identity.

import { createHash } from "node:crypto"

export type OutcomeResolutionKind = "build_green" | "test_green" | "command_green" | "episode_expired"

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
  worked: boolean
  needSignature: string
}

interface EpisodeTrackerOptions {
  onDrop?: (cid: string, reason: string) => void
}

interface EpisodeState {
  orgId: string
  sessionId: string
  needSignature: string
  episodeRef: string
  injectedCids: string[]
  triggers: string[]
  openedAtTurn: number
  openedWithFailing: { build: boolean; test: boolean }
  idleTurns: number
  failedTools: Set<string>
  lastEvidence: OutcomeEvidence
}

const HASH_HEX_RE = /^[0-9a-f]{64}$/
const MAX_EPISODE_CIDS = 32
const EXPIRY_IDLE_TURNS = 2

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

export function computeEpisodeRef(orgId: string, sessionId: string, needSignature: string): string {
  return sha256Hex(`wevibe-episode-v1\n${orgId}\n${sessionId}\n${needSignature}`)
}

export function computeEvidenceRef(evidence: OutcomeEvidence): string {
  return sha256Hex(evidencePreimage(evidence))
}

export function deriveDeterministicNonceHex(
  orgId: string,
  memoryHashHex: string,
  episodeRefHex: string,
  worked: boolean,
): string {
  const preimage = `wevibe-event-nonce-v1\n${orgId}\n${memoryHashHex}\n${episodeRefHex}\nworked=${worked ? "true" : "false"}`
  return sha256Hex(preimage).slice(0, 16)
}

export class EpisodeTracker {
  private sessions = new Map<string, EpisodeState>()
  private onDrop: (cid: string, reason: string) => void

  constructor(options: EpisodeTrackerOptions = {}) {
    this.onDrop = options.onDrop ?? (() => {})
  }

  openEpisode(input: {
    orgId: string
    sessionId: string
    needSignature: string
    injectedCids: string[]
    triggers: string[]
    failing: { build: boolean; test: boolean }
    openedAtTurn: number
  }): HarvestedOutcome[] {
    const existing = this.sessions.get(input.sessionId)
    const expired = existing && existing.needSignature !== input.needSignature ? this.expire(existing) : []

    const injectedCids = this.cleanInjectedCids(input.injectedCids)
    const episodeRef = computeEpisodeRef(input.orgId, input.sessionId, input.needSignature)
    this.sessions.set(input.sessionId, {
      orgId: input.orgId,
      sessionId: input.sessionId,
      needSignature: input.needSignature,
      episodeRef,
      injectedCids,
      triggers: [...input.triggers],
      openedAtTurn: input.openedAtTurn,
      openedWithFailing: { build: input.failing.build, test: input.failing.test },
      idleTurns: 0,
      failedTools: new Set<string>(),
      lastEvidence: {
        kind: "episode_expired",
        tool: "",
        commandFp8: "",
        preBuildFailing: input.failing.build,
        preTestFailing: input.failing.test,
        postBuildFailing: input.failing.build,
        postTestFailing: input.failing.test,
        exitCode: null,
      },
    })

    return expired
  }

  observeToolResult(input: {
    sessionId: string
    tool: string
    commandFp8: string
    exitCode: number | null
    pre: { buildFailing: boolean; testFailing: boolean }
    post: { buildFailing: boolean; testFailing: boolean }
  }): HarvestedOutcome[] {
    const episode = this.sessions.get(input.sessionId)
    if (!episode) return []

    const baseEvidence: OutcomeEvidence = {
      kind: "episode_expired",
      tool: input.tool,
      commandFp8: input.commandFp8,
      preBuildFailing: input.pre.buildFailing,
      preTestFailing: input.pre.testFailing,
      postBuildFailing: input.post.buildFailing,
      postTestFailing: input.post.testFailing,
      exitCode: input.exitCode,
    }
    episode.lastEvidence = baseEvidence

    if (input.exitCode !== null && input.exitCode !== 0) {
      episode.failedTools.add(input.tool)
      return []
    }

    const kind = this.resolutionKind(episode, input)
    if (!kind) return []

    return this.close(episode, true, { ...baseEvidence, kind })
  }

  onSessionIdle(sessionId: string): HarvestedOutcome[] {
    const episode = this.sessions.get(sessionId)
    if (!episode) return []

    episode.idleTurns += 1
    if (episode.idleTurns < EXPIRY_IDLE_TURNS) return []
    return this.expire(episode)
  }

  closeSession(sessionId: string): HarvestedOutcome[] {
    const episode = this.sessions.get(sessionId)
    if (!episode) return []
    return this.expire(episode)
  }

  private cleanInjectedCids(cids: string[]): string[] {
    const kept: string[] = []
    for (const cid of cids) {
      if (!HASH_HEX_RE.test(cid)) {
        this.onDrop(cid, "invalid_cid")
        continue
      }
      if (kept.length >= MAX_EPISODE_CIDS) {
        this.onDrop(cid, "episode_cid_cap")
        continue
      }
      kept.push(cid)
    }
    return kept
  }

  private resolutionKind(
    episode: EpisodeState,
    input: {
      tool: string
      exitCode: number | null
      pre: { buildFailing: boolean; testFailing: boolean }
      post: { buildFailing: boolean; testFailing: boolean }
    },
  ): OutcomeResolutionKind | null {
    if (input.pre.buildFailing && !input.post.buildFailing) return "build_green"
    if (input.pre.testFailing && !input.post.testFailing) return "test_green"
    if (
      !episode.openedWithFailing.build &&
      !episode.openedWithFailing.test &&
      input.exitCode === 0 &&
      episode.failedTools.has(input.tool)
    ) {
      return "command_green"
    }
    return null
  }

  private expire(episode: EpisodeState): HarvestedOutcome[] {
    return this.close(episode, false, { ...episode.lastEvidence, kind: "episode_expired" })
  }

  private close(episode: EpisodeState, worked: boolean, evidence: OutcomeEvidence): HarvestedOutcome[] {
    this.sessions.delete(episode.sessionId)
    const evidenceRef = computeEvidenceRef(evidence)
    return episode.injectedCids.map((memoryHash) => ({
      orgId: episode.orgId,
      sessionId: episode.sessionId,
      episodeRef: episode.episodeRef,
      evidenceRef,
      memoryHash,
      worked,
      needSignature: episode.needSignature,
    }))
  }
}
