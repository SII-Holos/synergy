import type { PrepareWrapperOpts, SandboxExecutionWrapper } from "./types"

export namespace SandboxHost {
  export interface Host {
    prepareWrapper(options: PrepareWrapperOpts): SandboxExecutionWrapper
    cleanupWrapper(wrapper: SandboxExecutionWrapper): void
  }

  let current: Host | undefined

  export function register(host: Host | undefined): void {
    current = host
  }

  export function prepareWrapper(options: PrepareWrapperOpts): SandboxExecutionWrapper {
    if (!current)
      throw new Error("Sandbox host is not registered; compose a local runtime before executing sandboxed tools")
    return current.prepareWrapper(options)
  }

  /**
   * Release the temporary resources a prepared wrapper owns.
   *
   * Authorization now runs after the containment verdict is known, so a wrapper
   * can be prepared for a call that is then refused. This is the same cleanup
   * the execution path already performs when a run finishes, surfaced on the
   * host contract so whoever prepared the wrapper can release it.
   */
  export function cleanupWrapper(wrapper: SandboxExecutionWrapper | undefined): void {
    if (!wrapper || !current) return
    current.cleanupWrapper(wrapper)
  }
}
