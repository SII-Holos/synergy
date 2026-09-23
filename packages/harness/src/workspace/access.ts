import { randomUUID } from "node:crypto"
import { RuntimeContext } from "../lifecycle/context"
import { ScopeContext } from "../scope/context"
import { ExecutionCapacity } from "../session/execution-capacity"
import type { Workspace } from "../session/workspace-schema"
import { WorkspaceBinding } from "./binding"

export namespace WorkspaceAccess {
  export class BusyError extends Error {
    override name = "WorkspaceBusyError"
  }
  export interface ClaimInput {
    id: string
    owner: string
    ancestors: string[]
    kind: "use" | "task" | "operation" | "process" | "exclusive"
    roots: string[] | null
    useRoots?: string[]
    parentClaim?: string
    processID?: number
    retainAfterExit?: boolean
    signal?: AbortSignal
    timeoutMs?: number
  }
  export interface Lease {
    id: string
    release(beforeRelease?: () => Promise<void>): Promise<void>
    bindProcess(processID: number, options?: { descendants?: boolean }): Promise<void>
  }
  export interface Host {
    acquire(input: ClaimInput): Promise<Lease>
  }
  interface Task {
    runtime: RuntimeContext.Instance
    id: string
    owner: string
    sessionID?: string
    ancestors: string[]
    workspace?: Workspace | null
    roots?: string[] | null
    lease?: Lease
    use?: Lease
    uses: Map<string, Lease>
    bindings: Map<string, Workspace>
    useRoots: Set<string>
    retired: Set<Lease>
    activity: number
    transitioning: boolean
    serial: Promise<void>
    closed: boolean
    signal: AbortSignal
  }
  type WriteFinalizer = { finish(): Promise<void>; afterRelease?(): Promise<void> }
  type WriteObserver = (input: {
    roots: string[] | null
    workspaces: Workspace[]
    signal: AbortSignal
  }) => Promise<WriteFinalizer | undefined>
  const observers = RuntimeContext.createAsyncContext<
    { runtime: RuntimeContext.Instance; observe: WriteObserver } | undefined
  >()
  export function observeWrites<T>(observe: WriteObserver | undefined, fn: () => Promise<T>): Promise<T> {
    return observers.run(observe ? { runtime: RuntimeContext.current(), observe } : undefined, fn)
  }
  function observer() {
    const current = observers.getStore()
    return current?.runtime === RuntimeContext.current() ? current.observe : undefined
  }
  function observation(task: Task, roots: string[] | null) {
    return {
      roots,
      workspaces: structuredClone([...(task.workspace ? [task.workspace] : []), ...task.bindings.values()]),
      signal: task.signal,
    }
  }
  const context = RuntimeContext.createAsyncContext<Task>()
  const state = RuntimeContext.state(() => ({ host: undefined as Host | undefined }))

  export function register(host: Host) {
    RuntimeContext.assertCompositionOpen("Workspace access")
    if (state().host) throw new Error("Workspace access is already registered")
    state().host = host
  }
  function host() {
    const source = state().host
    if (!source) throw new Error("This Runtime has no local Workspace coordination host")
    return source
  }
  function current() {
    const task = context.getStore()
    if (task && task.runtime !== RuntimeContext.current()) throw new Error("Workspace task belongs to another Runtime")
    if (task?.closed) throw new Error("Workspace task is closed")
    return task
  }
  async function validate(task: Task) {
    task.signal.throwIfAborted()
    if (task.closed) throw new Error("Workspace task is closed")
    const workspace = task.workspace
    if (workspace?.id) await WorkspaceBinding.validate(workspace.id, workspace.scopeID, workspace.generation)
  }

  export async function task<T>(
    input: { sessionID?: string; parentSessionID?: string; workspace?: Workspace | null; signal?: AbortSignal },
    fn: () => Promise<T>,
  ): Promise<T> {
    const runtime = RuntimeContext.current()
    const parent = context.getStore()
    const controller = new AbortController()
    const value: Task = {
      runtime,
      id: randomUUID(),
      owner: JSON.stringify([runtime.host.root, input.sessionID ?? randomUUID()]),
      sessionID: input.sessionID,
      ancestors: input.parentSessionID
        ? [
            JSON.stringify([runtime.host.root, input.parentSessionID]),
            ...(parent?.runtime === runtime && input.parentSessionID === parent.sessionID ? parent.ancestors : []),
          ]
        : [],
      workspace: input.workspace,
      closed: false,
      uses: new Map(),
      bindings: new Map(),
      useRoots: new Set(input.workspace ? [input.workspace.path] : []),
      retired: new Set(),
      activity: 0,
      transitioning: false,
      serial: Promise.resolve(),
      signal: input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal,
    }
    try {
      if (value.workspace && state().host) {
        await ExecutionCapacity.wait(async () => {
          value.use = await host().acquire({
            id: randomUUID(),
            owner: value.owner,
            ancestors: value.ancestors,
            kind: "use",
            roots: [value.workspace!.path],
            signal: value.signal,
          })
        })
        await validate(value)
      }
      return await context.run(value, fn)
    } finally {
      value.closed = true
      controller.abort(new DOMException("Workspace task ended", "AbortError"))
      await value.serial.catch(() => {})
      const released = await Promise.allSettled([
        value.lease?.release(),
        value.use?.release(),
        ...[...value.uses.values()].map((lease) => lease.release()),
        ...[...value.retired].map((lease) => lease.release()),
      ])
      const errors = released.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
      if (errors.length) throw new AggregateError(errors, "Workspace claims could not be released")
    }
  }

