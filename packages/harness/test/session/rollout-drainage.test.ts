import { afterAll, expect, spyOn, test } from "bun:test"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { fixture, complete } from "../support/rollout"
import { testRuntime } from "../support/runtime"
import { RolloutQuery } from "../../src/session/rollout/query"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutProcess } from "../../src/session/rollout/process"
import { RolloutArtifact } from "../../src/session/rollout/artifact"
import { ProcessRegistry } from "../../src/process/registry"
import { Session } from "../../src/session"
import { SessionManager } from "../../src/session/manager"
import { MessageV2 } from "../../src/session/message-v2"
import { LoopJob } from "../../src/session/loop-job"
import { RolloutJournal } from "../../src/session/rollout/journal"
import { RolloutLifecycle } from "../../src/session/rollout/lifecycle"
import { Storage } from "../../src/storage/storage"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test("terminal root release evidence waits for physical process exit and preserves unknown drainage", () =>
  runtime.run(() =>
    fixture(async ({ session, rootID, call }) => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
      const closed = once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>
      const processRecord = ProcessRegistry.create({ command: "root drainage fixture", child })
      const writer = await RolloutProcess.open(
        { owner: call.owner, runID: rootID, toolExecutionID: crypto.randomUUID(), processID: processRecord.id },
        async (error) => {
          throw error
        },
      )
      let finished = false
      try {
        await complete(call)
        await RolloutLedger.finishRun(call.owner, rootID, "completed")
        expect(await RolloutQuery.releaseEvidence(session.id, rootID)).toBeUndefined()
        child.kill("SIGTERM")
        const [code, signal] = await closed
        await writer.finish({ interrupted: true, exitCode: code, signal, pid: child.pid })
        finished = true
        ProcessRegistry.markExited(processRecord, code, signal)
        expect(await RolloutQuery.releaseEvidence(session.id, rootID)).toMatchObject({
          id: rootID,
          status: "completed",
        })
        const [process] = await RolloutLedger.processes(call.owner, rootID)
        await RolloutLedger.writeProcess({
          ...process,
          id: "unknown-exit",
          status: "running",
          ended: undefined,
          exitCode: null,
          signal: null,
        })
        expect(await RolloutQuery.releaseEvidence(session.id, rootID)).toBeUndefined()
        await RolloutLedger.writeProcess({
          ...process,
          id: "unknown-exit",
          status: "interrupted",
          exitCode: 0,
          signal: null,
        })
        expect(await RolloutQuery.releaseEvidence(session.id, rootID)).toMatchObject({ status: "completed" })
        expect(
          (await RolloutLedger.processes(call.owner, rootID)).find((record) => record.id === "unknown-exit")?.exitCode,
        ).toBe(0)
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
        await closed
        if (!finished) await writer.finish({ interrupted: true, exitCode: null, signal: null, pid: child.pid })
        ProcessRegistry.remove(processRecord.id)
      }
    }),
  ))

test("release evidence waits for the native lease and detached jobs after the root settles", () =>
  runtime.run(() =>
    fixture(async ({ session, rootID, call }) => {
      await complete(call)
      await RolloutLedger.finishRun(call.owner, rootID, "completed")
      const lease = SessionManager.acquire(session.id)!
      try {
        expect(await RolloutQuery.releaseEvidence(session.id, rootID)).toBeUndefined()
        SessionManager.bindRootTask(lease, rootID)
        expect(await RolloutQuery.releaseEvidence(session.id, rootID)).toBeUndefined()
      } finally {
        await SessionManager.release(lease, { requestNextWork: false })
      }
      const lastUser = await MessageV2.readInfo({ scopeID: session.scope.id, sessionID: session.id, messageID: rootID })
      if (lastUser.role !== "user") throw new Error("Fixture root must be a user message")
      const release = Promise.withResolvers<void>()
      const started = Promise.withResolvers<void>()
      const type = `release-evidence-${crypto.randomUUID()}`
      LoopJob.register({
        type,
        phase: "post",
        blocking: false,
        detached: true,
        collect: () => [],
        capture: () => ({ type }),
        async execute() {
          started.resolve()
          await release.promise
          return "pass"
        },
      })
      try {
        await LoopJob.execute([{ type }], {
          session,
          sessionID: session.id,
          step: 1,
          messages: [],
          lastUser,
          lastUserParts: [],
          abort: new AbortController().signal,
        })
        await started.promise
        expect(LoopJob.activeBackgroundCount(session.id, "unrelated-root")).toBe(0)
        expect(await RolloutQuery.releaseEvidence(session.id, rootID)).toBeUndefined()
      } finally {
        release.resolve()
        await LoopJob.settleDetached(session.id, new Set([rootID]))
      }
      expect(await RolloutQuery.releaseEvidence(session.id, rootID)).toMatchObject({ status: "completed" })
    }),
  ))

