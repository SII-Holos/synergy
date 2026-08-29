/**
 * L1 executor port for the L4 runtime reload orchestrator. L1 write paths
 * (tool file edits, config import/setup, provider auth, file watchers) call
 * `reload`/`reloadGlobal` here; src/product-registration.ts injects the real
 * `RuntimeReload` implementation at entry-point boot so no L1 module imports
 * `runtime/`. Without a registered executor the calls degrade to a synthetic
 * success result carrying an explicit warning.
 */
import { RuntimeSchema } from "./reload-schema"
import type { Config } from "./config"

export namespace RuntimeReloadExecutor {
  export interface ReloadOptions {
    configChange?: Config.Change
    eventDirectory?: string
    includePrerequisites?: boolean
    useCurrentDirectory?: boolean
    /** File paths that triggered the reload; lets Config.reload skip unaffected markdown scans. */
    files?: string[]
  }

  export type Input = RuntimeSchema.ReloadInput
  export type Result = RuntimeSchema.ReloadResult

  type Executor = (input: Input, options?: ReloadOptions) => Promise<Result>

  let reloadExecutor: Executor | undefined
  let reloadGlobalExecutor: Executor | undefined

  export function setExecutor(fn: Executor): void {
    reloadExecutor = fn
  }

  export function setGlobalExecutor(fn: Executor): void {
    reloadGlobalExecutor = fn
  }

  export async function reload(input: Input, options: ReloadOptions = {}): Promise<Result> {
    if (!reloadExecutor) return degradedResult(input)
    return reloadExecutor(input, options)
  }

  export async function reloadGlobal(input: Input, options: ReloadOptions = {}): Promise<Result> {
    if (!reloadGlobalExecutor) return degradedResult({ ...input, scope: "global" })
    return reloadGlobalExecutor(input, options)
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
