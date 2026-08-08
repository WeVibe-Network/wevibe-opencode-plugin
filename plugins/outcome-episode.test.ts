import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import {
  computeEpisodeRef,
  computeEvidenceRef,
  deriveDeterministicNonceHex,
  EpisodeTracker,
  type HarvestedOutcome,
  type OutcomeEvidence,
  type OutcomeResolution,
} from "./outcome-episode"

const cidA = "a".repeat(64)
const cidB = "b".repeat(64)
const cidC = "c".repeat(64)

function sha256Hex(preimage: string): string {
  return createHash("sha256").update(preimage, "utf8").digest("hex")
}

function assertHex64(value: string): void {
  assert.match(value, /^[0-9a-f]{64}$/)
}

function assertResolved(outcomes: HarvestedOutcome[], resolution: OutcomeResolution, cids: string[]): void {
  assert.equal(outcomes.length, cids.length)
  assert.deepEqual(outcomes.map((o) => o.memoryHash), cids)
  for (const outcome of outcomes) {
    assert.equal(outcome.resolution, resolution)
    assertHex64(outcome.episodeRef)
    assertHex64(outcome.evidenceRef)
  }
}

test("refs are deterministic with fixed preimage layouts", () => {
  const episodePreimage = "wevibe-episode-v1\norg-1\nsession-1\nneed:build"
  assert.equal(episodePreimage, ["wevibe-episode-v1", "org-1", "session-1", "need:build"].join("\n"))
  const episodeExpected = sha256Hex(episodePreimage)
  assert.equal(computeEpisodeRef("org-1", "session-1", "need:build"), episodeExpected)
  assertHex64(episodeExpected)

  const evidence: OutcomeEvidence = {
    kind: "build_green",
    tool: "bash",
    commandFp8: "1234abcd",
    preBuildFailing: true,
    preTestFailing: false,
    postBuildFailing: false,
    postTestFailing: false,
    exitCode: 0,
  }
  const evidencePreimage = "wevibe-evidence-v1\nbuild_green\nbash\n1234abcd\ntrue\nfalse\nfalse\nfalse\n0"
  assert.equal(
    evidencePreimage,
    ["wevibe-evidence-v1", "build_green", "bash", "1234abcd", "true", "false", "false", "false", "0"].join("\n"),
  )
  const evidenceExpected = sha256Hex(evidencePreimage)
  assert.equal(computeEvidenceRef(evidence), evidenceExpected)
  assertHex64(evidenceExpected)

  const nullExitEvidence: OutcomeEvidence = { ...evidence, kind: "episode_expired", exitCode: null }
  const nullExitPreimage = "wevibe-evidence-v1\nepisode_expired\nbash\n1234abcd\ntrue\nfalse\nfalse\nfalse\n"
  assert.equal(computeEvidenceRef(nullExitEvidence), sha256Hex(nullExitPreimage))
})

test("open to build red-green resolves worked=true once per cid then closes", () => {
  const tracker = new EpisodeTracker()
  assert.deepEqual(
    tracker.openEpisode({
      orgId: "org",
      sessionId: "s1",
      needSignature: "need-build",
      injectedCids: [cidA, cidB],
      triggers: ["build_transition"],
      failing: { build: true, test: false },
      openedAtTurn: 1,
    }),
    [],
  )

  const outcomes = tracker.observeToolResult({
    sessionId: "s1",
    tool: "bash",
    commandFp8: "11111111",
    exitCode: 0,
    pre: { buildFailing: true, testFailing: false },
    post: { buildFailing: false, testFailing: false },
  })
  assertResolved(outcomes, "worked", [cidA, cidB])

  assert.deepEqual(
    tracker.observeToolResult({
      sessionId: "s1",
      tool: "bash",
      commandFp8: "11111111",
      exitCode: 0,
      pre: { buildFailing: true, testFailing: false },
      post: { buildFailing: false, testFailing: false },
    }),
    [],
  )
})

test("test red-green resolves test_green", () => {
  const tracker = new EpisodeTracker()
  tracker.openEpisode({
    orgId: "org",
    sessionId: "s2",
    needSignature: "need-test",
    injectedCids: [cidA],
    triggers: ["test_transition"],
    failing: { build: false, test: true },
    openedAtTurn: 1,
  })

  const evidence: OutcomeEvidence = {
    kind: "test_green",
    tool: "bash",
    commandFp8: "22222222",
    preBuildFailing: false,
    preTestFailing: true,
    postBuildFailing: false,
    postTestFailing: false,
    exitCode: 0,
  }
  const outcomes = tracker.observeToolResult({
    sessionId: "s2",
    tool: "bash",
    commandFp8: "22222222",
    exitCode: 0,
    pre: { buildFailing: false, testFailing: true },
    post: { buildFailing: false, testFailing: false },
  })

  assertResolved(outcomes, "worked", [cidA])
  assert.equal(outcomes[0]?.evidenceRef, computeEvidenceRef(evidence))
})

