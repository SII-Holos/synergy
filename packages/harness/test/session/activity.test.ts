import { afterAll, expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionActivity } from "../../src/session/activity"
import { RolloutArtifact } from "../../src/session/rollout/artifact"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutProcess } from "../../src/session/rollout/process"
import { PermissionNext } from "../../src/permission/next"
import { SecretVault } from "../../src/secrets/vault"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "../support/fixture"

const runtime = await testRuntime()
afterAll(() => runtime.close())

async function assistant(session: Session.Info, directory: string, rootID: string) {
  const message = {
    id: Identifier.ascending("message"),
    sessionID: session.id,
    role: "assistant" as const,
    time: { created: Date.now() },
    parentID: rootID,
    rootID,
    modelID: "test",
    providerID: "test",
    mode: "test",
    agent: "synergy",
    path: { cwd: directory, root: directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  await Session.updateMessage(message)
  return message
}

test("a tool opens its captured content and rejects a different call or Scope", () =>
  runtime.run(async () => {
    await using first = await tmpdir({ git: true })
    await using second = await tmpdir({ git: true })
    const target = await ScopeContext.provide({
      scope: await first.scope(),
      fn: async () => {
        const session = await Session.create({})
        const partID = Identifier.ascending("part")
        const rootID = Identifier.ascending("message")
        const info = await assistant(session, first.path, rootID)
        const messageID = info.id
        const content = await RolloutArtifact.writeText(
          { kind: "session", scopeID: session.scope.id, sessionID: session.id },
          "captured content",
        )
        await Session.updatePart({
          id: partID,
          sessionID: session.id,
          messageID,
          type: "tool",
          tool: "read",
          callID: "read-1",
          workBrief: "Check the original file",
          activityEvidence: { kind: "file-read", resource: { path: first.path + "/example.txt" }, content },
          state: {
            status: "completed",
            input: { filePath: first.path + "/example.txt" },
            output: "protocol wrapper",
            title: "example.txt",
            metadata: {},
            time: { start: 1, end: 2 },
          },
        })
        await Bun.write(first.path + "/example.txt", "current content")
        const input = { sessionID: session.id, messageID, partID, callID: "read-1" }
        expect(await SessionActivity.tool(input)).toMatchObject({ text: "captured content", evidenceMissing: false })
        await expect(SessionActivity.tool({ ...input, callID: "other" })).rejects.toThrow()
        return input
      },
    })
    await ScopeContext.provide({
      scope: await second.scope(),
      fn: async () => {
        await expect(SessionActivity.tool(target)).rejects.toThrow()
      },
    })
  }))

test("root status remains stopped when a different root completes and retains stops when resumed", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const owner = { kind: "session" as const, scopeID: session.scope.id, sessionID: session.id }
        const stopped = Identifier.ascending("message")
        const completed = Identifier.ascending("message")
        const first = await RolloutLedger.beginSegment({ owner, runID: stopped, input: {} })
        await RolloutLedger.finishSegment(first, "cancelled")
        await RolloutLedger.finishRun(owner, stopped, "cancelled")
        const other = await RolloutLedger.beginSegment({ owner, runID: completed, input: {} })
        await RolloutLedger.finishSegment(other, "completed")
        await RolloutLedger.finishRun(owner, completed, "completed")
        expect(await SessionActivity.turns(session.id, [stopped, completed])).toMatchObject([
          { rootID: stopped, status: "stopped" },
          { rootID: completed, status: "completed" },
        ])
        await RolloutLedger.resumeRun(owner, stopped)
        const resumed = await RolloutLedger.beginSegment({ owner, runID: stopped, input: {} })
        expect(await SessionActivity.turns(session.id, [stopped])).toMatchObject([
          { status: "running", segmentID: resumed.id, stoppedAt: [expect.any(Number)] },
        ])
        await RolloutLedger.finishSegment(resumed, "completed")
        await RolloutLedger.finishRun(owner, stopped, "completed")
      },
    })
  }))

test("a pending approval pauses only the message's actual root", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const owner = { kind: "session" as const, scopeID: session.scope.id, sessionID: session.id }
        const first = Identifier.ascending("message")
        const second = Identifier.ascending("message")
        await RolloutLedger.beginSegment({ owner, runID: first, input: {} })
        await RolloutLedger.beginSegment({ owner, runID: second, input: {} })
        const message = await assistant(session, tmp.path, first)
        const approvalID = Identifier.ascending("permission")
        const pending = PermissionNext.ask({
          id: approvalID,
          sessionID: session.id,
          permission: "fixture-write",
          patterns: ["fixture"],
          metadata: {},
          ruleset: [],
          tool: { messageID: message.id, callID: "approval-call" },
        })
        for (let i = 0; i < 40 && !(await PermissionNext.list()).some((item) => item.id === approvalID); i++)
          await Bun.sleep(5)
        try {
          const states = await SessionActivity.turns(session.id, [first, second])
          expect(states.find((state) => state.rootID === first)?.status).toBe("approval")
          expect(states.find((state) => state.rootID === second)?.status).toBe("running")
        } finally {
          await PermissionNext.reply({ requestID: approvalID, reply: "once" })
          await pending
        }
      },
    })
  }))

test("a returned background tool retains independent bounded, masked process evidence", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const owner = { kind: "session" as const, scopeID: session.scope.id, sessionID: session.id }
        const rootID = Identifier.ascending("message")
        await RolloutLedger.beginSegment({ owner, runID: rootID, input: {} })
        const message = await assistant(session, tmp.path, rootID)
        const tool = await RolloutLedger.beginTool({
          owner,
          runID: rootID,
          messageID: message.id,
          toolCallID: "background-call",
          tool: "bash",
          args: { command: "fixture", background: true },
        })
        const writer = await RolloutProcess.open(
          { owner, runID: rootID, toolExecutionID: tool.id, processID: "activity-background" },
          async (error) => {
            throw error
          },
        )
        const secret = "activity-fixture-private-value"
        await SecretVault.register(secret, { kind: "heuristic", context: "tool_output" })
        await writer.append("stdout", new TextEncoder().encode(`Started ${secret}\n`))
        const partID = Identifier.ascending("part")
        await Session.updatePart({
          id: partID,
          messageID: message.id,
          sessionID: session.id,
          type: "tool",
          tool: "bash",
          callID: "background-call",
          workBrief: "Start independent verification",
          state: {
            status: "completed",
            input: { command: "fixture", background: true },
            output: "Started in the background",
            title: "fixture",
            metadata: {},
            time: { start: 1, end: 2 },
          },
        })
        const target = { sessionID: session.id, messageID: message.id, partID, callID: "background-call" }
        const active = await SessionActivity.tool(target)
        expect(active.process?.status).toBe("running")
        expect(active.text).not.toContain(secret)
        expect(active.text).toContain("⟦sec:")
        await writer.append("stderr", new Uint8Array(700000).fill(120))
        await writer.finish({ interrupted: false, exitCode: 2, signal: null })
        const ended = await SessionActivity.tool(target)
        expect(ended.part.state.status).toBe("completed")
        expect(ended.process).toMatchObject({ status: "completed", exitCode: 2 })
        expect(ended.truncated).toBe(true)
        expect(Buffer.byteLength(ended.text ?? "")).toBeLessThanOrEqual(512 * 1024)
        expect(ended.text).not.toContain(secret)
      },
    })
  }))
