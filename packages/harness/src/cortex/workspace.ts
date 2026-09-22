import { RuntimeContext } from "../lifecycle/context"
export namespace CortexWorkspace {
  export interface CreateInput {
    sessionID: string
    name?: string
    baseRef: "current" | "fresh"
    baseRevision?: string
  }

  export interface Adapter {
    create(input: CreateInput): Promise<{ id: string; name: string }>
    cleanup(input: { sessionID: string; taskID: string }): Promise<void>
  }

  const runtimeState = RuntimeContext.state(() => ({
    adapter: undefined as Adapter | undefined,
  }))

  export function register(value: Adapter) {
    const instanceState = runtimeState()

    instanceState.adapter = value
  }

  export function create(input: CreateInput) {
    const instanceState = runtimeState()

    if (!instanceState.adapter) throw new Error("Worktree execution requires a workspace adapter")
    return instanceState.adapter.create(input)
  }

  export async function cleanup(input: { sessionID: string; taskID: string }) {
    const instanceState = runtimeState()

    await instanceState.adapter?.cleanup(input)
  }
}
