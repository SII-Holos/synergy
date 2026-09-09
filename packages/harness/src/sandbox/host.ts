import type { PrepareWrapperOpts, SandboxExecutionWrapper } from "./types"

export namespace SandboxHost {
  export interface Host {
    prepareWrapper(options: PrepareWrapperOpts): SandboxExecutionWrapper
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
}
