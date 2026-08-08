// plugins/bench-fixture-adapter.ts
//
// Predicate adapter for the bench-fixture command's "machine-readable reporter".
// A bench-fixture test command emits this report to its stdout so the plugin can
// attribute per-test pass/fail without re-running anything. This adapter is a
// PURE parser of ctx.output — it never runs commands.
//
// Reporter format v1:
//   - First line is the exact magic header: WEVIBE-BENCH-REPORT v1
//   - Each subsequent non-empty line is one JSONL record:
//       {"test":"<stable-id>","status":"fail"}  |  {"test":"<stable-id>","status":"pass"}
//   - <stable-id> is a per-test identity DECLARED in the fixture (e.g.
//     "suite:file::TestCase") — NOT discovery order. That is what makes partial
//     progress stable: a fixed test's record disappears or flips to pass, but
//     still-failing records keep IDENTICAL ids, so their failureKey stays the
//     same and their episode does not reset.
//   - Unknown/malformed/blank lines, records with a missing "test" or invalid
//     "status", and records whose status is neither "fail" nor "pass" are
//     ignored (robust to noise).

import type { PredicateAdapter, PredicateRunContext } from "./predicate-adapter"

export const BENCH_REPORT_HEADER = "WEVIBE-BENCH-REPORT v1"

// First non-empty line, whitespace-trimmed, must equal the magic header.
function hasReportHeader(output: string): boolean {
  for (const rawLine of output.split("\n")) {
    if (rawLine.trim() === "") continue
    return rawLine.trim() === BENCH_REPORT_HEADER
  }
  return false
}

type BenchRecordStatus = "fail" | "pass"

interface BenchRecord {
  test: string
  status: BenchRecordStatus
}

function parseRecord(line: string): BenchRecord | null {
  const trimmed = line.trim()
  if (trimmed === "") return null
  if (trimmed === BENCH_REPORT_HEADER) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const record = parsed as Record<string, unknown>
  const test = record["test"]
  if (typeof test !== "string" || test === "") return null
  const status = record["status"]
  if (status !== "fail" && status !== "pass") return null
  return { test, status }
}

// Extract ids for a status in file order, deduplicated (first occurrence wins).
// Order is NOT sorted — file order is the deterministic order; the plugin sorts
// if it needs to.
function extractIds(ctx: PredicateRunContext, wanted: BenchRecordStatus): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const rawLine of ctx.output.split("\n")) {
    const record = parseRecord(rawLine)
    if (record === null || record.status !== wanted) continue
    if (seen.has(record.test)) continue
    seen.add(record.test)
    ids.push(record.test)
  }
  return ids
}

export const benchFixtureAdapter: PredicateAdapter = {
  predicateId: "bench-fixture:v1",
  matches(ctx: PredicateRunContext): boolean {
    if (ctx.exitCode === null) return false
    return hasReportHeader(ctx.output)
  },
  extractFailingTestIds(ctx: PredicateRunContext): string[] {
    return extractIds(ctx, "fail")
  },
  extractPassingTestIds(ctx: PredicateRunContext): string[] {
    return extractIds(ctx, "pass")
  },
}