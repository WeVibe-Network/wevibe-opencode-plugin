import { access, copyFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

type JsonObject = Record<string, unknown>;
type JsonWriteStatus = 'created' | 'updated' | 'unchanged';
type PluginFileStatus = 'created' | 'updated' | 'unchanged';
type PluginRemovalStatus = 'removed' | 'absent';
type EnginePluginInstallStatus = 'registered' | 'missing';
type EnginePluginRemovalStatus = 'removed' | 'absent';
type OpencodePluginOptions = {
  adminScript: string;
  node: string;
};

type InstallOpencodeResult = {
  ok: true;
  configDir: string;
  pluginPath: string;
  enginePluginPath: string;
  enginePluginStatus: EnginePluginInstallStatus;
  tuiJson: JsonWriteStatus;
  opencodeJson: JsonWriteStatus;
  adminScript: string;
  serverScript: string;
};

type UninstallOpencodeResult = {
  ok: true;
  configDir: string;
  pluginPath: string;
  enginePluginPath: string;
  enginePluginStatus: EnginePluginRemovalStatus;
  pluginFile: PluginRemovalStatus;
  tuiJson: 'updated' | 'unchanged';
  opencodeJson: 'updated' | 'unchanged';
};

function die(msg: string): never {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

/** True if a (possibly value-less) flag was passed. The arg parser stores
 *  value-less trailing flags as '' and mid-list flags as 'true', so presence
 *  is the reliable signal for boolean flags. */
function hasFlag(flags: Record<string, string>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(flags, key) && flags[key] !== 'false';
}

function getOptionalValueFlag(flags: Record<string, string>, key: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(flags, key)) {
    return null;
  }
  const value = flags[key];
  if (!value || value === 'true') {
    die(`--${key} requires a value`);
  }
  return value;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ensureJsonObject(value: unknown, filePath: string): JsonObject {
  if (!isJsonObject(value)) {
    die(`${filePath} must contain a JSON object at the top level.`);
  }
  return value;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function readJsonObjectFile(filePath: string, parseErrorMessage?: string): Promise<JsonObject | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    die(`Failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (parseErrorMessage) {
      die(parseErrorMessage);
    }
    die(`Failed to parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  return ensureJsonObject(parsed, filePath);
}

function makeBackupPath(filePath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${filePath}.bak-${stamp}`;
}

async function writeJsonObjectFile(filePath: string, previous: JsonObject | null, next: JsonObject, force: boolean): Promise<JsonWriteStatus> {
  if (previous && !force && isDeepStrictEqual(previous, next)) {
    return 'unchanged';
  }

  if (previous) {
    const backupPath = makeBackupPath(filePath);
    await copyFile(filePath, backupPath);
  }

  await writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return previous ? 'updated' : 'created';
}

function resolveOpencodeConfigDir(flags: Record<string, string>): string {
  const configDirFlag = getOptionalValueFlag(flags, 'config-dir');
  if (configDirFlag) {
    return path.resolve(configDirFlag);
  }
  if (process.env.OPENCODE_CONFIG_DIR) {
    return path.resolve(process.env.OPENCODE_CONFIG_DIR);
  }
  if (process.env.XDG_CONFIG_HOME) {
    return path.join(process.env.XDG_CONFIG_HOME, 'opencode');
  }
  return path.join(os.homedir(), '.config', 'opencode');
}

function resolveInstallerRuntimePaths(flags: Record<string, string>): {
  adminScript: string;
  serverScript: string;
  tuiSource: string;
  enginePluginPath: string;
} {
  const __filename = fileURLToPath(import.meta.url);
  const repoRoot = path.resolve(path.dirname(__filename), '..');
  const workspaceRoot = path.resolve(repoRoot, '..');
  const enginePluginPath = path.resolve(
    getOptionalValueFlag(flags, 'engine-path') ??
      process.env.WEVIBE_ENGINE_PATH ??
      path.join(repoRoot, 'plugins', 'wevibe-plugin.ts'),
  );
  const tuiSource = path.resolve(
    getOptionalValueFlag(flags, 'tui-path') ??
      path.join(repoRoot, 'tui', 'wevibe.tsx'),
  );
  const mcpDistDir = path.resolve(
    getOptionalValueFlag(flags, 'mcp-dir') ??
      process.env.WEVIBE_MCP_DIR ??
      path.join(workspaceRoot, 'wevibe-mcp', 'dist'),
  );
  const adminScript = path.join(mcpDistDir, 'admin.js');
  const serverScript = path.join(mcpDistDir, 'server.js');

  return { adminScript, serverScript, tuiSource, enginePluginPath };
}

async function copyCanonicalPlugin(sourcePath: string, destinationPath: string, force: boolean): Promise<PluginFileStatus> {
  let sourceContents: string;
  try {
    sourceContents = await readFile(sourcePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      die(`Canonical opencode plugin source not found at ${sourcePath}.`);
    }
    die(`Failed to read plugin source ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let existingContents: string | null = null;
  try {
    existingContents = await readFile(destinationPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      die(`Failed to read existing plugin at ${destinationPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!force && existingContents !== null && existingContents === sourceContents) {
    return 'unchanged';
  }

  await writeFile(destinationPath, sourceContents, 'utf8');
  return existingContents === null ? 'created' : 'updated';
}

async function removeFileIfExists(filePath: string): Promise<PluginRemovalStatus> {
  try {
    await unlink(filePath);
    return 'removed';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 'absent';
    }
    die(`Failed to remove ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function mergeTuiPluginEntry(existing: JsonObject, pluginRelPath: string, options: OpencodePluginOptions): JsonObject {
  const existingPlugins = Array.isArray(existing.plugin) ? [...existing.plugin] : [];
  let found = false;

  const mergedPlugins = existingPlugins.map((entry) => {
    if (!found && Array.isArray(entry) && typeof entry[0] === 'string' && entry[0] === pluginRelPath) {
      found = true;
      return [pluginRelPath, { ...options }];
    }
    return entry;
  });

  if (!found) {
    mergedPlugins.push([pluginRelPath, { ...options }]);
  }

  return {
    ...existing,
    plugin: mergedPlugins,
  };
}

function removeTuiPluginEntry(existing: JsonObject, pluginRelPath: string): JsonObject {
  if (!Array.isArray(existing.plugin)) {
    return { ...existing };
  }

  const filteredPlugins = existing.plugin.filter((entry) => !(Array.isArray(entry) && entry[0] === pluginRelPath));
  return {
    ...existing,
    plugin: filteredPlugins,
  };
}

function mergeMcpEntry(existing: JsonObject, node: string, serverScriptPath: string): JsonObject {
  const existingMcp = isJsonObject(existing.mcp) ? existing.mcp : {};
  return {
    ...existing,
    mcp: {
      ...existingMcp,
      wevibe: {
        '//': 'DISABLED: the wevibe engine plugin is the SOLE :4450 MCP spawner. An opencode-spawned env-less copy would break leader-side Umbral crypto. Keep this off.',
        type: 'local',
        command: [node, serverScriptPath],
        enabled: false,
      },
    },
  };
}

function mergeServerPluginEntry(existing: JsonObject, enginePath: string): JsonObject {
  const existingPlugins = Array.isArray(existing.plugin) ? [...existing.plugin] : [];
  const mergedPlugins: unknown[] = [];
  let found = false;

  for (const entry of existingPlugins) {
    if (typeof entry === 'string' && entry === enginePath) {
      if (!found) {
        mergedPlugins.push(entry);
        found = true;
      }
      continue;
    }
    mergedPlugins.push(entry);
  }

  if (!found) {
    mergedPlugins.push(enginePath);
  }

  return {
    ...existing,
    plugin: mergedPlugins,
  };
}

function removeServerPluginEntry(existing: JsonObject, enginePath: string): JsonObject {
  if (!Array.isArray(existing.plugin)) {
    return { ...existing };
  }

  const filteredPlugins = existing.plugin.filter((entry) => !(typeof entry === 'string' && entry === enginePath));
  return {
    ...existing,
    plugin: filteredPlugins,
  };
}

function hasServerPluginEntry(existing: JsonObject, enginePath: string): boolean {
  if (!Array.isArray(existing.plugin)) {
    return false;
  }
  return existing.plugin.some((entry) => typeof entry === 'string' && entry === enginePath);
}

function removeMcpEntry(existing: JsonObject): JsonObject {
  if (!isJsonObject(existing.mcp)) {
    return { ...existing };
  }

  const { wevibe: _removed, ...remainingMcp } = existing.mcp;
  return {
    ...existing,
    mcp: remainingMcp,
  };
}

async function cmdInstallOpencode(flags: Record<string, string>) {
  const asJson = hasFlag(flags, 'json');
  const force = hasFlag(flags, 'force');
  const nodeBin = getOptionalValueFlag(flags, 'node') ?? 'node';
  const configDir = resolveOpencodeConfigDir(flags);

  const { adminScript, serverScript, tuiSource, enginePluginPath } = resolveInstallerRuntimePaths(flags);
  if (!await pathExists(tuiSource)) {
    die(`Canonical opencode plugin source is missing: ${tuiSource}`);
  }

  const enginePluginExists = await pathExists(enginePluginPath);
  const enginePluginStatus: EnginePluginInstallStatus = enginePluginExists ? 'registered' : 'missing';
  if (!enginePluginExists) {
    console.warn(
      `Warning: Canonical opencode engine plugin source is missing: ${enginePluginPath}. ` +
      'Skipping opencode.json plugin registration.',
    );
  }

  const tuiDir = path.join(configDir, 'tui');
  const pluginPath = path.join(tuiDir, 'wevibe.tsx');
  const tuiJsonPath = path.join(configDir, 'tui.json');
  const opencodeJsonPath = path.join(configDir, 'opencode.json');

  await mkdir(configDir, { recursive: true });
  await mkdir(tuiDir, { recursive: true });

  const pluginStatus = await copyCanonicalPlugin(tuiSource, pluginPath, force);

  const tuiExisting = await readJsonObjectFile(tuiJsonPath);
  const tuiSeed: JsonObject = tuiExisting ?? {
    '$schema': 'https://opencode.ai/tui.json',
  };
  const tuiMerged = mergeTuiPluginEntry(tuiSeed, './tui/wevibe.tsx', { adminScript, node: nodeBin });
  const tuiJson = await writeJsonObjectFile(tuiJsonPath, tuiExisting, tuiMerged, force);

  const opencodeParseError =
    `Failed to parse ${opencodeJsonPath} as strict JSON. ` +
    'install-opencode will not modify commented JSON/JSONC files. ' +
    'Please add the mcp.wevibe and plugin entries manually to avoid clobbering your config.';
  const opencodeExisting = await readJsonObjectFile(opencodeJsonPath, opencodeParseError);
  const opencodeSeed: JsonObject = opencodeExisting ?? {
    '$schema': 'https://opencode.ai/config.json',
  };
  let opencodeMerged = mergeMcpEntry(opencodeSeed, nodeBin, serverScript);
  if (enginePluginExists) {
    opencodeMerged = mergeServerPluginEntry(opencodeMerged, enginePluginPath);
  }
  const opencodeJson = await writeJsonObjectFile(opencodeJsonPath, opencodeExisting, opencodeMerged, force);

  const result: InstallOpencodeResult = {
    ok: true,
    configDir,
    pluginPath,
    enginePluginPath,
    enginePluginStatus,
    tuiJson,
    opencodeJson,
    adminScript,
    serverScript,
  };

  if (asJson) {
    console.log(JSON.stringify(result));
    return;
  }

  console.log('Installed WeVibe opencode integration.');
  console.log(`  configDir: ${configDir}`);
  console.log(`  plugin: ${pluginPath} (${pluginStatus})`);
  console.log(`  engine: ${enginePluginPath} (${enginePluginStatus})`);
  console.log(`  tui.json: ${tuiJsonPath} (${tuiJson})`);
  console.log(`  opencode.json: ${opencodeJsonPath} (${opencodeJson})`);
  console.log('Restart opencode to load updated plugin/MCP settings.');
}

async function cmdUninstallOpencode(flags: Record<string, string>) {
  const asJson = hasFlag(flags, 'json');
  const configDir = resolveOpencodeConfigDir(flags);
  const { enginePluginPath } = resolveInstallerRuntimePaths(flags);

  const tuiJsonPath = path.join(configDir, 'tui.json');
  const pluginPath = path.join(configDir, 'tui', 'wevibe.tsx');
  const opencodeJsonPath = path.join(configDir, 'opencode.json');

  let tuiJson: 'updated' | 'unchanged' = 'unchanged';
  const tuiExisting = await readJsonObjectFile(tuiJsonPath);
  if (tuiExisting) {
    const tuiRemoved = removeTuiPluginEntry(tuiExisting, './tui/wevibe.tsx');
    const status = await writeJsonObjectFile(tuiJsonPath, tuiExisting, tuiRemoved, false);
    tuiJson = status === 'created' ? 'updated' : status;
  }

  const pluginFile = await removeFileIfExists(pluginPath);

  let enginePluginStatus: EnginePluginRemovalStatus = 'absent';
  let opencodeJson: 'updated' | 'unchanged' = 'unchanged';
  const opencodeParseError =
    `Failed to parse ${opencodeJsonPath} as strict JSON. ` +
    'uninstall-opencode will not modify commented JSON/JSONC files. ' +
    'Please remove mcp.wevibe and plugin entries manually to avoid clobbering your config.';
  const opencodeExisting = await readJsonObjectFile(opencodeJsonPath, opencodeParseError);
  if (opencodeExisting) {
    if (hasServerPluginEntry(opencodeExisting, enginePluginPath)) {
      enginePluginStatus = 'removed';
    }
    const opencodeWithoutMcp = removeMcpEntry(opencodeExisting);
    const opencodeRemoved = removeServerPluginEntry(opencodeWithoutMcp, enginePluginPath);
    const status = await writeJsonObjectFile(opencodeJsonPath, opencodeExisting, opencodeRemoved, false);
    opencodeJson = status === 'created' ? 'updated' : status;
  }

  const result: UninstallOpencodeResult = {
    ok: true,
    configDir,
    pluginPath,
    enginePluginPath,
    enginePluginStatus,
    pluginFile,
    tuiJson,
    opencodeJson,
  };

  if (asJson) {
    console.log(JSON.stringify(result));
    return;
  }

  console.log('Uninstalled WeVibe opencode integration.');
  console.log(`  configDir: ${configDir}`);
  console.log(`  plugin: ${pluginPath} (${pluginFile})`);
  console.log(`  engine: ${enginePluginPath} (${enginePluginStatus})`);
  console.log(`  tui.json: ${tuiJsonPath} (${tuiJson})`);
  console.log(`  opencode.json: ${opencodeJsonPath} (${opencodeJson})`);
  console.log('Restart opencode to apply the updated configuration.');
}

function parseArgs(argv: string[]): { command: string; flags: Record<string, string> } {
  let command = 'install-opencode';
  let startIndex = 0;

  if (argv[0] && !argv[0].startsWith('--')) {
    command = argv[0];
    startIndex = 1;
  }

  const flags: Record<string, string> = {};
  for (let i = startIndex; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      die(`Unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    const value = argv[i + 1] ?? '';
    if (!value.startsWith('--')) {
      flags[key] = value;
      i++;
    } else {
      flags[key] = 'true';
    }
  }

  return { command, flags };
}

function printUsage() {
  console.log(`wevibe-install-opencode — install/uninstall WeVibe OpenCode integration

Usage:
  tsx bin/install-opencode.ts install-opencode [--config-dir <path>] [--node <path>] [--engine-path <abs>] [--mcp-dir <path>] [--force] [--json]
  tsx bin/install-opencode.ts uninstall-opencode [--config-dir <path>] [--engine-path <abs>] [--json]

Default command:
  install-opencode (when no subcommand is provided)
`);
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));

  switch (command) {
    case 'install-opencode':
      return cmdInstallOpencode(flags);
    case 'uninstall-opencode':
      return cmdUninstallOpencode(flags);
    case 'help':
    case '--help':
    case '-h':
      return printUsage();
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

main().catch((e: unknown) => {
  const message = e instanceof Error ? e.message : String(e);
  console.error(`Fatal: ${message}`);
  process.exit(1);
});
