import { expect, test } from "bun:test"
import { tmpdir } from "../support/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionWorkflowService } from "../../src/session/workflow"
import { SessionExecutionContributions } from "../../src/session/execution-contributions"
import { SessionRecoveryContributions } from "../../src/session/recovery-contributions"
import { SessionRecovery } from "../../src/session/recovery"
import { WorkflowKindRegistry } from "../../src/session/workflow-kind-registry"
import { SessionModePolicy } from "../../src/session/tool-mode-policy"

const kind = "research-contribution-test"

test("an explicitly registered workflow shares session persistence, execution ownership and cancellation", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const session = await Session.create()
      await expect(SessionWorkflowService.set(session.id, { kind })).rejects.toThrow("is not registered")
      expect((await Session.get(session.id)).workflow).toBeUndefined()
      WorkflowKindRegistry.register({
        id: kind,
        conflicts: [],
        async enable({ sessionID, args }) {
          await Session.update(sessionID, (draft) => {
            draft.workflow = { kind, experiment: args.experiment }
          })
        },
      })
      SessionExecutionContributions.register({
        id: kind,
        isActive: (info) => info.id === session.id && info.workflow?.kind === kind,
        hasContinuation: (info) => info.id === session.id && info.workflow?.kind === kind,
        ownsPendingReply: (info) => info.id === session.id,
        system: (info) => (info.id === session.id ? ["experiment system context"] : []),
        archive: async (info) => (info.id === session.id ? { experiment: "saved evidence" } : {}),
        advisory: async (sessionID, _scopeID, signal) => {
          signal.throwIfAborted()
          return sessionID === session.id ? ["experiment advisory"] : []
        },
        async assertWorkflowAllowed(info) {
          if (info.id === session.id && info.workflow) throw new Error("Experiment owns this session")
        },
      })
      const enabled = await SessionWorkflowService.set(session.id, { kind, experiment: "run A" })
      expect(enabled.workflow).toEqual({ kind, experiment: "run A" })
      expect(await SessionWorkflowService.hasPendingExecution(enabled)).toBe(true)
      expect(SessionExecutionContributions.hasContinuation(enabled)).toBe(true)
      expect(SessionExecutionContributions.ownsPendingReply(enabled)).toBe(true)
      expect(
        await SessionExecutionContributions.system(enabled, { agentName: "test", deliveryMetadata: undefined }),
      ).toEqual(["experiment system context"])
      expect(await SessionExecutionContributions.archive(enabled)).toEqual({ experiment: "saved evidence" })
      expect(
        await SessionExecutionContributions.advisory(enabled.id, enabled.scope.id, new AbortController().signal),
      ).toEqual(["experiment advisory"])
      await expect(
        SessionExecutionContributions.advisory(enabled.id, enabled.scope.id, AbortSignal.abort()),
      ).rejects.toThrow()
      await expect(SessionExecutionContributions.assertWorkflowAllowed(enabled, "next")).rejects.toThrow(
        "owns this session",
      )
      await SessionWorkflowService.setNone(enabled.id)
      expect((await Session.get(enabled.id)).workflow).toBeUndefined()
      expect(await SessionWorkflowService.hasPendingExecution(await Session.get(enabled.id))).toBe(false)
      expect(await SessionExecutionContributions.isActive(await Session.create())).toBe(false)
    },
  })
})

test("recovery invokes the selected domain without requiring product stores", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const session = await Session.create()
      SessionRecoveryContributions.register({
        id: kind,
        scopes: async () => [session.scope.id],
        async reconcile({ scopeID, apply, report }) {
          if (scopeID !== session.scope.id) return
          if (apply)
            await Session.update(session.id, (draft) => {
              draft.title = "Recovered experiment"
            })
          report.entries.push({ scopeID, sessionID: session.id, action: "experiment_recovery" })
          report.changed++
        },
        resume: async (scopeID) => (scopeID === session.scope.id ? 1 : 0),
        statuses: async (scopeID) =>
          scopeID === session.scope.id ? { [session.id]: { type: "recovering" as const } } : {},
      })
      const preview = await SessionRecovery.reconcileRuntimeState({ scopeID: session.scope.id })
      expect(preview.changed).toBe(1)
      expect((await Session.get(session.id)).title).not.toBe("Recovered experiment")
      const applied = await SessionRecovery.reconcileRuntimeState({ scopeID: session.scope.id, apply: true })
      expect(applied.sessionsScanned).toBe(1)
      expect((await Session.get(session.id)).title).toBe("Recovered experiment")
      expect(await SessionRecovery.resumePendingStopRequests(session.scope.id)).toBe(1)
      expect(await SessionRecovery.recoverableStatuses(session.scope.id)).toEqual({
        [session.id]: { type: "recovering" },
      })
    },
  })
})

test("tool policy contributions retain denial evidence and explicit exposure without business defaults", async () => {
  const diagnostic = {
    code: "tool_unavailable" as const,
    toolName: "experiment_write",
    message: "Experiment is frozen",
  }
  SessionModePolicy.register({
    id: kind,
    visibility: (input) => (input.toolName === diagnostic.toolName ? diagnostic : undefined),
    evaluateCall: (input) => (input.toolName === diagnostic.toolName ? diagnostic : undefined),
    unavailable: (input) => (input.reason === "experiment_frozen" ? diagnostic : undefined),
    forcedGroups: (session) => (session?.workflow?.kind === kind ? [kind] : []),
    availability: async () => new Map([[diagnostic.toolName, diagnostic]]),
  })
  expect(SessionModePolicy.visibility({ toolName: diagnostic.toolName })).toBe(diagnostic)
  expect(SessionModePolicy.visibility({ toolName: "read" })).toBeUndefined()
  expect(SessionModePolicy.evaluateCall({ toolName: diagnostic.toolName, args: {}, capabilities: [] })).toBe(diagnostic)
  expect(SessionModePolicy.evaluateCall({ toolName: "read", args: {}, capabilities: [] })).toBeUndefined()
  expect(SessionModePolicy.forcedGroups()).not.toContain(kind)
  expect((await SessionModePolicy.availability({ agent: "researcher" })).get(diagnostic.toolName)).toBe(diagnostic)
  expect(SessionModePolicy.unavailable({ toolName: diagnostic.toolName, reason: "experiment_frozen" })).toBe(diagnostic)
  expect(SessionModePolicy.unavailable({ toolName: "read", reason: "permission" }).code).toBe("permission_denied")
  expect(SessionModePolicy.unavailable({ toolName: "read", reason: "user_disabled" }).message).toContain(
    "disabled for this request",
  )
  expect(SessionModePolicy.unavailable({ toolName: "read", reason: "deferred" }).message).toContain("search_tools")
})
