import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StorageMutationGuard } from "@ericsanchezok/synergy-harness/storage/mutation-guard"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"

const ownerID = "organization-service"
interface Operation {
  runtime: RuntimeContext.Instance
  store: Storage.Handle["store"]
  references: number
  active: boolean
  done: ReturnType<typeof Promise.withResolvers<void>>
}
interface Callback {
  operation: Operation
  open: boolean
}
const current = RuntimeContext.createAsyncContext<Callback>()
const state = RuntimeContext.state(() => ({
  operations: new Set<Operation>(),
  suspended: false,
  installed: false,
  store: undefined as Storage.Handle["store"] | undefined,
}))

export namespace OrganizationServiceMaintenance {
  export interface Tail {
    run<T>(body: () => T | Promise<T>): Promise<T>
    close(): void
  }
  function assertOperation(operation: Operation) {
    if (
      !operation.active ||
      operation.runtime !== RuntimeContext.current() ||
      operation.store !== Storage.current().store ||
      !state().operations.has(operation)
    )
      throw new RuntimeMaintenance.Blocked({ message: "Service completion requires its original open operation" })
  }
  function assertCallback(frame: Callback) {
    if (!frame.open) throw new RuntimeMaintenance.Blocked({ message: "Service callback has ended" })
    assertOperation(frame.operation)
  }
  function invoke<T>(operation: Operation, body: () => T | Promise<T>): Promise<T> {
    const frame = { operation, open: true }
    return current.run(frame, async () => {
      try {
        return await body()
      } finally {
        frame.open = false
      }
    })
  }
  function release(operation: Operation) {
    operation.references--
    if (operation.references) return
    operation.active = false
    state().operations.delete(operation)
    operation.done.resolve()
  }
  export function register() {
    RuntimeContext.assertCompositionOpen("Organization service maintenance")
    if (state().installed) throw new Error("Organization service maintenance is already registered")
    const store = Storage.current().store
    state().store = store
    RuntimeMaintenance.configure({ required: [ownerID] })
    StorageMutationGuard.register(ownerID, async (_tx, keys) => {
      if (Storage.current().store !== store) return
      if (keys.every((key) => key[0] === "runtime_maintenance")) return
      const frame = current.getStore()
      if (frame) {
        assertCallback(frame)
        return
      }
      await RuntimeMaintenance.assertAdmission()
    })
    RuntimeMaintenance.register(ownerID, {
      version: 1,
      async suspend(context) {
        await RuntimeMaintenance.assertDraining(context.lease)
        state().suspended = true
      },
      async drain(context) {
        await drain(context.signal)
      },
      async reconcileFrozen(context) {
        if ((await RuntimeMaintenance.assertHeld(context.lease)).phase !== "frozen")
          throw new RuntimeMaintenance.Blocked({
            message: "Service cold reconciliation requires its original frozen operation",
          })
        state().suspended = true
        await drain(context.signal)
      },
      async reconcileReleasing(context) {
        const held = await RuntimeMaintenance.assertHeld(context.lease)
        if (held.version !== 2 || held.purpose !== "organization-home-upgrade" || held.phase !== "releasing")
          throw new RuntimeMaintenance.Blocked({
            message: "Service cold release requires its original releasing Home upgrade",
          })
        state().suspended = true
        await drain(context.signal)
      },
      async inspect() {
        return state().operations.size
          ? [
              {
                owner: ownerID,
                code: "service_operations_active",
                label: "Wait for the accepted service operations and their exact completions",
                recoverable: true,
              },
            ]
          : []
      },
      async release() {},
      async released(context) {
        await RuntimeMaintenance.assertReleased(context.lease)
        state().suspended = false
      },
    })
    state().installed = true
  }
  async function drain(signal?: AbortSignal) {
    while (state().operations.size) {
      signal?.throwIfAborted()
      const ended = Promise.all([...state().operations].map((operation) => operation.done.promise))
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          signal?.removeEventListener("abort", abort)
          reject(signal?.reason)
        }
        signal?.addEventListener("abort", abort, { once: true })
        void ended.then(() => {
          signal?.removeEventListener("abort", abort)
          resolve()
        }, reject)
        if (signal?.aborted) abort()
      })
    }
  }
  export async function stop() {
    state().suspended = true
    await drain()
  }
  export async function run<T>(body: () => T | Promise<T>): Promise<T> {
    const parent = current.getStore()
    if (parent) {
      assertCallback(parent)
      parent.operation.references++
      try {
        return await invoke(parent.operation, body)
      } finally {
        release(parent.operation)
      }
    }
    if (!state().installed || state().store !== Storage.current().store)
      throw new Error("Organization service maintenance requires its installed namespace")
    if (state().suspended)
      throw new RuntimeMaintenance.Blocked({ message: "Organization service maintenance holds new operations" })
    const operation: Operation = {
      runtime: RuntimeContext.current(),
      store: Storage.current().store,
      references: 1,
      active: true,
      done: Promise.withResolvers<void>(),
    }
    state().operations.add(operation)
    try {
      await Storage.transaction(() => RuntimeMaintenance.assertAdmission())
      assertOperation(operation)
      return await invoke(operation, body)
    } finally {
      release(operation)
    }
  }
  export function captureTail(): Tail {
    const frame = current.getStore()
    if (!frame) throw new RuntimeMaintenance.Blocked({ message: "Service completion has no accepted operation" })
    assertCallback(frame)
    const operation = frame.operation
    operation.references++
    let closed = false
    return Object.freeze({
      async run<T>(body: () => T | Promise<T>): Promise<T> {
        if (closed) throw new RuntimeMaintenance.Blocked({ message: "Service completion is closed" })
        return operation.runtime.run(async () => {
          assertOperation(operation)
          operation.references++
          try {
            return await invoke(operation, body)
          } finally {
            release(operation)
          }
        })
      },
      close() {
        if (closed) return
        operation.runtime.run(() => {
          assertOperation(operation)
          closed = true
          release(operation)
        })
      },
    })
  }
  export async function ready() {
    try {
      if (!state().installed || state().suspended || state().store !== Storage.current().store) return false
      await Storage.snapshot(() => RuntimeMaintenance.assertAdmission())
      return !state().suspended
    } catch {
      return false
    }
  }
}
