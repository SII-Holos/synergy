import { describe, expect, test } from "bun:test"
import { agentWorkerCapacityDisplay } from "../../../../src/components/settings/panels/runtime-agent-workers-model"

describe("runtime agent worker capacity display", () => {
  test("shows the machine-derived capacity and its source while the ceiling is unset", () => {
    expect(agentWorkerCapacityDisplay({ configured: null, effective: 20, source: "derived" })).toEqual({
      source: "derived",
      value: "20",
    })
  })

  test("shows the explicit ceiling and its source when configured", () => {
    expect(agentWorkerCapacityDisplay({ configured: 6, effective: 6, source: "explicit" })).toEqual({
      source: "explicit",
      value: "6",
    })
  })

  test("renders an explicit ceiling with the resolved effective value", () => {
    expect(agentWorkerCapacityDisplay({ configured: 64, effective: 64, source: "explicit" })?.value).toBe("64")
  })

  test("renders nothing until the status is known", () => {
    expect(agentWorkerCapacityDisplay(undefined)).toBeUndefined()
  })
})
