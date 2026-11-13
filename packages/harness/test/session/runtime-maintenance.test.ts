import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { RuntimeMaintenance } from "../../src/storage/runtime-maintenance"
import { Storage } from "../../src/storage/storage"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { registerHarness } from "../../src/lifecycle/register"
import { Session } from "../../src/session"
import { SessionInbox } from "../../src/session/inbox"
import { SessionDrive } from "../../src/session/drive"
import { SessionManager } from "../../src/session/manager"
import { SessionResume } from "../../src/session/resume"
import { SessionLifecycle } from "../../src/session/lifecycle"
import { SessionInteraction } from "../../src/session/interaction"
import { SessionTransferGate } from "../../src/session/transfer-gate"
import { ScopeContext } from "../../src/scope/context"
import { Identifier } from "../../src/id/id"
import { testRuntime } from "../support/runtime"
import { storageTestRuntime } from "../support/storage-runtime"
import { tmpdir } from "../support/fixture"

function configure() {
  RuntimeMaintenance.configure({ required: ["fixture"] })
  RuntimeMaintenance.register("fixture", {
    version: 1,
    async suspend() {},
    async drain() {},
    async inspect() {
      return []
    },
    async release() {},
  })
}
const begin = () =>
  RuntimeMaintenance.begin({
    purpose: "organization-backup",
    requestID: "native-admission",
    actor: {
      kind: "system",
      subjectID: "operator",
      displayName: "Host operator",
      clientKind: "system",
      requestID: "native-admission",
    },
  })

test("native maintenance holds automatic and forced execution, new input and Continue while preserving accepted input", async () => {
  await using runtime = await testRuntime({ register: configure })
  await runtime.run(async () => {
    await using directory = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await directory.scope(),
      async fn() {
        const session = await Session.create({})
        const machine = await Session.create({ interaction: SessionInteraction.unattended("maintenance-test") })
        const input = {
          sessionID: session.id,
          messageID: Identifier.ascending("message"),
          model: { providerID: "test", modelID: "test" },
          parts: [{ type: "text" as const, text: "Retain the accepted task" }],
        }
        const queued = await SessionInbox.enqueueUser(input)
        await SessionInbox.enqueueUser({ ...input, sessionID: machine.id, messageID: Identifier.ascending("message") })
        await SessionLifecycle.pause({ sessionID: session.id, reason: "aborted" })
        const paused = (await Session.get(session.id)).paused
        const lease = await begin()
        try {
          await expect(SessionTransferGate.assert(session.id)).rejects.toBeInstanceOf(RuntimeMaintenance.Blocked)
          expect(await SessionDrive.request(machine.id, "maintenance-test", { force: true })).toBe(false)
          expect(SessionManager.hasPendingWake(machine.id)).toBe(false)
          let executed = false
          await expect(
            SessionManager.run(machine.id, async () => {
              executed = true
            }),
          ).rejects.toBeInstanceOf(RuntimeMaintenance.Blocked)
          expect(executed).toBe(false)
          expect((await SessionInbox.enqueueUser(input)).id).toBe(queued.id)
          const before = await SessionInbox.peekReady(session.id)
          await expect(
            SessionInbox.enqueueUser({ ...input, messageID: Identifier.ascending("message") }),
          ).rejects.toBeInstanceOf(RuntimeMaintenance.Blocked)
          expect(await SessionInbox.peekReady(session.id)).toEqual(before)
          await expect(
            SessionResume.request({ sessionID: session.id, requestID: "blocked-resume", pausedSince: paused?.since }),
          ).rejects.toThrow()
          expect((await Session.get(session.id)).paused).toEqual(paused)
        } finally {
          SessionDrive.reset()
          await RuntimeMaintenance.release(lease)
        }
        expect((await SessionInbox.peekReady(session.id)).map((item) => item.id)).toContain(queued.id)
      },
    })
  })
}, 15_000)

test("Continue rechecks a maintenance hold admitted while it waits for native execution to settle", async () => {
  await using runtime = await testRuntime({ register: configure })
  await runtime.run(async () => {
    await using directory = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await directory.scope(),
      async fn() {
        const session = await Session.create({})
        const queued = await SessionInbox.enqueueUser({
          sessionID: session.id,
          model: { providerID: "test", modelID: "test" },
          parts: [{ type: "text", text: "Preserve the original accepted root" }],
        })
        await SessionLifecycle.pause({ sessionID: session.id, reason: "aborted" })
        const paused = (await Session.get(session.id)).paused
        const entered = Promise.withResolvers<void>()
        const settle = Promise.withResolvers<void>()
        const wait = SessionManager.waitForIdle
        using barrier = spyOn(SessionManager, "waitForIdle").mockImplementation(async (...args) => {
          await wait(...args)
          entered.resolve()
          await settle.promise
        })
        const resume = SessionResume.request({
          sessionID: session.id,
          requestID: "racing-continue",
          pausedSince: paused?.since,
        }).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        )
        await entered.promise
        const lease = await begin()
        settle.resolve()
        try {
          expect(await resume).toHaveProperty("error")
          const current = await Session.get(session.id)
          expect(current.paused).toEqual(paused)
          expect(current.resume).toBeUndefined()
          expect((await SessionInbox.peekReady(session.id)).map((item) => item.id)).toEqual([queued.id])
        } finally {
          settle.resolve()
          await RuntimeMaintenance.release(lease)
        }
      },
    })
  })
}, 15_000)

test("base Harness registration protects a retained frozen operation without selecting maintenance owners", async () => {
  const source = await storageTestRuntime()
  const cold = await storageTestRuntime()
  await using directory = await tmpdir()
  const store = await TransactionalStore.open({
    backend: "sqlite",
    namespace: "maintenance-base",
    filename: path.join(directory.path, "authority.sqlite"),
  })
  const handle = { store, artifactDirectory: path.join(directory.path, "content") }
  try {
    await source.run(() =>
      Storage.provide(handle, async () => {
        configure()
        const lease = await begin()
        await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
      }),
    )
    await cold.run(() =>
      Storage.provide(handle, async () => {
        registerHarness()
        await expect(Storage.write(["canonical", "late"], { unsafe: true })).rejects.toBeInstanceOf(
          RuntimeMaintenance.Blocked,
        )
        await expect(RuntimeMaintenance.assertAdmission()).rejects.toBeInstanceOf(RuntimeMaintenance.Blocked)
        expect(await Storage.readMany([["canonical", "late"]])).toEqual([undefined])
      }),
    )
  } finally {
    await store.close()
    await source.close()
    await cold.close()
  }
})
