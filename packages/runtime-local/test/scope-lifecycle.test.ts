import { expect, test } from "bun:test"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeRuntime } from "@ericsanchezok/synergy-harness/scope/runtime"
import { ScopeStartup } from "@ericsanchezok/synergy-harness/scope/startup"
import { RuntimeHandle, registerLocalRuntime, createLocalStorage } from "../src"

test("failed Scope startup disposes acquired steps in reverse order and can retry", async () => {
  await using fixture = await runtimeHome()
  const calls: string[] = []
  let fail = true
  await using runtime = await RuntimeHandle.open({
    host: fixture.host,
    mode: "oneshot",
    storage: createLocalStorage(fixture.host),
    composition: {
      register() {
        registerLocalRuntime()
        for (const [index, name] of ["a", "b", "c"].entries())
          ScopeStartup.register({
            name,
            phase: "surface",
            after: index ? [String.fromCharCode(name.charCodeAt(0) - 1)] : [],
            init() {
              calls.push(`start ${name}`)
              if (name === "b" && fail) throw new Error("startup fixture failed")
            },
            dispose() {
              calls.push(`stop ${name}`)
            },
          })
      },
    },
  })
  await runtime.run(async () => {
    const { scope } = await Scope.fromDirectory(fixture.host.home)
    await expect(ScopeRuntime.ensure(scope)).rejects.toThrow("startup fixture failed")
    expect(calls).toEqual(["start a", "start b", "stop b", "stop a"])
    fail = false
    await ScopeRuntime.ensure(scope)
    await ScopeRuntime.ensure(scope)
    expect(calls.slice(4)).toEqual(["start a", "start b", "start c"])
  })
  await runtime.close()
  expect(calls.slice(-3)).toEqual(["stop c", "stop b", "stop a"])
})

test("Scope disposal still releases state after an extension cleanup fails", async () => {
  const { ScopedState } = await import("@ericsanchezok/synergy-harness/scope/scoped-state")
  const { ScopeContext } = await import("@ericsanchezok/synergy-harness/scope/context")
  await using fixture = await runtimeHome()
  let released = false
  const resource = ScopedState.create(
    () => "lease",
    async () => {
      released = true
    },
  )
  await using runtime = await RuntimeHandle.open({
    host: fixture.host,
    mode: "oneshot",
    storage: createLocalStorage(fixture.host),
    composition: {
      register() {
        registerLocalRuntime()
        ScopeStartup.register({
          name: "cleanup-failure",
          phase: "surface",
          init() {
            resource()
          },
          dispose() {
            throw new Error("extension cleanup failed")
          },
        })
      },
    },
  })
  await runtime.run(async () => {
    const { scope } = await Scope.fromDirectory(fixture.host.home)
    await ScopeRuntime.ensure(scope)
    await expect(ScopeRuntime.dispose(scope.id)).rejects.toThrow("cleanup")
    expect(released).toBe(true)
    await ScopeContext.provide({ scope, fn: () => expect(resource.peek()).toBeUndefined() })
  })
})

test("invalid startup dependencies reject opening before storage preparation", async () => {
  await using fixture = await runtimeHome()
  let opened = false
  await expect(
    RuntimeHandle.open({
      host: fixture.host,
      mode: "oneshot",
      storage: {
        kind: "owned",
        async open() {
          opened = true
          throw new Error("storage should not be opened")
        },
      },
      composition: {
        register() {
          ScopeStartup.register({ name: "invalid", phase: "surface", after: ["missing"], init() {} })
        },
      },
    }),
  ).rejects.toThrow("references unknown step")
  expect(opened).toBe(false)
})
