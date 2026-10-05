import { expect, test } from "bun:test"
import { Config } from "../../src/config/config"
import { ConfigSource } from "../../src/config/source"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { testRuntime } from "../support/runtime"

function read<T>(runtime: Awaited<ReturnType<typeof testRuntime>>, fn: () => Promise<T>) {
  return runtime.run(() => ScopeContext.provide({ scope: Scope.home(), fn }))
}

test("exclusive host configuration is isolated, schema-validated, sealed and has no file sources", async () => {
  const snapshot = { model: "fixture/approved", default_agent: "fixture" }
  await using first = await testRuntime({
    env: { SYNERGY_CONFIG_CONTENT: '{"model":"foreign/unapproved"}' },
    register: () => ConfigSource.register({ resolve: async () => snapshot }),
  })
  await using second = await testRuntime({
    register: () => ConfigSource.register({ resolve: async () => ({ model: "second/approved" }) }),
  })
  expect((await read(first, Config.current)).model).toBe("fixture/approved")
  expect((await read(first, Config.global)).model).toBe("fixture/approved")
  expect((await read(second, Config.current)).model).toBe("second/approved")
  expect(await read(first, Config.directories)).toEqual([])
  await expect(read(first, () => Config.updateGlobal({ model: "foreign/unapproved" }))).rejects.toThrow("read-only")
  expect((await read(first, () => Config.domainGet("models"))).model).toBe("fixture/approved")
  await read(first, async () =>
    expect(() => ConfigSource.register({ resolve: async () => ({}) })).toThrow("before opening"),
  )
})

test("a host configuration failure cannot reuse a last-good or file fallback", async () => {
  let failing = false
  await using runtime = await testRuntime({
    register: () =>
      ConfigSource.register({
        resolve: async () => {
          if (failing) throw new Error("host unavailable")
          return { model: "fixture/approved" }
        },
      }),
  })
  expect((await read(runtime, Config.current)).model).toBe("fixture/approved")
  failing = true
  await expect(read(runtime, Config.resolveExecution)).rejects.toThrow("host unavailable")
  await expect(read(runtime, Config.global)).rejects.toThrow("host unavailable")
  await read(runtime, () => Config.state.resetAll())
  await expect(read(runtime, Config.current)).rejects.toThrow("host unavailable")
})

test("an invalid exclusive snapshot prevents Runtime activation", async () => {
  await expect(
    testRuntime({ register: () => ConfigSource.register({ resolve: async () => ({ execution: "invalid" }) }) }),
  ).rejects.toThrow()
})
