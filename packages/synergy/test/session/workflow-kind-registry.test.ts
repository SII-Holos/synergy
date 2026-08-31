import { describe, expect, test } from "bun:test"
import { Session } from "../../src/session"
import { SessionWorkflowService, WorkflowConflictError } from "../../src/session/workflow"
import { ContinuationKernel } from "../../src/session/continuation-kernel"
import { WorkflowPromptRegistry } from "../../src/session/workflow-prompt-registry"
import { WorkflowKindRegistry } from "../../src/session/workflow-kind-registry"
import { WorkflowUserWrapper } from "../../src/session/workflow-user-wrapper"
import { WorkflowInfo } from "../../src/session/types"
// Core workflow domains register via the L4 manifest; the test-only kind
// mounts alongside them, exactly as a real extension would.
import "../../src/product-registration"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

/**
 * H3 acceptance: a test-only workflow kind (descriptor + prompt contribution
 * + continuation policy) mounts entirely from test code — no L1 file edits —
 * and behaves like a first-class kind: enable persists through the extension
 * envelope projection, the user-message wrapper applies through the registry,
 * the mutual-exclusion gate rejects competing core kinds, and setNone
 * releases it. Legacy workflow records parse unchanged (pure addition).
 */

const TEST_KIND = "testonly_kind"

function registerTestOnlyKind() {
  WorkflowKindRegistry.register({
    id: TEST_KIND,
    conflicts: ["plan", "lightloop", "lattice", "boss"],
    async enable(input) {
      const session = await Session.get(input.sessionID)
      if (session.workflow) {
        throw new WorkflowConflictError(
          WorkflowKindRegistry.effectiveKind(session.workflow) ?? session.workflow.kind,
          `Cannot enable ${TEST_KIND} while the ${WorkflowKindRegistry.effectiveKind(session.workflow)} workflow is active.`,
        )
      }
      return Session.update(input.sessionID, (draft) => {
        draft.workflow = { kind: "extension", extension: { kind: TEST_KIND, payload: input.args } }
      })
    },
    async disable(sessionID) {
      await Session.update(sessionID, (draft) => {
        if (draft.workflow?.kind === "extension" && draft.workflow.extension?.kind === TEST_KIND) {
          draft.workflow = undefined
        }
      })
    },
  })

  WorkflowPromptRegistry.register({
    kind: TEST_KIND,
    controlSources: [`${TEST_KIND}_continuation`],
    projectUserMessage(query: string, agentName: string) {
      return [
        "<testonly-user-request>",
        `You are ${agentName} in the test-only workflow.`,
        "User request:",
        query,
        "</testonly-user-request>",
      ].join("\n")
    },
    async isActive(session) {
      return session.workflow?.kind === "extension" && session.workflow.extension?.kind === TEST_KIND
    },
  })

  ContinuationKernel.registerProvider(TEST_KIND, () => [
    {
      id: `${TEST_KIND}_policy`,
      priority: 1,
      async handle() {
        return undefined
      },
    },
  ])
}

async function withScope<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  return ScopeContext.provide({ scope: await tmp.scope(), fn })
}

describe("workflow kind registry (H3 test-only kind)", () => {
  test("extension kind enables, persists, wraps, conflicts, and disables without L1 edits", async () => {
    await withScope(async () => {
      registerTestOnlyKind()
      expect(WorkflowKindRegistry.ids()).toContain(TEST_KIND)
      expect(ContinuationKernel.registeredPolicyIDs()).toContain(`${TEST_KIND}_policy`)

      const session = await Session.create({})
      const enabled = await SessionWorkflowService.setExtension(session.id, TEST_KIND, {
        intensity: "maximum",
      })
      expect(enabled.workflow?.kind).toBe("extension")
      expect(WorkflowKindRegistry.effectiveKind(enabled.workflow)).toBe(TEST_KIND)

      const reread = await Session.get(session.id)
      expect(reread.workflow?.kind).toBe("extension")
      if (reread.workflow?.kind !== "extension") throw new Error("expected extension envelope")
      expect(reread.workflow.extension.kind).toBe(TEST_KIND)
      expect(reread.workflow.extension.payload).toEqual({ intensity: "maximum" })

      const wrapped = WorkflowUserWrapper.build("synergy", TEST_KIND, "do the thing")
      expect(wrapped).toBe(
        [
          "<testonly-user-request>",
          "You are synergy in the test-only workflow.",
          "User request:",
          "do the thing",
          "</testonly-user-request>",
        ].join("\n"),
      )

      await expect(SessionWorkflowService.setExtension(session.id, TEST_KIND, {})).rejects.toThrow("workflow is active")
      await expect(SessionWorkflowService.enablePlan(session.id)).rejects.toThrow(TEST_KIND)
      await expect(
        SessionWorkflowService.enableLattice(session.id, { kind: "lattice", mode: "auto" }),
      ).rejects.toMatchObject({
        data: { state: TEST_KIND, reason: expect.stringContaining(TEST_KIND) },
      })

      const cleared = await SessionWorkflowService.setNone(session.id)
      expect(cleared.workflow).toBeUndefined()
      expect((await Session.get(session.id)).workflow).toBeUndefined()
      expect(
        WorkflowUserWrapper.metadataForUserMessage({
          session: await Session.get(session.id),
          agentName: "synergy",
        }),
      ).toEqual({})
    })
  })

  test("unregistered extension kinds are rejected loudly", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      await expect(SessionWorkflowService.setExtension(session.id, "never_registered", {})).rejects.toThrow(
        'Workflow kind "never_registered" is not registered',
      )
      expect((await Session.get(session.id)).workflow).toBeUndefined()
    })
  })

  test("legacy workflow records parse unchanged through the extension member", () => {
    const legacy = [
      { kind: "plan" },
      {
        kind: "lightloop",
        instructions: "Keep going",
        stopRequest: {
          summary: "done",
          requestedAt: 1,
          requesterSessionID: "ses_a",
          requesterMessageID: "msg_a",
        },
      },
      { kind: "lattice", runID: "ltr_x", mode: "collaborative" },
      { kind: "boss", role: "worker", workerRole: "research", rootID: "ses_root" },
    ] as const
    for (const workflow of legacy) {
      expect(WorkflowInfo.parse(workflow)).toEqual(workflow)
    }
    expect(WorkflowInfo.parse({ kind: "extension", extension: { kind: TEST_KIND, payload: { a: 1 } } })).toEqual({
      kind: "extension",
      extension: { kind: TEST_KIND, payload: { a: 1 } },
    })
  })
})
