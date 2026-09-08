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

  let adapter: Adapter | undefined

  export function register(value: Adapter) {
    adapter = value
  }

  export function create(input: CreateInput) {
    if (!adapter) throw new Error("Worktree execution requires a workspace adapter")
    return adapter.create(input)
  }

  export async function cleanup(input: { sessionID: string; taskID: string }) {
    await adapter?.cleanup(input)
  }
}
