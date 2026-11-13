import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { registerWorkspace } from "../../src/register-workspace"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"

const actor = {
  kind: "system" as const,
  subjectID: "host-operator",
  displayName: "Host operator",
  clientKind: "system" as const,
  requestID: "workspace-native-admission",
}

test("a real physical claim acquired across maintenance admission is released before its first file effect", async () => {
  await using directory = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(directory.path, "claims") })
  await using runtime = await testRuntime({
    register() {
      RuntimeMaintenance.configure({ required: ["workspace-access"] })
      registerWorkspace(coordinator)
    },
  })
  await runtime.run(async () => {
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const acquire = coordinator.acquire.bind(coordinator)
    let delayed = false
    using held = spyOn(coordinator, "acquire").mockImplementation(async (input) => {
      const lease = await acquire(input)
      if (!delayed && input.kind === "task") {
        delayed = true
        entered.resolve()
        await resume.promise
      }
      return lease
    })
    const file = path.join(directory.path, "forbidden-effect")
    const writer = WorkspaceAccess.write([directory.path], () => Bun.write(file, "unexpected"))
    void writer.catch(() => {})
    await entered.promise
    const lease = await RuntimeMaintenance.begin({ purpose: "organization-backup", requestID: actor.requestID, actor })
    const draining = RuntimeMaintenance.drain(lease)
    try {
      expect((await coordinator.inspect()).some((claim) => claim.kind === "task")).toBe(true)
      resume.resolve()
      await expect(writer).rejects.toThrow("maintenance")
      await RuntimeMaintenance.freeze(lease, await draining)
      expect(await coordinator.inspect()).toHaveLength(0)
      expect(await Bun.file(file).exists()).toBe(false)
    } finally {
      resume.resolve()
      await writer.catch(() => {})
      await RuntimeMaintenance.release(lease)
    }
  })
})

test("an unacknowledged native claim release stays held until the same physical lease actually completes", async () => {
  await using directory = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(directory.path, "claims") })
  await using runtime = await testRuntime({
    register() {
      RuntimeMaintenance.configure({ required: ["workspace-access"] })
      registerWorkspace(coordinator)
    },
  })
  await runtime.run(async () => {
    const lost = new Error("Original native claim release acknowledgement is unavailable")
    const retryEntered = Promise.withResolvers<void>()
    const finishRetry = Promise.withResolvers<void>()
    const acquire = coordinator.acquire.bind(coordinator)
    let attempts = 0
    using fault = spyOn(coordinator, "acquire").mockImplementation(async (input) => {
      const lease = await acquire(input)
      return {
        ...lease,
        async release(beforeRelease) {
          if (input.kind !== "process") return lease.release(beforeRelease)
          if (++attempts === 1) throw lost
          retryEntered.resolve()
          await finishRetry.promise
          return lease.release(beforeRelease)
        },
      }
    })
    const process = await WorkspaceAccess.process([directory.path])
    await expect(process.release()).rejects.toBe(lost)
    const lease = await RuntimeMaintenance.begin({ purpose: "organization-backup", requestID: actor.requestID, actor })
    await expect(RuntimeMaintenance.drain(lease)).rejects.toBeInstanceOf(RuntimeMaintenance.Blocked)
    expect((await coordinator.inspect()).some((claim) => claim.id === process.id)).toBe(true)
    const retry = process.release()
    await retryEntered.promise
    const draining = RuntimeMaintenance.drain(lease)
    let drained = false
    void draining.then(
      () => {
        drained = true
      },
      () => {},
    )
    try {
      await Bun.sleep(20)
      expect(drained).toBe(false)
      finishRetry.resolve()
      await retry
      await RuntimeMaintenance.freeze(lease, await draining)
      expect(attempts).toBe(2)
      expect(await coordinator.inspect()).toHaveLength(0)
    } finally {
      finishRetry.resolve()
      await retry
      await RuntimeMaintenance.release(lease)
    }
  })
})

test("a resolved release while the native process lives remains pending and its original finalizer can retry after exit", async () => {
  await using directory = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(directory.path, "claims") })
  await using runtime = await testRuntime({
    register() {
      RuntimeMaintenance.configure({ required: ["workspace-access"] })
      registerWorkspace(coordinator)
    },
  })
  await runtime.run(async () => {
    const child = Bun.spawn(
      [process.execPath, "-e", "process.stdout.write('ready'); for await (const chunk of process.stdin) {}"],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    )
    const output = child.stdout.getReader()
    await output.read()
    output.releaseLock()
    let finalizations = 0
    const claim = await WorkspaceAccess.observeWrites(
      async () => ({
        async finish() {
          finalizations++
        },
      }),
      () => WorkspaceAccess.process([directory.path], undefined, { durable: true, retainAfterExit: true }),
    )
    try {
      await claim.bindProcess(child.pid)
      await claim.release()
      expect(finalizations).toBe(0)
      expect(await claim.isReleased!()).toBe(false)
      child.stdin.end()
      await child.exited
      await claim.release()
      expect(finalizations).toBe(1)
      expect(await claim.isReleased!()).toBe(true)
      await claim.release()
      expect(finalizations).toBe(1)
      const lease = await RuntimeMaintenance.begin({
        purpose: "organization-backup",
        requestID: actor.requestID,
        actor,
      })
      await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
      await RuntimeMaintenance.release(lease)
    } finally {
      child.stdin.end()
      if (child.exitCode === null) child.kill()
      await child.exited
      await (await coordinator.recover(claim.recovery!)).release()
    }
  })
}, 10_000)