test("command_green resolves after same tool records nonzero then exits zero", () => {
  const tracker = new EpisodeTracker()
  tracker.openEpisode({
    orgId: "org",
    sessionId: "s3",
    needSignature: "need-command",
    injectedCids: [cidA],
    triggers: ["exit_nonzero"],
    failing: { build: false, test: false },
    openedAtTurn: 1,
  })

  assert.deepEqual(
    tracker.observeToolResult({
      sessionId: "s3",
      tool: "bash",
      commandFp8: "33333333",
      exitCode: 2,
      pre: { buildFailing: false, testFailing: false },
      post: { buildFailing: false, testFailing: false },
    }),
    [],
  )
  assert.deepEqual(
    tracker.observeToolResult({
      sessionId: "s3",
      tool: "read",
      commandFp8: "33333333",
      exitCode: 0,
      pre: { buildFailing: false, testFailing: false },
      post: { buildFailing: false, testFailing: false },
    }),
    [],
  )

  const outcomes = tracker.observeToolResult({
    sessionId: "s3",
    tool: "bash",
    commandFp8: "33333333",
    exitCode: 0,
    pre: { buildFailing: false, testFailing: false },
    post: { buildFailing: false, testFailing: false },
  })
  assertResolved(outcomes, "worked", [cidA])
})

test("two idle turns expire resolution=unobserved (silence is not a vote)", () => {
  const tracker = new EpisodeTracker()
  tracker.openEpisode({
    orgId: "org",
    sessionId: "s4",
    needSignature: "need-expire",
    injectedCids: [cidA, cidB],
    triggers: [],
    failing: { build: true, test: false },
    openedAtTurn: 1,
  })

  assert.deepEqual(tracker.onSessionIdle("s4"), [])
  const outcomes = tracker.onSessionIdle("s4")
  assertResolved(outcomes, "unobserved", [cidA, cidB])
  assert.deepEqual(tracker.onSessionIdle("s4"), [])
})

test("opening a superseding need closes the old episode resolution=unobserved", () => {
  const tracker = new EpisodeTracker()
  tracker.openEpisode({
    orgId: "org",
    sessionId: "s5",
    needSignature: "old-need",
    injectedCids: [cidA],
    triggers: [],
    failing: { build: false, test: true },
    openedAtTurn: 1,
  })

  const expired = tracker.openEpisode({
    orgId: "org",
    sessionId: "s5",
    needSignature: "new-need",
    injectedCids: [cidB],
    triggers: [],
    failing: { build: false, test: false },
    openedAtTurn: 2,
  })
  assertResolved(expired, "unobserved", [cidA])
  assert.equal(expired[0]?.needSignature, "old-need")
})

test("invalid cids are dropped and cid cap keeps first 32 valid cids", () => {
  const drops: Array<{ cid: string; reason: string }> = []
  const tracker = new EpisodeTracker({ onDrop: (cid, reason) => drops.push({ cid, reason }) })
  const cids = Array.from({ length: 34 }, (_, index) => index.toString(16).padStart(64, "0"))
  tracker.openEpisode({
    orgId: "org",
    sessionId: "s6",
    needSignature: "need-cap",
    injectedCids: ["bad-cid", cidC.toUpperCase(), ...cids],
    triggers: [],
    failing: { build: true, test: false },
    openedAtTurn: 1,
  })

  const outcomes = tracker.closeSession("s6")
  assert.equal(outcomes.length, 32)
  assert.deepEqual(outcomes.map((o) => o.memoryHash), cids.slice(0, 32))
  assert.deepEqual(drops, [
    { cid: "bad-cid", reason: "invalid_cid" },
    { cid: cidC.toUpperCase(), reason: "invalid_cid" },
    { cid: cids[32] ?? "", reason: "episode_cid_cap" },
    { cid: cids[33] ?? "", reason: "episode_cid_cap" },
  ])
})

test("deriveDeterministicNonceHex is deterministic 16-hex and changes when resolution flips", () => {
  const episodeRef = computeEpisodeRef("org", "s7", "need")
  const workedNonce = deriveDeterministicNonceHex("org", cidA, episodeRef, "worked")
  const workedNonceAgain = deriveDeterministicNonceHex("org", cidA, episodeRef, "worked")
  const failedNonce = deriveDeterministicNonceHex("org", cidA, episodeRef, "unobserved")

  assert.match(workedNonce, /^[0-9a-f]{16}$/)
  assert.equal(workedNonce, workedNonceAgain)
  assert.notEqual(workedNonce, failedNonce)
})
