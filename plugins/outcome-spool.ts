import { existsSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { join } from "node:path";

// @ts-expect-error tsx test runner resolves .ts extension imports.
import { deriveDeterministicNonceHex, type HarvestedOutcome, type OutcomeResolution } from "./outcome-episode.ts";
// @ts-expect-error tsx test runner resolves .ts extension imports.
import { excerpt, fp8 } from "./gstv-spool.ts";

export const OUTCOME_SPOOL_VERSION = "outcome-spool-v1" as const;
export const OUTCOME_SPOOL_SUBDIR = "outcome-spool";
export const OUTCOME_SPOOL_FILENAME = "outcome-spool-v1.jsonl";

export type OutcomeSpoolStatus = "pending" | "acked" | "terminal";

export interface OutcomeSpoolRecord {
  v: typeof OUTCOME_SPOOL_VERSION;
  seq: number;
  ts: string;
  org_id: string;
  session_id: string;
  memory_hash: string;
  episode_ref: string;
  evidence_ref: string;
  resolution: OutcomeResolution;
  source: "harvested" | "user";
  nonce_hex: string;
  status: OutcomeSpoolStatus;
  attempts: number;
  last_error?: string;
  next_attempt_at?: number;
}

export interface OutcomeSpool {
  readonly path: string;
  enqueue(outcome: HarvestedOutcome): void;
  flush(): Promise<void>;
  drainOnce(): Promise<{ posted: number; acked: number; failed: number }>;
  startBackgroundLoop(intervalMs: number): () => void;
  pendingCount(): number;
  statusOf(nonceHex: string): OutcomeSpoolStatus | undefined;
}

type LogLevel = "debug" | "info" | "warn" | "error";

interface OutcomeSpoolOptions {
  stateDir: string;
  mcpBase: string;
  getToken: () => string | null;
  getOrgActive: () => boolean;
  newTrace: () => string;
  fetchFn?: typeof fetch;
  log?: (level: LogLevel, msg: string, trace?: string) => void;
  nowMs?: () => number;
  requestTimeoutMs?: number;
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function backoffMs(attempts: number): number {
  return Math.min(60_000, 1000 * 2 ** Math.max(0, attempts - 1));
}

function safeLog(log: OutcomeSpoolOptions["log"], level: LogLevel, msg: string, trace?: string): void {
  try {
    log?.(level, msg, trace);
  } catch {
    // Host execution must never observe logging failures.
  }
}

function parseRecord(line: string): OutcomeSpoolRecord | null {
  try {
    const parsed = JSON.parse(line) as Partial<OutcomeSpoolRecord>;
    if (parsed.v !== OUTCOME_SPOOL_VERSION || typeof parsed.nonce_hex !== "string") {
      return null;
    }
    if (parsed.status !== "pending" && parsed.status !== "acked" && parsed.status !== "terminal") {
      return null;
    }
    if (typeof parsed.seq !== "number" || !Number.isInteger(parsed.seq) || parsed.seq < 0) {
      return null;
    }
    return parsed as OutcomeSpoolRecord;
  } catch {
    return null;
  }
}

export function createOutcomeSpool(opts: OutcomeSpoolOptions): OutcomeSpool {
  const dir = join(opts.stateDir, OUTCOME_SPOOL_SUBDIR);
  const path = join(dir, OUTCOME_SPOOL_FILENAME);
  const fetchFn = opts.fetchFn ?? fetch;
  const nowMs = opts.nowMs ?? (() => Date.now());
  const requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
  const latestByNonce = new Map<string, OutcomeSpoolRecord>();
  let nextSeq = 0;
  let queue: Promise<void> = Promise.resolve();
  let loggedNoToken = false;
  let loggedOrgInactive = false;

  const loadExisting = (): void => {
    if (!existsSync(path)) {
      return;
    }

    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      safeLog(opts.log, "error", `[outcome] resume read failed: ${toErrorMessage(err)}`);
      return;
    }

    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      const record = parseRecord(trimmed);
      if (!record) {
        continue;
      }
      nextSeq = Math.max(nextSeq, record.seq + 1);
      const previous = latestByNonce.get(record.nonce_hex);
      if (!previous || record.seq >= previous.seq) {
        latestByNonce.set(record.nonce_hex, record);
      }
    }
  };

  loadExisting();

  const appendRecord = (record: OutcomeSpoolRecord): void => {
    const line = `${JSON.stringify(record)}\n`;
    queue = queue
      .then(() => fs.mkdir(dir, { recursive: true }).then(() => fs.appendFile(path, line)))
      .catch((err: unknown) => {
        safeLog(opts.log, "error", `[outcome] write failed: ${toErrorMessage(err)}`);
      });
  };

  const replaceRecord = (
    current: OutcomeSpoolRecord,
    status: OutcomeSpoolStatus,
    fields: { attempts?: number; last_error?: string; next_attempt_at?: number } = {},
  ): OutcomeSpoolRecord => {
    const record: OutcomeSpoolRecord = {
      ...current,
      seq: nextSeq,
      ts: new Date(nowMs()).toISOString(),
      status,
      attempts: fields.attempts ?? current.attempts,
    };
    nextSeq += 1;
    if (fields.last_error !== undefined) {
      record.last_error = fields.last_error;
    }
    if (fields.next_attempt_at !== undefined) {
      record.next_attempt_at = fields.next_attempt_at;
    }
    latestByNonce.set(record.nonce_hex, record);
    appendRecord(record);
    return record;
  };

  const terminal = (record: OutcomeSpoolRecord, reason: string): void => {
    replaceRecord(record, "terminal", { last_error: reason });
    safeLog(opts.log, "warn", `[outcome] terminal nonce_fp=${fp8(record.nonce_hex)} reason=${excerpt(reason, 256)}`);
  };

  return {
    path,
    enqueue(outcome: HarvestedOutcome): void {
      try {
        const nonceHex = deriveDeterministicNonceHex(
          outcome.orgId,
          outcome.memoryHash,
          outcome.episodeRef,
          outcome.resolution,
        );
        const existing = latestByNonce.get(nonceHex);
        if (existing?.status === "pending" || existing?.status === "acked") {
          return;
        }

        const record: OutcomeSpoolRecord = {
          v: OUTCOME_SPOOL_VERSION,
          seq: nextSeq,
          ts: new Date(nowMs()).toISOString(),
          org_id: outcome.orgId,
          session_id: outcome.sessionId,
          memory_hash: outcome.memoryHash,
          episode_ref: outcome.episodeRef,
          evidence_ref: outcome.evidenceRef,
          resolution: outcome.resolution,
          source: "harvested",
          nonce_hex: nonceHex,
          status: "pending",
          attempts: 0,
        };
        nextSeq += 1;
        latestByNonce.set(nonceHex, record);
        appendRecord(record);
        safeLog(
          opts.log,
          "info",
          `[outcome] enqueue nonce_fp=${fp8(nonceHex)} cid_fp=${fp8(outcome.memoryHash)} resolution=${outcome.resolution} sid=${outcome.sessionId}`,
        );
      } catch (err) {
        safeLog(opts.log, "error", `[outcome] enqueue failed: ${toErrorMessage(err)}`);
      }
    },
    flush(): Promise<void> {
      return queue;
    },
    async drainOnce(): Promise<{ posted: number; acked: number; failed: number }> {
      await queue;
      const token = opts.getToken();
      if (token === null) {
        if (!loggedNoToken) {
          safeLog(opts.log, "debug", "[outcome] drain skipped token=null");
          loggedNoToken = true;
        }
        return { posted: 0, acked: 0, failed: 0 };
      }
      loggedNoToken = false;

      if (!opts.getOrgActive()) {
        if (!loggedOrgInactive) {
          safeLog(opts.log, "debug", "[outcome] drain skipped org_active=false");
          loggedOrgInactive = true;
        }
        return { posted: 0, acked: 0, failed: 0 };
      }
      loggedOrgInactive = false;

      let posted = 0;
      let acked = 0;
      let failed = 0;
      const due = [...latestByNonce.values()].filter(
        (record) => record.status === "pending" && (record.next_attempt_at ?? 0) <= nowMs(),
      );

      for (const record of due) {
        const latest = latestByNonce.get(record.nonce_hex);
        if (latest !== record || latest.status !== "pending") {
          continue;
        }

        const trace = opts.newTrace();
        const started = nowMs();
        posted += 1;
        try {
          const response = await fetchFn(
            `${opts.mcpBase}/v1/orgs/${encodeURIComponent(record.org_id)}/outcome-events`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
                "X-WeVibe-Trace-Id": trace,
              },
              body: JSON.stringify({
                org_id: record.org_id,
                memory_hash: record.memory_hash,
                episode_ref: record.episode_ref,
                resolution: record.resolution,
                source: record.source,
                evidence_ref: record.evidence_ref,
                session_id: record.session_id,
              }),
              signal: AbortSignal.timeout(requestTimeoutMs),
            },
          );
          const bodyText = await response.text().catch(() => "");
          const durMs = nowMs() - started;
          safeLog(
            opts.log,
            response.ok ? "info" : "warn",
            `[outcome] post result status=${response.ok ? "ok" : "failed"} http=${response.status} nonce_fp=${fp8(record.nonce_hex)} dur_ms=${durMs}`,
            trace,
          );

          if (response.ok) {
            replaceRecord(record, "acked");
            acked += 1;
            continue;
          }

          if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
            terminal(record, `http_${response.status}:${excerpt(bodyText, 512) ?? ""}`);
            failed += 1;
            continue;
          }

          const attempts = record.attempts + 1;
          if (attempts >= 8) {
            terminal(record, `attempts_exhausted:http_${response.status}:${excerpt(bodyText, 512) ?? ""}`);
          } else {
            replaceRecord(record, "pending", {
              attempts,
              last_error: `http_${response.status}:${excerpt(bodyText, 512) ?? ""}`,
              next_attempt_at: nowMs() + backoffMs(attempts),
            });
          }
          failed += 1;
        } catch (err) {
          const durMs = nowMs() - started;
          const attempts = record.attempts + 1;
          const message = toErrorMessage(err);
          safeLog(
            opts.log,
            "warn",
            `[outcome] post result status=failed http=network nonce_fp=${fp8(record.nonce_hex)} dur_ms=${durMs}`,
            trace,
          );
          if (attempts >= 8) {
            terminal(record, `attempts_exhausted:${excerpt(message, 512) ?? ""}`);
          } else {
            replaceRecord(record, "pending", {
              attempts,
              last_error: excerpt(message, 512),
              next_attempt_at: nowMs() + backoffMs(attempts),
            });
          }
          failed += 1;
        }
      }

      await queue;
      return { posted, acked, failed };
    },
    startBackgroundLoop(intervalMs: number): () => void {
      const interval = setInterval(() => {
        void this.drainOnce().catch((err: unknown) => {
          safeLog(opts.log, "error", `[outcome] drain failed: ${toErrorMessage(err)}`);
        });
      }, intervalMs);
      (interval as unknown as { unref?: () => void }).unref?.();
      return () => {
        clearInterval(interval);
      };
    },
    pendingCount(): number {
      return [...latestByNonce.values()].filter((record) => record.status === "pending").length;
    },
    statusOf(nonceHex: string): OutcomeSpoolStatus | undefined {
      return latestByNonce.get(nonceHex)?.status;
    },
  };
}
