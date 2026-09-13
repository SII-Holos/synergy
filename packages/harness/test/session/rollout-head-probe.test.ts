import { afterEach, expect, spyOn, test } from "bun:test"
import { cleanupObservabilityHomes, resetObservabilityHome } from "../observability/fixture"
import { ObservabilityIssues } from "../../src/observability/issues"
import { RolloutJournal } from "../../src/session/rollout/journal"

afterEach(cleanupObservabilityHomes)

test("probing a missing journal head does not raise a storage issue", async () => {
  resetObservabilityHome()
  const raised = spyOn(ObservabilityIssues, "raise")
  try {
    const target = { kind: "operation" as const, scopeID: "test", operationID: crypto.randomUUID() }
    expect(await RolloutJournal.head(target)).toEqual({ allocated: 0, committed: 0 })
    expect(raised).not.toHaveBeenCalled()
  } finally {
    raised.mockRestore()
  }
})
