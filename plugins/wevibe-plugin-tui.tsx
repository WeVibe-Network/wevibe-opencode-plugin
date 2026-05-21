/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { existsSync, readFileSync, writeFileSync, watchFile, unwatchFile, mkdirSync } from "fs"
import { join, dirname } from "path"

const STATE_DIRNAME = ".opencode"
const QUEUE_FILENAME = "wevibe-plugin-queue.json"
const DECISIONS_FILENAME = "wevibe-plugin-decisions.json"

const REPORT_REASONS = [
  { value: "inappropriate", label: "Inappropriate content" },
  { value: "inaccurate", label: "Inaccurate or misleading" },
  { value: "security", label: "Security concern" },
  { value: "policy", label: "Policy violation" },
  { value: "other", label: "Other" },
] as const

type ReportReason = (typeof REPORT_REASONS)[number]["value"]

interface PendingMemory {
  id: string
  cid: string
  text: string
  source: string
  createdAt: number
}

interface StoredDecision {
  memoryID: string
  action: "accept" | "deny" | "report"
  reason?: ReportReason
  note?: string
  timestamp: number
}

const readJson = <T,>(filePath: string, fallback: T): T => {
  try {
    if (!existsSync(filePath)) {
      return fallback
    }
    const data = readFileSync(filePath, "utf-8")
    return data.length === 0 ? fallback : JSON.parse(data)
  } catch {
    return fallback
  }
}

const writeJson = (filePath: string, value: unknown): void => {
  const serialized = `${JSON.stringify(value, null, 2)}\n`
  writeFileSync(filePath, serialized)
}

