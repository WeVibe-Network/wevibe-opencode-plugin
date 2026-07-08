import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// @ts-expect-error tsx test runner resolves .ts extension imports.
import { deriveOrgMembership, shouldPromptOrgJoin } from './org-join-gate.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

test('deriveOrgMembership marks non-empty org map as known membership', () => {
  const signal = deriveOrgMembership({
    ed25519PublicKey: 'pub',
    adoptedAt: null,
    orgs: { 'org-1': {} },
  });

  assert.equal(signal.identityPresent, true);
  assert.equal(signal.adopted, false);
  assert.equal(signal.hasKnownOrg, true);
});

test('deriveOrgMembership treats empty org map as no known org', () => {
  const signal = deriveOrgMembership({
    ed25519PublicKey: 'pub',
    adoptedAt: null,
    orgs: {},
  });

  assert.equal(signal.hasKnownOrg, false);
});

test('deriveOrgMembership treats missing org map as no known org', () => {
  const signal = deriveOrgMembership({
    ed25519PublicKey: 'pub',
    adoptedAt: null,
  });

  assert.equal(signal.hasKnownOrg, false);
});

test('deriveOrgMembership tracks adoptedAt and missing public key', () => {
  const signal = deriveOrgMembership({
    adoptedAt: '2026-07-08T00:00:00.000Z',
    orgs: {},
  });

  assert.equal(signal.identityPresent, false);
  assert.equal(signal.adopted, true);
  assert.equal(signal.hasKnownOrg, false);
});

test("deriveOrgMembership mirrors Walter's sidecar state (known org + not adopted)", () => {
  const signal = deriveOrgMembership({
    ed25519PublicKey: 'pub',
    adoptedAt: null,
    orgs: {
      'wevibe-org-0': {
        hubEndpoints: [],
        hubResponsePubkey: '',
        hubServingAddress: 'x',
        activeHubEndpoint: null,
        updatedAt: 't',
      },
    },
  });

  assert.equal(signal.identityPresent, true);
  assert.equal(signal.adopted, false);
  assert.equal(signal.hasKnownOrg, true);
});

const eligibleNonMember = {
  identityPresent: true,
  adopted: false,
  hasKnownOrg: false,
  isBound: true,
  promptedThisSession: false,
};

test('shouldPromptOrgJoin suppresses accepted org members', () => {
  assert.equal(
    shouldPromptOrgJoin({
      ...eligibleNonMember,
      hasKnownOrg: true,
    }),
    false,
  );
});

test('shouldPromptOrgJoin suppresses dashboard-adopted users', () => {
  assert.equal(
    shouldPromptOrgJoin({
      ...eligibleNonMember,
      adopted: true,
    }),
    false,
  );
});

test('shouldPromptOrgJoin shows for bound non-member not yet prompted this session', () => {
  assert.equal(shouldPromptOrgJoin(eligibleNonMember), true);
});

test('shouldPromptOrgJoin does not re-show in same session once prompted', () => {
  assert.equal(
    shouldPromptOrgJoin({
      ...eligibleNonMember,
      promptedThisSession: true,
    }),
    false,
  );
});

test('shouldPromptOrgJoin shows again in a new session when prompt flag resets', () => {
  assert.equal(
    shouldPromptOrgJoin({
      ...eligibleNonMember,
      promptedThisSession: false,
    }),
    true,
  );
});

test('shouldPromptOrgJoin suppresses when sidecar indicates org while hub is unreachable', () => {
  // Fail-safe by design: this gate reads only sidecar state. If sidecar orgs are
  // present, we suppress the popup without blocking on hub reachability.
  assert.equal(
    shouldPromptOrgJoin({
      ...eligibleNonMember,
      hasKnownOrg: true,
    }),
    false,
  );
});

test('shouldPromptOrgJoin suppresses when project is not bound', () => {
  assert.equal(
    shouldPromptOrgJoin({
      ...eligibleNonMember,
      isBound: false,
    }),
    false,
  );
});

test('shouldPromptOrgJoin suppresses when identity is missing', () => {
  assert.equal(
    shouldPromptOrgJoin({
      ...eligibleNonMember,
      identityPresent: false,
    }),
    false,
  );
});

test('tui org-join gate tokens stay aligned with standalone duplicate', () => {
  const tui = readFileSync(join(__dirname, '..', 'tui', 'wevibe.tsx'), 'utf8');
  const legacyKvToken = new RegExp(`KV_ORG_JOIN_${'ASKED'}`);

  assert.match(tui, /!hasKnownOrg/);
  assert.match(tui, /orgJoinPromptedThisSession/);
  assert.doesNotMatch(tui, /orgJoinAsked/);
  assert.doesNotMatch(tui, legacyKvToken);
});
