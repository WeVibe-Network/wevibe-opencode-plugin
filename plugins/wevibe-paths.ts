import { join } from "node:path"
import { existsSync, realpathSync } from "node:fs"
import { createHash } from "node:crypto"

// Bind-gated path policy (Option A, Walter-locked 2026-07-07):
// - BOUND project (<root>/.wevibe/org.json or org.local.json present) -> keep
//   observability under <root>/.wevibe (Option C hygiene; behavior unchanged).
// - UNBOUND project -> route ALL working state (state/logs/runs) into a central
//   homedir dir keyed by the project fingerprint, so unbound repos stay clean
//   while every coding session is still captured for contribution.
// Fingerprint matches the bind CLI's realpath-source project_fingerprint
// (sha256 hex of the project realpath) so an unbound capture maps to the same
// project once bound. NOTE: the bind CLI's git-origin fingerprint branch is
// intentionally NOT replicated here (avoids blocking git subprocesses in the
// plugin factory; migrating pre-existing unbound data is out of scope). This
// logic is mirrored byte-for-behavior in tui/wevibe.tsx (raw-copied standalone,
// cannot import this module) and guarded by plugins/tui-statedir-guard.test.ts.
// See report 07-07-26-1028-tui-unbound-statedir-gate.md.
function isProjectBound(projectRoot: string): boolean {
  const markerDir = join(projectRoot, ".wevibe")
  return existsSync(join(markerDir, "org.json")) || existsSync(join(markerDir, "org.local.json"))
}

function projectFingerprint(projectRoot: string): string {
  let canonical = projectRoot
  try {
    canonical = realpathSync(projectRoot)
  } catch {
    // path not resolvable (e.g. deleted) -> hash the raw root; keeps a stable key.
  }
  return createHash("sha256").update(canonical, "utf8").digest("hex")
}

export function resolveScopedWeVibeDir(
  roots: { worktree?: string; directory?: string; cwd?: string; wevibeRoot?: string },
  homeDir: string,
): string {
  const firstUsableRoot = [roots.worktree, roots.directory, roots.cwd, roots.wevibeRoot].find(
    (root): root is string => typeof root === "string" && root.trim().length > 0,
  )

  // No project context at all -> legacy homedir root (unchanged).
  if (firstUsableRoot === undefined) {
    return join(homeDir, ".wevibe")
  }

  // Bound project -> unchanged in-project location.
  if (isProjectBound(firstUsableRoot)) {
    return join(firstUsableRoot, ".wevibe")
  }

  // Unbound project -> central per-project dir. scopedStateDir/scopedLogDir/
  // scopedRunsDir append state/logs/runs, yielding
  // ~/.wevibe/unbound/<fp>/{state,logs,runs}.
  return join(homeDir, ".wevibe", "unbound", projectFingerprint(firstUsableRoot))
}

export function scopedStateDir(scopedWeVibeDir: string): string {
  return join(scopedWeVibeDir, "state")
}

export function scopedLogDir(scopedWeVibeDir: string, envOverride?: string): string {
  if (typeof envOverride === "string" && envOverride.trim() !== "") {
    return envOverride
  }

  return join(scopedWeVibeDir, "logs")
}

export function scopedRunsDir(scopedWeVibeDir: string): string {
  return join(scopedWeVibeDir, "runs")
}