  async function serial<T>(task: Task, fn: () => Promise<T>) {
    const pending = task.serial.then(fn, fn)
    task.serial = pending.then(
      () => {},
      () => {},
    )
    return pending
  }
  async function reserve(task: Task, roots: string[] | null, signal?: AbortSignal, includeWorkspace = true) {
    return serial(task, async () => {
      await validate(task)
      const combined = signal ? AbortSignal.any([task.signal, signal]) : task.signal
      task.roots =
        roots === null || task.roots === null
          ? null
          : [
              ...new Set([
                ...(task.roots ?? []),
                ...(includeWorkspace && task.workspace ? [task.workspace.path] : []),
                ...roots,
              ]),
            ]
      task.lease = await host().acquire({
        id: task.id,
        owner: task.owner,
        ancestors: task.ancestors,
        kind: "task",
        roots: task.roots,
        signal: combined,
      })
      await validate(task)
    })
  }
  async function inTask<T>(fn: (task: Task) => Promise<T>, signal?: AbortSignal) {
    const active = current()
    if (active) return withActivity(active, () => fn(active))
    return task({ workspace: ScopeContext.tryWorkspace(), signal }, () => {
      const active = current()!
      return withActivity(active, () => fn(active))
    })
  }

  async function withActivity<T>(task: Task, fn: () => Promise<T>): Promise<T> {
    if (task.transitioning) throw new BusyError("A Workspace switch is in flight")
    task.activity++
    try {
      return await fn()
    } finally {
      task.activity--
    }
  }

  export function owns(sessionID: string) {
    return current()?.sessionID === sessionID
  }

  export async function transition<T>(sessionID: string, workspace: Workspace | null, commit: () => Promise<T>) {
    const task = current()
    if (!task || task.sessionID !== sessionID) return commit()
    const previous = task.workspace
    if (
      previous?.id === workspace?.id &&
      previous?.generation === workspace?.generation &&
      previous?.path === workspace?.path
    )
      return commit()
    if (task.transitioning || task.activity) throw new BusyError("Workspace operations are in flight")
    task.transitioning = true
    try {
      return await serial(task, async () => {
        let nextUse: Lease | undefined
        try {
          if (workspace) {
            if (!workspace.id) throw new Error("Workspace must be registered before switching an active Task")
            await ExecutionCapacity.wait(async () => {
              nextUse = await host().acquire({
                id: randomUUID(),
                owner: task.owner,
                ancestors: task.ancestors,
                kind: "use",
                roots: [workspace.path],
                signal: task.signal,
              })
              await WorkspaceBinding.validate(workspace.id!, workspace.scopeID, workspace.generation)
            })
          }
          task.signal.throwIfAborted()
          if (task.closed) throw new Error("Workspace task is closed")
          const result = await commit()
          for (const lease of [task.lease, task.use, ...task.uses.values()]) if (lease) task.retired.add(lease)
          task.workspace = workspace
          task.use = nextUse
          nextUse = undefined
          task.lease = undefined
          task.roots = undefined
          task.uses.clear()
          task.bindings.clear()
          task.useRoots = new Set(workspace ? [workspace.path] : [])
          ScopeContext.refreshWorkspace(workspace)
          const released = await Promise.allSettled(
            [...task.retired].map(async (lease) => {
              await lease.release()
              task.retired.delete(lease)
            }),
          )
          const failures = released.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
          if (failures.length) throw new AggregateError(failures, "Previous Workspace claims could not be released")
          return result
        } finally {
          await nextUse?.release()
        }
      })
    } finally {
      task.transitioning = false
    }
  }

  export async function reserveWrite(roots: string[] | null, signal?: AbortSignal): Promise<void> {
    const task = current()
    if (!task) throw new Error("A write reservation requires a Workspace task")
    await withActivity(task, async () => {
      await ExecutionCapacity.wait(() => reserve(task, roots, signal))
      await validate(task)
    })
  }

