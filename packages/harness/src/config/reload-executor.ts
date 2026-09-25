import { RuntimeContext } from "../lifecycle/context"
/**
 * L1 executor port for the L4 runtime reload orchestrator. L1 write paths
 * (tool file edits, config import/setup, provider auth, file watchers) call
 * `reload`/`reloadGlobal` here; src/registration.ts injects the real
 * `RuntimeReload` implementation at entry-point boot so no L1 module imports
 * `runtime/`. Without a registered executor the calls degrade to a synthetic
 * success result carrying an explicit warning.
 */
import { RuntimeSchema } from "./reload-schema"
import type { Config } from "./config"

export namespace RuntimeReloadExecutor {
  export interface ReloadOptions {
    configChange?: Config.Change
    eventScopeID?: string | null
    includePrerequisites?: boolean
    useCurrentScope?: boolean
    /** File paths that triggered the reload; lets Config.reload skip unaffected markdown scans. */
    files?: string[]
  }

  export type Input = RuntimeSchema.ReloadInput
  export type Result = RuntimeSchema.ReloadResult

  type Executor = (input: Input, options?: ReloadOptions) => Promise<Result>

  const runtimeState = RuntimeContext.state(() => ({
    reloadExecutor: undefined as Executor | undefined,
    reloadGlobalExecutor: undefined as Executor | undefined,
  }))

  export function setExecutor(fn: Executor): void {
    const instanceState = runtimeState()

    instanceState.reloadExecutor = fn
  }

  export function setGlobalExecutor(fn: Executor): void {
    const instanceState = runtimeState()

    instanceState.reloadGlobalExecutor = fn
  }

  export async function reload(input: Input, options: ReloadOptions = {}): Promise<Result> {
    const instanceState = runtimeState()

    if (!instanceState.reloadExecutor) return degradedResult(input)
    return instanceState.reloadExecutor(input, options)
  }

  export async function reloadGlobal(input: Input, options: ReloadOptions = {}): Promise<Result> {
    const instanceState = runtimeState()

    if (!instanceState.reloadGlobalExecutor) return degradedResult({ ...input, scope: "global" })
    return instanceState.reloadGlobalExecutor(input, options)
  }

  function degradedResult(input: Input): Result {
    return RuntimeSchema.ReloadResult.parse({
      success: true,
      requested: [...input.targets],
      executed: [],
      cascaded: [],
      changedFields: [],
      restartRequired: [],
      liveApplied: [],
      warnings: ["runtime reload executor not registered"],
      failed: [],
      failures: [],
      diagnostics: [],
    })
  }
}
