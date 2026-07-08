import { readFile } from "node:fs/promises"
import { join } from "node:path"

export interface BindingState {
  active: boolean
  orgId?: string
  fingerprint?: string
  source?: string
  markerPath?: string
}

interface MarkerFile {
  org_id?: unknown
  project_fingerprint?: unknown
  fingerprint_source?: unknown
}

const inactive = (): BindingState => ({ active: false })

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0

const isNotFoundError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === "ENOENT"

const parseMarker = (raw: string, markerPath: string): BindingState => {
  const parsed = JSON.parse(raw) as MarkerFile
  if (!parsed || typeof parsed !== "object") {
    return inactive()
  }

  if (!isNonEmptyString(parsed.org_id) || !isNonEmptyString(parsed.project_fingerprint)) {
    return inactive()
  }

  return {
    active: true,
    orgId: parsed.org_id,
    fingerprint: parsed.project_fingerprint,
    source: isNonEmptyString(parsed.fingerprint_source) ? parsed.fingerprint_source : undefined,
    markerPath,
  }
}

export async function detectBinding(worktreeRoot: string): Promise<BindingState> {
  try {
    const markerDir = join(worktreeRoot, ".wevibe")
    const orgMarkerPath = join(markerDir, "org.json")
    const orgLocalMarkerPath = join(markerDir, "org.local.json")

    let markerPath = orgMarkerPath
    let markerRaw: string

    try {
      markerRaw = await readFile(markerPath, "utf-8")
    } catch (error) {
      if (!isNotFoundError(error)) {
        return inactive()
      }

      markerPath = orgLocalMarkerPath
      try {
        markerRaw = await readFile(markerPath, "utf-8")
      } catch {
        return inactive()
      }
    }

    return parseMarker(markerRaw, markerPath)
  } catch {
    return inactive()
  }
}
