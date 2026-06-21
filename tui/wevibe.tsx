// WeVibe onboarding + engagement hook for the opencode TUI (opencode >= 1.16).
//
// Registered via tui.json:  "plugin": [["<abs>/wevibe.tsx", { "adminScript": "<abs>/dist/admin.js" }]]
// Module shape per the TUI plugin spec: default export { id, tui }; no `server`.
//
// Surface (verified on 1.16.0): api.ui.DialogConfirm / DialogAlert via
// api.ui.dialog.replace(), api.ui.toast, api.keymap.registerLayer (slash
// commands), api.kv (persistence), api.event.on (session lifecycle).
//
// All privileged work (identity creation = Touch ID, pairing) is delegated to
// the `wevibe-admin` CLI via a child process.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { createSignal, Show } from "solid-js";

const SIDECAR_PATH = path.join(os.homedir(), ".wevibe", "identity.json");

function readSidecar(): any | null {
  try {
    return JSON.parse(fs.readFileSync(SIDECAR_PATH, "utf8"));
  } catch {
    return null;
  }
}

type AdminLoc = { node: string; script: string | null; bin: string };

interface PluginOptions {
  adminScript?: string;
  node?: string;
}

type QueueEntry = {
  id: string;
  cid: string;
  text: string;
  source: string;
  createdAt: number;
  [key: string]: unknown;
};

type ReportReason = "inappropriate" | "inaccurate" | "security" | "policy" | "other";

type QueueDecision = {
  memoryID: string;
  action: "accept" | "deny" | "report" | "block";
  reason?: ReportReason;
  note?: string;
  timestamp: number;
};

type RiskColor = "red" | "amber" | "green";
type RetrievalCardSection = { label: string; value: string };

// Conservative midpoint: anything below this on trust/confidence is caution.
const LOW_SIGNAL_THRESHOLD = 0.5;
const COMPACT_MAX_HEIGHT = 36;

const RISK_BADGE_BY_COLOR: Record<RiskColor, string> = {
  red: "🔴",
  amber: "🟡",
  green: "🟢",
};

const RISK_LABEL_BY_COLOR: Record<RiskColor, string> = {
  red: "Flagged",
  amber: "Caution",
  green: "Safe",
};

const asFiniteNumber = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
};

const asNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const asStringList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const values: string[] = [];
  for (const item of value) {
    const normalized = asNonEmptyString(item);
    if (normalized) values.push(normalized);
  }
  return values;
};

const trunc = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, Math.max(1, n - 1)) + "\u2026");

const RETRIEVAL_CARD_LABELS: Array<{ label: string; matcher: RegExp }> = [
  { label: "Applies when", matcher: /^\s*applies when\s*:\s*(.*)$/i },
  { label: "Stack", matcher: /^\s*stack\s*:\s*(.*)$/i },
  { label: "Implement", matcher: /^\s*implement\s*:\s*(.*)$/i },
  { label: "Avoid", matcher: /^\s*avoid\s*:\s*(.*)$/i },
  { label: "Anticipated need", matcher: /^\s*anticipated need\s*:\s*(.*)$/i },
];

const parseRetrievalCard = (text: string): RetrievalCardSection[] | null => {
  if (typeof text !== "string" || text.length === 0) return null;

  const lines = text.split(/\r?\n/);
  const sections: Array<{ label: string; valueLines: string[] }> = [];
  let current: { label: string; valueLines: string[] } | null = null;

  for (const line of lines) {
    let matched: { label: string; firstValue: string } | null = null;
    for (const candidate of RETRIEVAL_CARD_LABELS) {
      const hit = line.match(candidate.matcher);
      if (hit) {
        matched = { label: candidate.label, firstValue: (hit[1] ?? "").trim() };
        break;
      }
    }

    if (matched) {
      current = { label: matched.label, valueLines: [] };
      if (matched.firstValue.length > 0) {
        current.valueLines.push(matched.firstValue);
      }
      sections.push(current);
      continue;
    }

    if (current) {
      current.valueLines.push(line);
    }
  }

  if (sections.length === 0) return null;

  return sections.map((section) => ({
    label: section.label,
    value: section.valueLines.join("\n").trim(),
  }));
};

const riskColorForEntry = (entry: QueueEntry): RiskColor => {
  const guardPassed = typeof entry.guardPassed === "boolean" ? entry.guardPassed : undefined;
  const guardFlags = asStringList(entry.guardFlags);
  if (guardPassed === false || guardFlags.length > 0) return "red";

  const score = asFiniteNumber(entry.score);
  if (score !== null && score < LOW_SIGNAL_THRESHOLD) return "amber";

  return "green";
};

const THRESHOLD = 3;
const COOLDOWN_MS = 24 * 60 * 60 * 1000;
const KV_COUNTED = "wevibe.counted";
const KV_LAST_NUDGE_AT = "wevibe.lastNudgeAt";
const KV_LAST_NUDGE_N = "wevibe.lastNudgeN";
let endpointResolutionStarted = false;

