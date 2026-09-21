import { RuntimeContext } from "../lifecycle/context"
import type { Info } from "./types"

export namespace SessionWorkspaceRuntime {
  export interface Provider {
    lockWorktree(directory: string): Promise<unknown>
    unlockWorktree(directory: string): Promise<void>
    withWorktree<T>(directory: string, sessionID: string | undefined, fn: () => Promise<T>): Promise<T>
    createWorktree(input: {
      sessionID: string
      name?: string
      baseRef: "current" | "fresh"
      baseRevision?: string
      bind: boolean
    }): Promise<unknown>
    enterWorktree(input: { sessionID: string; target: string; force?: boolean }): Promise<unknown>
    releaseSession(session: Pick<Info, "id" | "scope" | "workspace">): Promise<void>
  }
  const state = RuntimeContext.state(() => ({ provider: undefined as Provider | undefined }))
  export function register(provider: Provider) {
    const current = state()
    if (current.provider === provider) return
    RuntimeContext.assertCompositionOpen("Session workspace runtime")
    if (current.provider) throw new Error("Session workspace runtime is already registered")
    current.provider = provider
  }
  export async function releaseSession(session: Pick<Info, "id" | "scope" | "workspace">) {
    await state().provider?.releaseSession(session)
  }
  export function get(): Provider {
    const provider = state().provider
    if (!provider) throw new Error("This Runtime has no local workspace services")
    return provider
  }
}
