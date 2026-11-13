import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { RuntimeMaintenance } from "../../src/storage/runtime-maintenance"
import { Storage } from "../../src/storage/storage"
import { Session } from "../../src/session"
import { SessionManager } from "../../src/session/manager"
import { LoopJob } from "../../src/session/loop-job"
import { RolloutRecordingError } from "../../src/session/rollout/error"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { testRuntime } from "../support/runtime"
import { storageTestRuntime } from "../support/storage-runtime"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { storageTestOptions } from "../support/storage-backends"

const actor = {
  kind: "system" as const,
  subjectID: "host-operator",
  displayName: "Host operator",
  clientKind: "system" as const,
  requestID: "background-maintenance",
}

test("native maintenance admits turn finalizers before draining their detached writes and never replays them on release", async () => {
  await using runtime = await testRuntime({
    register() {
      RuntimeMaintenance.configure({ required: ["sessions"] })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      async fn() {
        const session = await Session.create()
        const entered = Promise.withResolvers<void>()
        const started = Promise.withResolvers<void>()
        const finish = Promise.withResolvers<void>()
        const type = "maintenance-native-tail"
        let executions = 0
        let cancelled = false
        LoopJob.register({
          type,
          phase: "post",
          blocking: false,
          detached: true,
          collect: () => [],
          capture: (_context, instance) => instance,
          async execute(_payload, signal) {
            executions++
            started.resolve()
            await finish.promise
            cancelled = signal.aborted
            await Storage.write(["maintenance-native-tail", "saved"], { executions })
            return "pass"
          },
        })
        const turn = SessionManager.run(session.id, async (lease) => {
          entered.resolve()
          await new Promise<void>((resolve) => {
            if (lease.signal.aborted) resolve()
            else lease.signal.addEventListener("abort", () => resolve(), { once: true })
          })
          expect(LoopJob.scheduleDetached({ type, sessionID: session.id, rootID: "original-root" })).toBe(true)
        })
        await entered.promise
        const lease = await RuntimeMaintenance.begin({
          purpose: "organization-backup",
          requestID: actor.requestID,
          actor,
        })
        const cancellation = new AbortController()
        let draining = RuntimeMaintenance.drain(lease, { signal: cancellation.signal })
        try {
          await started.promise
          expect(await Promise.race([draining.then(() => "drained"), Bun.sleep(30).then(() => "pending")])).toBe(
            "pending",
          )
          expect(LoopJob.activeBackgroundCount(session.id)).toBe(1)
          const reason = new Error("Stop waiting without cancelling the native save")
          cancellation.abort(reason)
          await expect(draining).rejects.toBe(reason)
          expect(LoopJob.activeBackgroundCount(session.id)).toBe(1)
          draining = RuntimeMaintenance.drain(lease)
        } finally {
          finish.resolve()
          await turn
        }
        const receipt = await draining
        expect(LoopJob.scheduleDetached({ type, sessionID: session.id, rootID: "late-root" })).toBe(false)
        await RuntimeMaintenance.freeze(lease, receipt)
        expect(await Storage.read(["maintenance-native-tail", "saved"])).toEqual({ executions: 1 })
        expect(cancelled).toBe(false)
        expect(LoopJob.activeBackgroundCount()).toBe(0)
        await RuntimeMaintenance.release(lease)
        expect(executions).toBe(1)
        expect(LoopJob.scheduleDetached({ type, sessionID: session.id, rootID: "new-root" })).toBe(true)
        await LoopJob.settleDetached(session.id)
        expect(executions).toBe(2)
      },
    }),
  )
}, 15_000)

