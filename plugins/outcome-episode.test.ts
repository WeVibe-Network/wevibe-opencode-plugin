import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import {
  computeEpisodeRef,
  computeEvidenceRef,
  computeUserVerdictEvidenceRef,
  computeUserVerdictRef,
  deriveDeterministicNonceHex,
  EpisodeTracker,
  type HarvestedOutcome,
  type OutcomeEvidence,
  type OutcomeResolution,
} from "./outcome-episode"
import { computeFailureKey } from "./failure-key"

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

const keyA = computeFailureKey({ repoBinding: "repo", predicateId: "cmd:11111111", failingTest: null, commandFp8: "11111111" })
const keyB = computeFailureKey({ repoBinding: "repo", predicateId: "cmd:22222222", failingTest: null, commandFp8: "22222222" })

function openInput(overrides: Partial<Parameters<EpisodeTracker["openOrTouch"]>[0]> = {}) {
  return {
    orgId: "org",
    sessionId: "s1",
    failureKey: keyA,
    predicateId: "cmd:11111111",
    testId: "testA",
    needSignature: "need-build",
    triggers: ["build_transition"],
    failing: { build: true, test: false },
    tool: "bash",
    commandFp8: "11111111",
    exitCode: 1,
    openedAtTurn: 1,
    ...overrides,
  }
}

