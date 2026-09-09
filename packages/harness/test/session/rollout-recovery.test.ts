import { expect, test } from "bun:test"
import { tmpdir } from "../support/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Identifier } from "../../src/id/id"
import { Session } from "../../src/session"
import { RolloutProcess } from "../../src/session/rollout/process"
import { RolloutLifecycle } from "../../src/session/rollout/lifecycle"
import { RolloutRecovery } from "../../src/session/rollout/recovery"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutArtifact } from "../../src/session/rollout/artifact"
import { RolloutSnapshot } from "../../src/session/rollout/snapshot"

test("recovery preserves committed evidence, interrupts side effects, and resumes in a new segment", async () => {
  const owner = { kind: "operation" as const, scopeID: "test", operationID: crypto.randomUUID() }
  const segment = await RolloutLedger.beginSegment({ owner, runID: "run", input: { task: "original" } })
  const call = await RolloutLedger.beginCall({
    owner,
    runID: "run",
    purpose: "test",
    request: {},
    model: { providerID: "test", modelID: "test", sdk: "test", pricing: null },
  })
  const writer = await RolloutArtifact.open(owner, "text/plain")
  await RolloutLedger.checkpointCall(owner, "run", call.id, writer.committed)
  await writer.append(new TextEncoder().encode("committed prefix"))
  await writer.checkpoint()
  await writer.append(new TextEncoder().encode("not committed"))
  await RolloutLedger.beginTool({
    owner,
    runID: "run",
    messageID: "message",
    toolCallID: "tool",
    tool: "bash",
    args: {},
  })
  await RolloutRecovery.owner(owner)
  const snapshot = await RolloutSnapshot.read(owner)
  expect(snapshot.segments[0].status).toBe("interrupted")
  expect(snapshot.calls[0].status).toBe("interrupted")
  expect(snapshot.tools[0].status).toBe("interrupted")
  const chunks: Uint8Array[] = []
  for await (const bytes of RolloutArtifact.read(owner, snapshot.calls[0].response!)) chunks.push(bytes)
  expect(Buffer.concat(chunks).toString()).toBe("committed prefix")
  expect(snapshot.runs[0].status).toBe("interrupted")
  await RolloutRecovery.owner(owner)
  expect(await RolloutSnapshot.read(owner)).toEqual(snapshot)
  const resumed = await RolloutLedger.beginSegment({ owner, runID: "run", input: { task: "resumed" } })
  expect(resumed.id).not.toBe(segment.id)
  expect((await RolloutLedger.getRun(owner, "run")).input).toEqual(snapshot.runs[0].input)
  expect(await RolloutLedger.tools(owner, "run")).toHaveLength(1)
})

test("reconcile settles records left running by an interrupted turn and completes the run", async () => {
  await using tmp = await tmpdir({ git: true })
  const scope = await tmp.scope()
  await ScopeContext.provide({
    scope,
    fn: async () => {
      const session = await Session.create({})
      const identity = { kind: "session" as const, scopeID: scope.id, sessionID: session.id }
      const runID = Identifier.ascending("message")
      const call = await RolloutLedger.beginCall({
        owner: identity,
        runID,
        purpose: "chat",
        request: {},
        model: { providerID: "test", modelID: "test", sdk: "test", pricing: null },
      })
      expect((await RolloutSnapshot.read(identity)).runs[0].status).toBe("running")

      await RolloutLifecycle.reconcile(session.id, runID, "failed")

      const snapshot = await RolloutSnapshot.read(identity)
      expect(snapshot.calls.find((entry) => entry.id === call.id)?.status).toBe("interrupted")
      expect(snapshot.runs.find((run) => run.id === runID)?.status).toBe("failed")
      await Session.remove(session.id)
    },
  })
})

test("reconcile preserves live background process evidence through its eventual exit", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const session = await Session.create({})
      const owner = RolloutLifecycle.owner(session)
      const runID = Identifier.ascending("message")
      const tool = await RolloutLedger.beginTool({
        owner,
        runID,
        messageID: runID,
        toolCallID: "background",
        tool: "bash",
        args: {},
      })
      const writer = await RolloutProcess.open(
        { owner, runID, toolExecutionID: tool.id, processID: "background" },
        async (error) => {
          throw error
        },
      )
      try {
        await writer.append("stdout", new TextEncoder().encode("before"))
        await RolloutLedger.writeTool({ ...tool, status: "completed", ended: Date.now() })
        await RolloutLifecycle.reconcile(session.id, runID, "failed")
        expect((await RolloutLedger.processes(owner, runID))[0].status).toBe("running")
        await writer.append("stdout", new TextEncoder().encode("after"))
        await writer.finish({ interrupted: false, exitCode: 0, signal: null })
        const process = (await RolloutLedger.processes(owner, runID))[0]
        expect(process.status).toBe("completed")
        expect(process.exitCode).toBe(0)
        const chunks: Uint8Array[] = []
        for await (const bytes of RolloutArtifact.read(owner, process.stream)) chunks.push(bytes)
        expect(Buffer.concat(chunks).toString()).toContain("after")
      } finally {
        await writer.finish({ interrupted: true, exitCode: null, signal: null })
        await Session.remove(session.id)
      }
    },
  })
})
