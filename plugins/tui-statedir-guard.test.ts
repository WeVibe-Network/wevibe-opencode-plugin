import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

test('tui + engine bind-gated .wevibe layout stay aligned (no divergent copies)', () => {
  // Guard: installer deploys tui/wevibe.tsx as a standalone raw-copied file, so it
  // cannot import plugins/wevibe-paths.ts. The bind-gated routing (bound ->
  // <root>/.wevibe; unbound -> ~/.wevibe/unbound/<fp>) is DUPLICATED in both and
  // must not drift, or the engine<->TUI heartbeat handshake breaks.
  const tui = readFileSync(join(__dirname, '..', 'tui', 'wevibe.tsx'), 'utf8');
  const paths = readFileSync(join(__dirname, 'wevibe-paths.ts'), 'utf8');

  // TUI derives stateDir from the bind-gated base and carries the full gate.
  assert.match(tui, /path\.join\(\s*weVibeBase\s*,\s*"state"\s*\)/);
  assert.match(tui, /"unbound"/);
  assert.match(tui, /org\.json/);
  assert.match(tui, /org\.local\.json/);
  assert.match(tui, /createHash\("sha256"\)/);
  assert.doesNotMatch(tui, /stateRoot\s*,\s*"\.opencode"/);

  // Engine chokepoint carries the same gate.
  assert.match(paths, /"unbound"/);
  assert.match(paths, /org\.json/);
  assert.match(paths, /org\.local\.json/);
  assert.match(paths, /createHash\("sha256"\)/);
});
