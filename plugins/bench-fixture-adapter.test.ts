import assert from "node:assert/strict"
import test from "node:test"

// @ts-expect-error tsx test runner resolves .ts extension imports.
import { BENCH_REPORT_HEADER, benchFixtureAdapter } from "./bench-fixture-adapter.ts"
import type { PredicateRunContext } from "./predicate-adapter"

const HEADER = BENCH_REPORT_HEADER

function ctx(output: string, exitCode: number | null = 1): PredicateRunContext {
  return { command: "bench-fixture", output, metadata: {}, exitCode }
}

test("mixed fail/pass records: matches true, fail ids and pass ids each in file order", () => {
  const output = [
    HEADER,
    '{"test":"suite:file::TestA","status":"fail"}',
    '{"test":"suite:file::TestB","status":"pass"}',
    '{"test":"suite:file::TestC","status":"fail"}',
  ].join("\n")
  const c = ctx(output, 1)
  assert.equal(benchFixtureAdapter.matches(c), true)
  assert.deepEqual(benchFixtureAdapter.extractFailingTestIds(c), [
    "suite:file::TestA",
    "suite:file::TestC",
  ])
  assert.deepEqual(benchFixtureAdapter.extractPassingTestIds(c), ["suite:file::TestB"])
})

test("all-pass output: failing ids empty, passing ids all in file order", () => {
  const output = [
    HEADER,
    '{"test":"suite:file::TestA","status":"pass"}',
    '{"test":"suite:file::TestB","status":"pass"}',
  ].join("\n")
  const c = ctx(output, 0)
  assert.equal(benchFixtureAdapter.matches(c), true)
  assert.deepEqual(benchFixtureAdapter.extractFailingTestIds(c), [])
  assert.deepEqual(benchFixtureAdapter.extractPassingTestIds(c), [
    "suite:file::TestA",
    "suite:file::TestB",
  ])
})

test("partial-progress stability: fixing B keeps A,C byte-identical and in order", () => {
  const idA = "suite:file::TestA"
  const idB = "suite:file::TestB"
  const idC = "suite:file::TestC"

  const run1 = ctx(
    [
      HEADER,
      `{"test":"${idA}","status":"fail"}`,
      `{"test":"${idB}","status":"fail"}`,
      `{"test":"${idC}","status":"fail"}`,
    ].join("\n"),
    1,
  )
  const before = benchFixtureAdapter.extractFailingTestIds(run1)
  assert.deepEqual(before, [idA, idB, idC])

  // B is now fixed: its record flips to pass. A and C still fail.
  const run2 = ctx(
    [
      HEADER,
      `{"test":"${idA}","status":"fail"}`,
      `{"test":"${idB}","status":"pass"}`,
      `{"test":"${idC}","status":"fail"}`,
    ].join("\n"),
    1,
  )
  const after = benchFixtureAdapter.extractFailingTestIds(run2)
  assert.deepEqual(after, [idA, idC])

  // The still-failing ids are byte-identical to their earlier values, so the
  // failureKey/episode is unchanged.
  assert.equal(after[0], before[0])
  assert.equal(after[1], before[2])
})

test("distinctive matches / no false positive", () => {
  // (a) output without the header at all -> matches false.
  const noHeader = ctx('{"test":"x","status":"fail"}', 1)
  assert.equal(benchFixtureAdapter.matches(noHeader), false)

  // (a) JSON that merely CONTAINS the magic string as a substring but not on
  // its own line -> matches false.
  const substringOnly = ctx('{"test":"WEVIBE-BENCH-REPORT v1 embedded","status":"fail"}', 1)
  assert.equal(benchFixtureAdapter.matches(substringOnly), false)

  // (b) header present but exitCode === null -> matches false.
  const headerNullExit = ctx(HEADER, null)
  assert.equal(benchFixtureAdapter.matches(headerNullExit), false)

  // (c) malformed records are ignored and never appear in extracted lists.
  const malformed = ctx(
    [
      HEADER,
      "this is not json",
      '{"status":"fail"}', // missing test
      '{"test":"suite:file::Skip","status":"skip"}', // invalid status
      '{"test":"suite:file::Bad","status":"flaky"}', // invalid status
      '{"test":"suite:file::Pass","status":"pass"}',
    ].join("\n"),
    1,
  )
  assert.equal(benchFixtureAdapter.matches(malformed), true)
  assert.deepEqual(benchFixtureAdapter.extractFailingTestIds(malformed), [])
  assert.deepEqual(benchFixtureAdapter.extractPassingTestIds(malformed), ["suite:file::Pass"])
})

test("dedupe: duplicate records for the same test id are extracted once", () => {
  const output = [
    HEADER,
    '{"test":"suite:file::TestA","status":"fail"}',
    '{"test":"suite:file::TestA","status":"fail"}',
    '{"test":"suite:file::TestB","status":"fail"}',
    '{"test":"suite:file::TestA","status":"fail"}',
    '{"test":"suite:file::TestB","status":"pass"}',
    '{"test":"suite:file::TestB","status":"pass"}',
  ].join("\n")
  const c = ctx(output, 1)
  assert.deepEqual(benchFixtureAdapter.extractFailingTestIds(c), [
    "suite:file::TestA",
    "suite:file::TestB",
  ])
  assert.deepEqual(benchFixtureAdapter.extractPassingTestIds(c), ["suite:file::TestB"])
})

test("header may have surrounding whitespace but is matched as its own line", () => {
  const output = [
    `  ${HEADER}  `,
    '{"test":"suite:file::TestA","status":"fail"}',
  ].join("\n")
  const c = ctx(output, 1)
  assert.equal(benchFixtureAdapter.matches(c), true)
  assert.deepEqual(benchFixtureAdapter.extractFailingTestIds(c), ["suite:file::TestA"])
})