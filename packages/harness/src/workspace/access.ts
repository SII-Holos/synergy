import { randomUUID } from "node:crypto"
import { RuntimeContext } from "../lifecycle/context"
import { ScopeContext } from "../scope/context"
import { ExecutionCapacity } from "../session/execution-capacity"
import type { Workspace } from "../session/workspace-schema"
import { WorkspaceBinding } from "./binding"
import path from "node:path"
import { WorkspaceBusyError } from "./claim"
import { Storage } from "../storage/storage"
import { RuntimeMaintenance } from "../storage/runtime-maintenance"
import { addAbortListener } from "node:events"

export namespace WorkspaceAccess {
  export const BusyError = WorkspaceBusyError
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
    durable?: boolean
    cooperative?: boolean
    transient?: boolean
    signal?: AbortSignal
    timeoutMs?: number
  }
  export interface Lease {
    id: string
    recovery?: { id: string; token: string }
    isolated?(): Promise<boolean>
    isReleased?(): Promise<boolean>
    release(beforeRelease?: () => Promise<void>): Promise<void>
    bindProcess(processID: number, options?: { descendants?: boolean }): Promise<void>
  }
  export interface Host {
    acquire(input: ClaimInput): Promise<Lease>
    contendedProcesses?(): Promise<string[]>
  }
  interface Task {
    runtime: RuntimeContext.Instance
    owner: string
    sessionID?: string
    ancestors: string[]
    workspace?: Workspace | null
    use?: Lease
    uses: Map<string, Lease>
    bindings: Map<string, Workspace>
    useRoots: Set<string>
    retired: Set<Lease>
    activity: number
    transitioning: boolean
    retiring?: boolean
    serial: Promise<void>
    closed: boolean
    signal: AbortSignal
  }
  type WriteFinalizer = { finish(isolated?: () => Promise<boolean>): Promise<void>; afterRelease?(): Promise<void> }
  type WriteObserver = (input: {
    roots: string[] | null
    workspaces: Workspace[]
    signal: AbortSignal
  }) => Promise<WriteFinalizer | undefined>
  const observers = RuntimeContext.createAsyncContext<
    { runtime: RuntimeContext.Instance; observe: WriteObserver } | undefined
  >()
  const useObservers = RuntimeContext.createAsyncContext<
    { runtime: RuntimeContext.Instance; observe: (workspaces: Workspace[]) => Promise<void> } | undefined
  >()
  export function observeUses<T>(observe: (workspaces: Workspace[]) => Promise<void>, fn: () => Promise<T>) {
    return useObservers.run({ runtime: RuntimeContext.current(), observe }, fn)
  }
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
  interface ClaimContext { task: Task; lease: Lease; open: boolean }
  const mutation = RuntimeContext.createAsyncContext<ClaimContext>()
  const retirement = RuntimeContext.createAsyncContext<ClaimContext & { roots: string[] }>()
  interface NativeClaim {
    runtime: RuntimeContext.Instance
    store: Storage.Handle["store"]
    completion: PromiseWithResolvers<void>
    released: boolean
    finalizing: number
    failure?: unknown
    inspectRelease?: () => Promise<boolean>
  }
  const claims = new WeakMap<Lease, NativeClaim>()
  const tail = RuntimeContext.createAsyncContext<{ claim: NativeClaim; open: boolean }>()
  const state = RuntimeContext.state(() => ({ host: undefined as Host | undefined, active: new Set<NativeClaim>() }))

  function selected(claim: NativeClaim) {
    return claim.runtime === RuntimeContext.current() && claim.store === Storage.current().store && state().active.has(claim)
  }
  function settle(claim: NativeClaim) {
    if (!claim.released || claim.finalizing || claim.failure !== undefined) return
    state().active.delete(claim)
    claim.completion.resolve()
  }
  function parentClaim(task: Task | undefined) {
    if (!task || task.closed) return
    for (const parent of [retirement.getStore(), mutation.getStore()])
      if (parent?.open && parent.task === task) return parent
  }
  async function withTail<T>(claim: NativeClaim, body: () => Promise<T>) {
    const scope = { claim, open: true }
    try { return await tail.run(scope, body) } finally { scope.open = false }
  }
  async function claimAdmission() {
    const parent = parentClaim(context.getStore())
    const inherited = parent ? claims.get(parent.lease) : undefined
    const finalizer = tail.getStore()
    const owner = inherited ?? (finalizer?.open ? finalizer.claim : undefined)
    if (owner && selected(owner)) return RuntimeMaintenance.assertMutation()
    return RuntimeMaintenance.assertAdmission()
  }
  async function acquire(source: Host, input: ClaimInput): Promise<Lease> {
    if (input.kind === "use") return source.acquire(input)
    const active: NativeClaim = {
      runtime: RuntimeContext.current(), store: Storage.current().store,
      completion: Promise.withResolvers<void>(), released: false, finalizing: 0,
    }
    state().active.add(active)
    let owned: Lease | undefined
    try {
      await claimAdmission()
      const native = await source.acquire(input)
      active.inspectRelease = native.isReleased?.bind(native)
      let closing: Promise<void> | undefined
      owned = {
        ...native,
        async bindProcess(processID, options) {
          if (!selected(active) || active.released)
            throw new Error("Workspace claim belongs to another Runtime or namespace, or is released")
          await native.bindProcess(processID, options)
        },
        async release(beforeRelease) {
          if (!selected(active)) {
            if (active.released) return
            throw new Error("Workspace claim belongs to another Runtime or namespace")
          }
          if (active.released) return
          if (!closing && active.failure !== undefined) {
            active.failure = undefined
            active.completion = Promise.withResolvers<void>()
          }
          closing ??= withTail(active, async () => {
            try {
              await native.release(beforeRelease)
              active.failure = undefined
              active.released = native.isReleased ? await native.isReleased() : true
              settle(active)
            } catch (error) {
              active.failure = error
              active.completion.resolve()
              throw error
            }
          })
          try { await closing } finally { if (!active.released) closing = undefined }
        },
      }
      claims.set(owned, active)
      await claimAdmission()
      return owned
    } catch (error) {
      if (owned) await owned.release()
      else {
        state().active.delete(active)
        active.completion.resolve()
      }
      throw error
    }
  }
  async function finishClaim<T>(lease: Lease | undefined, body: () => Promise<T>): Promise<T> {
    if (!lease) return body()
    const claim = claims.get(lease)
    if (!claim || !selected(claim)) throw new Error("Workspace finalizer has no current native claim")
    if (claim.failure !== undefined) {
      claim.failure = undefined
      claim.completion = Promise.withResolvers<void>()
    }
    claim.finalizing++
    try {
      const value = await withTail(claim, body)
      claim.failure = undefined
      return value
    } catch (error) {
      claim.failure = error
      claim.completion.resolve()
      throw error
    } finally {
      claim.finalizing--
      settle(claim)
    }
  }
  function maintenanceRequirements(): RuntimeMaintenance.Requirement[] {
    if ([...state().active].some((claim) => !selected(claim) || claim.failure !== undefined))
      return [{ owner: "workspace-access", code: "workspace_claim_release_unknown", label: "Reconcile the original Workspace claim and final save", recoverable: true }]
    return state().active.size
      ? [{ owner: "workspace-access", code: "workspace_claim_active", label: "Wait for accepted Workspace writers and their finalizers", recoverable: true }]
      : []
  }
  async function reconcileClaims(signal: AbortSignal) {
    for (const claim of state().active) {
      signal.throwIfAborted()
      if (!selected(claim)) throw new Error("Workspace maintenance found a claim from another namespace")
      if (claim.failure !== undefined || claim.finalizing || !claim.inspectRelease) continue
      if (!(await claim.inspectRelease())) continue
      claim.released = true
      settle(claim)
    }
  }

  export function register(host: Host) {
    RuntimeContext.assertCompositionOpen("Workspace access")
    if (state().host) throw new Error("Workspace access is already registered")
    state().host = {
      acquire: (input) => acquire(host, input),
      ...(host.contendedProcesses ? { contendedProcesses: () => host.contendedProcesses!() } : {}),
    }
    RuntimeMaintenance.register("workspace-access", {
      version: 1, order: 250,
      async suspend(context) { await RuntimeMaintenance.assertDraining(context.lease) },
      async drain(context) {
        await RuntimeMaintenance.assertDraining(context.lease)
        while ([...state().active].some((claim) => claim.failure === undefined)) {
          await reconcileClaims(context.signal)
          if (![...state().active].some((claim) => claim.failure === undefined)) break
          context.signal.throwIfAborted()
          const aborted = Promise.withResolvers<never>()
          using listener = addAbortListener(context.signal, () => aborted.reject(context.signal.reason))
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            await Promise.race([
              Promise.all([...state().active].map((claim) => claim.completion.promise)),
              aborted.promise,
              ...(state().active.size && [...state().active].some((claim) => claim.inspectRelease)
                ? [new Promise<void>((resolve) => { timer = setTimeout(resolve, 100) })]
                : []),
            ])
          } finally { clearTimeout(timer) }
        }
        const requirements = maintenanceRequirements()
        if (requirements.length) throw new RuntimeMaintenance.Blocked({ message: "Workspace physical claims require reconciliation", requirements })
      },
      async inspect(context) { await reconcileClaims(context.signal); return maintenanceRequirements() },
      async release(context) { await RuntimeMaintenance.assertReleasing(context.lease) },
    })
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

  interface TaskInput {
    sessionID?: string
    parentSessionID?: string
    workspace?: Workspace | null
    signal?: AbortSignal
    lazy?: boolean
  }
  export function task<T>(input: TaskInput, fn: () => Promise<T>): Promise<T> {
    return runTask(input, fn)
  }

  async function runTask<T>(input: TaskInput, fn: () => Promise<T>, owner?: string): Promise<T> {
    const runtime = RuntimeContext.current()
    const parent = context.getStore()
    const controller = new AbortController()
    const value: Task = {
      runtime,
      owner: owner ?? JSON.stringify([runtime.host.root, input.sessionID ?? randomUUID()]),
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
      if (value.workspace && state().host && !input.lazy) {
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
  export function withinTask<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const active = current()
    if (active) return withActivity(active, fn)
    return task({ workspace: ScopeContext.tryWorkspace(), signal }, () => withActivity(current()!, fn))
  }

  export function maintenance<T>(
    fn: () => Promise<T>,
    options: { signal?: AbortSignal; inheritOwner?: boolean } = {},
  ): Promise<T> {
    const owner = options.inheritOwner ? current()?.owner : undefined
    return ExecutionCapacity.detached(() =>
      observeWrites(undefined, () => runTask({ workspace: null, signal: options.signal }, fn, owner)),
    )
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
    if (task.retiring && retirement.getStore()?.task !== task) throw new BusyError("Workspace removal is in flight")
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

  export function ambientSessionID() {
    return current()?.sessionID
  }

  export function transition<T>(
    sessionID: string,
    workspace: Workspace | null,
    commit: () => Promise<T>,
    signal?: AbortSignal,
  ) {
    const active = current()?.signal
    const abort = signal && active ? AbortSignal.any([signal, active]) : (signal ?? active)
    abort?.throwIfAborted()
    return transitionTask(sessionID, workspace, commit, abort)
  }

  async function transitionTask<T>(
    sessionID: string,
    workspace: Workspace | null,
    commit: () => Promise<T>,
    signal?: AbortSignal,
  ) {
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
                signal: signal ?? task.signal,
              })
              await WorkspaceBinding.validate(workspace.id!, workspace.scopeID, workspace.generation)
            })
          }
          signal?.throwIfAborted()
          task.signal.throwIfAborted()
          if (task.closed) throw new Error("Workspace task is closed")
          const result = await commit()
          for (const lease of [task.use, ...task.uses.values()]) if (lease) task.retired.add(lease)
          task.workspace = workspace
          task.use = nextUse
          nextUse = undefined
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

  export async function write<T>(roots: string[], fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!RuntimeContext.tryCurrent()) return fn()
    return inTask(async (task) => {
      let operation: Lease | undefined
      let finalize: WriteFinalizer | undefined
      try {
        await ExecutionCapacity.wait(async () => {
          const parent = parentClaim(task)
          operation = await host().acquire({
            id: randomUUID(),
            owner: task.owner,
            ancestors: task.ancestors,
            kind: "task",
            parentClaim: parent?.task === task ? parent.lease.id : undefined,
            roots,
            signal: signal ? AbortSignal.any([signal, task.signal]) : task.signal,
          })
        })
        signal?.throwIfAborted()
        await validate(task)
        finalize = await observer()?.(observation(task, roots))
        signal?.throwIfAborted()
        await validate(task)
        const admitted = { task, lease: operation!, open: true }
        try { return await mutation.run(admitted, fn) } finally { admitted.open = false }
      } finally {
        await finishClaim(operation, async () => {
          try {
            await finalize?.finish(operation?.isolated)
          } finally {
            await operation?.release()
            await finalize?.afterRelease?.()
          }
        })
      }
    }, signal)
  }

  export async function metadata<T>(roots: string[], fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return inTask(async (task) => {
      let lease: Lease | undefined
      try {
        await ExecutionCapacity.wait(async () => {
          const parent = parentClaim(task)
          lease = await host().acquire({
            id: randomUUID(),
            owner: task.owner,
            ancestors: task.ancestors,
            kind: "operation",
            parentClaim: parent?.task === task ? parent.lease.id : undefined,
            transient: true,
            roots,
            signal: signal ? AbortSignal.any([signal, task.signal]) : task.signal,
          })
        })
        signal?.throwIfAborted()
        await validate(task)
        return await fn()
      } finally {
        await lease?.release()
      }
    }, signal)
  }

  export async function process(
    useRoots: string[],
    signal?: AbortSignal,
    options?: {
      cooperative?: boolean
      retainAfterExit?: boolean
      transient?: boolean
      durable?: boolean
      mutationRoots?: string[]
    },
  ): Promise<Lease> {
    if (options?.cooperative && !host().contendedProcesses)
      throw new Error("This Runtime cannot monitor cooperative process contention")
    return inTask(async (task) => {
      let lease: Lease | undefined
      const observe = observer()
      try {
        await ExecutionCapacity.wait(async () => {
          const parent = parentClaim(task)
          lease = await host().acquire({
            id: randomUUID(),
            owner: task.owner,
            ancestors: task.ancestors,
            kind: "process",
            retainAfterExit: !!observe || options?.retainAfterExit,
            durable: options?.durable,
            cooperative: options?.cooperative,
            parentClaim: parent?.task === task ? parent.lease.id : undefined,
            transient: options?.transient || parent?.task === task,
            roots: options?.mutationRoots ?? [],
            useRoots: [...new Set([...task.useRoots, ...useRoots])],
            signal: signal ? AbortSignal.any([signal, task.signal]) : task.signal,
          })
        })
        signal?.throwIfAborted()
        await validate(task)
        const finalize =
          useRoots.length === 0
            ? undefined
            : await observe?.(observation(task, options?.mutationRoots?.length ? options.mutationRoots : useRoots))
        const owned = lease!
        if (!finalize) return owned
        let finalized = false
        let afterRelease: Promise<void> | undefined
        let releasing: Promise<void> | undefined
        return {
          ...owned,
          async release(beforeRelease?: () => Promise<void>) {
            releasing ??= finishClaim(owned, async () => {
              await owned.release(async () => {
                await finalize.finish(owned.isolated)
                await beforeRelease?.()
                finalized = true
              })
              if (finalized) await (afterRelease ??= finalize.afterRelease?.() ?? Promise.resolve())
            })
            try { await releasing } catch (error) { releasing = undefined; throw error }
            finally { if (!finalized) releasing = undefined }
          },
        }
      } catch (error) {
        await lease?.release()
        throw error
      }
    }, signal)
  }

  export function contendedProcesses(): Promise<string[]> {
    const provider = host()
    if (!provider.contendedProcesses) throw new Error("This Runtime cannot monitor cooperative process contention")
    return provider.contendedProcesses()
  }

  export async function hostClaim(
    input: Omit<ClaimInput, "owner" | "ancestors" | "parentClaim" | "useRoots">,
  ): Promise<Lease> {
    if (input.kind === "exclusive" && !current()) return maintenance(() => hostClaim(input))
    return inTask(async (task) => {
      let lease: Lease | undefined
      try {
        await ExecutionCapacity.wait(async () => {
          const parent = parentClaim(task)
          lease = await host().acquire({
            ...input,
            owner: task.owner,
            ancestors: task.ancestors,
            parentClaim: parent?.task === task ? parent.lease.id : undefined,
            useRoots: [...task.useRoots],
            signal: input.signal ? AbortSignal.any([input.signal, task.signal]) : task.signal,
          })
        })
        input.signal?.throwIfAborted()
        await validate(task)
        return lease!
      } catch (error) {
        await lease?.release()
        throw error
      }
    }, input.signal)
  }

  export async function pin(signal?: AbortSignal): Promise<Lease> {
    const workspace = ScopeContext.current.workspace
    if (!workspace?.id) throw new Error("A resolved Workspace is required for file resources")
    const active = current()
    let lease: Lease | undefined
    try {
      await ExecutionCapacity.wait(async () => {
        lease = await host().acquire({
          id: randomUUID(),
          owner: active?.owner ?? JSON.stringify([RuntimeContext.current().host.root, randomUUID()]),
          ancestors: active?.ancestors ?? [],
          kind: "use",
          roots: [workspace.path],
          signal,
        })
      })
      signal?.throwIfAborted()
      await WorkspaceBinding.validate(workspace.id, workspace.scopeID, workspace.generation)
      return lease!
    } catch (error) {
      await lease?.release()
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
    const listener = useObservers.getStore()
    if (listener?.runtime === RuntimeContext.current()) await listener.observe(workspaces)
  }

  export function signal() {
    return current()?.signal
  }

  export async function handoff<T>(fn: () => Promise<T>): Promise<T> {
    const task = current()
    if (task?.retiring) throw new BusyError("Cannot release write ownership during retirement")
    return ExecutionCapacity.wait(fn)
  }

  export async function exclusive<T>(roots: string[], fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const retiring = retirement.getStore()
    const parent = retiring?.open ? retiring : undefined
    if (parent && (!parent.task.retiring || parent.task !== current()))
      throw new BusyError("Workspace retirement is no longer active")
    if (
      parent &&
      !roots.every((root) =>
        parent.roots.some((allowed) => {
          const relative = path.relative(allowed, path.resolve(root))
          return (
            relative === "" ||
            (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
          )
        }),
      )
    )
      throw new BusyError("Exclusive operation escapes its retirement roots")
    let lease: Lease | undefined
    try {
      await ExecutionCapacity.wait(async () => {
        lease = await host().acquire({
          id: randomUUID(),
          owner: parent?.task.owner ?? JSON.stringify([RuntimeContext.current().host.root, randomUUID()]),
          ancestors: parent?.task.ancestors ?? [],
          parentClaim: parent?.lease.id,
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

  export async function retire<T>(
    roots: string[],
    fn: () => Promise<T>,
    options: { writeRoots?: string[]; signal?: AbortSignal } = {},
  ): Promise<T> {
    return inTask(async (task) => {
      const signal = options.signal ? AbortSignal.any([options.signal, task.signal]) : task.signal
      signal.throwIfAborted()
      if (task.activity !== 1 || task.retiring) throw new BusyError("Workspace operations are in flight")
      const bindings = [...(task.workspace ? [task.workspace] : []), ...task.bindings.values()]
      if (
        roots.some((root) =>
          bindings.some((binding) => {
            const relative = path.relative(root, binding.path)
            return (
              relative === "" ||
              (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
            )
          }),
        )
      )
        throw new BusyError("Leave the Workspace before removing its directory")
      task.retiring = true
      let lease: Lease | undefined
      let reservation: Lease | undefined
      try {
        await ExecutionCapacity.wait(async () => {
          reservation = await host().acquire({
            id: randomUUID(),
            owner: task.owner,
            ancestors: task.ancestors,
            kind: "task",
            roots: [...roots, ...(options.writeRoots ?? [])],
            signal,
            timeoutMs: 1000,
          })
          lease = await host().acquire({
            id: randomUUID(),
            owner: task.owner,
            ancestors: task.ancestors,
            kind: "exclusive",
            parentClaim: reservation!.id,
            transient: true,
            roots,
            signal,
            timeoutMs: 1000,
          })
        })
        await validate(task)
        signal.throwIfAborted()
        const admitted = { task, lease: lease!, roots: roots.map((root) => path.resolve(root)), open: true }
        try { return await retirement.run(admitted, fn) } finally { admitted.open = false }
      } finally {
        try {
          try {
            await lease?.release()
          } finally {
            await reservation?.release()
          }
        } finally {
          task.retiring = false
        }
      }
    }, options.signal)
  }
}
