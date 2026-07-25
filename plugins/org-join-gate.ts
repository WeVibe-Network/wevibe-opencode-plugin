// Canonical org-join popup gate logic. tui/wevibe.tsx is a standalone raw-copied
// file that cannot import this module at runtime, so it DUPLICATES these gate
// checks inline; plugins/org-join-gate.test.ts guards against drift
// (same pattern as plugins/wevibe-paths.ts <-> tui/wevibe.tsx).

export interface OrgMembershipSignal {
  identityPresent: boolean
  adopted: boolean
  hasKnownOrg: boolean
}

interface IdentitySidecar {
  ed25519PublicKey?: unknown
  adoptedAt?: unknown
  orgs?: Record<string, unknown> | null
}

/** Derive membership signal from the parsed ~/.wevibe/identity.json sidecar (or null). */
export function deriveOrgMembership(sidecar: IdentitySidecar | null | undefined): OrgMembershipSignal {
  const identityPresent = !!sidecar?.ed25519PublicKey
  const adopted = sidecar?.adoptedAt != null
  const orgs = sidecar?.orgs
  const hasKnownOrg = !!orgs && typeof orgs === "object" && Object.keys(orgs).length > 0
  return { identityPresent, adopted, hasKnownOrg }
}

export interface OrgJoinGateInput {
  identityPresent: boolean
  adopted: boolean
  hasKnownOrg: boolean
  isBound: boolean
  promptedThisSession: boolean
}

/**
 * Show the join-org popup ONLY for an identity-present, project-bound NON-member
 * who has not yet been prompted this opencode session. Accepted members
 * (hasKnownOrg) and dashboard-adopted users are suppressed entirely.
 */
export function shouldPromptOrgJoin(input: OrgJoinGateInput): boolean {
  return input.identityPresent && !input.adopted && !input.hasKnownOrg && input.isBound && !input.promptedThisSession
}
