import { expect, test } from "bun:test"
import { Environment } from "../../src/environment"
import { EnvironmentExecution } from "../../src/environment/execution"
import { EnvironmentProviders } from "../../src/environment/provider"
import { ExecutionProtocol, type Executor } from "../../src/environment/executor"
import { RuntimeMaintenance } from "../../src/storage/runtime-maintenance"
import { testEnvironmentRuntime as testRuntime } from "../support/environment-origin"

const command = { command: "fixture", args: [], cwd: "/workspace", env: {}, useRoots: [] }
const begin = () =>
  RuntimeMaintenance.begin({
    purpose: "organization-backup",
    requestID: "environment-maintenance",
    actor: {
      kind: "system",
      subjectID: "operator",
      displayName: "Host operator",
      clientKind: "system",
      requestID: "environment-maintenance",
    },
  })
async function fixture() {
  let allocations = 0
  let starts = 0
  let releases = 0
  let allocate: (() => Promise<void>) | undefined
  const statuses = new Map<string, ExecutionProtocol.Status>()
  const executor: Executor = {
    async start(request) {
      starts++
      const status: ExecutionProtocol.Status = {
        id: request.id,
        target: request.target,
        digest: request.digest,
        state: "running",
        cursor: 0,
        treeDrained: false,
        streamsDrained: false,
      }
      statuses.set(request.id, status)
      return status
    },
    async status(id) {
      return statuses.get(id)
    },
    async output() {
      return []
    },
    async stdin() {},
    async resize() {},
    async cancel() {},
    async release() {
      releases++
    },
  }
  const runtime = await testRuntime({
    register() {
      RuntimeMaintenance.configure({ required: ["environments"] })
      EnvironmentProviders.register({
        id: "maintenance",
        async allocate(request) {
          allocations++
          await allocate?.()
          return { id: request.requestID, capabilities: ["exec"] }
        },
        async inspect(request) {
          return { state: "ready", allocation: { id: request.requestID, capabilities: ["exec"] } }
        },
        async deallocate() {},
        async connect() {
          return executor
        },
      })
    },
  })
  return {
    ...runtime,
    statuses,
    allocations: () => allocations,
    starts: () => starts,
    releases: () => releases,
    blockAllocation: (work: () => Promise<void>) => {
      allocate = work
    },
  }
}
const bind = (ownerID: string) => Environment.bind({ scopeID: "scope", ownerID, provider: "maintenance", spec: {} })

test("maintenance refuses new allocation and execution while exact accepted execution remains observable", async () => {
  await using runtime = await fixture()
  await runtime.run(async () => {
    const environment = await bind("active")
    const existing = {
      origin: runtime.origin("accepted"),
      id: "accepted",
      scopeID: "scope",
      environmentID: environment.id,
      command,
    }
    await EnvironmentExecution.start(existing)
    const idle = await bind("idle")
    const lease = await begin()
    try {
      expect((await EnvironmentExecution.start(existing)).id).toBe(existing.id)
      await expect(EnvironmentExecution.start({ ...existing, id: "new" })).rejects.toBeInstanceOf(
        RuntimeMaintenance.Blocked,
      )
      await expect(
        Environment.acquire(idle.id, { scopeID: "scope", useID: "new-allocation", capabilities: ["exec"] }),
      ).rejects.toBeInstanceOf(RuntimeMaintenance.Blocked)
      expect(runtime.starts()).toBe(1)
      expect(runtime.allocations()).toBe(1)
    } finally {
      const current = runtime.statuses.get("accepted")!
      runtime.statuses.set(current.id, { ...current, state: "exited", treeDrained: true, streamsDrained: true })
      await RuntimeMaintenance.drain(lease)
      await RuntimeMaintenance.release(lease)
    }
  })
}, 15_000)

test("a native Environment checkpoint requires known process and stream drainage before freezing", async () => {
  await using runtime = await fixture()
  await runtime.run(async () => {
    const environment = await bind("active")
    await EnvironmentExecution.start({
      origin: runtime.origin("accepted"),
      id: "accepted",
      scopeID: "scope",
      environmentID: environment.id,
      command,
    })
    const lease = await begin()
    try {
      await expect(RuntimeMaintenance.drain(lease)).rejects.toBeInstanceOf(RuntimeMaintenance.Blocked)
      expect((await RuntimeMaintenance.status())?.phase).toBe("draining")
      const current = runtime.statuses.get("accepted")!
      runtime.statuses.set(current.id, { ...current, state: "exited", treeDrained: true, streamsDrained: false })
      await expect(RuntimeMaintenance.drain(lease)).rejects.toBeInstanceOf(RuntimeMaintenance.Blocked)
      runtime.statuses.set(current.id, { ...current, state: "exited", treeDrained: true, streamsDrained: true })
      const receipt = await RuntimeMaintenance.drain(lease)
      await RuntimeMaintenance.freeze(lease, receipt)
      expect((await EnvironmentExecution.get("accepted", "scope")).state).toBe("completed")
      expect(runtime.releases()).toBe(1)
      expect(runtime.starts()).toBe(1)
    } finally {
      await RuntimeMaintenance.release(lease)
    }
  })
}, 15_000)

test("an admitted provider allocation remains held until its real owner finishes without issuing another allocation", async () => {
  await using runtime = await fixture()
  await runtime.run(async () => {
    const entered = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    runtime.blockAllocation(async () => {
      entered.resolve()
      await finish.promise
    })
    const environment = await bind("allocating")
    const acquisition = Environment.acquire(environment.id, {
      scopeID: "scope",
      useID: "existing",
      capabilities: ["exec"],
    })
    await entered.promise
    let lease: RuntimeMaintenance.Lease | undefined
    try {
      lease = await begin()
      await expect(RuntimeMaintenance.drain(lease)).rejects.toBeInstanceOf(RuntimeMaintenance.Blocked)
      finish.resolve()
      await (await acquisition).release()
      const receipt = await RuntimeMaintenance.drain(lease)
      await RuntimeMaintenance.freeze(lease, receipt)
      expect(runtime.allocations()).toBe(1)
      expect((await Environment.get(environment.id, "scope")).state).toBe("ready")
    } finally {
      finish.resolve()
      await (await acquisition).release()
      if (lease) await RuntimeMaintenance.release(lease)
    }
  })
}, 15_000)
