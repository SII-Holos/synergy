import { z } from "zod"
import { RuntimeContext } from "../lifecycle/context"
import { Storage } from "../storage/storage"
import { JsonValue } from "../util/json-value"
import { EnvironmentOrigin } from "./origin"
import { EnvironmentSchema } from "./schema"
import { EnvironmentExecutionSchema } from "./execution-schema"
import { ExecutionProtocol, type Executor } from "./executor"
import { WorkspaceProtocol } from "../workspace/protocol"
import { ProcessAccessSource } from "../process/access-source"

export namespace EnvironmentExecutionSource {
  export const Record = EnvironmentExecutionSchema.Source
  export type Record = z.infer<typeof Record>
  export interface Selection {
    scopeID: string
    ownerID: string
    environmentID?: string | null
    workspaceID?: string | null
    workspaceGeneration?: number
  }
  export interface Start {
    id: string
    scopeID: string
    command: ExecutionProtocol.Command
    digest: string
    origin: EnvironmentOrigin.Captured
    intentDigest?: string
    workspaces?: WorkspaceProtocol.Reference[]
    signal?: AbortSignal
  }
  export interface Operations {
    start(input: Start): Promise<EnvironmentExecutionSchema.Info>
    inspect(id: string): Promise<EnvironmentExecutionSchema.Info | undefined>
    output(id: string, after: number, limit: number): Promise<ExecutionProtocol.Chunk[]>
    complete(id: string): Promise<EnvironmentExecutionSchema.Info>
    cancel(id: string, digest: string): Promise<void>
    stdin(id: string, data: Uint8Array, end: boolean): Promise<void>
    resize(id: string, cols: number, rows: number): Promise<void>
  }
  const operationBrand: unique symbol = Symbol("original Environment execution operation")
  export interface OriginalOperation extends Omit<Operations, "start"> {
    readonly [operationBrand]: true
    close(): Promise<void>
  }
  export interface Input {
    selection: Readonly<Selection>
    origin: EnvironmentOrigin.Captured
    needs: Readonly<{ workspace?: boolean; execution: "exec" | "pty" }>
    signal?: AbortSignal
  }
  export interface Opened {
    target: EnvironmentSchema.Target
    binding: unknown
    runtime: ExecutionProtocol.Description
    directory: string
    executor: Executor
    workspaces: WorkspaceProtocol.Reference[]
    useRoots: string[]
    operations: Operations
    assert(): void
    release(): Promise<void>
  }
  export interface Inspection {
    info: EnvironmentExecutionSchema.Info | undefined
    output: ExecutionProtocol.Chunk[]
  }
  export interface Port {
    selected?(selection: Readonly<Selection>, signal?: AbortSignal): Promise<boolean>
    open(input: Input): Promise<Opened | undefined>
    inspect(input: {
      binding: z.infer<typeof JsonValue>
      target: EnvironmentSchema.Target
      scopeID: string
      operationID: string
      digest: string
      origin: EnvironmentOrigin.Info
      after: number
      limit: number
      signal?: AbortSignal
    }): Promise<Inspection>
    close?(): Promise<void>
  }
  const brand: unique symbol = Symbol("registered Environment execution source")
  export interface Lease {
    readonly [brand]: true
    readonly target: EnvironmentSchema.Target
    readonly runtime: ExecutionProtocol.Description
    readonly directory: string
    readonly executor: Executor
    readonly workspaces: readonly WorkspaceProtocol.Reference[]
    readonly useRoots: readonly string[]
    assert(): void
    release(): Promise<void>
  }
  interface Registration {
    provider: string
    port: Port
    owner(): void
    accepting: boolean
    closed: boolean
    calls: Set<Promise<unknown>>
    resources: Set<Retained>
    operations: Set<{ origin: EnvironmentOrigin.Captured }>
    closing?: Promise<void>
  }
  interface Retained {
    registration: Registration
    origin: EnvironmentOrigin.Captured
    release(): Promise<void>
    released: boolean
    pending?: Promise<void>
    frame?: Frame
  }
  interface Frame {
    registration: Registration
    origin: EnvironmentOrigin.Captured
    selection: Readonly<Selection>
    opened: Opened
    record: Record
    open: boolean
    signal?: AbortSignal
    calls: Set<Promise<unknown>>
    originalOperations: Map<string, { identity: string; operation: OriginalOperation }>
  }
  const frames = new WeakMap<Lease, Frame>()
  const state = RuntimeContext.state(() => new Map<string, Registration>())
  const callback = RuntimeContext.createAsyncContext<Registration>()
  const frameCallback = RuntimeContext.createAsyncContext<Frame>()
  function fail(message: string): never {
    throw new EnvironmentSchema.Unavailable({ environmentID: "", message })
  }
  function outsideTransaction() {
    if (Storage.inTransaction()) fail("Remote Environment I/O must run outside a Storage transaction")
  }
  function primaryOwner() {
    const runtime = RuntimeContext.current(),
      home = runtime.host.home,
      root = runtime.host.root
    let original:
      | {
          handle: NonNullable<typeof runtime.storage>
          options: string
          store: ReturnType<typeof Storage.current>["store"]
          directory: string
          objects: ReturnType<typeof Storage.current>["artifactObjects"]
          blobs: unknown
          writerID: unknown
          now: unknown
        }
      | undefined
    return () => {
      const current = Storage.current(),
        primary = runtime.storage
      if (
        RuntimeContext.current() !== runtime ||
        runtime.host.home !== home ||
        runtime.host.root !== root ||
        !primary ||
        current.store !== primary.store ||
        current.artifactDirectory !== primary.artifactDirectory ||
        current.artifactObjects !== primary.artifactObjects
      )
        fail("Remote Environment requires its original Runtime Home and actual primary Store")
      original ??= {
        handle: primary,
        store: primary.store,
        options: JSON.stringify(primary.store.options),
        directory: primary.artifactDirectory,
        objects: primary.artifactObjects,
        blobs: primary.artifactObjects?.blobs,
        writerID: primary.artifactObjects?.writerID,
        now: primary.artifactObjects?.now,
      }
      if (
        primary !== original.handle ||
        primary.store !== original.store ||
        JSON.stringify(primary.store.options) !== original.options ||
        primary.artifactDirectory !== original.directory ||
        primary.artifactObjects !== original.objects ||
        primary.artifactObjects?.blobs !== original.blobs ||
        primary.artifactObjects?.writerID !== original.writerID ||
        primary.artifactObjects?.now !== original.now
      )
        fail("Remote Environment lost its original primary Store or artifact ports")
    }
  }
  export function register(provider: string, port: Port) {
    RuntimeContext.assertCompositionOpen("Environment execution sources")
    provider = Record.shape.provider.parse(provider)
    if (state().has(provider)) throw new Error("Environment execution source is already registered")
    state().set(provider, {
      provider,
      port: {
        selected: port.selected?.bind(port),
        open: port.open.bind(port),
        inspect: port.inspect.bind(port),
        close: port.close?.bind(port),
      },
      owner: primaryOwner(),
      accepting: true,
      closed: false,
      calls: new Set(),
      resources: new Set(),
      operations: new Set(),
    })
  }
  export function has(provider: string) {
    const registration = state().get(provider)
    return !!registration?.accepting && !registration.closed
  }
  export async function selected(value: Selection, signal?: AbortSignal) {
    const selection = Object.freeze({ ...value })
    for (const registration of state().values()) {
      registration.owner()
      signal?.throwIfAborted()
      if (!registration.accepting || registration.closed) fail("Environment execution source is closing")
      const inspect = registration.port.selected
      if (!inspect) fail("Environment source cannot verify native-only selection")
      const remote = await tracked(registration, () => inspect(selection, signal))
      registration.owner()
      signal?.throwIfAborted()
      if (!registration.accepting || registration.closed) fail("Environment execution source is closing")
      if (typeof remote !== "boolean") fail("Environment source returned an unknown native-only selection")
      if (remote) return true
    }
    return false
  }
  export function hasPendingRequests() {
    return [...state().values()].some(
      (registration) => registration.calls.size || registration.resources.size || registration.operations.size,
    )
  }
  export function hasSessionPending(scopeID: string, sessionID: string) {
    return [...state().values()].some((registration) =>
      [...registration.resources, ...registration.operations].some(
        ({ origin }) =>
          origin.value.kind === "session" && origin.value.scopeID === scopeID && origin.value.sessionID === sessionID,
      ),
    )
  }
  export function captureOwner(value: Record) {
    const record = Record.parse(value),
      registration = state().get(record.provider)
    if (!registration) fail("The retained Environment execution source is unavailable")
    const assert = () => {
      registration.owner()
      if (registration.closed) fail("Environment execution source is closed")
      if (Storage.current().store.options.readonly) fail("Remote execution requires a writable primary Store")
    }
    assert()
    return assert
  }
  function assertOwner(frame: Frame) {
    frame.registration.owner()
    frame.origin.assertCurrent()
    if (frame.registration.closed) fail("Environment execution source is closed")
  }
  function assertEffect(frame: Frame) {
    assertOwner(frame)
    if (!frame.open || !frame.registration.accepting) fail("Environment execution lease has ended")
    if (Storage.current().store.options.readonly) fail("Remote execution requires a writable primary Store")
    frame.opened.assert()
  }
  function assertLive(frame: Frame) {
    assertEffect(frame)
    frame.signal?.throwIfAborted()
  }
  function selectedLease(lease: Lease) {
    const frame = frames.get(lease)
    if (!frame) fail("Remote execution requires its registered private live lease")
    assertOwner(frame)
    return frame
  }
  async function tracked<T>(registration: Registration, body: () => Promise<T>) {
    outsideTransaction()
    registration.owner()
    if (registration.closed) fail("Environment execution source is closed")
    const pending = Promise.resolve().then(() => callback.run(registration, body))
    registration.calls.add(pending)
    try {
      return await pending
    } finally {
      registration.calls.delete(pending)
    }
  }
  async function ownedCall<T>(frame: Frame, body: () => Promise<T>) {
    const pending = tracked(frame.registration, () => frameCallback.run(frame, body))
    frame.calls.add(pending)
    try {
      return await pending
    } finally {
      frame.calls.delete(pending)
    }
  }
  function retire(resource: Retained) {
    outsideTransaction()
    const registration = resource.registration
    registration.owner()
    resource.origin.assertCurrent()
    if (resource.frame && frameCallback.getStore() === resource.frame)
      fail("Environment execution leases cannot release from an accepted lease callback")
    if (resource.frame) resource.frame.open = false
    if (resource.released) return Promise.resolve()
    if (resource.pending) return resource.pending
    resource.pending = tracked(registration, async () => {
      while (resource.frame?.calls.size) await Promise.allSettled([...resource.frame.calls])
      await resource.release()
      registration.owner()
      resource.origin.assertCurrent()
      resource.released = true
      registration.resources.delete(resource)
    }).finally(() => {
      resource.pending = undefined
    })
    return resource.pending
  }
  export async function open(value: Input): Promise<Lease | undefined> {
    const input: Input = {
      selection: Object.freeze({ ...value.selection }),
      needs: Object.freeze({ ...value.needs }),
      origin: EnvironmentOrigin.selected(value.origin),
      signal: value.signal,
    }
    input.origin.assertCurrent()
    for (const registration of state().values()) {
      outsideTransaction()
      registration.owner()
      if (Storage.current().store.options.readonly) fail("Remote execution requires a writable primary Store")
      if (!registration.accepting || registration.closed) fail("Environment execution source is closing")
      input.signal?.throwIfAborted()
      const lease = await tracked(registration, async () => {
        await EnvironmentOrigin.assertAdmission(input.origin, { scopeID: input.selection.scopeID })
        const opened = await registration.port.open(input)
        if (!opened) {
          registration.owner()
          input.origin.assertCurrent()
          input.signal?.throwIfAborted()
          if (!registration.accepting) fail("Environment execution source is closing")
          return
        }
        const resource: Retained = {
          registration,
          origin: input.origin,
          release: opened.release.bind(opened),
          released: false,
        }
        registration.resources.add(resource)
        try {
          registration.owner()
          input.origin.assertCurrent()
          const target = EnvironmentSchema.Target.parse(opened.target),
            runtime = ExecutionProtocol.Description.parse(opened.runtime)
          if (!EnvironmentSchema.sameTarget(target, runtime.target))
            fail("Remote runtime has another actual allocation")
          const operations = opened.operations
          const frame: Frame = {
            registration,
            origin: input.origin,
            selection: input.selection,
            opened: {
              ...opened,
              operations: {
                start: operations.start.bind(operations),
                inspect: operations.inspect.bind(operations),
                output: operations.output.bind(operations),
                complete: operations.complete.bind(operations),
                cancel: operations.cancel.bind(operations),
                stdin: operations.stdin.bind(operations),
                resize: operations.resize.bind(operations),
              },
              assert: opened.assert.bind(opened),
              release: opened.release.bind(opened),
            },
            signal: input.signal,
            open: true,
            calls: new Set(),
            originalOperations: new Map(),
            record: Record.parse({ version: 1, provider: registration.provider, target, binding: opened.binding }),
          }
          resource.frame = frame
          const lease: Lease = Object.freeze({
            [brand]: true as const,
            target: Object.freeze(target),
            runtime: Object.freeze({
              ...runtime,
              target: Object.freeze(runtime.target),
              env: Object.freeze(runtime.env),
            }),
            directory: z.string().min(1).parse(opened.directory),
            executor: finiteExecutor(frame),
            workspaces: Object.freeze(
              z
                .array(WorkspaceProtocol.Reference)
                .parse(opened.workspaces)
                .map((reference) => Object.freeze(reference)),
            ),
            useRoots: Object.freeze(z.array(z.string().min(1).max(4096)).max(128).parse(opened.useRoots)),
            assert: () => assertLive(frame),
            release() {
              return retire(resource)
            },
          })
          frames.set(lease, frame)
          assertLive(frame)
          return lease
        } catch (error) {
          try {
            await retire(resource)
          } catch {}
          throw error
        }
      })
      if (lease) return lease
    }
  }
  export function capture(lease: Lease, origin: EnvironmentOrigin.Captured): Record {
    const frame = selectedLease(lease)
    assertLive(frame)
    origin.assertCurrent()
    if (JSON.stringify(frame.origin.value) !== JSON.stringify(origin.value))
      fail("Remote execution changed its original native caller")
    return Record.parse(frame.record)
  }
  export async function assertAdmission(lease: Lease, origin: EnvironmentOrigin.Captured) {
    const frame = selectedLease(lease)
    assertLive(frame)
    origin.assertCurrent()
    if (JSON.stringify(frame.origin.value) !== JSON.stringify(origin.value))
      fail("Remote execution changed its admitted native caller")
    await EnvironmentOrigin.assertAdmission(origin, {
      scopeID: frame.selection.scopeID,
      environmentID: frame.selection.environmentID ?? undefined,
    })
    assertLive(frame)
  }
  function finiteExecutor(frame: Frame): Executor {
    const source = frame.opened.executor
    const prepareInputs = source.prepareInputs?.bind(source),
      discardInputs = source.discardInputs?.bind(source)
    const prepareSandbox = source.prepareSandbox?.bind(source),
      releaseSandbox = source.releaseSandbox?.bind(source)
    function canonical(): never {
      assertLive(frame)
      return fail("Remote processes require their canonical Environment execution owner")
    }
    return Object.freeze({
      ...(prepareInputs && {
        async prepareInputs(value: ExecutionProtocol.Inputs) {
          const input = ExecutionProtocol.Inputs.parse(value)
          assertLive(frame)
          outsideTransaction()
          const result = await ownedCall(frame, () => prepareInputs(input))
          assertLive(frame)
          return ExecutionProtocol.PreparedInputs.parse(result)
        },
      }),
      ...(discardInputs && {
        async discardInputs(id: string) {
          assertLive(frame)
          outsideTransaction()
          await ownedCall(frame, () => discardInputs(id))
          assertOwner(frame)
        },
      }),
      ...(prepareSandbox && {
        async prepareSandbox(value: ExecutionProtocol.SandboxInput) {
          const input = ExecutionProtocol.SandboxInput.parse(value)
          assertLive(frame)
          outsideTransaction()
          const result = await ownedCall(frame, () => prepareSandbox(input))
          assertLive(frame)
          return ExecutionProtocol.Sandbox.parse(result)
        },
      }),
      ...(releaseSandbox && {
        async releaseSandbox(id: string) {
          assertLive(frame)
          outsideTransaction()
          await ownedCall(frame, () => releaseSandbox(id))
          assertOwner(frame)
        },
      }),
      async describe() {
        assertLive(frame)
        return ExecutionProtocol.Description.parse(frame.opened.runtime)
      },
      async start() {
        return canonical()
      },
      async status() {
        return canonical()
      },
      async output() {
        return canonical()
      },
      async stdin() {
        return canonical()
      },
      async resize() {
        return canonical()
      },
      async cancel() {
        return canonical()
      },
      async release() {
        return canonical()
      },
    })
  }
  export function operations(lease: Lease): Operations {
    const frame = selectedLease(lease),
      source = frame.opened.operations
    function current() {
      assertOwner(frame)
    }
    function result(info: EnvironmentExecutionSchema.Info | undefined, id: string) {
      current()
      if (
        info &&
        (info.id !== id ||
          info.scopeID !== frame.selection.scopeID ||
          !EnvironmentSchema.sameTarget(info.target, frame.record.target))
      )
        fail("Remote execution returned another operation or allocation")
      return info && EnvironmentExecutionSchema.Info.parse(info)
    }
    return {
      async start(value) {
        const input: Start = {
          ...value,
          origin: EnvironmentOrigin.selected(value.origin),
          command: ExecutionProtocol.Command.parse(value.command),
          workspaces: value.workspaces && z.array(WorkspaceProtocol.Reference).parse(value.workspaces),
        }
        assertLive(frame)
        input.origin.assertCurrent()
        if (
          input.scopeID !== frame.selection.scopeID ||
          JSON.stringify(input.origin.value) !== JSON.stringify(frame.origin.value)
        )
          fail("Remote execution changed its admitted native caller")
        await assertAdmission(lease, input.origin)
        outsideTransaction()
        const info = await ownedCall(frame, () => source.start(input))
        const parsed = result(info, input.id)!
        if (parsed.digest !== input.digest || JSON.stringify(parsed.origin) !== JSON.stringify(input.origin.value))
          fail("Remote execution changed its original command or native evidence")
        return parsed
      },
      async inspect(id) {
        current()
        return result(await ownedCall(frame, () => source.inspect(id)), id)
      },
      async output(id, after, limit) {
        current()
        const chunks = await ownedCall(frame, () => source.output(id, after, limit))
        current()
        return z.array(ExecutionProtocol.Chunk).parse(chunks)
      },
      async complete(id) {
        assertEffect(frame)
        outsideTransaction()
        return result(await ownedCall(frame, () => source.complete(id)), id)!
      },
      async cancel(id, digest) {
        assertEffect(frame)
        outsideTransaction()
        await ownedCall(frame, () => source.cancel(id, digest))
        current()
      },
      async stdin(id, data, end) {
        const bytes = Uint8Array.from(data)
        assertEffect(frame)
        outsideTransaction()
        await ownedCall(frame, () => source.stdin(id, bytes, end))
        current()
      },
      async resize(id, cols, rows) {
        assertEffect(frame)
        outsideTransaction()
        await ownedCall(frame, () => source.resize(id, cols, rows))
        current()
      },
    }
  }
  export async function retainOperation(
    lease: Lease,
    input: { scopeID: string; id: string; digest: string; origin: EnvironmentOrigin.Captured },
  ): Promise<OriginalOperation> {
    outsideTransaction()
    const frame = selectedLease(lease)
    assertLive(frame)
    input.origin.assertCurrent()
    const selected = { scopeID: input.scopeID, id: ExecutionProtocol.ID.parse(input.id), digest: input.digest }
    if (
      selected.scopeID !== frame.selection.scopeID ||
      JSON.stringify(input.origin.value) !== JSON.stringify(frame.origin.value)
    )
      fail("Original operation changed its admitted native caller")
    const { EnvironmentExecution } = await import("./execution")
    assertLive(frame)
    const initial = await EnvironmentExecution.get(selected.id, selected.scopeID)
    assertLive(frame)
    const identity = (info: EnvironmentExecutionSchema.Info) =>
      JSON.stringify({
        id: info.id,
        scopeID: info.scopeID,
        digest: info.digest,
        intentDigest: info.intentDigest,
        target: info.target,
        origin: info.origin,
        source: info.source,
        workspaces: info.workspaces,
      })
    if (
      initial.digest !== selected.digest ||
      JSON.stringify(initial.source) !== JSON.stringify(frame.record) ||
      JSON.stringify(initial.origin) !== JSON.stringify(frame.origin.value) ||
      !EnvironmentSchema.sameTarget(initial.target, frame.record.target)
    )
      fail("Original operation requires its actual committed native submission")
    const original = identity(initial),
      source = frame.opened.operations
    const existing = frame.originalOperations.get(selected.id)
    if (existing) {
      if (existing.identity !== original) fail("Original operation changed its committed native binding")
      return existing.operation
    }
    if (initial.state !== "submitted") fail("Original operation requires its actual committed native submission")
    const owner = { origin: frame.origin }
    frame.registration.operations.add(owner)
    let open = true
    const assert = () => {
      assertOwner(frame)
      if (!open) fail("Original Environment operation has settled")
    }
    const canonical = async (id: string, effect = false) => {
      outsideTransaction()
      assert()
      if (id !== selected.id) fail("Original operation cannot replace its native identity")
      if (effect && Storage.current().store.options.readonly) fail("Remote execution requires a writable primary Store")
      const info = await EnvironmentExecution.get(id, selected.scopeID)
      assert()
      if (identity(info) !== original) fail("Original operation changed its committed native binding")
      return info
    }
    const invoke = async <T>(body: () => Promise<T>) => {
      const value = await tracked(frame.registration, body)
      assert()
      return value
    }
    const result = (info: EnvironmentExecutionSchema.Info | undefined) => {
      if (
        info &&
        (info.id !== selected.id ||
          info.scopeID !== selected.scopeID ||
          info.digest !== selected.digest ||
          JSON.stringify(info.origin) !== JSON.stringify(initial.origin) ||
          JSON.stringify(info.workspaces) !== JSON.stringify(initial.workspaces) ||
          !EnvironmentSchema.sameTarget(info.target, initial.target))
      )
        fail("Original operation returned another native receipt")
      return info && EnvironmentExecutionSchema.Info.parse(info)
    }
    const operation: OriginalOperation = Object.freeze({
      [operationBrand]: true as const,
      async inspect(id: string) {
        await canonical(id)
        return result(await invoke(() => source.inspect(id)))
      },
      async output(id: string, after: number, limit: number) {
        await canonical(id)
        if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 128)
          fail("Invalid original operation output cursor")
        return z.array(ExecutionProtocol.Chunk).parse(await invoke(() => source.output(id, after, limit)))
      },
      async stdin(id: string, data: Uint8Array, end: boolean) {
        const bytes = Uint8Array.from(data),
          info = await canonical(id, true)
        if (!frame.registration.accepting || info.state !== "running" || info.status?.state !== "running")
          fail("Original operation no longer accepts new process input")
        await ProcessAccessSource.recheckCurrent()
        await invoke(() => source.stdin(id, bytes, end))
      },
      async resize(id: string, cols: number, rows: number) {
        const size = ExecutionProtocol.Command.shape.pty.unwrap().parse({ cols, rows })
        const info = await canonical(id, true)
        if (!frame.registration.accepting || info.state !== "running" || info.status?.state !== "running")
          fail("Original operation no longer accepts process resizing")
        await ProcessAccessSource.recheckCurrent()
        await invoke(() => source.resize(id, size.cols, size.rows))
      },
      async cancel(id: string, digest: string) {
        const info = await canonical(id, true)
        if (digest !== selected.digest) fail("Original cancellation changed its native command digest")
        if (info.state === "completed") return
        await ProcessAccessSource.recheckCurrent()
        await invoke(() => source.cancel(id, digest))
      },
      async complete(id: string) {
        const info = await canonical(id, true)
        if (info.state === "completed") return info
        if (!info.status || !ExecutionProtocol.terminal(info.status))
          fail("Original operation has not physically completed")
        const completed = result(await invoke(() => source.complete(id)))
        if (!completed) fail("Original operation completion returned no native receipt")
        return completed
      },
      async close() {
        if (!open) return
        const info = await canonical(selected.id)
        if (info.state !== "completed") fail("Original operation completion is not committed")
        open = false
        frame.registration.operations.delete(owner)
        frame.originalOperations.delete(selected.id)
      },
    })
    frame.originalOperations.set(selected.id, { identity: original, operation })
    return operation
  }
  export async function inspect(
    record: Record,
    value: {
      scopeID: string
      operationID: string
      digest: string
      origin: EnvironmentOrigin.Info
      after?: number
      limit?: number
      signal?: AbortSignal
    },
  ) {
    const source = Record.parse(record),
      input = {
        ...value,
        origin: EnvironmentOrigin.Info.parse(value.origin),
        after: value.after ?? 0,
        limit: value.limit ?? 128,
      }
    const registration = state().get(source.provider)
    if (!registration) fail("The retained Environment execution source is unavailable")
    registration.owner()
    input.signal?.throwIfAborted()
    const result = await tracked(registration, () =>
      registration.port.inspect({ ...input, binding: source.binding, target: source.target }),
    )
    registration.owner()
    input.signal?.throwIfAborted()
    const info = result.info && EnvironmentExecutionSchema.Info.parse(result.info)
    if (
      info &&
      (info.id !== input.operationID ||
        info.scopeID !== input.scopeID ||
        info.digest !== input.digest ||
        JSON.stringify(info.origin) !== JSON.stringify(input.origin) ||
        !EnvironmentSchema.sameTarget(info.target, source.target))
    )
      fail("Retained Environment inspection returned another original operation")
    return { info, output: z.array(ExecutionProtocol.Chunk).parse(result.output) }
  }
  export async function close() {
    outsideTransaction()
    if (callback.getStore()) fail("Environment execution sources cannot close from an accepted source callback")
    const registrations = [...state().values()]
    for (const registration of registrations) registration.accepting = false
    const outcomes = await Promise.allSettled(
      registrations.map((registration) => {
        if (registration.closed) return
        registration.owner()
        return (registration.closing ??= closeRegistration(registration).finally(() => {
          registration.closing = undefined
        }))
      }),
    )
    const errors = outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : []))
    if (errors.length) throw new AggregateError(errors, "Environment execution sources did not close")
  }
  async function closeRegistration(registration: Registration) {
    while (registration.calls.size) await Promise.allSettled([...registration.calls])
    const outcomes = await Promise.allSettled([...registration.resources].map((resource) => retire(resource)))
    const errors = outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : []))
    if (errors.length)
      throw new AggregateError(errors, "Environment admissions are still retained by their original owners")
    await tracked(registration, async () => {
      await registration.port.close?.()
    })
    registration.owner()
    if (registration.resources.size || registration.calls.size || registration.operations.size)
      fail("Environment execution source has not drained")
    registration.closed = true
  }
}
