import { RuntimeContext } from "../lifecycle/context"

export namespace WorkspaceFileImport {
  export interface Input {
    from: string
    to: string
    validateSource(source: string): Promise<void>
  }
  export interface Host {
    importEntry(input: Input, signal?: AbortSignal): Promise<unknown>
  }
  const state = RuntimeContext.state(() => ({ host: undefined as Host | undefined }))

  export function register(host: Host) {
    RuntimeContext.assertCompositionOpen("Workspace file import")
    if (state().host) throw new Error("Workspace file import Host is already registered")
    state().host = host
  }

  export async function apply(input: Input, signal?: AbortSignal): Promise<void> {
    const host = state().host
    if (!host) throw new Error("This Runtime cannot import local files")
    await host.importEntry(input, signal)
  }
}
