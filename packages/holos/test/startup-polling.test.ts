import { expect, jest, spyOn, test } from "bun:test"
import { RuntimeComponents } from "@ericsanchezok/synergy-harness/lifecycle"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { holos } from "../src/component"
import { HolosRuntime } from "../src/holos/runtime"
import { connectionStatusRows } from "../src/startup-status"

test("holos polling in another Runtime survives disposal and settles when connected", async () => {
  const composition = () => RuntimeComponents.compose([localRuntime({ workers: false, environment: false }), holos()])
  await using first = await testRuntime({ composition: composition() })
  await using second = await testRuntime({ composition: composition() })
  const entered = Promise.withResolvers<void>()
  let reads = 0
  const status = spyOn(HolosRuntime, "status").mockImplementation(async () => {
    if (++reads === 2) entered.resolve()
    return { status: "connecting" as const }
  })
  jest.useFakeTimers()
  try {
    const pendingFirst = first.run(() =>
      ScopeContext.provide({ scope: Scope.home(), fn: () => connectionStatusRows() }),
    )
    const pendingSecond = second.run(() =>
      ScopeContext.provide({ scope: Scope.home(), fn: () => connectionStatusRows() }),
    )
    await entered.promise
    await Promise.resolve()
    await Promise.resolve()
    expect(jest.getTimerCount()).toBe(4)
    await first.close()
    expect(await pendingFirst).toEqual([])
    expect(jest.getTimerCount()).toBe(2)
    status.mockResolvedValue({ status: "connected" })
    jest.advanceTimersByTime(320)
    expect(await pendingSecond).toEqual([{ label: "Holos", value: "agent network connected", kind: "success" }])
    expect(jest.getTimerCount()).toBe(0)
  } finally {
    jest.clearAllTimers()
    jest.useRealTimers()
    status.mockRestore()
  }
})

for (const finish of ["timeout", "close"] as const) {
  test(`holos startup polling releases its timers after ${finish}`, async () => {
    await using runtime = await testRuntime({
      composition: RuntimeComponents.compose([localRuntime({ workers: false, environment: false }), holos()]),
    })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          const entered = Promise.withResolvers<void>()
          const status = spyOn(HolosRuntime, "status").mockImplementation(async () => {
            entered.resolve()
            return { status: "connecting" }
          })
          jest.useFakeTimers()
          try {
            const pending = connectionStatusRows()
            await entered.promise
            await Promise.resolve()
            await Promise.resolve()
            expect(jest.getTimerCount()).toBe(2)
            if (finish === "timeout") {
              jest.advanceTimersByTime(15_000)
              expect(await pending).toEqual([
                { label: "Holos", value: "agent network failed: connection timeout", kind: "error" },
              ])
            } else {
              await runtime.close()
              expect(jest.getTimerCount()).toBe(0)
              expect(await pending).toEqual([])
            }
            expect(jest.getTimerCount()).toBe(0)
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
