// plugins/failure-key.ts
//
// Stable failure identity (D-RECALL-KEY-SPLIT, 2026-08-08). Two keys derive
// from the same observation with opposite requirements and are never fused:
// failureKey is stable across attempts and is the episode identity;
// needSignature stays volatile query material (metrics.ts construction,
// unchanged). Derivation: predicate identity + a single failing test identity —
// test-granular when the predicate reporter supplies one; a tripwire-only
// observation falls back to the failing command fingerprint.

import { createHash } from "node:crypto"

export interface FailureObservation {
  repoBinding: string
  predicateId: string
  failingTest: string | null
  commandFp8: string
}

function sha256Hex(preimage: string): string {
  return createHash("sha256").update(preimage, "utf8").digest("hex")
}

export function computeFailureKey(obs: FailureObservation): string {
  const identity = obs.failingTest ?? `cmd:${obs.commandFp8}`
  return sha256Hex(`wevibe-failure-v1\n${obs.repoBinding}\n${obs.predicateId}\n${identity}`)
}
