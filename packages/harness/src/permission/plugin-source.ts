import { RuntimeContext } from "../lifecycle/context"
import type { Permission } from "."

/**
 * S9d source inversion: the L1 permission ask pipeline delivers the
 * permission.ask hook to plugins through this registered source instead of
 * importing the plugin product domain. Unregistered, no hook runs and the
 * ask proceeds through the normal pending flow.
 */
export namespace PermissionPluginSource {
  export interface Source {
    triggerAsk(info: Permission.Info, initial: { status: string }): Promise<{ status: string }>
  }

  const runtimeState = RuntimeContext.state(() => ({
    source: undefined as Source | undefined,
  }))

  export function register(value: Source): void {
    const instanceState = runtimeState()

    if (instanceState.source === value) return
    RuntimeContext.assertCompositionOpen("permission/plugin-source")
    if (instanceState.source && value) throw new Error("permission/plugin-source is already registered")
    instanceState.source = value
  }

  export function get(): Source | undefined {
    const instanceState = runtimeState()

    return instanceState.source
  }
}
