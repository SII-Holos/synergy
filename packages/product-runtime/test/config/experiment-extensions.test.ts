import "../../src/configuration"
import { expect, test } from "bun:test"
import { Experiment } from "@ericsanchezok/synergy-harness/config/experiment"

test("attach checks process settings and one-shot runtime overrides reach configuration readers", () => {
  try {
    Experiment.configureRuntime({ execution: { agentWorkers: 3 }, formatter: false }, { formatter: false })
    expect(() => Experiment.assertRuntime({ execution: { agentWorkers: 3 } })).not.toThrow()
    expect(() => Experiment.assertRuntime({ execution: { agentWorkers: 5 } })).toThrow("differ")
    expect(Experiment.apply({ formatter: {} }).formatter).toBe(false)
  } finally {
    Experiment.configureRuntime()
  }
})
