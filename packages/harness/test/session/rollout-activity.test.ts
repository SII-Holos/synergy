import { afterAll, expect, spyOn, test } from "bun:test"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { fixture } from "../support/rollout"
import { testRuntime } from "../support/runtime"
import { Session } from "../../src/session"
import { SessionManager } from "../../src/session/manager"
import { RolloutQuery } from "../../src/session/rollout/query"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutLifecycle } from "../../src/session/rollout/lifecycle"
import { RolloutProcess } from "../../src/session/rollout/process"
import { RolloutArtifact } from "../../src/session/rollout/artifact"
import { RolloutJournal } from "../../src/session/rollout/journal"
import { RolloutSchema } from "../../src/session/rollout/schema"
import { ProcessRegistry } from "../../src/process/registry"
import { Storage } from "../../src/storage/storage"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test("activity distinguishes a live owned process, observed exit and interrupted evidence with unknown exit", () =>
  runtime.run(() =>
    fixture(async ({ session, rootID, call }) => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
      const closed = once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>
      const proc = ProcessRegistry.create({ command: "activity fixture", child })
      const writer = await RolloutProcess.open(
        { owner: call.owner, runID: rootID, toolExecutionID: crypto.randomUUID(), processID: proc.id },
        async (error) => {
          throw error
        },
      )
      let finished = false
      try {
        const running = await RolloutQuery.activity(session.id, rootID)
        expect(running).toMatchObject({
          run: { id: rootID, status: "running", active: false },
          runsObserved: 1,
          activeExecutions: 0,
          processes: { active: 1, exited: 0, unknown: 0 },
          scope: "recorded_subtree",
          truncated: false,
        })
        child.kill("SIGTERM")
        const [code, signal] = await closed
        await writer.finish({ interrupted: true, exitCode: code, signal, pid: child.pid })
        finished = true
        ProcessRegistry.markExited(proc, code, signal)
        await RolloutLifecycle.cancel(session.id, rootID)
        const ended = await RolloutQuery.activity(session.id, rootID)
        expect(ended).toMatchObject({
          run: { status: "cancelled", cancelRequestedAt: expect.any(Number), active: false },
          processes: { active: 0, exited: 1, unknown: 0 },
          scope: "recorded_subtree",
          truncated: false,
        })
        const [record] = await RolloutLedger.processes(call.owner, rootID)
        await RolloutLedger.writeProcess({ ...record, id: "unconfirmed-exit", exitCode: null, signal: null })
        expect((await RolloutQuery.activity(session.id, rootID))?.processes).toEqual({
          active: 0,
          exited: 1,
          unknown: 1,
        })
        await RolloutLedger.resumeRun(call.owner, rootID)
        const lease = SessionManager.acquire(session.id)!
        SessionManager.bindRootTask(lease, rootID)
        try {
          const resumed = await RolloutQuery.activity(session.id, rootID)
          expect(resumed).toMatchObject({ run: { status: "running", active: true }, activeExecutions: 1 })
          expect(resumed?.run.cancelRequestedAt).toBeUndefined()
        } finally {
          await SessionManager.release(lease, { requestNextWork: false })
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
        await closed
        if (!finished) await writer.finish({ interrupted: true, exitCode: null, signal: null, pid: child.pid })
        ProcessRegistry.remove(proc.id)
      }
    }),
  ))

async function evidence(owner: RolloutSchema.Owner, runID: string, id: string, exited: boolean) {
  const stream = await RolloutArtifact.writeText(owner, "", "application/vnd.synergy.process-stream;version=1")
  await RolloutLedger.writeProcess({
    version: 1,
    id,
    owner,
    runID,
    toolExecutionID: crypto.randomUUID(),
    started: 1,
    ended: 2,
    status: "interrupted",
    stream,
    ...(exited ? { exitCode: 0, signal: null } : {}),
  })
}

