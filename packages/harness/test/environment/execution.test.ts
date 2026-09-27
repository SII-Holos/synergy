import { expect, test } from "bun:test"
import { Environment } from "../../src/environment"
import { EnvironmentExecution } from "../../src/environment/execution"
import { EnvironmentProviders } from "../../src/environment/provider"
import type { Executor, ExecutionProtocol } from "../../src/environment/executor"
import { testRuntime } from "../support/runtime"

function fixture() {
  let starts = 0
  let releases = 0
  let loseResponse = false
  const operations = new Map<string, ExecutionProtocol.Status>()
  const executor: Executor = {
    async start(request) {
      starts++
      expect((await EnvironmentExecution.get(request.id, "scope")).state).toBe("submitted")
      const status: ExecutionProtocol.Status = {
        id: request.id,
        target: request.target,
        digest: request.digest,
        state: "exited",
        exitCode: 0,
        cursor: 0,
        treeDrained: true,
        streamsDrained: true,
      }
      operations.set(request.id, status)
      if (loseResponse) throw new Error("ack lost")
      return status
    },
    async status(id) {
      return operations.get(id)
    },
    async output() {
      return []
    },
    async stdin() {},
    async resize() {},
    async cancel(id) {
      const status = operations.get(id)
      if (!status) return
      operations.set(id, { ...status, state: "cancelled", treeDrained: true, streamsDrained: true })
    },
    async release() {
      releases++
    },
  }
  return {
    executor,
    operations,
    starts: () => starts,
    releases: () => releases,
    loseResponse: () => {
      loseResponse = true
    },
  }
}

const command = { command: "example", args: ["one"], cwd: "/workspace", env: {}, writableRoots: ["/workspace"] }

test("execution intent precedes dispatch, duplicate operation IDs never repeat an effect", async () => {
  const f = fixture()
  await using runtime = await testRuntime({
    register: () =>
      EnvironmentProviders.register({
        id: "fixture",
        async allocate(request) {
          return { id: request.requestID, capabilities: ["exec"] }
        },
        async inspect() {
          return { state: "unknown" }
        },
        async deallocate() {},
        async connect() {
          return f.executor
        },
      }),
  })
  await runtime.run(async () => {
    const environment = await Environment.bind({ scopeID: "scope", ownerID: "session", provider: "fixture", spec: {} })
    f.loseResponse()
    const input = { scopeID: "scope", environmentID: environment.id, id: "operation", command }
    await expect(EnvironmentExecution.start(input)).rejects.toThrow("ack lost")
    expect((await EnvironmentExecution.get(input.id, "scope")).state).toBe("submitted")
    expect((await EnvironmentExecution.start(input)).state).toBe("exited")
    expect(f.starts()).toBe(1)
    await expect(EnvironmentExecution.start({ ...input, command: { ...command, args: ["changed"] } })).rejects.toThrow(
      "different input",
    )
    expect(f.starts()).toBe(1)
    await EnvironmentExecution.complete(input.id, "scope", async () => ({ revision: "saved-1" }))
    expect(f.releases()).toBe(1)
    expect(await Environment.uses(environment.id)).toHaveLength(0)
  })
})

test("failed checkpoint retains the use and retries saving without re-executing", async () => {
  const f = fixture()
  await using runtime = await testRuntime({
    register: () =>
      EnvironmentProviders.register({
        id: "fixture",
        async allocate(request) {
          return { id: request.requestID, capabilities: ["exec"] }
        },
        async inspect() {
          return { state: "unknown" }
        },
        async deallocate() {},
        async connect() {
          return f.executor
        },
      }),
  })
  await runtime.run(async () => {
    const environment = await Environment.bind({ scopeID: "scope", ownerID: "session", provider: "fixture", spec: {} })
    await EnvironmentExecution.start({ scopeID: "scope", environmentID: environment.id, id: "operation", command })
    await expect(
      EnvironmentExecution.complete("operation", "scope", async () => {
        throw new Error("upload failed")
      }),
    ).rejects.toThrow("upload failed")
    expect((await EnvironmentExecution.get("operation", "scope")).state).toBe("unsaved")
    expect(f.releases()).toBe(0)
    expect(await Environment.uses(environment.id)).toHaveLength(1)
    let saves = 0
    const checkpoint = async () => {
      saves++
      await Bun.sleep(10)
      return { revision: "saved-2" }
    }
    const results = await Promise.all([
      EnvironmentExecution.complete("operation", "scope", checkpoint),
      EnvironmentExecution.complete("operation", "scope", checkpoint),
    ])
    expect(results[0]).toEqual(results[1])
    expect(saves).toBe(1)
    expect((await EnvironmentExecution.get("operation", "scope")).state).toBe("completed")
    expect(f.starts()).toBe(1)
    expect(f.releases()).toBe(1)
  })
})
