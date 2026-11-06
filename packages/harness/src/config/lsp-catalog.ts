import { RuntimeContext } from "../lifecycle/context"
/**
 * S9d LSP catalog port: the config schema's `lsp` refinement needs the set of
 * builtin LSP server IDs without importing the lsp product domain. The L4
 * product manifest registers the concrete catalog; unregistered, every lsp
 * entry is treated as a custom server (extensions required).
 */
export namespace ConfigLspCatalog {
  const runtimeState = RuntimeContext.state(() => ({
    serverIds: new Set<string>(),
  }))

  export function registerServerIds(ids: string[]): void {
    const instanceState = runtimeState()

    instanceState.serverIds = new Set(ids)
  }

  export function isKnownServer(id: string): boolean {
    const instanceState = runtimeState()

    return instanceState.serverIds.has(id)
  }
}