test("a fresh Runtime context cannot execute a detached native effect through a retained frozen namespace", async () => {
  const directory = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "loop-job-frozen-"))
  const store = await TransactionalStore.open(
    storageTestOptions({ namespace: crypto.randomUUID(), filename: path.join(directory, "authority.sqlite") }),
  )
  let runtime = await storageTestRuntime()
  const run = <T>(body: () => Promise<T>) =>
    runtime.run(() => Storage.provide({ store, artifactDirectory: path.join(directory, "content") }, body))
  try {
    await run(async () => {
      RuntimeMaintenance.configure({ required: ["loop-jobs"] })
      LoopJob.registerMaintenanceOwner()
      const lease = await RuntimeMaintenance.begin({
        purpose: "organization-backup",
        requestID: actor.requestID,
        actor,
      })
      await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
    })
    await runtime.close()
    runtime = await storageTestRuntime()
    await run(async () => {
      RuntimeMaintenance.configure({ required: ["loop-jobs"] })
      LoopJob.registerMaintenanceOwner()
      const type = "maintenance-cold-native-effect"
      let executions = 0
      LoopJob.register({
        type,
        phase: "post",
        blocking: false,
        detached: true,
        collect: () => [],
        capture: (_context, instance) => instance,
        async execute() {
          executions++
          return "pass"
        },
      })
      LoopJob.scheduleDetached({ type, sessionID: "cold-session", rootID: "cold-root" })
      await LoopJob.settleDetached("cold-session")
      expect(executions).toBe(0)
      expect(LoopJob.activeBackgroundCount()).toBe(0)
      expect((await RuntimeMaintenance.status())?.phase).toBe("frozen")
    })
  } finally {
    await runtime.close()
    await store.close()
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("native background admission stays closed while other owners are still releasing", async () => {
  const releasing = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  await using runtime = await testRuntime({
    register() {
      RuntimeMaintenance.configure({ required: ["sessions", "release-barrier"] })
      RuntimeMaintenance.register("release-barrier", {
        version: 1,
        order: 0,
        async suspend() {},
        async drain() {},
        async inspect() {
          return []
        },
        async release() {
          releasing.resolve()
          await finish.promise
        },
      })
    },
  })
  await runtime.run(async () => {
    let executions = 0
    const type = "maintenance-release-admission"
    LoopJob.register({
      type,
      phase: "post",
      blocking: false,
      detached: true,
      collect: () => [],
      capture: (_context, instance) => instance,
      async execute() {
        executions++
        return "pass"
      },
    })
    const lease = await RuntimeMaintenance.begin({ purpose: "organization-backup", requestID: actor.requestID, actor })
    await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
    const released = RuntimeMaintenance.release(lease)
    try {
      await releasing.promise
      expect((await RuntimeMaintenance.status())?.phase).toBe("releasing")
      expect(LoopJob.scheduleDetached({ type, sessionID: "release-session", rootID: "before-release" })).toBe(false)
    } finally {
      finish.resolve()
      await released
      await LoopJob.settleDetached("release-session")
    }
    expect(executions).toBe(0)
    expect(LoopJob.scheduleDetached({ type, sessionID: "release-session", rootID: "after-release" })).toBe(true)
    await LoopJob.settleDetached("release-session")
    expect(executions).toBe(1)
  })
}, 15_000)

test("maintenance keeps detached recording failures blocking even after ordinary turn settlement consumes its error", async () => {
  await using runtime = await testRuntime({
    register() {
      RuntimeMaintenance.configure({ required: ["sessions"] })
    },
  })
  await runtime.run(async () => {
    const started = Promise.withResolvers<void>()
    const fail = Promise.withResolvers<void>()
    const type = "maintenance-recording-failure"
    const error = new RolloutRecordingError({ message: "The detached native receipt could not be saved" })
    LoopJob.register({
      type,
      phase: "post",
      blocking: false,
      detached: true,
      collect: () => [],
      capture: (_context, instance) => instance,
      async execute() {
        started.resolve()
        await fail.promise
        throw error
      },
    })
    expect(LoopJob.scheduleDetached({ type, sessionID: "recording-session", rootID: "recording-root" })).toBe(true)
    await started.promise
    const lease = await RuntimeMaintenance.begin({ purpose: "organization-backup", requestID: actor.requestID, actor })
    const draining = RuntimeMaintenance.drain(lease)
    try {
      expect(await Promise.race([draining.then(() => "drained"), Bun.sleep(30).then(() => "pending")])).toBe("pending")
      fail.resolve()
      await expect(draining).rejects.toThrow("recording")
      await expect(LoopJob.settleDetached("recording-session")).rejects.toBe(error)
      await expect(RuntimeMaintenance.drain(lease)).rejects.toThrow("recording")
      await expect(RuntimeMaintenance.release(lease)).rejects.toThrow()
      expect((await RuntimeMaintenance.status())?.phase).toBe("draining")
    } finally {
      fail.resolve()
      await LoopJob.settleDetached("recording-session").catch(() => {})
    }
  })
}, 15_000)
