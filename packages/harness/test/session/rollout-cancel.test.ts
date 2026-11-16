import { expect, test } from "bun:test"
import { fixture } from "../support/rollout"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutLifecycle } from "../../src/session/rollout/lifecycle"
import { RolloutRecovery } from "../../src/session/rollout/recovery"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
import { Storage } from "../../src/storage/storage"
import { SessionInbox } from "../../src/session/inbox"
import { SessionManager } from "../../src/session/manager"
import { RolloutJournal } from "../../src/session/rollout/journal"
const runtime = await testRuntime()

test("cancel admission commits its receipt before signalling the matching execution", () =>
  runtime.run(() =>
    fixture(async ({ session, rootID, call }) => {
      const lease = SessionManager.acquire(session.id)!
      SessionManager.bindRootTask(lease, rootID)
      SessionManager.activate(lease)
      const controller = new AbortController()
      const stopped = Promise.withResolvers<void>()
      const timer = setTimeout(() => stopped.reject(new Error("cancel did not signal")), 2_000)
      lease.signal.addEventListener("abort", () => stopped.resolve(), { once: true })
      const key = ["cancel-receipt", session.id]
      const before = await RolloutJournal.head(call.owner)
      let settled = false
      const cancel = RolloutLifecycle.cancel(session.id, rootID, {
        signal: controller.signal,
        async validate() {
          expect(Storage.inTransaction()).toBeTrue()
          expect(lease.signal.aborted).toBeFalse()
        },
        async record(run) {
          expect(run.cancelRequestedAt).toBeNumber()
          expect(lease.signal.aborted).toBeFalse()
          await Storage.write(key, { rootID, requestedAt: run.cancelRequestedAt })
        },
      }).finally(() => {
        settled = true
      })
      try {
        await stopped.promise
        expect(await Storage.read(key)).toMatchObject({ rootID, requestedAt: expect.any(Number) })
        expect((await RolloutJournal.head(call.owner)).committed).toBeGreaterThan(before.committed)
        expect(settled).toBeFalse()
        expect((await RolloutLedger.getRun(call.owner, rootID)).status).toBe("running")
        controller.abort(new Error("transport ended after reception"))
        await SessionManager.release(lease, { requestNextWork: false })
        expect((await cancel).status).toBe("cancelled")
      } finally {
        clearTimeout(timer)
        await SessionManager.release(lease, { requestNextWork: false })
        await Promise.allSettled([cancel])
      }
    }),
  ))

test("a refused cancel admission rolls back its receipt and journal without signalling execution", () =>
  runtime.run(() =>
    fixture(async ({ session, rootID, call }) => {
      const lease = SessionManager.acquire(session.id)!
      SessionManager.bindRootTask(lease, rootID)
      const key = ["cancel-receipt", session.id]
      const original = await RolloutLedger.getRun(call.owner, rootID)
      const head = await RolloutJournal.head(call.owner)
      const refusal = new Storage.NotFoundError({ message: "host admission refused" })
      let rescue: Promise<boolean> | undefined
      const timer = setTimeout(() => {
        rescue = SessionManager.release(lease, { requestNextWork: false })
      }, 2_000)
      try {
        const cancelledAdmission = new AbortController()
        cancelledAdmission.abort(refusal)
        await expect(RolloutLifecycle.cancel(session.id, rootID, { signal: cancelledAdmission.signal })).rejects.toBe(
          refusal,
        )
        for (const failure of ["validate", "record", "guard"] as const) {
          await expect(
            RolloutLifecycle.cancel(session.id, rootID, {
              async validate() {
                if (failure === "validate") throw refusal
              },
              async record(run) {
                await Storage.write(key, { requestedAt: run.cancelRequestedAt })
                if (failure === "record") throw refusal
              },
              commitGuard() {
                if (failure === "guard") throw refusal
              },
            }),
          ).rejects.toBe(refusal)
          expect(lease.signal.aborted).toBeFalse()
          expect(await RolloutLedger.getRun(call.owner, rootID)).toEqual(original)
          expect(await RolloutJournal.head(call.owner)).toEqual(head)
          await expect(Storage.read(key)).rejects.toBeInstanceOf(Storage.NotFoundError)
        }
        SessionManager.bindRootTask(lease, "another-root")
        expect(
          (
            await RolloutLifecycle.cancel(session.id, rootID, {
              async record(run) {
                await Storage.write(key, { rootID: run.id })
              },
            })
          ).status,
        ).toBe("cancelled")
        expect(lease.signal.aborted).toBeFalse()
        expect(await Storage.read(key)).toEqual({ rootID })
      } finally {
        clearTimeout(timer)
        await rescue
        await SessionManager.release(lease, { requestNextWork: false })
      }
    }),
  ))

