import { RuntimeContext } from "../lifecycle/context"
import type { Config } from "./config"
import type { RuntimeSchema } from "./reload-schema"

export namespace RuntimeReloadContributions {
  export interface Context {
    scope: RuntimeSchema.ReloadScope
    executed: RuntimeSchema.ReloadTarget[]
    failed: RuntimeSchema.ReloadTarget[]
    failures: RuntimeSchema.ReloadFailure[]
    diagnostics: RuntimeSchema.ReloadDiagnostic[]
    changedFields: Set<string>
    restartRequired: Set<string>
    liveApplied: Set<string>
    warnings: string[]
    files?: string[]
    includePrerequisites: boolean
    configChange?: Config.Change
  }
  export interface ConfigChange {
    config: Config.Info
    oldConfig: Config.Info
    changedFields: string[]
    scope: "global" | "project"
  }
  export interface Contribution {
    id: string
    targets?: Partial<Record<RuntimeSchema.ReloadTarget, (context: Context) => Promise<void>>>
    configChanged?(change: ConfigChange, context: Context): Promise<void>
  }
  const state = RuntimeContext.state(() => new Map<string, Contribution>())

  export function register(contribution: Contribution) {
    RuntimeContext.assertCompositionOpen("reload contributions")
    if (state().get(contribution.id) === contribution) return
    if (state().has(contribution.id)) throw new Error(`Reload owner already registered: ${contribution.id}`)
    for (const target of Object.keys(contribution.targets ?? {})) {
      if (has(target as RuntimeSchema.ReloadTarget)) throw new Error(`Reload target already registered: ${target}`)
    }
    state().set(contribution.id, contribution)
  }

  export function has(target: RuntimeSchema.ReloadTarget) {
    return [...state().values()].some((contribution) => contribution.targets?.[target])
  }

  export async function execute(target: RuntimeSchema.ReloadTarget, context: Context) {
    const execute = [...state().values()].map((contribution) => contribution.targets?.[target]).find(Boolean)
    if (!execute) throw new Error(`Reload capability is not installed: ${target}`)
    await execute(context)
  }

  export async function configChanged(change: ConfigChange, context: Context) {
    for (const contribution of state().values()) await contribution.configChanged?.(change, context)
  }
}
