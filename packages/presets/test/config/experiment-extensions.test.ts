import "../../src/configuration"
import { expect, test } from "bun:test"
import { Experiment } from "@ericsanchezok/synergy-harness/config/experiment"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

test("attach checks process settings and one-shot runtime overrides reach configuration readers", () =>
  runtime.run(() => {
    try {
      Experiment.configureRuntime({ execution: { agentWorkers: 3 }, formatter: false }, { formatter: false })
      expect(() => Experiment.assertRuntime({ execution: { agentWorkers: 3 } })).not.toThrow()
      expect(() => Experiment.assertRuntime({ execution: { agentWorkers: 5 } })).toThrow("differ")
      expect(Experiment.apply({ formatter: {} }).formatter).toBe(false)
    } finally {
      Experiment.configureRuntime()
    }
  }))

afterRuntimeTests(() => runtime.close())
