import type { Permission } from "./index"

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

  let source: Source | undefined

  export function register(value: Source): void {
    source = value
  }

  export function get(): Source | undefined {
    return source
  }
}
