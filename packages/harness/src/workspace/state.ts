import { RuntimeContext } from "../lifecycle/context"
import { ScopeContext } from "../scope/context"
import { State } from "../scope/state"

export namespace WorkspaceState {
  const records = RuntimeContext.state(() => new Map<string, string>())

  export function key() {
    const workspace = ScopeContext.current.workspace
    if (!workspace?.id || workspace.generation === undefined)
      throw new Error("A resolved Workspace is required for file resources")
    const key = JSON.stringify(["workspace", workspace.id, workspace.generation])
    records().set(key, workspace.scopeID)
    return key
  }

  export function create<S>(init: () => S, dispose?: (state: Awaited<S>) => Promise<void>) {
    return State.create(key, init, dispose)
  }

  export async function dispose(key: string) {
    await State.dispose(key)
    records().delete(key)
  }

  export async function disposeWorkspace(workspaceID: string) {
    const results = await Promise.allSettled(
      [...records().keys()].filter((key) => JSON.parse(key)[1] === workspaceID).map(dispose),
    )
    const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    if (errors.length) throw new AggregateError(errors, "Workspace resources could not be released")
  }

  export async function disposeScope(scopeID: string) {
    const results = await Promise.allSettled(
      [...records()].filter(([, owner]) => owner === scopeID).map(([key]) => dispose(key)),
    )
    const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    if (errors.length) throw new AggregateError(errors, "Workspace resources could not be released")
  }
}
