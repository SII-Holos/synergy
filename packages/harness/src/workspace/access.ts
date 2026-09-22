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
    parentClaim?: string
    processID?: number
    signal?: AbortSignal
    timeoutMs?: number
  }
  export interface Lease {
    id: string
    release(): Promise<void>
    bindProcess(processID: number): Promise<void>
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
    uses: Map<string, Lease>
    serial: Promise<void>
    closed: boolean
    signal: AbortSignal
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
      serial: Promise.resolve(),
      signal: input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal,
    }
    let use: Lease | undefined
    try {
      if (value.workspace && state().host) {
        await ExecutionCapacity.wait(async () => {
          use = await host().acquire({
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
        use?.release(),
        ...[...value.uses.values()].map((lease) => lease.release()),
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
  async function reserve(task: Task, roots: string[] | null, signal?: AbortSignal) {
    return serial(task, async () => {
      await validate(task)
      const combined = signal ? AbortSignal.any([task.signal, signal]) : task.signal
      task.roots =
        roots === null || task.roots === null
          ? null
          : [...new Set([...(task.roots ?? []), ...(task.workspace ? [task.workspace.path] : []), ...roots])]
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
    if (active) return fn(active)
    return task({ workspace: ScopeContext.tryWorkspace(), signal }, () => fn(current()!))
  }

  export async function write<T>(roots: string[] | null, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!RuntimeContext.tryCurrent()) return fn()
    return inTask(async (task) => {
      let operation: Lease | undefined
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
        return await fn()
      } finally {
        await operation?.release()
      }
    }, signal)
  }

  export async function process(roots: string[] | null, signal?: AbortSignal): Promise<Lease> {
    return inTask(async (task) => {
      let lease: Lease | undefined
      try {
        await ExecutionCapacity.wait(async () => {
          await reserve(task, roots, signal)
          lease = await host().acquire({
            id: randomUUID(),
            owner: task.owner,
            ancestors: task.ancestors,
            kind: "process",
            parentClaim: task.id,
            roots: roots === null ? null : [...new Set([...(task.workspace ? [task.workspace.path] : []), ...roots])],
            signal: signal ? AbortSignal.any([signal, task.signal]) : task.signal,
          })
        })
        signal?.throwIfAborted()
        await validate(task)
        return lease!
      } catch (error) {
        await lease?.release()
        throw error
      }
    }, signal)
  }

  export async function use(workspaces: Workspace[]) {
    const task = current()
    if (!task || !state().host) return
    await ExecutionCapacity.wait(() =>
      serial(task, async () => {
        for (const workspace of workspaces) {
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
        }
      }),
    )
    await validate(task)
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
