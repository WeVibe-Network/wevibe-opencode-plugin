// plugins/predicate-adapter.ts
//
// Predicate adapters extract test identities from a predicate's run output.
// A predicate run context is the raw material an adapter reads to decide
// whether it understands the command and to pull out the failing / passing
// test ids. No concrete adapter ships here yet; the registry is populated by
// future predicate-specific adapters and resolved by match order.

export interface PredicateRunContext {
  command: string
  output: string
  metadata: Record<string, unknown>
  exitCode: number | null
}

export interface PredicateAdapter {
  readonly predicateId: string
  matches(ctx: PredicateRunContext): boolean
  extractFailingTestIds(ctx: PredicateRunContext): string[]
  extractPassingTestIds(ctx: PredicateRunContext): string[]
}

export const nullPredicateAdapter: PredicateAdapter = {
  predicateId: "",
  matches: () => false,
  extractFailingTestIds: () => [],
  extractPassingTestIds: () => [],
}

const registry: PredicateAdapter[] = []

export function registerPredicateAdapter(a: PredicateAdapter): void {
  registry.push(a)
}

export function resolvePredicateAdapter(ctx: PredicateRunContext): PredicateAdapter {
  return registry.find((a) => a.matches(ctx)) ?? nullPredicateAdapter
}