test("activity follows recorded parent roots without loading bodies or recovering execution", () =>
  runtime.run(() =>
    fixture(async ({ session, rootID, call }) => {
      const child = await Session.create({ parentID: session.id })
      const childOwner = RolloutLifecycle.owner(child)
      await RolloutLedger.beginSegment({
        owner: childOwner,
        runID: "child",
        input: {},
        parent: { owner: call.owner, runID: rootID, messageID: rootID },
      })
      await RolloutLedger.beginSegment({
        owner: childOwner,
        runID: "unrelated",
        input: {},
        parent: { owner: call.owner, runID: "other-root", messageID: "other-message" },
      })
      const grandchild = await Session.create({ parentID: child.id })
      const grandchildOwner = RolloutLifecycle.owner(grandchild)
      await RolloutLedger.beginSegment({
        owner: grandchildOwner,
        runID: "grandchild",
        input: {},
        parent: { owner: childOwner, runID: "child", messageID: "child" },
      })
      await evidence(call.owner, rootID, "root-unknown", false)
      await evidence(childOwner, "child", "child-exited", true)
      await evidence(childOwner, "unrelated", "unrelated-unknown", false)
      await evidence(grandchildOwner, "grandchild", "grandchild-unknown", false)
      using bodies = spyOn(Storage, "readBinary").mockRejectedValue(new Error("Must not hydrate artifacts"))
      using admission = spyOn(RolloutJournal, "prepare").mockRejectedValue(new Error("Must not recover execution"))
      using history = spyOn(RolloutJournal, "events")
      const activity = await RolloutQuery.activity(session.id, rootID)
      expect(activity).toMatchObject({
        runsObserved: 3,
        activeExecutions: 0,
        processes: { active: 0, exited: 1, unknown: 2 },
        scope: "recorded_subtree",
        truncated: false,
      })
      expect(bodies).not.toHaveBeenCalled()
      expect(admission).not.toHaveBeenCalled()
      expect(history).not.toHaveBeenCalled()
      expect(await RolloutQuery.activity(session.id, "missing-root")).toBeUndefined()
      await expect(Storage.snapshot(() => RolloutQuery.activity(session.id, rootID))).rejects.toThrow(
        "outside a transaction",
      )
      const controller = new AbortController()
      const refusal = new Error("Stopped query")
      controller.abort(refusal)
      await expect(RolloutQuery.activity(session.id, rootID, controller.signal)).rejects.toBe(refusal)
    }),
  ))

test("activity reports truncated descendants when its owner and run window is exhausted", () =>
  runtime.run(() =>
    fixture(async ({ session, rootID, call }) => {
      for (let index = 0; index < 65; index++) {
        const child = await Session.create({ parentID: session.id })
        const owner = RolloutLifecycle.owner(child)
        await RolloutLedger.beginSegment({
          owner,
          runID: "child",
          input: {},
          parent: { owner: call.owner, runID: rootID, messageID: rootID },
        })
      }
      expect(await RolloutQuery.activity(session.id, rootID)).toMatchObject({
        runsObserved: 64,
        scope: "recorded_subtree",
        truncated: true,
        processes: { active: 0, exited: 0, unknown: 0 },
      })
    }),
  ))

test("activity bounds process enumeration and refuses corrupt or unsettled evidence", () =>
  runtime.run(() =>
    fixture(async ({ session, rootID, call }) => {
      const stream = await RolloutArtifact.writeText(call.owner, "", "application/vnd.synergy.process-stream;version=1")
      for (let index = 0; index < 257; index++)
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
      const result = await RolloutQuery.activity(session.id, rootID)
      expect(result).toMatchObject({ processes: { active: 0, exited: 256, unknown: 0 }, truncated: true })
      const root = RolloutArtifact.root(call.owner)
      const key = [...root, "runs", rootID, "processes", "process-000"]
      const original = await Storage.read<RolloutSchema.ProcessRecord>(key)
      await Storage.write(key, { ...original, runID: "foreign-run" })
      await expect(RolloutQuery.activity(session.id, rootID)).rejects.toThrow("identity")
      await Storage.write(key, original)
      const head = await RolloutJournal.head(call.owner)
      await Storage.write([...root, "journal", "head"], { ...head, allocated: head.allocated + 1 })
      await expect(RolloutQuery.activity(session.id, rootID)).rejects.toThrow("recovery")
      expect(await RolloutJournal.head(call.owner)).toEqual({ ...head, allocated: head.allocated + 1 })
    }),
  ))