const ensureFile = (filePath: string, defaultContents: string): void => {
  const dir = dirname(filePath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  if (!existsSync(filePath)) {
    writeFileSync(filePath, defaultContents)
  }
}

const removeFromQueue = (queuePath: string, memoryID: string): void => {
  const queue = readJson<PendingMemory[]>(queuePath, [])
  const nextQueue = queue.filter(entry => entry.id !== memoryID)
  if (nextQueue.length !== queue.length) {
    writeJson(queuePath, nextQueue)
  }
}

const recordDecision = (
  decisionsPath: string,
  queuePath: string,
  decision: StoredDecision,
): void => {
  const decisions = readJson<StoredDecision[]>(decisionsPath, [])
  decisions.push(decision)
  writeJson(decisionsPath, decisions)
  removeFromQueue(queuePath, decision.memoryID)
}

const truncate = (value: string, max: number): string => {
  if (value.length <= max) return value
  return `${value.slice(0, max - 1)}…`
}

const showReviewDialog = (
  api: TuiPluginApi,
  memory: PendingMemory,
  queuePath: string,
  decisionsPath: string,
  onComplete: () => void,
) => {
  const { DialogSelect } = api.ui

  api.ui.dialog.replace(
    () => (
      <DialogSelect
        title="Memory Review"
        description={`Source: ${memory.source}\n\n"${truncate(memory.text, 200)}"`}
        options={[
          { value: "accept", label: "Accept — inject into session" },
          { value: "deny", label: "Deny — discard this memory" },
          { value: "report", label: "Report — submit for review and discard" },
        ]}
        onSelect={(value: string) => {
          if (value === "accept") {
            recordDecision(decisionsPath, queuePath, {
              memoryID: memory.id,
              action: "accept",
              timestamp: Date.now(),
            })
            api.ui.toast("Memory accepted")
            api.ui.dialog.clear()
            onComplete()
          } else if (value === "deny") {
            showDenyConfirm(api, memory, queuePath, decisionsPath, onComplete)
          } else if (value === "report") {
            showReportReasonDialog(api, memory, queuePath, decisionsPath, onComplete)
          }
        }}
      />
    ),
    () => {
      onComplete()
    },
  )
}

const showDenyConfirm = (
  api: TuiPluginApi,
  memory: PendingMemory,
  queuePath: string,
  decisionsPath: string,
  onComplete: () => void,
) => {
  const { DialogConfirm } = api.ui

  api.ui.dialog.replace(
    () => (
      <DialogConfirm
        title="Confirm Denial"
        description={`Deny this memory?\n\n"${truncate(memory.text, 120)}"`}
        confirmLabel="Yes, deny"
        cancelLabel="Go back"
        onConfirm={() => {
          recordDecision(decisionsPath, queuePath, {
            memoryID: memory.id,
            action: "deny",
            timestamp: Date.now(),
          })
          api.ui.toast("Memory denied")
          api.ui.dialog.clear()
          onComplete()
        }}
        onCancel={() => showReviewDialog(api, memory, queuePath, decisionsPath, onComplete)}
      />
    ),
  )
}

const showReportReasonDialog = (
  api: TuiPluginApi,
  memory: PendingMemory,
  queuePath: string,
  decisionsPath: string,
  onComplete: () => void,
) => {
  const { DialogSelect } = api.ui

  api.ui.dialog.replace(
    () => (
      <DialogSelect
        title="Select Reason for Report"
        description="Choose the most appropriate reason:"
        options={REPORT_REASONS.map(reason => ({
          value: reason.value,
          label: reason.label,
        }))}
        onSelect={(reason: string) => {
          showReportNoteDialog(
            api,
            memory,
            queuePath,
            decisionsPath,
            reason as ReportReason,
            onComplete,
          )
        }}
      />
    ),
  )
}

const showReportNoteDialog = (
  api: TuiPluginApi,
  memory: PendingMemory,
  queuePath: string,
  decisionsPath: string,
  reason: ReportReason,
  onComplete: () => void,
) => {
  const { DialogPrompt } = api.ui

  api.ui.dialog.replace(
    () => (
      <DialogPrompt
        title="Add a Note (Optional)"
        description="Provide additional context for the review team:"
        placeholder="Optional details..."
        onSubmit={(note: string) => {
          showReportConfirm(api, memory, queuePath, decisionsPath, reason, note, onComplete)
        }}
        onCancel={() => {
          showReportConfirm(api, memory, queuePath, decisionsPath, reason, "", onComplete)
        }}
      />
    ),
  )
}

const showReportConfirm = (
  api: TuiPluginApi,
  memory: PendingMemory,
  queuePath: string,
  decisionsPath: string,
  reason: ReportReason,
  note: string,
  onComplete: () => void,
) => {
  const { DialogConfirm } = api.ui
  const reasonLabel = REPORT_REASONS.find(item => item.value === reason)?.label ?? reason

  api.ui.dialog.replace(
    () => (
      <DialogConfirm
        title="Confirm Report Submission"
        description={[
          `Memory: "${truncate(memory.text, 80)}"`,
          `Reason: ${reasonLabel}`,
          note ? `Note: ${note}` : "",
          "",
          "This will submit a report and discard the memory.",
          "The memory will NOT be injected into the session.",
        ]
          .filter(Boolean)
          .join("\n")}
        confirmLabel="Yes, submit report"
        cancelLabel="Cancel"
        onConfirm={() => {
          recordDecision(decisionsPath, queuePath, {
            memoryID: memory.id,
            action: "report",
            reason,
            note: note.length > 0 ? note : undefined,
            timestamp: Date.now(),
          })
          api.ui.toast("Report submitted — memory discarded")
          api.ui.dialog.clear()
          onComplete()
        }}
        onCancel={() => {
          api.ui.dialog.clear()
          onComplete()
        }}
      />
    ),
  )
}

const plugin: TuiPlugin = async (api) => {
  const workspaceDir = api.state.path.directory
  const stateDir = join(workspaceDir, STATE_DIRNAME)
  const queuePath = join(stateDir, QUEUE_FILENAME)
  const decisionsPath = join(stateDir, DECISIONS_FILENAME)

  ensureFile(queuePath, "[]\n")
  ensureFile(decisionsPath, "[]\n")

  let activeMemory: string | null = null

  const openNext = () => {
    const queue = readJson<PendingMemory[]>(queuePath, [])
    if (queue.length === 0) {
      activeMemory = null
      api.ui.dialog.clear()
      return
    }

    const next = queue[0]
    if (activeMemory === next.id) {
      return
    }

    activeMemory = next.id
    showReviewDialog(api, next, queuePath, decisionsPath, () => {
      activeMemory = null
      setTimeout(openNext, 0)
    })
  }

  watchFile(queuePath, { interval: 500 }, openNext)
  const unsubscribe = api.event.on("message.updated", openNext)

  api.command.register(() => [
    {
      title: "Review Pending Memories",
      value: "wevibe-plugin.review",
      description: "Review, approve, deny, or report pending memory items",
      category: "WeVibe Guard",
      slash: { name: "review-memories" },
      onSelect: () => {
        const queue = readJson<PendingMemory[]>(queuePath, [])
        if (queue.length === 0) {
          api.ui.toast("No pending memories to review")
          return
        }
        activeMemory = queue[0]?.id ?? null
        showReviewDialog(api, queue[0], queuePath, decisionsPath, () => {
          activeMemory = null
          setTimeout(openNext, 0)
        })
      },
    },
  ])

  api.lifecycle.onDispose(() => {
    unwatchFile(queuePath)
    unsubscribe()
  })

  // Kick off initial check when plugin loads
  openNext()
}

export default {
  id: "wevibe-plugin.tui",
  tui: plugin,
}
