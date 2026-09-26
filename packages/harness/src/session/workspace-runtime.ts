import { RuntimeContext } from "../lifecycle/context"
import type { Info } from "./types"
import { Lock } from "../util/lock"
import { ExecutionCapacity } from "./execution-capacity"

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
  type Transition = (session: Info, workspace: Info["workspace"]) => Promise<void>
  const state = RuntimeContext.state(() => ({
    provider: undefined as Provider | undefined,
    transitions: new Map<string, Transition>(),
  }))
  const binding = RuntimeContext.createAsyncContext<{
    runtime: RuntimeContext.Instance
    sessionID: string
    active: boolean
  }>()

  export async function withBinding<T>(sessionID: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const runtime = RuntimeContext.current()
    const current = binding.getStore()
    if (current?.runtime === runtime && current.sessionID === sessionID && current.active) return fn()
    const abort = signal ?? new AbortController().signal
    let lease: Disposable | undefined
    const value = { runtime, sessionID, active: true }
    try {
      await ExecutionCapacity.wait(async () => {
        lease = await Lock.writeWithSignal(`session-workspace:${sessionID}`, abort)
      })
      abort.throwIfAborted()
      if (!lease) throw new Error("Session Workspace binding could not be acquired")
      return await binding.run(value, fn)
    } finally {
      value.active = false
      lease?.[Symbol.dispose]()
    }
  }

  export function registerTransition(id: string, transition: Transition) {
    RuntimeContext.assertCompositionOpen("Session Workspace transition")
    if (state().transitions.has(id)) throw new Error(`Session Workspace transition is already registered: ${id}`)
    state().transitions.set(id, transition)
  }

  export async function beforeTransition(session: Info, workspace: Info["workspace"]) {
    if (
      session.workspaceID === (workspace?.id ?? null) &&
      session.workspace?.generation === workspace?.generation &&
      session.workspace?.path === workspace?.path
    )
      return
    for (const transition of state().transitions.values()) await transition(session, workspace)
  }
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
