import { expect, jest, spyOn, test } from "bun:test"
import { RuntimeComponents } from "@ericsanchezok/synergy-harness/lifecycle"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { observePollingTimers } from "@ericsanchezok/synergy-harness/test/support/polling-timers"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { channels } from "../src/component"
import { Channel } from "../src/channel"
import { connectionStatusRows } from "../src/startup-status"

test("channels polling in another Runtime survives disposal and settles when connected", async () => {
  const composition = () =>
    RuntimeComponents.compose([localRuntime({ workers: false, environment: false }), channels()])
  await using first = await testRuntime({ composition: composition() })
  await using second = await testRuntime({ composition: composition() })
  const entered = Promise.withResolvers<void>()
  let reads = 0
  const status = spyOn(Channel, "status").mockImplementation(async () => {
    if (++reads === 2) entered.resolve()
    return { "fixture:one": { status: "connecting" as const } }
  })
  jest.useFakeTimers()
  try {
    using timers = observePollingTimers()
    setTimeout(() => {}, 60_000)
    const pendingFirst = first.run(() =>
      ScopeContext.provide({ scope: Scope.home(), fn: () => timers.run(() => connectionStatusRows(() => {})) }),
    )
    const pendingSecond = second.run(() =>
      ScopeContext.provide({ scope: Scope.home(), fn: () => timers.run(() => connectionStatusRows(() => {})) }),
    )
    await entered.promise
    await Promise.resolve()
    await Promise.resolve()
    expect(timers.count()).toBe(4)
    await first.close()
    expect(await pendingFirst).toEqual([])
    expect(timers.count()).toBe(2)
    status.mockResolvedValue({ "fixture:one": { status: "connected" } })
    jest.advanceTimersByTime(320)
    expect(await pendingSecond).toEqual([{ label: "Channels", value: "fixture:one connected", kind: "success" }])
    expect(timers.count()).toBe(0)
    expect(jest.getTimerCount()).toBeGreaterThan(0)
  } finally {
    jest.clearAllTimers()
    jest.useRealTimers()
    status.mockRestore()
  }
})

for (const finish of ["timeout", "close"] as const) {
  test(`channels startup polling releases its timers after ${finish}`, async () => {
    await using runtime = await testRuntime({
      composition: RuntimeComponents.compose([localRuntime({ workers: false, environment: false }), channels()]),
    })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          const entered = Promise.withResolvers<void>()
          const status = spyOn(Channel, "status").mockImplementation(async () => {
            entered.resolve()
            return { "fixture:one": { status: "connecting" } }
          })
          jest.useFakeTimers()
          try {
            using timers = observePollingTimers()
            const pending = timers.run(() => connectionStatusRows(() => {}))
            await entered.promise
            await Promise.resolve()
            await Promise.resolve()
            expect(timers.count()).toBe(2)
            if (finish === "timeout") {
              jest.advanceTimersByTime(15_000)
              expect(await pending).toEqual([
                { label: "Channels", value: "fixture:one failed: connection timeout", kind: "error" },
              ])
            } else {
              await runtime.close()
              expect(timers.count()).toBe(0)
              expect(await pending).toEqual([])
            }
            expect(timers.count()).toBe(0)
          } finally {
            jest.clearAllTimers()
            jest.useRealTimers()
            status.mockRestore()
          }
        },
      }),
    )
  })
}
