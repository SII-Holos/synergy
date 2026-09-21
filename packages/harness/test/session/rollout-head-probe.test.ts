import { afterEach, expect, spyOn, test } from "bun:test"
import { clearObservabilityState, resetObservabilityState } from "../observability/fixture"
import { ObservabilityIssues } from "../../src/observability/issues"
import { RolloutJournal } from "../../src/session/rollout/journal"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

afterEach(() => runtime.run(clearObservabilityState))

test("probing a missing journal head does not raise a storage issue", () =>
  runtime.run(async () => {
    resetObservabilityState()
    const raised = spyOn(ObservabilityIssues, "raise")
    try {
      const target = { kind: "operation" as const, scopeID: "test", operationID: crypto.randomUUID() }
      expect(await RolloutJournal.head(target)).toEqual({ allocated: 0, committed: 0 })
      expect(raised).not.toHaveBeenCalled()
    } finally {
      raised.mockRestore()
    }
  }))

afterRuntimeTests(() => runtime.close())