async function locateAdmin(api: any, options: PluginOptions | undefined): Promise<AdminLoc> {
  const node = options?.node || process.execPath || "node";
  // 1) explicit option (baked by install-opencode)
  if (options?.adminScript) {
    return { node, script: options.adminScript, bin: "wevibe-admin" };
  }
  // 2) derive from the opencode MCP config: mcp.wevibe.command = ["node", ".../dist/server.js"]
  try {
    const cfg = await api?.client?.config?.get?.();
    const cmd = cfg?.data?.mcp?.wevibe?.command;
    if (Array.isArray(cmd) && typeof cmd[1] === "string") {
      const script = path.join(path.dirname(cmd[1]), "admin.js");
      return { node: typeof cmd[0] === "string" ? cmd[0] : node, script, bin: "wevibe-admin" };
    }
  } catch {
    /* fall through */
  }
  // 3) PATH fallback
  return { node, script: null, bin: "wevibe-admin" };
}

function runAdmin(loc: AdminLoc, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const file = loc.script ? loc.node : loc.bin;
    const argv = loc.script ? [loc.script, ...args] : args;
    let out = "";
    let err = "";
    try {
      const child = spawn(file, argv, { stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (d) => (out += d.toString()));
      child.stderr.on("data", (d) => (err += d.toString()));
      child.on("error", (e) => resolve({ code: -1, stdout: out, stderr: String(e) }));
      child.on("close", (code) => resolve({ code: code ?? -1, stdout: out, stderr: err }));
    } catch (e) {
      resolve({ code: -1, stdout: "", stderr: String(e) });
    }
  });
}

function parseLastJson(s: string): any {
  const lines = s.trim().split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      /* keep scanning upward */
    }
  }
  return null;
}

