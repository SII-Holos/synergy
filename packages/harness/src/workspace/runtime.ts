import { AsyncLocalStorage } from "node:async_hooks"
import { RuntimeContext } from "../lifecycle/context"
import { ScopeStartup } from "../scope/startup"
import { WorkspaceBinding } from "./binding"
import { WorkspaceState } from "./state"
import { WorkspaceAccess } from "./access"
import { SessionWorkspaceRuntime } from "../session/workspace-runtime"
import type { Scope } from "../scope"
import type { Workspace } from "../session/workspace-schema"

export namespace WorkspaceRuntime {
  export async function withUse<T>(
    scope: Scope,
    workspace: Workspace,
    sessionID: string | undefined,
    fn: () => Promise<T>,
  ) {
    if (!workspace.id) throw new Error("Workspace has no canonical reference")
    await WorkspaceBinding.validate(workspace.id, scope.id, workspace.generation)
    const use = await WorkspaceAccess.pin()
    try {
      const run = async () => {
        await ensure(scope, workspace)
        return fn()
      }
      if (workspace.type !== "git_worktree") return await run()
      const worktree = SessionWorkspaceRuntime.get()
      return await worktree.withWorktree(workspace.path, sessionID, async () => {
        await worktree.lockWorktree(workspace.path)
        try {
          return await run()
        } finally {
          await worktree.unlockWorktree(workspace.path)
        }
      })
    } finally {
      await use.release()
    }
  }

  interface Entry {
    scopeID: string
    workspaceID: string
    starting: Promise<void>
    dispose: () => Promise<void>
  }
  const state = RuntimeContext.state(() => ({
    stopped: false,
    started: new Map<string, Entry>(),
    disposing: new Map<string, Promise<void>>(),
  }))

  export async function ensure(scope: Scope, workspace: Workspace): Promise<void> {
    if (!workspace.id) throw new Error("Workspace must be registered before starting file resources")
    await WorkspaceBinding.validate(workspace.id, scope.id, workspace.generation)
    const current = state()
    await current.disposing.get(scope.id)
    if (current.stopped) throw new Error("Workspace runtime is stopping")
    const key = WorkspaceState.key()
    const previous = [...current.started].filter(
      ([other, entry]) => other !== key && entry.workspaceID === workspace.id,
    )
    for (const [oldKey] of previous) await dispose(oldKey)
    const existing = current.started.get(key)
    if (existing) return existing.starting
    const entry: Entry = {
      scopeID: scope.id,
      workspaceID: workspace.id,
      starting: Promise.resolve(),
      dispose: AsyncLocalStorage.bind(async () => {
        const errors: unknown[] = []
        for (const cleanup of [() => ScopeStartup.dispose(key), () => WorkspaceState.dispose(key)]) {
          try {
            await cleanup()
          } catch (error) {
            errors.push(error)
          }
        }
        if (errors.length) throw new AggregateError(errors, "Workspace shutdown failed")
      }),
    }
    current.started.set(key, entry)
    entry.starting = ScopeStartup.run({
      scope,
      workspaceKey: key,
      notifyStarting() {},
    }).catch(async (error) => {
      try {
        await entry.dispose()
      } finally {
        current.started.delete(key)
      }
      throw error
    })
    return entry.starting
  }

  async function dispose(key: string) {
    const current = state()
    const entry = current.started.get(key)
    if (!entry) return
    await entry.starting.catch(() => {})
    try {
      await entry.dispose()
    } finally {
      current.started.delete(key)
    }
  }

  export async function disposeWorkspace(workspaceID: string) {
    const results = await Promise.allSettled(
      [...state().started].filter(([, entry]) => entry.workspaceID === workspaceID).map(([key]) => dispose(key)),
    )
    results.push(...(await Promise.allSettled([WorkspaceState.disposeWorkspace(workspaceID)])))
    const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    if (errors.length) throw new AggregateError(errors, "Workspace shutdown failed")
  }

  export async function disposeScope(scopeID: string): Promise<void> {
    const current = state()
    const existing = current.disposing.get(scopeID)
    if (existing) return existing
    const task = (async () => {
      const results = await Promise.allSettled(
        [...current.started].filter(([, entry]) => entry.scopeID === scopeID).map(([key]) => dispose(key)),
      )
      results.push(...(await Promise.allSettled([WorkspaceState.disposeScope(scopeID)])))
      const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
      if (errors.length) throw new AggregateError(errors, "Workspace shutdown failed")
    })().finally(() => current.disposing.delete(scopeID))
    current.disposing.set(scopeID, task)
    return task
  }

  export async function disposeAll() {
    const results = await Promise.allSettled(
      [...new Set([...state().started.values()].map((entry) => entry.scopeID))].map(disposeScope),
    )
    const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    if (errors.length) throw new AggregateError(errors, "Workspace shutdown failed")
  }

  export function stop() {
    state().stopped = true
  }
}
