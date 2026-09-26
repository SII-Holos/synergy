import { expect, test } from "bun:test"
import { RuntimeContext } from "../../src/lifecycle/context"
import { WorkflowKindRegistry } from "../../src/session/workflow-kind-registry"
import { WorkflowPromptRegistry } from "../../src/session/workflow-prompt-registry"
import { SessionExecutionContributions } from "../../src/session/execution-contributions"
import { SessionRecoveryContributions } from "../../src/session/recovery-contributions"
import { SessionModePolicy } from "../../src/session/tool-mode-policy"
import { SessionContextContributions } from "../../src/session/context-contributions"
import { ContinuationKernel } from "../../src/session/continuation-kernel"

const contributions = [
  () => WorkflowKindRegistry.register({ id: "late", conflicts: [], enable: async () => {} }),
  () => WorkflowPromptRegistry.register({ kind: "late" }),
  () => SessionExecutionContributions.register({ id: "late" }),
  () => SessionRecoveryContributions.register({ id: "late" }),
  () => SessionModePolicy.register({ id: "late" }),
  () => SessionContextContributions.register("late", { contribute: async () => undefined }),
  () => ContinuationKernel.registerProvider("late", () => []),
]

test("opening seals execution contributions only in their owning Runtime", () => {
  const host = {
    home: "/isolated/composition",
    root: "/isolated/composition/.synergy",
    env: { SYNERGY_TEST_HOME: "/isolated/composition" },
  }
  const ready = RuntimeContext.create(host)
  const next = RuntimeContext.create({ ...host, home: "/isolated/next", root: "/isolated/next/.synergy" })
  try {
    ready.run(() => {
      RuntimeContext.sealComposition()
      for (const register of contributions) expect(register).toThrow("before opening")
      expect(WorkflowKindRegistry.ids()).toEqual([])
      expect(WorkflowPromptRegistry.kinds()).toEqual([])
      expect(ContinuationKernel.providerIDs()).toEqual([])
    })
    next.run(() => {
      for (const register of contributions) register()
      expect(WorkflowKindRegistry.ids()).toEqual(["late"])
      expect(WorkflowPromptRegistry.kinds()).toEqual(["late"])
      expect(ContinuationKernel.providerIDs()).toEqual(["late"])
    })
  } finally {
    ready.dispose()
    next.dispose()
  }
})
