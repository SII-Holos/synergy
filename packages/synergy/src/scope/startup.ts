import { Log } from "@/util/log"
import { Format } from "@/file/format"
import { FileWatcher } from "@/file/watcher"
import { ActivitySummary } from "@/session/activity-summary"
import { SessionInvoke } from "@/session/invoke"
import { SessionRecovery } from "@/session/recovery"
import type { Scope } from "./index"

const log = Log.create({ service: "scope-startup" })

/**
 * H5 startup contribution registry (L1): product domains register their
 * scope-startup steps (plugin activation/init, lattice runtime, LSP, Vcs,
 * the command initialization watcher) instead of scope/runtime.ts importing
 * them. Built-in harness steps are modeled as chained anchor contributions
 * so order-sensitive product steps can pin themselves with before/after
 * declarations; the chain reproduces the historical startup order exactly:
 * plugin-activate → listeners → plugin-init → session-recovery → lattice →
 * activity-summary → resume-pending → format → lsp → file-watcher → vcs →
 * command-watcher. Execution is a deterministic topological sort; ties break
 * by (phase rank, registration rank).
 */
export namespace ScopeStartup {
  export type Phase = "core" | "workflow" | "surface"

  const PHASE_RANK: Record<Phase, number> = { core: 0, workflow: 1, surface: 2 }

  export interface Contribution {
    name: string
    phase: Phase
    /** This step must run after the named steps complete. */
    after?: string[]
    /** This step must run before the named steps start. */
    before?: string[]
    init(scope: Scope.Project): Promise<void> | void
    /** Scope disposal hook; runs before scoped state disposal. */
    dispose?(scopeID: string): Promise<void> | void
  }

  interface Step extends Contribution {
    rank: number
  }

  const contributions: Step[] = []

  export function register(contribution: Contribution): void {
    if (contributions.some((candidate) => candidate.name === contribution.name)) return
    contributions.push({ ...contribution, rank: contributions.length })
  }

  export function registered(): Array<{ name: string; phase: Phase }> {
    return contributions.map((contribution) => ({ name: contribution.name, phase: contribution.phase }))
  }

  export function reset(): void {
    contributions.length = 0
  }

  /** The built-in anchor chain, in execution order. Each step runs after the
   * previous one; product contributions pin themselves between anchors with
   * explicit before/after declarations. */
  const BUILTIN_CHAIN: Array<{ name: string; init: (scope: Scope.Project) => Promise<void> | void }> = [
    {
      name: "starting-listeners",
      init: () => {},
    },
    {
      name: "session-recovery",
      init: async (scope) => {
        await SessionRecovery.reconcileRuntimeState({ scopeID: scope.id, apply: true }).catch((error) => {
          log.warn("session runtime recovery failed", { scopeID: scope.id, error })
        })
      },
    },
    { name: "activity-summary", init: () => ActivitySummary.init() },
    { name: "resume-pending", init: (scope) => SessionInvoke.resumePending({ scopeID: scope.id }) },
    { name: "format", init: () => Format.init() },
    { name: "file-watcher", init: () => FileWatcher.init() },
  ]

  function builtinSteps(notifyStarting: (scope: Scope.Project) => void): Step[] {
    return BUILTIN_CHAIN.map((step, index) => ({
      name: step.name,
      phase: "core" as const,
      rank: index,
      after: index > 0 ? [BUILTIN_CHAIN[index - 1]!.name] : undefined,
      init: step.name === "starting-listeners" ? (scope: Scope.Project) => notifyStarting(scope) : step.init,
    }))
  }

  function topoSort(steps: Step[]): Step[] {
    const byName = new Map(steps.map((step) => [step.name, step]))
    for (const step of steps) {
      for (const reference of [...(step.after ?? []), ...(step.before ?? [])]) {
        if (!byName.has(reference)) {
          throw new Error(`scope startup step '${step.name}' references unknown step '${reference}'`)
        }
      }
    }

    const incoming = new Map<string, Set<string>>()
    const outgoing = new Map<string, Set<string>>()
    for (const step of steps) {
      incoming.set(step.name, new Set())
      outgoing.set(step.name, new Set())
    }
    const connect = (from: string, to: string) => {
      if (from === to) throw new Error(`scope startup step '${from}' cannot order against itself`)
      outgoing.get(from)!.add(to)
      incoming.get(to)!.add(from)
    }
    for (const step of steps) {
      for (const predecessor of step.after ?? []) connect(predecessor, step.name)
      for (const successor of step.before ?? []) connect(step.name, successor)
    }

    const rankOf = (step: Step) => PHASE_RANK[step.phase] * 10_000 + step.rank
    const ready = steps
      .filter((step) => incoming.get(step.name)!.size === 0)
      .sort((left, right) => rankOf(left) - rankOf(right))
    const ordered: Step[] = []
    const placed = new Set<string>()
    while (ready.length > 0) {
      const step = ready.shift()!
      ordered.push(step)
      placed.add(step.name)
      for (const successor of outgoing.get(step.name)!) {
        const edges = incoming.get(successor)!
        edges.delete(step.name)
        if (edges.size === 0) {
          const candidate = byName.get(successor)!
          const index = ready.findIndex((item) => rankOf(item) > rankOf(candidate))
          ready.splice(index === -1 ? ready.length : index, 0, candidate)
        }
      }
    }
    if (ordered.length !== steps.length) {
      const remaining = steps.filter((step) => !placed.has(step.name)).map((step) => step.name)
      throw new Error(`scope startup steps have cyclic or unresolved ordering: ${remaining.join(", ")}`)
    }
    return ordered
  }

  /** Execute the startup pipeline: built-in anchors plus registered
   * contributions in topological order. Throws on unknown ordering
   * references or cycles so a mis-registered domain fails loudly instead of
   * silently skipping steps. */
  export async function run(input: { scope: Scope.Project; notifyStarting(scope: Scope.Project): void }) {
    const steps = topoSort([...builtinSteps(input.notifyStarting), ...contributions])
    for (const step of steps) await step.init(input.scope)
  }

  /** Ordered plan without executing; exposed for tests. */
  export function plan(): string[] {
    return topoSort([...builtinSteps(() => {}), ...contributions]).map((step) => step.name)
  }

  /** Run registered disposal hooks in registration order. */
  export async function dispose(scopeID: string) {
    for (const contribution of contributions) await contribution.dispose?.(scopeID)
  }
}