test("refs are deterministic with fixed preimage layouts", () => {
  const episodePreimage = "wevibe-episode-v2\norg-1\nsession-1\nfailure-key-1"
  assert.equal(episodePreimage, ["wevibe-episode-v2", "org-1", "session-1", "failure-key-1"].join("\n"))
  const episodeExpected = sha256Hex(episodePreimage)
  assert.equal(computeEpisodeRef("org-1", "session-1", "failure-key-1"), episodeExpected)
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

test("failureKey is stable across attempts and changes with failing test identity", () => {
  const base = { repoBinding: "repo", predicateId: "gstv:goal-1", commandFp8: "99999999" }
  const attempt1 = computeFailureKey({ ...base, failingTest: "pkg/foo.test.ts > renders" })
  const attempt2 = computeFailureKey({ ...base, failingTest: "pkg/foo.test.ts > renders" })
  assert.equal(attempt1, attempt2)

  const otherTest = computeFailureKey({ ...base, failingTest: "pkg/bar.test.ts > saves" })
  assert.notEqual(attempt1, otherTest)

  const tripwire = computeFailureKey({ repoBinding: "repo", predicateId: "cmd:99999999", failingTest: null, commandFp8: "99999999" })
  assertHex64(tripwire)
  assert.notEqual(tripwire, attempt1)
})

test("first red opens, repeat red accumulates attempts without expiring, green closes worked per served cid", () => {
  const tracker = new EpisodeTracker()
  const first = tracker.openOrTouch(openInput())
  assert.equal(first.opened, true)
  assert.equal(first.attempts, 1)
  assert.deepEqual(first.expired, [])

  tracker.recordServe("s1", keyA, [cidA, cidB])

  const repeat = tracker.openOrTouch(openInput({ needSignature: "need-build-attempt-2", exitCode: 1, openedAtTurn: 2 }))
  assert.equal(repeat.opened, false)
  assert.equal(repeat.attempts, 2)
  assert.equal(repeat.episodeRef, first.episodeRef)
  assert.deepEqual(repeat.expired, [])

  const outcomes = tracker.observeToolResult({
    sessionId: "s1",
    tool: "bash",
    predicateId: "cmd:11111111",
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
      predicateId: "cmd:11111111",
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
  tracker.openOrTouch(openInput({ sessionId: "s2", failureKey: keyB, predicateId: "cmd:22222222", commandFp8: "22222222", triggers: ["test_transition"], failing: { build: false, test: true } }))
  tracker.recordServe("s2", keyB, [cidA])

  const outcomes = tracker.observeToolResult({
    sessionId: "s2",
    tool: "bash",
    predicateId: "cmd:22222222",
    commandFp8: "22222222",
    exitCode: 0,
    pre: { buildFailing: false, testFailing: true },
    post: { buildFailing: false, testFailing: false },
  })

  assertResolved(outcomes, "worked", [cidA])
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
  assert.equal(outcomes[0]?.evidenceRef, computeEvidenceRef(evidence))
})

test("green under a different predicate does not close the episode", () => {
  const tracker = new EpisodeTracker()
  tracker.openOrTouch(openInput())
  tracker.recordServe("s1", keyA, [cidA])

  const outcomes = tracker.observeToolResult({
    sessionId: "s1",
    tool: "bash",
    predicateId: "cmd:55555555",
    commandFp8: "55555555",
    exitCode: 0,
    pre: { buildFailing: false, testFailing: false },
    post: { buildFailing: false, testFailing: false },
  })
  assert.deepEqual(outcomes, [])
})

test("a changed need signature under the same failureKey does not expire the episode", () => {
  const tracker = new EpisodeTracker()
  tracker.openOrTouch(openInput({ needSignature: "need-attempt-1" }))
  tracker.recordServe("s1", keyA, [cidA])

  const repeat = tracker.openOrTouch(openInput({ needSignature: "need-attempt-2-different-errors", openedAtTurn: 2 }))
  assert.equal(repeat.opened, false)
  assert.deepEqual(repeat.expired, [])

  const outcomes = tracker.observeToolResult({
    sessionId: "s1",
    tool: "bash",
    predicateId: "cmd:11111111",
    commandFp8: "11111111",
    exitCode: 0,
    pre: { buildFailing: true, testFailing: false },
    post: { buildFailing: false, testFailing: false },
  })
  assertResolved(outcomes, "worked", [cidA])
  assert.equal(outcomes[0]?.needSignature, "need-attempt-2-different-errors")
})

test("a different failureKey opens a second concurrent episode", () => {
  const tracker = new EpisodeTracker()
  tracker.openOrTouch(openInput())
  const second = tracker.openOrTouch(openInput({ failureKey: keyB, predicateId: "cmd:22222222", commandFp8: "22222222" }))
  assert.equal(second.opened, true)
  assert.notEqual(second.episodeRef, tracker.episodeRefFor("s1", keyA))

  tracker.recordServe("s1", keyA, [cidA])
  tracker.recordServe("s1", keyB, [cidB])

  const outcomesA = tracker.observeToolResult({
    sessionId: "s1",
    tool: "bash",
    predicateId: "cmd:11111111",
    commandFp8: "11111111",
    exitCode: 0,
    pre: { buildFailing: true, testFailing: false },
    post: { buildFailing: false, testFailing: false },
  })
  assertResolved(outcomesA, "worked", [cidA])
})

const keyTestA = computeFailureKey({ repoBinding: "repo", predicateId: "gstv:goal-1", failingTest: "testA", commandFp8: "99999999" })
const keyTestB = computeFailureKey({ repoBinding: "repo", predicateId: "gstv:goal-1", failingTest: "testB", commandFp8: "99999999" })

function testOpenInput(sessionId: string, testId: string, failureKey: string, openedAtTurn: number) {
  return openInput({ sessionId, testId, failureKey, predicateId: "gstv:goal-1", commandFp8: "99999999", openedAtTurn })
}

test("same test id red accumulates attempts under one key (single-test semantics)", () => {
  const tracker = new EpisodeTracker()
  const first = tracker.openOrTouch(testOpenInput("sA", "testA", keyTestA, 1))
  assert.equal(first.opened, true)
  assert.equal(first.attempts, 1)

  const repeat = tracker.openOrTouch(testOpenInput("sA", "testA", keyTestA, 2))
  assert.equal(repeat.opened, false)
  assert.equal(repeat.attempts, 2)
  assert.equal(repeat.episodeRef, first.episodeRef)
  assert.deepEqual(repeat.expired, [])
})

test("different test id red opens a SEPARATE episode under the same predicate", () => {
  const tracker = new EpisodeTracker()
  const a = tracker.openOrTouch(testOpenInput("sB", "testA", keyTestA, 1))
  const b = tracker.openOrTouch(testOpenInput("sB", "testB", keyTestB, 1))
  assert.equal(a.opened, true)
  assert.equal(b.opened, true)
  assert.notEqual(b.episodeRef, a.episodeRef)
})

test("green with passingTestIds closes ONLY the matching test episode, others stay open with attempts intact", () => {
  const tracker = new EpisodeTracker()
  const a = tracker.openOrTouch(testOpenInput("sC", "testA", keyTestA, 1))
  tracker.recordServe("sC", keyTestA, [cidA])
  const b = tracker.openOrTouch(testOpenInput("sC", "testB", keyTestB, 1))
  tracker.recordServe("sC", keyTestB, [cidB])
  // testB repeats a second time — attempts must survive the testA green.
  tracker.openOrTouch(testOpenInput("sC", "testB", keyTestB, 2))

  const outcomes = tracker.observeToolResult({
    sessionId: "sC",
    tool: "bash",
    predicateId: "gstv:goal-1",
    commandFp8: "99999999",
    exitCode: 0,
    pre: { buildFailing: true, testFailing: true },
    post: { buildFailing: false, testFailing: true },
    passingTestIds: ["testA"],
  })
  assertResolved(outcomes, "worked", [cidA])

  // testB episode stays open, served cid intact, and a later green for it closes.
  const again = tracker.observeToolResult({
    sessionId: "sC",
    tool: "bash",
    predicateId: "gstv:goal-1",
    commandFp8: "99999999",
    exitCode: 0,
    pre: { buildFailing: true, testFailing: true },
    post: { buildFailing: false, testFailing: false },
    passingTestIds: ["testB"],
  })
  assertResolved(again, "worked", [cidB])
})

test("green with empty/undefined passingTestIds closes every episode under the predicate (tripwire fallback)", () => {
  const tracker = new EpisodeTracker()
  tracker.openOrTouch(testOpenInput("sD", "testA", keyTestA, 1))
  tracker.recordServe("sD", keyTestA, [cidA])
  tracker.openOrTouch(testOpenInput("sD", "testB", keyTestB, 1))
  tracker.recordServe("sD", keyTestB, [cidB])

  const outcomes = tracker.observeToolResult({
    sessionId: "sD",
    tool: "bash",
    predicateId: "gstv:goal-1",
    commandFp8: "99999999",
    exitCode: 0,
    pre: { buildFailing: true, testFailing: true },
    post: { buildFailing: false, testFailing: false },
  })
  assert.equal(outcomes.length, 2)
  assert.deepEqual(outcomes.map((o) => o.memoryHash).sort(), [cidA, cidB])
})

test("a tripwire episode (null testId) is closed only by the predicate-scoped fallback, not a structured green", () => {
  const tracker = new EpisodeTracker()
  const trip = tracker.openOrTouch(openInput({ sessionId: "sE", testId: null, failureKey: keyA, predicateId: "cmd:11111111" }))
  assert.equal(trip.opened, true)
  tracker.recordServe("sE", keyA, [cidA])

  // A structured green naming a different test must NOT close the tripwire episode.
  const structured = tracker.observeToolResult({
    sessionId: "sE",
    tool: "bash",
    predicateId: "cmd:11111111",
    commandFp8: "11111111",
    exitCode: 0,
    pre: { buildFailing: true, testFailing: false },
    post: { buildFailing: false, testFailing: false },
    passingTestIds: ["testA"],
  })
  assert.deepEqual(structured, [])

  // The empty-list predicate-scoped green closes it.
  const fallback = tracker.observeToolResult({
    sessionId: "sE",
    tool: "bash",
    predicateId: "cmd:11111111",
    commandFp8: "11111111",
    exitCode: 0,
    pre: { buildFailing: true, testFailing: false },
    post: { buildFailing: false, testFailing: false },
  })
  assertResolved(fallback, "worked", [cidA])
})

test("red with N failing tests opens N separate episodes (per-failing-test partial progress)", () => {
  const tracker = new EpisodeTracker()
  const keyTestC = computeFailureKey({ repoBinding: "repo", predicateId: "gstv:goal-1", failingTest: "testC", commandFp8: "99999999" })
  const ids = ["testA", "testB", "testC"]
  const keys = [keyTestA, keyTestB, keyTestC]
  const refs = new Set<string>()
  for (let i = 0; i < ids.length; i += 1) {
    const opened = tracker.openOrTouch(testOpenInput("sF", ids[i] ?? "", keys[i] ?? "", 1))
    assert.equal(opened.opened, true)
    assert.equal(opened.attempts, 1)
    const ref = tracker.episodeRefFor("sF", keys[i] ?? "")
    assert.ok(ref, `episode ref present for ${ids[i]}`)
    refs.add(ref ?? "")
  }
  assert.equal(refs.size, ids.length, "each failing test gets a distinct episode")
})

test("two idle turns expire resolution=unobserved (silence is not a vote)", () => {
  const tracker = new EpisodeTracker()
  tracker.openOrTouch(openInput({ sessionId: "s4" }))
  tracker.recordServe("s4", keyA, [cidA, cidB])

  assert.deepEqual(tracker.onSessionIdle("s4"), [])
  const outcomes = tracker.onSessionIdle("s4")
  assertResolved(outcomes, "unobserved", [cidA, cidB])
  assert.deepEqual(tracker.onSessionIdle("s4"), [])
})

test("opening beyond the per-session cap expires the oldest episode unobserved", () => {
  const tracker = new EpisodeTracker()
  for (let i = 0; i < 8; i += 1) {
    const fp = String(i).padStart(8, "0")
    tracker.openOrTouch(openInput({ sessionId: "s5", failureKey: `key-${i}`, predicateId: `cmd:${fp}`, commandFp8: fp, openedAtTurn: i + 1 }))
  }
  tracker.recordServe("s5", "key-0", [cidA])

  const ninth = tracker.openOrTouch(openInput({ sessionId: "s5", failureKey: "key-8", predicateId: "cmd:88888888", commandFp8: "88888888", openedAtTurn: 9 }))
  assert.equal(ninth.opened, true)
  assertResolved(ninth.expired, "unobserved", [cidA])
})

test("markFired gates the once-per-key-per-session firing", () => {
  const tracker = new EpisodeTracker()
  tracker.openOrTouch(openInput())

  const repeat = tracker.openOrTouch(openInput({ openedAtTurn: 2 }))
  assert.equal(repeat.opened, false)
  assert.equal(repeat.fired, false)

  tracker.markFired("s1", keyA)

  const third = tracker.openOrTouch(openInput({ openedAtTurn: 3 }))
  assert.equal(third.fired, true)
})

test("invalid cids are dropped and cid cap keeps first 32 valid cids", () => {
  const drops: Array<{ cid: string; reason: string }> = []
  const tracker = new EpisodeTracker({ onDrop: (cid, reason) => drops.push({ cid, reason }) })
  tracker.openOrTouch(openInput({ sessionId: "s6" }))
  const cids = Array.from({ length: 34 }, (_, index) => index.toString(16).padStart(64, "0"))
  tracker.recordServe("s6", keyA, ["bad-cid", cidC.toUpperCase(), ...cids])

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
  const episodeRef = computeEpisodeRef("org", "s7", "failure-key")
  const workedNonce = deriveDeterministicNonceHex("org", cidA, episodeRef, "worked")
  const workedNonceAgain = deriveDeterministicNonceHex("org", cidA, episodeRef, "worked")
  const failedNonce = deriveDeterministicNonceHex("org", cidA, episodeRef, "unobserved")

  assert.match(workedNonce, /^[0-9a-f]{16}$/)
  assert.equal(workedNonce, workedNonceAgain)
  assert.notEqual(workedNonce, failedNonce)
})

// D3 user-verdict namespace: deterministic refs that provably cannot collide
// with real episode refs (different leading namespace token in the preimage).
test("computeUserVerdictRef is deterministic and lives in a disjoint namespace from episode refs", () => {
  const orgId = "org-uv"
  const sessionId = "sess-uv"
  const memoryHash = cidA
  const ref = computeUserVerdictRef(orgId, sessionId, memoryHash, "accept")
  const refAgain = computeUserVerdictRef(orgId, sessionId, memoryHash, "accept")
  const denyRef = computeUserVerdictRef(orgId, sessionId, memoryHash, "deny")
  const episodeRef = computeEpisodeRef(orgId, sessionId, "any-failure-key")

  assertHex64(ref)
  assert.equal(ref, refAgain)
  assert.notEqual(ref, denyRef)

  // Same inputs yield the identical hash as a reference sha256 over the exact
  // preimage, proving determinism against the documented preimage string.
  const expectedPreimage = `wevibe-user-verdict-v1\n${orgId}\n${sessionId}\n${memoryHash}\naccept`
  assert.equal(ref, sha256Hex(expectedPreimage))

  // The user-verdict namespace token is a distinct first line, so it can never
  // equal an episode-v2 ref even for arbitrary failure keys.
  assert.notEqual(ref, episodeRef)
})

test("computeUserVerdictEvidenceRef is deterministic and changes with action/timestamp", () => {
  const orgId = "org-uv"
  const sessionId = "sess-uv"
  const memoryHash = cidB
  const ts = 1_720_000_000_000
  const ref = computeUserVerdictEvidenceRef(orgId, sessionId, memoryHash, "accept", ts)
  const refAgain = computeUserVerdictEvidenceRef(orgId, sessionId, memoryHash, "accept", ts)
  const denyRef = computeUserVerdictEvidenceRef(orgId, sessionId, memoryHash, "deny", ts)
  const otherTsRef = computeUserVerdictEvidenceRef(orgId, sessionId, memoryHash, "accept", ts + 1)

  assertHex64(ref)
  assert.equal(ref, refAgain)
  assert.notEqual(ref, denyRef)
  assert.notEqual(ref, otherTsRef)

  const expectedPreimage = `wevibe-user-verdict-evidence-v1\n${orgId}\n${sessionId}\n${memoryHash}\naccept\n${ts}`
  assert.equal(ref, sha256Hex(expectedPreimage))
})

// The derived deterministic nonce uses the user-verdict episodeRef, so distinct
// verdicts must yield distinct nonces (no cross-verdict event identity merge).
test("user-verdict nonces stay distinct per (org, memory, verdict)", () => {
  const orgId = "org-uv"
  const sessionId = "sess-uv"
  const acceptRef = computeUserVerdictRef(orgId, sessionId, cidA, "accept")
  const denyRef = computeUserVerdictRef(orgId, sessionId, cidA, "deny")
  const acceptNonce = deriveDeterministicNonceHex(orgId, cidA, acceptRef, "worked")
  const denyNonce = deriveDeterministicNonceHex(orgId, cidA, denyRef, "didnt_work")
  const episodeRef = computeEpisodeRef(orgId, sessionId, "failure-key")
  const episodeNonce = deriveDeterministicNonceHex(orgId, cidA, episodeRef, "worked")

  assert.notEqual(acceptNonce, denyNonce)
  // A user verdict must not collide with a harvested episode close's nonce.
  assert.notEqual(acceptNonce, episodeNonce)
})
