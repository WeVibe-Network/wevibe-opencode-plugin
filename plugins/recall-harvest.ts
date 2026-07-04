export interface RecallHarvestSignals {
  prompt: string;
  language?: string;
  deps: string[];
  frameworks: string[];
  stack: string[];
  projectName?: string;
  directory?: string;
  errorStrings: string[];
  editedFiles: string[];
  buildFailing?: boolean;
  testFailing?: boolean;
}

export interface RecallHarvestFields {
  intent?: string;
  task?: string;
  language?: string;
  stack?: string[];
  technologies?: string[];
  frameworks?: string[];
  deps?: string[];
  errorStrings?: string[];
  files?: string[];
  directory?: string;
  projectName?: string;
}

const DEBUG_PROMPT = /\b(error|fix|bug|fail|crash|broken|debug|stack ?trace|exception)\b/i;
const TEST_PROMPT = /\b(test|spec|coverage|vitest|jest|pytest)\b/i;
const REFACTOR_PROMPT = /\b(refactor|rename|clean ?up|restructure|extract|simplify)\b/i;
const EXPLAIN_PROMPT = /\b(explain|why|how does|understand|what is)\b/i;
const BUILD_PROMPT = /\b(build|compile|bundle|deploy|ci)\b/i;

function normalizeText(value: string, maxLength = Number.POSITIVE_INFINITY): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return normalized.slice(0, maxLength);
}

function dedupCap(
  values: readonly string[],
  cap: number,
  normalizer: (value: string) => string = (value) => normalizeText(value),
): string[] {
  if (cap <= 0) {
    return [];
  }

  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = normalizer(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    result.push(normalized);

    if (result.length >= cap) {
      break;
    }
  }

  return result;
}

export function classifyIntent(prompt: string, opts: { buildFailing?: boolean; testFailing?: boolean }): string {
  if (opts.buildFailing || opts.testFailing) {
    return 'debug';
  }

  if (DEBUG_PROMPT.test(prompt)) {
    return 'debug';
  }

  if (TEST_PROMPT.test(prompt)) {
    return 'test';
  }

  if (REFACTOR_PROMPT.test(prompt)) {
    return 'refactor';
  }

  if (EXPLAIN_PROMPT.test(prompt)) {
    return 'explain';
  }

  if (BUILD_PROMPT.test(prompt)) {
    return 'build';
  }

  return 'implement';
}

export function buildRecallHarvest(signals: RecallHarvestSignals): RecallHarvestFields {
  const fields: RecallHarvestFields = {
    intent: classifyIntent(signals.prompt, {
      buildFailing: signals.buildFailing,
      testFailing: signals.testFailing,
    }),
  };

  const task = normalizeText(signals.prompt, 500);
  if (task) {
    fields.task = task;
  }

  const language = signals.language ? normalizeText(signals.language) : '';
  if (language) {
    fields.language = language;
  }

  const stack = dedupCap(signals.stack, 12);
  if (stack.length > 0) {
    fields.stack = stack;
  }

  const frameworks = dedupCap(signals.frameworks, 12);
  if (frameworks.length > 0) {
    fields.frameworks = frameworks;
  }

  const deps = dedupCap(signals.deps, 20);
  if (deps.length > 0) {
    fields.deps = deps;
  }

  const errorStrings = dedupCap(signals.errorStrings, 8, (value) => normalizeText(value, 300));
  if (errorStrings.length > 0) {
    fields.errorStrings = errorStrings;
  }

  const files = dedupCap(signals.editedFiles, 15);
  if (files.length > 0) {
    fields.files = files;
  }

  const directory = signals.directory ? normalizeText(signals.directory) : '';
  if (directory) {
    fields.directory = directory;
  }

  const projectName = signals.projectName ? normalizeText(signals.projectName) : '';
  if (projectName) {
    fields.projectName = projectName;
  }

  return fields;
}