  export async function write<T>(roots: string[] | null, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!RuntimeContext.tryCurrent()) return fn()
    return inTask(async (task) => {
      let operation: Lease | undefined
      let finalize: WriteFinalizer | undefined
      try {
        await ExecutionCapacity.wait(async () => {
          await reserve(task, roots, signal)
          operation = await host().acquire({
            id: randomUUID(),
            owner: task.owner,
            ancestors: task.ancestors,
            kind: "operation",
            parentClaim: task.id,
            roots: roots === null ? null : [...new Set([...(task.workspace ? [task.workspace.path] : []), ...roots])],
            signal: signal ? AbortSignal.any([signal, task.signal]) : task.signal,
          })
        })
        signal?.throwIfAborted()
        await validate(task)
        finalize = await observer()?.(observation(task, roots))
        signal?.throwIfAborted()
        await validate(task)
        return await fn()
      } finally {
        try {
          await finalize?.finish()
        } finally {
          await operation?.release()
          await finalize?.afterRelease?.()
        }
      }
    }, signal)
  }

  export async function process(roots: string[] | null, signal?: AbortSignal): Promise<Lease> {
    return inTask(async (task) => {
      let lease: Lease | undefined
      const observe = observer()
      try {
        await ExecutionCapacity.wait(async () => {
          const writes = roots === null || roots.length > 0
          if (writes) await reserve(task, roots, signal, false)
          lease = await host().acquire({
            id: randomUUID(),
            owner: task.owner,
            ancestors: task.ancestors,
            kind: "process",
            retainAfterExit: !!observe,
            parentClaim: writes ? task.id : undefined,
            roots,
            useRoots: [...task.useRoots],
            signal: signal ? AbortSignal.any([signal, task.signal]) : task.signal,
          })
        })
        signal?.throwIfAborted()
        await validate(task)
        const finalize = roots?.length === 0 ? undefined : await observe?.(observation(task, roots))
        const owned = lease!
        if (!finalize) return owned
        let finalized = false
        let afterRelease: Promise<void> | undefined
        return {
          ...owned,
          async release(beforeRelease?: () => Promise<void>) {
            await owned.release(async () => {
              await finalize.finish()
              await beforeRelease?.()
              finalized = true
            })
            if (finalized) await (afterRelease ??= finalize.afterRelease?.() ?? Promise.resolve())
          },
        }
      } catch (error) {
        await lease?.release()
        throw error
      }
    }, signal)
  }

  export async function pin(signal?: AbortSignal): Promise<Lease> {
    const workspace = ScopeContext.current.workspace
    if (!workspace?.id) throw new Error("A resolved Workspace is required for file resources")
    const active = current()
    const lease = await ExecutionCapacity.wait(() =>
      host().acquire({
        id: randomUUID(),
        owner: active?.owner ?? JSON.stringify([RuntimeContext.current().host.root, randomUUID()]),
        ancestors: active?.ancestors ?? [],
        kind: "use",
        roots: [workspace.path],
        signal,
      }),
    )
    try {
      signal?.throwIfAborted()
      await WorkspaceBinding.validate(workspace.id, workspace.scopeID, workspace.generation)
      return lease
    } catch (error) {
      await lease.release()
      throw error
    }
  }

  export async function use(workspaces: Workspace[]) {
    const task = current()
    if (!task || !state().host) return
    await withActivity(task, async () => {
      await ExecutionCapacity.wait(() =>
        serial(task, async () => {
          for (const workspace of workspaces) {
            task.useRoots.add(workspace.path)
            const key = JSON.stringify([workspace.id, workspace.generation])
            if (!task.uses.has(key))
              task.uses.set(
                key,
                await host().acquire({
                  id: randomUUID(),
                  owner: task.owner,
                  ancestors: task.ancestors,
                  kind: "use",
                  roots: [workspace.path],
                  signal: task.signal,
                }),
              )
            if (workspace.id) await WorkspaceBinding.validate(workspace.id, workspace.scopeID, workspace.generation)
            task.bindings.set(key, structuredClone(workspace))
          }
        }),
      )
      await validate(task)
    })
  }

  export function signal() {
    return current()?.signal
  }

  export async function handoff<T>(fn: () => Promise<T>): Promise<T> {
    const task = current()
    return ExecutionCapacity.wait(async () => {
      if (task)
        await serial(task, async () => {
          await task.lease?.release()
          task.lease = undefined
          task.roots = undefined
        })
      return fn()
    })
  }

  export async function exclusive<T>(roots: string[], fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    let lease: Lease | undefined
    try {
      await ExecutionCapacity.wait(async () => {
        lease = await host().acquire({
          id: randomUUID(),
          owner: randomUUID(),
          ancestors: [],
          kind: "exclusive",
          roots,
          signal,
          timeoutMs: 1000,
        })
      })
      signal?.throwIfAborted()
      return await fn()
    } finally {
      await lease?.release()
    }
  }
}