const tui = async (api: any, options: PluginOptions | undefined, _meta: unknown) => {
  const loc = await locateAdmin(api, options);
  let wevibeDialogActive = false;
  // True while a CORE opencode dialog (the `question` popup, a permission
  // prompt, the command palette, etc.) owns the shared dialog stack. We must
  // NEVER replace/clear that stack while a core dialog is up: doing so destroys
  // the core dialog's submit handler, which is what froze the question popup
  // (the answer never round-tripped → no `question.replied` → stuck "asking").
  let coreDialogOpen = false;

  // Is a core (non-WeVibe) dialog currently in control of the shared stack?
  // Three independent signals, any of which means "hands off":
  //   1. an event-tracked open flag (question.asked / permission.asked),
  //   2. a live probe of the dialog stack that isn't one of OUR dialogs,
  //   3. pending question/permission requests for the active session.
  const coreDialogBusy = (): boolean => {
    if (coreDialogOpen) return true;
    try {
      if (api?.ui?.dialog?.open && !wevibeDialogActive) return true;
    } catch {
      /* ignore */
    }
    try {
      const cur: any = api?.route?.current;
      const sid: string | undefined = cur?.params?.sessionID;
      if (sid && api?.state?.session) {
        const q = api.state.session.question?.(sid);
        if (Array.isArray(q) && q.length > 0) return true;
        const p = api.state.session.permission?.(sid);
        if (Array.isArray(p) && p.length > 0) return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  };

  const toast = (variant: string, message: string, duration?: number) => {
    try {
      api.ui.toast({ variant, title: "WeVibe", message, duration });
    } catch {
      /* ignore */
    }
  };
  const alert = (message: string) => {
    try {
      wevibeDialogActive = true;
      api.ui.dialog.replace(() =>
        api.ui.DialogAlert({
          title: "WeVibe",
          message,
          onConfirm: () => {
            wevibeDialogActive = false;
            api.ui.dialog.clear();
          },
        }),
      );
    } catch {
      wevibeDialogActive = false;
      /* ignore */
    }
  };
  const confirm = (message: string, onYes: () => void) => {
    try {
      wevibeDialogActive = true;
      api.ui.dialog.replace(() =>
        api.ui.DialogConfirm({
          title: "WeVibe",
          message,
          onConfirm: () => {
            wevibeDialogActive = false;
            api.ui.dialog.clear();
            onYes();
          },
          onCancel: () => {
            wevibeDialogActive = false;
            api.ui.dialog.clear();
          },
        }),
      );
    } catch {
      wevibeDialogActive = false;
      /* ignore */
    }
  };

  const kvGet = <T,>(key: string, fallback: T): T => {
    try {
      return api.kv.get(key, fallback) as T;
    } catch {
      return fallback;
    }
  };
  const kvSet = (key: string, value: unknown) => {
    try {
      api.kv.set(key, value);
    } catch {
      /* ignore */
    }
  };

  const isUsableDir = (p: unknown): p is string =>
    typeof p === "string" && p.length > 1 && p !== "/" && fs.existsSync(p);
  const wtWorktree = api?.state?.path?.worktree;
  const wtDirectory = api?.state?.path?.directory;
  const wtCwd = process.cwd();
  const writableFallback = path.join(os.homedir(), ".wevibe");
  const stateRoot =
    (isUsableDir(wtWorktree) ? wtWorktree : undefined) ??
    (isUsableDir(wtDirectory) ? wtDirectory : undefined) ??
    (isUsableDir(wtCwd) ? wtCwd : undefined) ??
    writableFallback;
  const stateDir = path.join(stateRoot, ".opencode");
  const queuePath = path.join(stateDir, "wevibe-plugin-queue.json");
  const decisionsPath = path.join(stateDir, "wevibe-plugin-decisions.json");
  const heartbeatPath = path.join(stateDir, "wevibe-tui-active.json");

  const ensureStateDir = () => {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
    } catch {
      /* ignore */
    }
  };

  const RISK_CONFIG_PATH = path.join(os.homedir(), ".wevibe", "plugin-config.json");

  const getRiskAppetite = (): "lowest" | "neutral" => {
    try {
      const raw = fs.readFileSync(RISK_CONFIG_PATH, "utf8");
      const parsed = JSON.parse(raw);
      return parsed?.risk_appetite === "lowest" ? "lowest" : "neutral";
    } catch {
      return "neutral";
    }
  };

  const setRiskAppetite = (value: "lowest" | "neutral"): void => {
    try {
      const dir = path.join(os.homedir(), ".wevibe");
      fs.mkdirSync(dir, { recursive: true });
      let current: Record<string, unknown> = {};
      try {
        current = JSON.parse(fs.readFileSync(RISK_CONFIG_PATH, "utf8"));
      } catch {
        current = {};
      }
      const next = { ...current, risk_appetite: value };
      fs.writeFileSync(RISK_CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    } catch {
      /* ignore */
    }
  };

  const readJsonArray = <T,>(filePath: string): T[] => {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  };

  const writeJsonArray = (filePath: string, value: unknown[]) => {
    try {
      ensureStateDir();
      fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      return true;
    } catch {
      return false;
      /* ignore */
    }
  };

  const readQueue = () =>
    readJsonArray<any>(queuePath).filter(
      (entry: any): entry is QueueEntry => entry && typeof entry.id === "string" && entry.id.length > 0,
    );

  const readQueueAsync = async (): Promise<QueueEntry[]> => {
    try {
      const raw = await fs.promises.readFile(queuePath, "utf8");
      const parsed = JSON.parse(raw);
      const queue = Array.isArray(parsed) ? parsed : [];
      return queue.filter(
        (entry: any): entry is QueueEntry => entry && typeof entry.id === "string" && entry.id.length > 0,
      );
    } catch {
      return [];
    }
  };

  const removeFromQueue = (id: string) => {
    try {
      const nextQueue = readQueue().filter((entry) => entry.id !== id);
      writeJsonArray(queuePath, nextQueue);
    } catch {
      /* ignore */
    }
  };

  const recordDecision = (decision: QueueDecision) => {
    try {
      const decisions = readJsonArray<QueueDecision>(decisionsPath);
      decisions.push(decision);
      if (writeJsonArray(decisionsPath, decisions)) {
        removeFromQueue(decision.memoryID);
      }
    } catch {
      /* ignore */
    }
  };

  const REVIEW_ROUTE = "wevibe-review";
  const [reviewEntry, setReviewEntry] = createSignal<QueueEntry | null>(null);
  let reviewReturnSessionID: string | undefined;
  let activeMemoryId: string | null = null;
  let reviewDialogNonce = 0;

  const openReviewDialog = (render: () => any, onClose: () => void) => {
    const nonce = ++reviewDialogNonce;
    wevibeDialogActive = true;
    try {
      api.ui.dialog.replace(render, () => {
        if (reviewDialogNonce !== nonce) return;
        wevibeDialogActive = false;
        onClose();
      });
    } catch {
      if (reviewDialogNonce === nonce) {
        wevibeDialogActive = false;
      }
      onClose();
    }
  };

  const finishReview = async () => {
    const queue = await readQueueAsync();
    const next = queue[0];
    if (next) {
      activeMemoryId = next.id;
      setReviewEntry(next);
      return;
    }
    activeMemoryId = null;
    setReviewEntry(null);
    const sessionID = reviewReturnSessionID;
    reviewReturnSessionID = undefined;
    if (sessionID) {
      api.route.navigate("session", { sessionID });
    } else {
      api.route.navigate("home");
    }
  };

  const decideReview = (entry: QueueEntry, action: "accept" | "deny" | "block", variant: string, message: string) => {
    recordDecision({ memoryID: entry.id, action, timestamp: Date.now() });
    toast(variant, message);
    void finishReview();
  };

  const openReviewReport = (entry: QueueEntry) => {
    showReportReasonDialog(entry);
  };

  const queueAdvance = () => {
    void finishReview();
  };

  const reportReasonOptions: Array<{ title: string; value: ReportReason; description: string }> = [
    { title: "Inappropriate", value: "inappropriate", description: "Content is abusive, offensive, or irrelevant" },
    { title: "Inaccurate", value: "inaccurate", description: "Memory is incorrect or misleading" },
    { title: "Security", value: "security", description: "Potential security or privacy risk" },
    { title: "Policy", value: "policy", description: "Violates policy or usage guidelines" },
    { title: "Other", value: "other", description: "Another issue not listed above" },
  ];

  const MemoryReview = (props: { entry: QueueEntry }) => {
    const theme = api?.theme?.current ?? {};
    const [selectedIndex, setSelectedIndex] = createSignal(0);
    const [armed, setArmed] = createSignal(false);
    const dim = useTerminalDimensions();
    const compact = dim().height < COMPACT_MAX_HEIGHT;

    const riskColor = riskColorForEntry(props.entry);
    const riskBadge = RISK_BADGE_BY_COLOR[riskColor];
    const riskLabel = RISK_LABEL_BY_COLOR[riskColor];
    const riskBorderColor = riskColor === "red" ? theme.error : riskColor === "amber" ? theme.warning : theme.success;

    const score = asFiniteNumber(props.entry.score);
    const vectorScore = asFiniteNumber(props.entry.vectorScore);
    const keywordScore = asFiniteNumber(props.entry.keywordScore);
    const memoryType = asNonEmptyString(props.entry.memoryType);
    const matchedKeywords = asStringList(props.entry.matchedKeywords);
    const guardFlags = asStringList(props.entry.guardFlags);
    const guardPassed = typeof props.entry.guardPassed === "boolean" ? props.entry.guardPassed : undefined;
    const guardFlagged = guardPassed === false || guardFlags.length > 0;
    const trustPanel = asNonEmptyString(props.entry.trustPanel);
    const cid = asNonEmptyString(props.entry.cid);
    const text = typeof props.entry.text === "string" ? props.entry.text : "";
    const cardSections = parseRetrievalCard(text);

    const relevanceSignals: string[] = [];
    if (vectorScore !== null) relevanceSignals.push(`sem ${Math.round(vectorScore * 100)}%`);
    if (keywordScore !== null) relevanceSignals.push(`kw ${Math.round(keywordScore * 100)}%`);
    const relevance =
      score !== null
        ? `${Math.round(score * 100)}%${relevanceSignals.length > 0 ? ` (${relevanceSignals.join(" · ")})` : ""}`
        : null;

    const detailRows: Array<{ label: string; value: string; fg?: string }> = [];
    if (relevance) {
      detailRows.push({ label: "Relevance", value: relevance });
    }
    if (memoryType) {
      detailRows.push({ label: "Type", value: memoryType });
    }
    if (matchedKeywords.length > 0) {
      detailRows.push({ label: "Matched", value: matchedKeywords.join(", ") });
    }
    detailRows.push({
      label: "Guard",
      value: guardFlagged ? `FLAGGED${guardFlags.length > 0 ? ` — ${guardFlags.join(", ")}` : ""}` : "clean",
      fg: guardFlagged ? theme.error : theme.success,
    });
    if (cid) {
      detailRows.push({ label: "Ref", value: cid.slice(0, 8) });
    }

    const renderInlineCard = () => (
      <box style={{ flexDirection: "column", width: "100%" }}>
        {cardSections ? (
          cardSections.map((section) => (
            <box style={{ flexDirection: "column", width: "100%" }}>
              <text>
                <span style={{ fg: theme.accent }}>{`${section.label}: `}</span>
                <span style={{ fg: theme.text }}>{section.value.replace(/\s*\n\s*/g, " ")}</span>
              </text>
            </box>
          ))
        ) : (
          <text>{text}</text>
        )}
      </box>
    );

    const actions: Array<{ label: string; description: string; run: () => void }> = [
      {
        label: "Accept",
        description: "Inject into context (records a serve)",
        run: () => decideReview(props.entry, "accept", "success", "Memory accepted"),
      },
      {
        label: "Deny",
        description: "Not useful now — hidden this session (corpus-neutral)",
        run: () => decideReview(props.entry, "deny", "info", "Memory denied"),
      },
      {
        label: "Block",
        description: "Never useful — permanent personal block",
        run: () => decideReview(props.entry, "block", "warning", "Memory blocked"),
      },
      {
        label: "Report",
        description: "Harmful or wrong — flag & escalate",
        run: () => openReviewReport(props.entry),
      },
    ];

    useKeyboard((evt: any) => {
      if (api.route.current?.name !== REVIEW_ROUTE) return;
      if (api.ui?.dialog?.open) return;

      const name = typeof evt?.name === "string" ? evt.name.toLowerCase() : "";
      if (name === "pageup" || name === "pagedown") {
        return;
      }

      if (armed()) {
        evt.preventDefault?.();
        evt.stopPropagation?.();

        if (name === "return" || name === "enter") {
          setArmed(false);
          const selected = actions[selectedIndex()] ?? actions[0];
          selected.run();
          return;
        }

        if (name === "escape") {
          setArmed(false);
          return;
        }

        return;
      }

      if (name === "up" || name === "k") {
        evt.preventDefault?.();
        evt.stopPropagation?.();
        setSelectedIndex((index) => (index + 3) % 4);
        return;
      }

      if (name === "down" || name === "j") {
        evt.preventDefault?.();
        evt.stopPropagation?.();
        setSelectedIndex((index) => (index + 1) % 4);
        return;
      }

      if (name === "return" || name === "enter") {
        evt.preventDefault?.();
        evt.stopPropagation?.();
        setArmed(true);
        return;
      }

      if (name === "escape") {
        evt.preventDefault?.();
        evt.stopPropagation?.();
        decideReview(props.entry, "deny", "info", "Memory denied");
        return;
      }

      if (name === "a") {
        evt.preventDefault?.();
        evt.stopPropagation?.();
        setSelectedIndex(0);
        return;
      }

      if (name === "d") {
        evt.preventDefault?.();
        evt.stopPropagation?.();
        setSelectedIndex(1);
        return;
      }

      if (name === "b") {
        evt.preventDefault?.();
        evt.stopPropagation?.();
        setSelectedIndex(2);
        return;
      }

      if (name === "r") {
        evt.preventDefault?.();
        evt.stopPropagation?.();
        setSelectedIndex(3);
      }
    });

    if (compact) {
      const pct = score !== null ? `${Math.round(score * 100)}%` : "—";
      const trustOneLine = trustPanel
        ? trustPanel
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .join(" · ")
        : "";
      const memoryTypeLabel = memoryType ?? "unknown";
      const refSegment = cid ? ` · ref ${cid.slice(0, 8)}` : "";

      return (
        <box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
          <text style={{ flexShrink: 0 }} fg={riskBorderColor}>
            {trunc(`${riskBadge} ${riskLabel} · ${pct} relevance · ${memoryTypeLabel}${refSegment}`, dim().width)}
          </text>

          <box
            border
            borderStyle="rounded"
            borderColor={theme.border}
            title="Memory"
            style={{ flexDirection: "column", flexGrow: 1, minHeight: 3, paddingLeft: 1, paddingRight: 1 }}
          >
            <scrollbox focused contentOptions={{ width: "100%" }} style={{ flexGrow: 1, minHeight: 0, width: "100%" }}>
              {renderInlineCard()}
            </scrollbox>
            <text style={{ flexShrink: 0 }} fg={theme.textMuted}>
              {trunc(`matched: ${matchedKeywords.join(", ") || "—"}${trustOneLine ? "  ·  " + trustOneLine : ""}`, dim().width - 3)}
            </text>
          </box>

          <box style={{ flexDirection: "row", width: "100%", flexShrink: 0 }}>
            {actions.map((action, index) => {
              const selected = selectedIndex() === index;
              return (
                <text fg={selected ? theme.background : theme.textMuted} bg={selected ? theme.primary : undefined}>
                  {selected ? ` ▶ ${action.label} ` : `   ${action.label} `}
                </text>
              );
            })}
          </box>

          <text style={{ flexShrink: 0 }} fg={theme.textMuted}>
            {armed()
              ? "⏎ Enter to confirm · Esc cancel"
              : "↑↓ select · Enter then Enter to confirm · PgUp/PgDn scroll · Esc deny"}
          </text>
        </box>
      );
    }

    return (
      <box style={{ flexDirection: "column", width: "100%", height: "100%", minHeight: 0, padding: 1 }}>
        <box border borderStyle="rounded" borderColor={riskBorderColor} style={{ flexDirection: "column", flexShrink: 0, padding: 1 }}>
          <text>{`${riskBadge} WeVibe — Review Memory     ·  ${riskLabel}`}</text>
        </box>

        <box border borderStyle="rounded" borderColor={theme.border} title="Details" style={{ flexDirection: "column", flexShrink: 0, padding: 1 }}>
          {detailRows.map((row) => (
            <box style={{ flexDirection: "row" }}>
              <text fg={theme.textMuted}>{`${row.label}: `}</text>
              <text fg={row.fg}>{row.value}</text>
            </box>
          ))}
        </box>

        {trustPanel ? (
          <box
            border
            borderStyle="rounded"
            borderColor={theme.border}
            title="Contributor / Trust"
            style={{ flexDirection: "column", flexShrink: 0, padding: 1 }}
          >
            {trustPanel.split(/\r?\n/).map((line) => (
              <text>{line}</text>
            ))}
          </box>
        ) : null}

        <box
          border
          borderStyle="rounded"
          borderColor={theme.border}
          title="Memory"
	          style={{ flexDirection: "column", flexGrow: 1, minHeight: 5, padding: 1 }}
        >
	          <scrollbox focused contentOptions={{ width: "100%" }} style={{ flexGrow: 1, minHeight: 0, width: "100%" }}>
	            {renderInlineCard()}
	          </scrollbox>
        </box>

        <box border borderStyle="rounded" borderColor={theme.border} title="Action" style={{ flexDirection: "column", flexShrink: 0, padding: 1 }}>
          {actions.map((action, index) => {
            const selected = selectedIndex() === index;
            const prefix = selected ? "▶ " : "  ";
            const confirmCue = armed() && selected ? " · ⏎ press Enter again to confirm · Esc to cancel" : "";
            return (
              <box backgroundColor={selected ? theme.primary : undefined} style={{ flexDirection: "row", width: "100%" }}>
                <text fg={selected ? theme.background : theme.textMuted}>{`${prefix}${action.label} — ${action.description}${confirmCue}`}</text>
              </box>
            );
          })}
        </box>

        <text style={{ flexShrink: 0 }} fg={theme.textMuted}>↑/↓ choose · Enter then Enter to confirm · PgUp/PgDn scroll · Esc = Deny</text>
      </box>
    );
  };

  const ReviewScreen = () => {
    const dim = useTerminalDimensions();

    return (
      <box style={{ width: dim().width, height: dim().height, flexDirection: "column" }}>
        <Show when={reviewEntry()} keyed>
          {(entry) => <MemoryReview entry={entry} />}
        </Show>
      </box>
    );
  };

  const showRiskDialog = () => {
    if (coreDialogBusy()) {
      toast("info", "Finish the current prompt first, then run /wevibe-risk.");
      return;
    }

    const current = getRiskAppetite();
    wevibeDialogActive = true;
    try {
      api.ui.dialog.replace(
        () =>
          api.ui.DialogSelect({
            title: "WeVibe — Risk appetite",
            placeholder: `Current: ${current}. 'lowest' = only negative-signal (avoid) memories are recalled; 'neutral' = default recall.`,
            options: [
              { title: "Neutral — default recall", value: "neutral" as const },
              { title: "Lowest — strictest filter (negative-signal only)", value: "lowest" as const },
            ],
            onSelect: (option: { value: "lowest" | "neutral" }) => {
              const value = option?.value;
              if (value === "lowest" || value === "neutral") {
                setRiskAppetite(value);
                toast("info", `Risk appetite set to ${value}`);
              }
              wevibeDialogActive = false;
              try {
                api.ui.dialog.clear();
              } catch {
                /* ignore */
              }
            },
          }),
        () => {
          wevibeDialogActive = false;
        },
      );
    } catch {
      wevibeDialogActive = false;
      /* ignore */
    }
  };

  const showReviewDialog = (entry: QueueEntry) => {
    const cur: any = api.route?.current;
    if (cur?.name === "session" && typeof cur?.params?.sessionID === "string") {
      reviewReturnSessionID = cur.params.sessionID;
    }
    setReviewEntry(entry);
    try {
      api.route.navigate(REVIEW_ROUTE);
    } catch {
      /* ignore */
    }
  };

  const showReviewActionConfirm = (
    entry: QueueEntry,
    config: {
      title: string;
      explainer: string;
      confirmTitle: string;
      onConfirm: () => void;
    },
  ) => {
    let handled = false;
    openReviewDialog(
      () =>
        api.ui.DialogSelect({
          title: config.title,
          placeholder: config.explainer,
          options: [
            { title: config.confirmTitle, value: "confirm" as const },
            { title: "Back", value: "back" as const },
          ],
          onSelect: (option: { value: "confirm" | "back" }) => {
            const selection = option?.value;
            handled = true;
            if (selection === "confirm") {
              config.onConfirm();
            } else {
              try {
                api.ui.dialog.clear();
              } catch {
                /* ignore */
              }
            }
          },
        }),
      () => {
        if (!handled) {
          try {
            api.ui.dialog.clear();
          } catch {
            /* ignore */
          }
        }
      },
    );
  };

  const showReportConfirm = (entry: QueueEntry, reason: ReportReason, noteInput?: string) => {
    const note = typeof noteInput === "string" ? noteInput.trim() : "";
    showReviewActionConfirm(entry, {
      title: "Report this memory?",
      explainer:
        `Reason: ${reason}${note ? `\nNote: ${note}` : ""}\n\n` +
        "Flag this memory with the selected reason and discard it from this review.\n" +
        "The report decision will be recorded.",
      confirmTitle: "Confirm Report",
      onConfirm: () => {
        const decision: QueueDecision = {
          memoryID: entry.id,
          action: "report",
          reason,
          timestamp: Date.now(),
        };
        if (note.length > 0) {
          decision.note = note;
        }
        recordDecision(decision);
        toast("warning", "Memory reported");
        try {
          api.ui.dialog.clear();
        } catch {
          /* ignore */
        }
        queueAdvance();
      },
    });
  };

  const showReportNotePrompt = (entry: QueueEntry, reason: ReportReason) => {
    openReviewDialog(
      () =>
        api.ui.DialogPrompt({
          title: "Report memory — optional note",
          placeholder: "Optional note",
          onConfirm: (value: string) => showReportConfirm(entry, reason, value),
          onCancel: () => showReportConfirm(entry, reason),
        }),
      () => {
        activeMemoryId = null;
      },
    );
  };

  const showReportReasonDialog = (entry: QueueEntry) => {
    openReviewDialog(
      () =>
        api.ui.DialogSelect({
          title: "Report memory — choose reason",
          options: reportReasonOptions,
          onSelect: (option: { value: ReportReason }) => {
            const reason = option?.value;
            if (reason === "inappropriate" || reason === "inaccurate" || reason === "security" || reason === "policy" || reason === "other") {
              showReportNotePrompt(entry, reason);
            } else {
              try {
                api.ui.dialog.clear();
              } catch {
                /* ignore */
              }
            }
          },
        }),
      () => {
        activeMemoryId = null;
      },
    );
  };

  const processQueue = async (force = false) => {
    // NEVER touch the dialog stack while a core dialog is up — even on an
    // explicit /wevibe-review. Replacing the stack here is exactly what froze
    // the question popup.
    if (coreDialogBusy()) {
      if (force) {
        toast("info", "Finish the current prompt first, then run /wevibe-review.");
      }
      return;
    }

    const routeName = api?.route?.current?.name;
    if (routeName !== "session") {
      if (force) {
        toast("info", "Open a session (submit a prompt) to review pending memories.");
      }
      return;
    }

    const queue = await readQueueAsync();
    if (queue.length === 0) {
      activeMemoryId = null;
      if (force) {
        toast("info", "No pending memories");
      }
      return;
    }

    if (!force && wevibeDialogActive && activeMemoryId === null) {
      return;
    }

    const next = queue[0];
    if (!force && activeMemoryId === next.id && wevibeDialogActive) {
      return;
    }

    activeMemoryId = next.id;
    showReviewDialog(next);
  };

  const writeHeartbeat = () => {
    try {
      ensureStateDir();
      void fs.promises.writeFile(heartbeatPath, `${JSON.stringify({ ts: Date.now() })}\n`, "utf8").catch(() => {});
    } catch {
      /* ignore */
    }
  };

  writeHeartbeat();
  const heartbeatInterval = setInterval(() => writeHeartbeat(), 10000);
  // Gentle, fully-guarded safety poll (was 1500ms, which churned the shared
  // dialog stack). processQueue() now bails instantly when the queue is empty
  // OR a core dialog is busy, so this can never clobber a question/permission
  // popup. It exists only to surface memories queued while the session is idle.
  const queueInterval = setInterval(() => void processQueue(), 5000);

  // Track the core-dialog lifecycle so we (a) stay off the stack while one is
  // up and (b) re-check the queue the moment it closes.
  const coreDialogUnsubs: Array<() => void> = [];
  const onCore = (type: string, handler: () => void) => {
    try {
      const unsub = api.event.on(type, handler);
      if (typeof unsub === "function") coreDialogUnsubs.push(unsub);
    } catch {
      /* ignore */
    }
  };
  onCore("question.asked", () => {
    coreDialogOpen = true;
  });
  onCore("permission.asked", () => {
    coreDialogOpen = true;
  });
  const onCoreClosed = () => {
    coreDialogOpen = false;
    setTimeout(() => void processQueue(), 0);
  };
  onCore("question.replied", onCoreClosed);
  onCore("question.rejected", onCoreClosed);
  onCore("permission.replied", onCoreClosed);

  let unsubscribeMessageUpdated: (() => void) | null = null;
  try {
    const unsubscribe = api.event.on("message.updated", () => void processQueue());
    if (typeof unsubscribe === "function") {
      unsubscribeMessageUpdated = unsubscribe;
    }
  } catch {
    /* ignore */
  }

  try {
    api.lifecycle.onDispose(() => {
      clearInterval(heartbeatInterval);
      clearInterval(queueInterval);
      try {
        unsubscribeMessageUpdated?.();
      } catch {
        /* ignore */
      }
      for (const unsub of coreDialogUnsubs) {
        try {
          unsub();
        } catch {
          /* ignore */
        }
      }
      try {
        fs.unlinkSync(heartbeatPath);
      } catch {
        /* ignore */
      }
    });
  } catch {
    /* dispose hook unavailable */
  }

  const getStatus = async () => parseLastJson((await runAdmin(loc, ["identity-status", "--json"])).stdout);

  if (!endpointResolutionStarted) {
    endpointResolutionStarted = true;
    runAdmin(loc, ["resolve-endpoints", "--json"])
      .then((r) => {
        const res = parseLastJson(r.stdout);
        const changed = Array.isArray(res?.changed) ? res.changed : [];
        const firstChangedOrgId =
          changed.find((entry: any) => entry && typeof entry.orgId === "string" && entry.orgId.length > 0)?.orgId ?? null;
        if (firstChangedOrgId) {
          toast("info", `Org ${firstChangedOrgId} updated its hub endpoint`, 6000);
        }
      })
      .catch(() => {
        /* best-effort */
      });
  }

  const createIdentity = () => {
    toast("info", "Creating your WeVibe identity — approve the Touch ID prompt…");
    runAdmin(loc, ["setup-identity", "--json"]).then((r) => {
      const res = parseLastJson(r.stdout);
      if (res?.status === "created") {
        alert(
          "WeVibe identity created \u2713\n\n" +
            "That's step 1 (your local keypair). Next, open app.wevibe.network to " +
            "join an org and become a contributor \u2014 contributing is how you earn " +
            "reputation & rewards. Run /wevibe-connect when you're ready.",
        );
      } else if (res?.status === "exists") {
        toast("info", "You already have a WeVibe identity.");
      } else if (/biometric|touch id|cancel/i.test(r.stderr)) {
        toast("warning", "Touch ID was cancelled — run /wevibe-setup to retry.", 6000);
      } else {
        toast("error", "Identity setup failed: " + (res?.error ?? r.stderr.slice(0, 140) ?? "unknown"), 8000);
      }
    });
  };

  const openDashboard = () => {
    toast("info", "Opening app.wevibe.network \u2014 join your org and contribute there\u2026");
    runAdmin(loc, ["export-pairing", "--open", "--json"]).then((r) => {
      const res = parseLastJson(r.stdout);
      if (res?.ok && res.opened) {
        toast("success", "Approve in your browser, then join your org to start contributing.", 7000);
      } else if (res?.ok && res.url) {
        toast("warning", "Open this to continue on the dashboard: " + res.url, 12000);
      } else {
        toast("error", "Couldn't open the dashboard: " + (r.stderr.slice(0, 140) || "unknown"), 8000);
      }
    });
  };

  // --- First-run onboarding -------------------------------------------------
  // Determine identity presence WITHOUT touching the keychain at startup (that
  // can raise a macOS keychain/Touch ID prompt). Prefer the non-secret sidecar
  // read over fs. Only if the sidecar is missing do we fall back to a (non-
  // biometric) CLI status probe — this covers legacy identities created before
  // sidecars existed.
  let identityPresent = false;
  let extracted = false;
  let adopted = false;

  const sc = readSidecar();
  if (sc?.ed25519PublicKey) {
    identityPresent = true;
    extracted = sc.extractedAt != null;
    adopted = sc.adoptedAt != null;
  } else {
    try {
      const status = await getStatus();
      if (status?.hasIdentity) {
        identityPresent = true;
        extracted = !!status.extracted;
        adopted = !!status.adopted;
        // Legacy identity with no sidecar — nudge to backfill, but don't nag with a modal.
        toast("info", "Finish WeVibe setup: run /wevibe-setup to refresh status.", 8000);
      }
    } catch {
      /* unknown — do not nag on error */
    }
  }

  if (!identityPresent) {
    // Small delay so the TUI is fully ready before the modal.
    setTimeout(() => {
      confirm(
        "No WeVibe identity detected.\n\n" +
          "Create your WeVibe identity now? This is step 1 (a local keypair). " +
          "You'll then join an org and contribute on app.wevibe.network.",
        createIdentity,
      );
    }, 900);
  }

  // --- Session-count nudge --------------------------------------------------
  const counted = new Set<string>(kvGet<string[]>(KV_COUNTED, []));

  const maybeNudge = () => {
    if (!identityPresent || extracted) return;
    if (coreDialogBusy()) return;
    const n = counted.size;
    if (n < THRESHOLD) return;
    const now = Date.now();
    const lastAt = kvGet<number>(KV_LAST_NUDGE_AT, 0);
    const lastN = kvGet<number>(KV_LAST_NUDGE_N, 0);
    if (now - lastAt < COOLDOWN_MS) return;
    if (n <= lastN) return;
    kvSet(KV_LAST_NUDGE_AT, now);
    kvSet(KV_LAST_NUDGE_N, n);
    confirm(
      adopted
        ? `You have ${n} coding sessions ready to contribute.\n\nOpen app.wevibe.network to contribute them?`
        : `You have ${n} coding sessions WeVibe can turn into contributions.\n\n` +
            `Open app.wevibe.network to join your org and start contributing? (Contributing is how you earn reputation & rewards.)`,
      openDashboard,
    );
  };

  const recordSession = (sessionID: unknown) => {
    if (typeof sessionID !== "string" || !sessionID) return;
    if (counted.has(sessionID)) return;
    counted.add(sessionID);
    kvSet(KV_COUNTED, [...counted]);
    maybeNudge();
  };

  const extractSessionId = (e: any): unknown =>
    e?.properties?.sessionID ?? e?.sessionID ?? e?.properties?.info?.id ?? e?.properties?.id;

  // session.idle is deprecated in favor of session.status; listen to both, dedupe by id.
  try {
    api.event.on("session.idle", (e: any) => recordSession(extractSessionId(e)));
  } catch {
    /* ignore */
  }
  try {
    api.event.on("session.status", (e: any) => {
      const status = e?.properties?.status?.type ?? e?.properties?.status;
      if (status === "idle" || status === undefined) recordSession(extractSessionId(e));
    });
  } catch {
    /* ignore */
  }

  // --- Slash commands / palette entries ------------------------------------
  try {
    api.route.register([{ name: REVIEW_ROUTE, render: () => <ReviewScreen /> }]);
  } catch {
    /* route API unavailable */
  }

  try {
    api.keymap.registerLayer({
      commands: [
        {
          name: "wevibe.setup",
          title: "WeVibe: Create / check identity",
          category: "WeVibe",
          namespace: "palette",
          slashName: "wevibe-setup",
          run: createIdentity,
        },
        {
          name: "wevibe.connect",
          title: "WeVibe: Open dashboard (join org & contribute)",
          category: "WeVibe",
          namespace: "palette",
          slashName: "wevibe-connect",
          run: openDashboard,
        },
        {
          name: "wevibe.status",
          title: "WeVibe: Show identity status",
          category: "WeVibe",
          namespace: "palette",
          slashName: "wevibe-status",
          run: () => {
            getStatus().then((s) => {
              if (!s) return toast("error", "Could not read WeVibe status.");
              if (!s.hasIdentity) return toast("info", "No WeVibe identity yet — run /wevibe-setup.");
              alert(
                `Identity: present\nKey: ${s.ed25519PublicKey ?? "(sidecar missing)"}\n` +
                  `Created: ${s.createdAt ?? "unknown"}\nExtracted: ${s.extracted}\n` +
                  `Sessions counted: ${counted.size}`,
              );
            });
          },
        },
        {
          name: "wevibe.review",
          title: "WeVibe: Review pending memories",
          category: "WeVibe",
          namespace: "palette",
          slashName: "wevibe-review",
          run: () => {
            const queue = readQueue();
            if (queue.length === 0) {
              toast("info", "No pending memories");
              return;
            }
            void processQueue(true);
          },
        },
        {
          name: "wevibe.risk",
          title: "WeVibe: Set recall risk appetite",
          category: "WeVibe",
          namespace: "palette",
          slashName: "wevibe-risk",
          run: () => {
            showRiskDialog();
          },
        },
      ],
    });
  } catch {
    /* keymap unavailable — slash commands simply won't register */
  }
};

export default { id: "wevibe", tui };
