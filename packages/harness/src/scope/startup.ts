import { RuntimeContext } from "../lifecycle/context"
import { SnapshotLifecycle } from "../session/snapshot-lifecycle"
import { Log } from "../util/log"
import { SessionInvoke } from "../session/invoke"
import { SessionRecovery } from "../session/recovery"
import type { Scope } from "."

const log = Log.create({ service: "scope-startup" })

export namespace ScopeStartup {
  const runtimeState = RuntimeContext.state(() => ({
    runtimeMode: "server" as "server" | "oneshot",
    contributions: new Map<string, Contribution>(),
    active: new Map<string, { scopeID: string; steps: Step[] }>(),
  }))
  export function configure(mode: ReturnType<typeof runtimeState>["runtimeMode"]) {
    const instanceState = runtimeState()

    instanceState.runtimeMode = mode
  }
  export function resident() {
    const instanceState = runtimeState()

    return instanceState.runtimeMode === "server"
  }
  export type Phase = "core" | "workflow" | "surface"

  const PHASE_RANK: Record<Phase, number> = { core: 0, workflow: 1, surface: 2 }

  export interface Contribution {
    name: string
    phase: Phase
    owner?: "workspace"
    /** This step must run after the named steps complete. */
    after?: string[]
    /** This step must run before the named steps start. */
    before?: string[]
    init(scope: Scope): Promise<void> | void
    /** Scope disposal hook; runs before scoped state disposal. */
    dispose?(scopeID: string): Promise<void> | void
  }

  interface Step extends Contribution {
    rank: number
  }

  export function register(contribution: Contribution): void {
    const instanceState = runtimeState()

    const existing = instanceState.contributions.get(contribution.name)
    if (existing === contribution) return
    if (existing || BUILTIN_CHAIN.some((step) => step.name === contribution.name))
      throw new Error(`Scope startup step ${contribution.name} is already registered`)
    RuntimeContext.assertCompositionOpen(`Scope startup step ${contribution.name}`)
    instanceState.contributions.set(contribution.name, contribution)
  }

  export function registered(): Array<{ name: string; phase: Phase }> {
    const instanceState = runtimeState()

    return [...instanceState.contributions.values()].map((contribution) => ({
      name: contribution.name,
      phase: contribution.phase,
    }))
  }

  export function reset(): void {
    const instanceState = runtimeState()

    RuntimeContext.assertCompositionOpen("Scope startup steps")
    instanceState.contributions.clear()
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
        await SnapshotLifecycle.recover(scope.id)
        if (!resident()) return
        await SessionRecovery.reconcileRuntimeState({ scopeID: scope.id, apply: true }).catch((error) => {
          log.warn("session runtime recovery failed", { scopeID: scope.id, error })
        })
      },
    },
    {
      name: "session-pause-reconcile",
      init: (scope) => (resident() ? SessionInvoke.reconcilePausedSessions(scope.id) : undefined),
    },
  ]

  function builtinSteps(notifyStarting: (scope: Scope.Project) => void): Step[] {
    return BUILTIN_CHAIN.map((step, index) => ({
      name: step.name,
      phase: "core" as const,
      rank: index,
      after: index > 0 ? [BUILTIN_CHAIN[index - 1]!.name] : undefined,
      init: (scope: Scope) => {
        if (scope.type !== "project") return
        return step.name === "starting-listeners" ? notifyStarting(scope) : step.init(scope)
      },
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
      if (byName.get(from)?.owner === "workspace" && byName.get(to)?.owner !== "workspace")
        throw new Error(`Scope startup step '${to}' cannot depend on Workspace step '${from}'`)
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
  export async function run(input: {
    scope: Scope
    workspaceKey?: string
    notifyStarting(scope: Scope.Project): void
  }) {
    const instanceState = runtimeState()

    const steps = topoSort([
      ...builtinSteps(input.notifyStarting),
      ...[...instanceState.contributions.values()].map((step, rank) => ({ ...step, rank })),
    ]).filter((step) => (step.owner === "workspace") === (input.workspaceKey !== undefined))
    const active: Step[] = []
    const key = input.workspaceKey ?? input.scope.id
    instanceState.active.set(key, { scopeID: input.scope.id, steps: active })
    try {
      for (const step of steps) {
        active.push(step)
        await step.init(input.scope)
      }
    } catch (error) {
      try {
        await dispose(key)
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Scope startup and cleanup failed")
      }
      throw error
    }
  }

  /** Ordered plan without executing; exposed for tests. */
  export function plan(owner?: "scope" | "workspace"): string[] {
    const instanceState = runtimeState()

    return topoSort([
      ...builtinSteps(() => {}),
      ...[...instanceState.contributions.values()].map((step, rank) => ({ ...step, rank })),
    ])
      .filter((step) => !owner || (step.owner === "workspace") === (owner === "workspace"))
      .map((step) => step.name)
  }

  /** Release acquired steps in reverse startup order, including a partially initialized step. */
  export async function dispose(scopeID: string) {
    const instanceState = runtimeState()

    const active = instanceState.active.get(scopeID)
    instanceState.active.delete(scopeID)
    const errors: unknown[] = []
    for (const step of active?.steps.toReversed() ?? []) {
      try {
        await step.dispose?.(active!.scopeID)
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length) throw new AggregateError(errors, "Scope cleanup failed")
  }
}