test("release evidence follows exact descendant roots beyond the activity window without recovery or body reads", () =>
  runtime.run(() =>
    fixture(async ({ session, rootID, call }) => {
      const child = await Session.create({ parentID: session.id })
      const owner = RolloutLifecycle.owner(child)
      for (let index = 0; index < 65; index++) {
        const segment = await RolloutLedger.beginSegment({
          owner,
          runID: `child-${String(index).padStart(2, "0")}`,
          input: {},
          parent: { owner: call.owner, runID: rootID, messageID: rootID },
        })
        await RolloutLedger.finishSegment(segment, "completed")
        await RolloutLedger.finishRun(owner, segment.runID, "completed")
      }
      await RolloutLedger.beginSegment({
        owner,
        runID: "unrelated",
        input: {},
        parent: { owner: call.owner, runID: "other-root", messageID: "other-root" },
      })
      const grandchild = await Session.create({ parentID: child.id })
      const segment = await RolloutLedger.beginSegment({
        owner: RolloutLifecycle.owner(grandchild),
        runID: "grandchild",
        input: {},
        parent: { owner, runID: "child-64", messageID: "child-64" },
      })
      await complete(call)
      await RolloutLedger.finishRun(call.owner, rootID, "completed")
      expect(await RolloutQuery.releaseEvidence(session.id, rootID)).toBeUndefined()
      await RolloutLedger.finishSegment(segment, "completed")
      await RolloutLedger.finishRun(segment.owner, segment.runID, "completed")
      using bodies = spyOn(Storage, "readBinary").mockRejectedValue(new Error("Must not hydrate artifacts"))
      using recovery = spyOn(RolloutJournal, "prepare").mockRejectedValue(new Error("Must not recover execution"))
      using history = spyOn(RolloutJournal, "events")
      expect(await RolloutQuery.releaseEvidence(session.id, rootID)).toMatchObject({ status: "completed" })
      expect(await RolloutQuery.releaseEvidence(session.id, "missing-root")).toBeUndefined()
      await expect(Storage.snapshot(() => RolloutQuery.releaseEvidence(session.id, rootID))).rejects.toThrow(
        "outside a transaction",
      )
      const stopped = new Error("Stopped evidence query")
      await expect(RolloutQuery.releaseEvidence(session.id, rootID, AbortSignal.abort(stopped))).rejects.toBe(stopped)
      expect(bodies).not.toHaveBeenCalled()
      expect(recovery).not.toHaveBeenCalled()
      expect(history).not.toHaveBeenCalled()
    }),
  ))

test("release evidence examines every process beyond the bounded activity display window", () =>
  runtime.run(() =>
    fixture(async ({ session, rootID, call }) => {
      const stream = await RolloutArtifact.writeText(call.owner, "", "application/vnd.synergy.process-stream;version=1")
      for (let index = 0; index < 257; index++) {
        await RolloutLedger.writeProcess({
          version: 1,
          id: `process-${String(index).padStart(3, "0")}`,
          owner: call.owner,
          runID: rootID,
          toolExecutionID: crypto.randomUUID(),
          started: 1,
          ended: 2,
          status: "completed",
          stream,
          exitCode: 0,
        })
      }
      await complete(call)
      await RolloutLedger.finishRun(call.owner, rootID, "completed")
      expect(await RolloutQuery.releaseEvidence(session.id, rootID)).toMatchObject({ status: "completed" })
      await RolloutLedger.writeProcess({
        version: 1,
        id: "process-999",
        owner: call.owner,
        runID: rootID,
        toolExecutionID: crypto.randomUUID(),
        started: 1,
        ended: 2,
        status: "interrupted",
        stream,
      })
      expect(await RolloutQuery.releaseEvidence(session.id, rootID)).toBeUndefined()
    }),
  ))
