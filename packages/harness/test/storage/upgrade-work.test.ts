import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()
import path from "node:path"
import { tmpdir } from "../support/fixture"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { Storage } from "../../src/storage/storage"
import { expect, test } from "bun:test"
import { UpgradeWork } from "../../src/storage/upgrade-work"

test("pausing background preparation preserves foreground admission and supports cancellation", () =>
  runtime.run(async () => {
    await UpgradeWork.control("pause")
    const controller = new AbortController()
    let passed = false
    const pending = UpgradeWork.run({ background: true, signal: controller.signal }, async () => {
      await UpgradeWork.checkpoint()
      passed = true
    })
    await UpgradeWork.run({ background: false }, () => UpgradeWork.checkpoint())
    expect(passed).toBe(false)
    controller.abort()
    await expect(pending).rejects.toThrow()
    await UpgradeWork.control("resume")
    await UpgradeWork.run({ background: true }, () => UpgradeWork.checkpoint())
  }))

test("capacity checks reserve room before allocating a migration chunk", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    const store = await TransactionalStore.open({
      backend: "sqlite",
      namespace: crypto.randomUUID(),
      filename: path.join(tmp.path, "capacity"),
    })
    try {
      await Storage.provide({ store, artifactDirectory: tmp.path }, async () => {
        await expect(
          UpgradeWork.run({ background: false }, () => UpgradeWork.checkpoint(Number.MAX_SAFE_INTEGER / 4)),
        ).rejects.toThrow("Insufficient free space")
        expect((await UpgradeWork.status()).pauseReason).toBe("disk")
      })
    } finally {
      await store.close()
    }
  }))

test("foreground priority cancels an unrelated background owner without cancelling its own import", () =>
  runtime.run(async () => {
    const other = UpgradeWork.controller(true, "other")
    const requested = UpgradeWork.controller(true, "requested")
    const release = UpgradeWork.priority("requested")
    try {
      expect(other.controller.signal.aborted).toBe(true)
      expect(requested.controller.signal.aborted).toBe(false)
      await UpgradeWork.control("pause")
      expect(requested.controller.signal.aborted).toBe(false)
    } finally {
      release()
      other.dispose()
      requested.dispose()
      await UpgradeWork.control("resume")
    }
  }))

test("cancelling parallel I/O keeps one retryable cancellation outcome", () =>
  runtime.run(async () => {
    const controller = new AbortController()
    await expect(
      UpgradeWork.run({ background: true, signal: controller.signal }, async () => {
        controller.abort(new DOMException("yield to foreground", "AbortError"))
        throw new AggregateError([controller.signal.reason, controller.signal.reason])
      }),
    ).rejects.toMatchObject({ name: "AbortError", message: "yield to foreground" })
  }))

test("shutdown refuses new preparation before the transport finishes closing", () =>
  runtime.run(() => {
    UpgradeWork.stop()
    const task = UpgradeWork.controller(false, "late-request")
    try {
      expect(task.controller.signal.aborted).toBe(true)
    } finally {
      task.dispose()
      UpgradeWork.activity(() => false)
    }
  }))

afterRuntimeTests(() => runtime.close())
