import { createHash } from "node:crypto";
import { existsSync, openSync, closeSync, fstatSync, readFileSync, readSync } from "node:fs";
import { promises as fs } from "node:fs";
import { join } from "node:path";

// SPOOL-V1 is a local evidence file (never shipped) with schema pinned under
// D-BENCH-INTEGRITY. Any schema change is a substrate change and requires a
// version bump with a fresh pre-registered baseline.
// Authoritative spec: wevibe-meta/workspace/docs/SPOOL-V1.md.
export const SPOOL_VERSION = "spool-v1" as const;
export const SPOOL_SUBDIR = "spool";
export const SPOOL_FILENAME = "spool-v1.jsonl";
export const MAX_EXCERPT_CHARS = 2048;
export const TRUNCATION_MARKER = "…[truncated]";
export const MAX_DIAGNOSTICS = 50;

const LARGE_FILE_BYTES = 64 * 1024 * 1024;
const TAIL_READ_BYTES = 64 * 1024;

export type SpoolEventName =
  | "session.created"
  | "session.idle"
  | "session.error"
  | "tool.execute.before"
  | "tool.execute.after"
  | "file.edited"
  | "file.watcher.updated"
  | "lsp.client.diagnostics"
  | "command.executed"
  | "gstv.attach.attempt"
  | "gstv.boundary.run";

export interface SpoolRecord {
  v: typeof SPOOL_VERSION;
  seq: number;
  ts: string;
  session_id: string;
  trace_id: string | null;
  event: SpoolEventName;
  payload: Record<string, unknown>;
}

export interface SpoolAppend {
  sessionId: string;
  traceId?: string | null;
  event: SpoolEventName;
  payload?: Record<string, unknown>;
}

export interface Spool {
  readonly path: string;
  readonly enabled: boolean;
  append(input: SpoolAppend): void;
  flush(): Promise<void>;
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function countCompleteLines(text: string, startedMidFile: boolean): number {
  if (text.length === 0) {
    return 0;
  }

  let lines = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") {
      lines += 1;
    }
  }

  if (startedMidFile && text[0] !== "\n" && lines > 0) {
    lines -= 1;
  }

  return lines;
}

function parseNextSeqFromText(text: string): number {
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline < 0) {
    throw new Error("spool has no complete line");
  }

  const upToLastCompleteLine = text.slice(0, lastNewline);
  const previousNewline = upToLastCompleteLine.lastIndexOf("\n");
  const line = upToLastCompleteLine.slice(previousNewline + 1).trim();
  if (line.length === 0) {
    throw new Error("last complete line is empty");
  }

  const parsed = JSON.parse(line) as { seq?: unknown };
  if (typeof parsed.seq !== "number" || !Number.isInteger(parsed.seq) || parsed.seq < 0) {
    throw new Error("last complete line has invalid seq");
  }

  return parsed.seq + 1;
}

export function createSpool(opts: {
  stateDir: string;
  disabled?: boolean;
  now?: () => Date;
  onError?: (message: string) => void;
}): Spool {
  const path = join(opts.stateDir, SPOOL_SUBDIR, SPOOL_FILENAME);
  const dir = join(opts.stateDir, SPOOL_SUBDIR);
  const enabled = opts.disabled !== true;
  const now = opts.now ?? (() => new Date());
  const onError = opts.onError;

  let sequenceInitialized = false;
  let nextSeq = 0;
  let queue: Promise<void> = Promise.resolve();

  const initializeSequence = (): void => {
    if (sequenceInitialized) {
      return;
    }

    sequenceInitialized = true;

    if (!existsSync(path)) {
      nextSeq = 0;
      return;
    }

    let text = "";
    let startedMidFile = false;

    try {
      const fileDescriptor = openSync(path, "r");
      try {
        const stats = fstatSync(fileDescriptor);
        if (stats.size > LARGE_FILE_BYTES) {
          const bytesToRead = Math.min(TAIL_READ_BYTES, stats.size);
          const buffer = Buffer.alloc(bytesToRead);
          const offset = stats.size - bytesToRead;
          const readBytes = readSync(fileDescriptor, buffer, 0, bytesToRead, offset);
          text = buffer.toString("utf8", 0, readBytes);
          startedMidFile = offset > 0;
        } else {
          text = readFileSync(path, "utf8");
          startedMidFile = false;
        }
      } finally {
        try {
          closeSync(fileDescriptor);
        } catch {
          // Deliberately ignored: close errors should not break host execution.
        }
      }
    } catch {
      // Fall back below using whatever was readable.
    }

    try {
      nextSeq = parseNextSeqFromText(text);
      return;
    } catch {
      nextSeq = countCompleteLines(text, startedMidFile);
      return;
    }
  };

  return {
    path,
    enabled,
    append(input: SpoolAppend): void {
      if (!enabled) {
        return;
      }

      try {
        initializeSequence();

        const seq = nextSeq;
        nextSeq += 1;

        const record: SpoolRecord = {
          v: SPOOL_VERSION,
          seq,
          ts: now().toISOString(),
          session_id: input.sessionId,
          trace_id: input.traceId ?? null,
          event: input.event,
          payload: input.payload ?? {},
        };

        let line: string;
        try {
          line = `${JSON.stringify(record)}\n`;
        } catch (err) {
          try {
            onError?.(`[spool] serialize failed: ${toErrorMessage(err)}`);
          } catch {
            // Host must never observe onError failures.
          }
          return;
        }

        queue = queue
          .then(() => fs.mkdir(dir, { recursive: true }).then(() => fs.appendFile(path, line)))
          .catch((err: unknown) => {
            try {
              onError?.(`[spool] write failed: ${toErrorMessage(err)}`);
            } catch {
              // Host must never observe onError failures.
            }
          });
      } catch (err) {
        try {
          onError?.(`[spool] write failed: ${toErrorMessage(err)}`);
        } catch {
          // Host must never observe onError failures.
        }
      }
    },
    flush(): Promise<void> {
      return queue;
    },
  };
}

// Excerpt helper for diagnostics only: keep bounded snippets and never pass
// env values, secrets, key material, or raw file contents into this function.
export function excerpt(value: unknown, max = MAX_EXCERPT_CHARS): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  let rendered: string;
  if (typeof value === "string") {
    rendered = value;
  } else {
    try {
      const json = JSON.stringify(value);
      rendered = json === undefined ? String(value) : json;
    } catch {
      rendered = String(value);
    }
  }

  if (rendered.length > max) {
    return `${rendered.slice(0, max)}${TRUNCATION_MARKER}`;
  }

  return rendered;
}

export function fp8(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}
