// plugins/predicate-binding.ts
//
// Per-repo "predicate declared once" resolver (task 1c).
//
// A repository declares its predicate ONCE in `${repoRoot}/.wevibe/predicate.json`
// (a sibling of org.json, inside the SAME `.wevibe` marker dir). Because it sits
// in the `.wevibe` dir, it obeys the SAME spawn-root hard-gate as binding.ts: no
// parent/subdir walk — only the spawn-root marker counts.
//
// Declaration shape:
//   { "reporter": "bench-fixture", "command": "npm run bench" }
//
// `reporter` selects the predicate adapter; `command` is the predicate command.
// The predicate is resolved ONCE per repo (at bind time) and then REUSED — it is
// NOT re-derived per failure.
//
// This module is PLUGIN-LOCAL: it has no schema/DB impact. It only adapts the
// adapter-selection concern; the plugin wiring chunk consumes this module.

import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { PredicateAdapter } from "./predicate-adapter"
import { benchFixtureAdapter } from "./bench-fixture-adapter"

export interface PredicateDeclaration {
  reporter: string
  command: string
}

export interface ResolvedPredicate {
  adapter: PredicateAdapter
  command: string
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0

const isNotFoundError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === "ENOENT"

/**
 * Reads `${repoRoot}/.wevibe/predicate.json`.
 *
 * Returns `null` (never throws) on a missing file (ENOENT), a blank/empty
 * repoRoot, malformed JSON, or an invalid shape (missing/blank reporter or
 * command). This is a PASSIVE best-effort resolver: an unexpected read error
 * also yields `null` rather than throwing — an unreadable declaration must
 * never crash a tool call.
 */
export async function readPredicateDeclaration(
  repoRoot: string
): Promise<PredicateDeclaration | null> {
  if (!isNonEmptyString(repoRoot)) {
    return null
  }
  let raw: string
  try {
    raw = await readFile(join(repoRoot, ".wevibe", "predicate.json"), "utf-8")
  } catch {
    // ENOENT (missing declaration) and any other read error: unconfigured.
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null

  const declaration = parsed as Record<string, unknown>
  const reporter = declaration["reporter"]
  const command = declaration["command"]
  if (!isNonEmptyString(reporter) || !isNonEmptyString(command)) {
    return null
  }
  return { reporter, command }
}

/**
 * The single adapter-selection switch. Today only "bench-fixture" is wired;
 * any other reporter value is treated as unconfigured (returns `null`).
 */
function selectAdapter(reporter: string): PredicateAdapter | null {
  switch (reporter) {
    case "bench-fixture":
      return benchFixtureAdapter
    default:
      return null
  }
}

/**
 * Caches the resolved predicate PER repoRoot.
 *
 * We key by the resolved repoRoot and store `ResolvedPredicate | null`; a
 * parallel `Set` of resolved keys lets us distinguish "resolved to null
 * (unconfigured)" from "not yet resolved", so we do NOT re-read the file on
 * every tool call once a repo has been resolved.
 *
 * TRADEOFF (documented): caching a `null` (unconfigured) result is intentional.
 * The declaration file rarely appears, so if a repo resolves to unconfigured,
 * re-reading `predicate.json` on every tool call would be wasteful and would
 * defeat the "declared once, reused" requirement. `clearPredicateCache()`
 * (tests / bind refresh) is the escape hatch when a declaration appears later.
 */
const predicateCache = new Map<string, ResolvedPredicate | null>()
const resolvedKeys = new Set<string>()

/**
 * Resolves the predicate for a repo, REUSING the cached result when present
 * (resolved at bind time, not re-derived per failure). Returns `null` when the
 * repo has no declaration, an invalid declaration, or an unknown reporter.
 */
export async function resolvePredicateForRepo(
  repoRoot: string
): Promise<ResolvedPredicate | null> {
  if (resolvedKeys.has(repoRoot)) {
    return predicateCache.get(repoRoot) ?? null
  }

  const declaration = await readPredicateDeclaration(repoRoot)
  let resolved: ResolvedPredicate | null = null
  if (declaration !== null) {
    const adapter = selectAdapter(declaration.reporter)
    if (adapter !== null) {
      resolved = { adapter, command: declaration.command }
    }
  }

  predicateCache.set(repoRoot, resolved)
  resolvedKeys.add(repoRoot)
  return resolved
}

/** Returns the cached resolution for a repo (never resolves). */
export function getCachedPredicate(repoRoot: string): ResolvedPredicate | null {
  if (!resolvedKeys.has(repoRoot)) {
    return null
  }
  return predicateCache.get(repoRoot) ?? null
}

/** Empties the resolution cache (tests / bind refresh). */
export function clearPredicateCache(): void {
  predicateCache.clear()
  resolvedKeys.clear()
}