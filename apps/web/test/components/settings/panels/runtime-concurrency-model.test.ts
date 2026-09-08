import { describe, expect, test } from "bun:test"
import { concurrencyPressureState } from "../../../../src/components/settings/panels/runtime-concurrency-model"

describe("runtime concurrency pressure state", () => {
  test("explains when memory pressure temporarily caps configured admission", () => {
    expect(
      concurrencyPressureState({
        configured: 12,
        environment: null,
        effective: 4,
        memoryPressureLimit: 4,
      }),
    ).toEqual({ managed: false, value: "4" })
  })

  test("keeps environment ownership visible while the safety limit is active", () => {
    expect(
      concurrencyPressureState({
        configured: 12,
        environment: 16,
        effective: 2,
        memoryPressureLimit: 2,
      }),
    ).toEqual({ managed: true, value: "2" })
  })

  test("omits pressure copy when the configured maximum is already lower", () => {
    expect(
      concurrencyPressureState({
        configured: 1,
        environment: null,
        effective: 1,
        memoryPressureLimit: 2,
      }),
    ).toBeUndefined()
  })
})
