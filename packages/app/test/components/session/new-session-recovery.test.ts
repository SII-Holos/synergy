import { describe, expect, test } from "bun:test"
import type { NewSessionRecovery } from "../../../src/components/session/new-session-recovery"
import {
  createNewSessionRecoveryActions,
  restoreNewSessionRecovery,
} from "../../../src/components/session/new-session-recovery"

function recovery(): NewSessionRecovery {
  return {
    draft: {
      version: 1,
      prompt: [{ type: "text", content: "Retry me", start: 0, end: 0 }],
      context: { items: [] },
    },
    mode: "normal",
    workspaceSelection: { mode: "create" },
    controlProfile: "guarded",
    plan: false,
    lattice: null,
    lightLoop: false,
    blueprintSlot: null,
    agent: "synergy",
    model: { providerID: "provider", modelID: "model" },
    autoSubmit: false,
  }
}

describe("new-session recovery actions", () => {
  test("retry deletes the failed session and restores an auto-submitting draft", async () => {
    const events: string[] = []
    let restored: NewSessionRecovery | undefined
    const actions = createNewSessionRecoveryActions({
      recovery: recovery(),
      clearTransition: () => events.push("clear"),
      setRecovery: (value) => {
        restored = value
        events.push("restore")
      },
      deleteSession: async () => {
        events.push("delete")
      },
      navigateToComposer: () => events.push("navigate"),
    })

    await actions.retry()

    expect(events).toEqual(["restore", "delete", "clear", "navigate"])
    expect(restored?.autoSubmit).toBe(true)
  })

  test("dismiss restores the draft without submitting and ignores repeated actions", async () => {
    const events: string[] = []
    let restored: NewSessionRecovery | undefined
    let finishDelete: (() => void) | undefined
    const actions = createNewSessionRecoveryActions({
      recovery: recovery(),
      clearTransition: () => events.push("clear"),
      setRecovery: (value) => {
        restored = value
        events.push("restore")
      },
      deleteSession: () =>
        new Promise<void>((resolve) => {
          finishDelete = resolve
          events.push("delete")
        }),
      navigateToComposer: () => events.push("navigate"),
    })

    const dismiss = actions.dismiss()
    const retry = actions.retry()
    finishDelete?.()
    await Promise.all([dismiss, retry])

    expect(events).toEqual(["restore", "delete", "clear", "navigate"])
    expect(restored?.autoSubmit).toBe(false)
  })

  test("restores the complete new-session request before optional auto-submit", () => {
    const source = {
      ...recovery(),
      plan: true,
      lattice: { mode: "collaborative" as const, maxModelCalls: 12 },
      lightLoop: true,
      blueprintSlot: {
        type: "pending" as const,
        noteID: "note-1",
        title: "Blueprint",
        runMode: "new" as const,
      },
      variant: "high",
      autoSubmit: true,
    }
    const restored: Record<string, unknown> = {}

    const autoSubmit = restoreNewSessionRecovery({
      recovery: source,
      setDraft: (value) => (restored.draft = value),
      setMode: (value) => (restored.mode = value),
      setWorkspaceSelection: (value) => (restored.workspaceSelection = value),
      setControlProfile: (value) => (restored.controlProfile = value),
      setPlan: (value) => (restored.plan = value),
      setLattice: (value) => (restored.lattice = value),
      setLightLoop: (value) => (restored.lightLoop = value),
      setBlueprintSlot: (value) => (restored.blueprintSlot = value),
      setAgent: (value) => (restored.agent = value),
      setModel: (value) => (restored.model = value),
      setVariant: (value, model) => (restored.variant = { value, model }),
    })

    expect(restored).toEqual({
      draft: source.draft,
      mode: source.mode,
      workspaceSelection: source.workspaceSelection,
      controlProfile: source.controlProfile,
      plan: source.plan,
      lattice: source.lattice,
      lightLoop: source.lightLoop,
      blueprintSlot: source.blueprintSlot,
      agent: source.agent,
      model: source.model,
      variant: { value: source.variant, model: source.model },
    })
    expect(autoSubmit).toBe(true)
  })
})