test("queued cancellation removes input and publishes unopened run evidence in one admission", () =>
  runtime.run(() =>
    fixture(async ({ session, call }) => {
      const item = await SessionInbox.enqueueUser({
        sessionID: session.id,
        model: { providerID: "test", modelID: "test" },
        parts: [{ type: "text", text: "cancel this saved task" }],
      })
      const key = ["cancel-receipt", session.id]
      const head = await RolloutJournal.head(call.owner)
      const refusal = new Error("receipt write refused")
      await expect(
        RolloutLifecycle.cancel(session.id, item.messageID, {
          async record(run) {
            expect((await SessionInbox.list(session.id)).some((current) => current.id === item.id)).toBeFalse()
            await Storage.write(key, { rootID: run.id })
            throw refusal
          },
        }),
      ).rejects.toBe(refusal)
      expect((await SessionInbox.list(session.id)).some((current) => current.id === item.id)).toBeTrue()
      await expect(RolloutLedger.getRun(call.owner, item.messageID)).rejects.toBeInstanceOf(Storage.NotFoundError)
      await expect(Storage.read(key)).rejects.toBeInstanceOf(Storage.NotFoundError)
      expect(await RolloutJournal.head(call.owner)).toEqual(head)
      const cancelled = await RolloutLifecycle.cancel(session.id, item.messageID, {
        async record(run) {
          await Storage.write(key, { rootID: run.id, requestedAt: run.cancelRequestedAt })
        },
      })
      expect(cancelled.status).toBe("cancelled")
      expect(await Storage.read(key)).toEqual({ rootID: item.messageID, requestedAt: cancelled.cancelRequestedAt })
      expect((await SessionInbox.list(session.id)).some((current) => current.id === item.id)).toBeFalse()
      await RolloutRecovery.owner(call.owner)
      expect(await RolloutLifecycle.cancel(session.id, item.messageID)).toEqual(cancelled)
    }),
  ))

test("terminal cancel admission commits new host receipts without changing prior evidence", () =>
  runtime.run(() =>
    fixture(async ({ session, rootID }) => {
      const cancelled = await RolloutLifecycle.cancel(session.id, rootID)
      const key = ["cancel-receipt", session.id]
      const controller = new AbortController()
      const refusal = new Error("connection lost before commit")
      await expect(
        RolloutLifecycle.cancel(session.id, rootID, {
          signal: controller.signal,
          async record(run) {
            await Storage.write(key, { rootID: run.id })
            controller.abort(refusal)
          },
        }),
      ).rejects.toBe(refusal)
      await expect(Storage.read(key)).rejects.toBeInstanceOf(Storage.NotFoundError)
      expect(
        await RolloutLifecycle.cancel(session.id, rootID, {
          async record(run) {
            await Storage.write(key, { rootID: run.id })
          },
        }),
      ).toEqual(cancelled)
      expect(await Storage.read(key)).toEqual({ rootID })
      await expect(Storage.transaction(() => RolloutLifecycle.cancel(session.id, rootID))).rejects.toThrow(
        "commit boundary",
      )
    }),
  ))

test("abandoning after recovery settles an interrupted run with an idempotent cancellation", () =>
  runtime.run(() =>
    fixture(async ({ session, rootID, call }) => {
      await RolloutLedger.beginSegment({ owner: call.owner, runID: rootID, input: {} })
      await RolloutRecovery.owner(call.owner)
      const result = await RolloutLifecycle.cancel(session.id, rootID)
      expect(result.status).toBe("cancelled")
      expect(result.cancelRequestedAt).toBeNumber()
      expect(await RolloutLifecycle.cancel(session.id, rootID)).toEqual(result)
      await expect(RolloutLedger.beginSegment({ owner: call.owner, runID: rootID, input: {} })).rejects.toThrow(
        "cancelled",
      )
    }),
  ))

test("cancellation settles orphaned calls after the execution owner has released", () =>
  runtime.run(async () => {
    await fixture(async ({ session, rootID, call }) => {
      expect((await RolloutLedger.calls(call.owner, rootID))[0]?.status).toBe("running")
      const cancelled = await RolloutLifecycle.cancel(session.id, rootID)
      expect(cancelled.status).toBe("cancelled")
      const calls = await RolloutLedger.calls(call.owner, rootID)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ id: call.id, status: "interrupted" })
      expect(await RolloutLifecycle.cancel(session.id, rootID)).toEqual(cancelled)
      expect(await RolloutLedger.calls(call.owner, rootID)).toEqual(calls)
    })
  }))

test("cancel reception survives failed drainage and recovery retains honest interrupted call evidence", () =>
  runtime.run(async () => {
    await fixture(async ({ session, rootID, call }) => {
      await RolloutLedger.beginSegment({ owner: call.owner, runID: rootID, input: {} })
      const key = ["cancel-receipt", session.id]
      await expect(
        RolloutLifecycle.cancel(session.id, rootID, {
          async record(run) {
            await Storage.write(key, { rootID, requestedAt: run.cancelRequestedAt })
          },
        }),
      ).rejects.toThrow("active segments")
      expect((await RolloutLedger.calls(call.owner, rootID))[0]?.status).toBe("running")
      const receipt = await Storage.read(key)
      expect(receipt).toMatchObject({ rootID, requestedAt: expect.any(Number) })
      await RolloutRecovery.owner(call.owner)
      expect((await RolloutLedger.getRun(call.owner, rootID)).status).toBe("cancelled")
      expect((await RolloutLedger.calls(call.owner, rootID))[0]?.status).toBe("interrupted")
      expect(await Storage.read(key)).toEqual(receipt)
    })
  }))

afterRuntimeTests(() => runtime.close())
