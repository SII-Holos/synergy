import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { EnvironmentOrigin } from "@ericsanchezok/synergy-harness/environment/origin"
import { EnvironmentProviders } from "@ericsanchezok/synergy-harness/environment/provider"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"

test("a failed native resolve preserves its actual cleanup capability across a lost release acknowledgement", async () => {
  await using temporary = await tmpdir()
  let host: ReturnType<typeof EnvironmentOrigin.registerHost> | undefined
  await using runtime = await testRuntime({
    workspaceCoordinator: new WorkspaceCoordinator({ directory: path.join(temporary.path, "claims") }),
    register() {
      host = EnvironmentOrigin.registerHost("native-cleanup-observer")
    },
  })
  await runtime.run(async () => {
    const environment = await Environment.bind({
      scopeID: "cleanup-scope",
      ownerID: "host",
      provider: "native",
      spec: {},
    })
    const provider = EnvironmentProviders.get("native"),
      connect = provider.connect?.bind(provider)
    if (!connect || !host) throw new Error("Native cleanup fixture has no original owner")
    provider.connect = async (request, target) => {
      const executor = await connect(request, target),
        describe = executor.describe?.bind(executor)
      if (!describe) throw new Error("Native Executor has no actual description")
      executor.describe = async () => {
        await describe()
        throw new Error("Description failed after acquiring the actual Use")
      }
      return executor
    }
    let releases = 0
    let originalRelease: (() => Promise<void>) | undefined
    const acquire = Environment.acquire
    const fault = spyOn(Environment, "acquire").mockImplementation(async (...args) => {
      const use = await acquire(...args)
      originalRelease = use.release
      return {
        ...use,
        async release() {
          await use.release()
          if (++releases === 1) throw new Error("Native release committed but its acknowledgement was lost")
        },
      }
    })
    let cleanup: Readonly<{ release(): Promise<void> }> | undefined
    try {
      const failure = await EnvironmentResources.resolve(
        {
          scopeID: environment.scopeID,
          environmentID: environment.id,
          origin: host.capture("failed-description"),
          needs: { execution: "exec" },
        },
        (value) => {
          cleanup = value
        },
      ).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(await Environment.uses(environment.id)).toHaveLength(0)
      expect(releases).toBe(1)
      expect(cleanup).toBeDefined()
      if (!cleanup) throw new Error("Native cleanup ownership was forgotten before returning resources")
      expect(failure).toBeInstanceOf(AggregateError)
      if (!(failure instanceof AggregateError))
        throw new Error("Resolution and cleanup failures lost their original evidence")
      expect(failure.errors).toHaveLength(2)
      expect(failure.errors[0]).toMatchObject({ message: "Description failed after acquiring the actual Use" })
      expect(failure.errors[1]).toMatchObject({ message: "Native release committed but its acknowledgement was lost" })
      expect(failure.cause).toBe(failure.errors[0])
      expect(Object.keys(cleanup)).toEqual(["release"])
      expect(Object.isFrozen(cleanup)).toBe(true)
      await cleanup.release()
      expect(releases).toBe(2)
      expect(await Environment.uses(environment.id)).toHaveLength(0)
    } finally {
      fault.mockRestore()
      await originalRelease?.()
      await Environment.deallocate(environment.id, { scopeID: environment.scopeID })
    }
  })
})
