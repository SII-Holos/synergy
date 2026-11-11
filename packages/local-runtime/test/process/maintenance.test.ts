import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { text } from "node:stream/consumers"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"
import { registerWorkspace } from "../../src/register-workspace"
import { OwnedProcess } from "../../src/process/owned-process"
import { DarwinJob } from "../../src/process/darwin-job"
import { LinuxTree } from "../../src/process/linux-tree"

const nativeTest = test.skipIf(!["darwin", "linux"].includes(process.platform))
const actor = {
  kind: "system" as const, subjectID: "host-operator", displayName: "Host operator",
  clientKind: "system" as const, requestID: "native-process-maintenance",
}

async function processFixture(coordinator: WorkspaceCoordinator, directory: string, owner: string) {
  const lease = await coordinator.acquire({ id: crypto.randomUUID(), owner, ancestors: [], kind: "process", roots: [directory] })
  const output = path.join(directory, crypto.randomUUID())
  const owned = await OwnedProcess.prepare({
    command: process.execPath,
    args: ["-e", "process.stdout.write('ready'); for await (const chunk of process.stdin) {} await Bun.write(process.argv[1], 'native-tail')", output],
    cwd: directory, env: {}, ownership: lease,
  })
  const started = new Promise<void>((resolve) => owned.child.stdout.once("data", () => resolve()))
  const streams = Promise.all([text(owned.child.stdout), text(owned.child.stderr)])
  await owned.activate()
  await started
  return {
    owned, output,
    async finish() { owned.child.stdin.end(); await owned.completion; await streams },
    async [Symbol.asyncDispose]() { await owned.stop(); await streams },
  }
}

nativeTest("native maintenance waits for a real owned process tail, output and claim release without killing or replaying it", async () => {
  await using directory = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(directory.path, "claims") })
  await using runtime = await testRuntime({ register() {
    RuntimeMaintenance.configure({ required: ["sessions"] })
    registerWorkspace(coordinator)
  } })
  await runtime.run(async () => {
    await using native = await processFixture(coordinator, directory.path, JSON.stringify([runtime.host.root, "native-session"]))
    const lease = await RuntimeMaintenance.begin({ purpose: "organization-backup", requestID: actor.requestID, actor })
    const cancellation = new AbortController()
    let draining = RuntimeMaintenance.drain(lease, { signal: cancellation.signal })
    try {
      expect(await Promise.race([draining.then(() => "drained"), Bun.sleep(30).then(() => "pending")])).toBe("pending")
      expect(await Bun.file(native.output).exists()).toBe(false)
      const reason = new Error("Stop waiting while the native command keeps its original lifetime")
      cancellation.abort(reason)
      await expect(draining).rejects.toBe(reason)
      expect(await Bun.file(native.output).exists()).toBe(false)
      draining = RuntimeMaintenance.drain(lease)
    } finally {
      await native.finish()
    }
    await RuntimeMaintenance.freeze(lease, await draining)
    expect(await Bun.file(native.output).text()).toBe("native-tail")
    expect(native.owned.child.exitCode).toBe(0)
    expect(await coordinator.inspect()).toHaveLength(0)
    const late = await coordinator.acquire({ id: crypto.randomUUID(), owner: "late-process", ancestors: [], kind: "process", roots: [directory.path] })
    const unexpected = path.join(directory.path, "unexpected-effect")
    try {
      await expect(OwnedProcess.prepare({
        command: process.execPath, args: ["-e", "await Bun.write(process.argv[1], 'unexpected')", unexpected],
        cwd: directory.path, env: {}, ownership: late,
      })).rejects.toThrow()
      expect(await Bun.file(unexpected).exists()).toBe(false)
    } finally { await late.release() }
    await RuntimeMaintenance.release(lease)
    expect(await Bun.file(native.output).text()).toBe("native-tail")
  })
}, 20_000)

nativeTest("a supervisor start with an unconfirmed native acknowledgement cannot become a successful drain by clearing local handles", async () => {
  await using directory = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(directory.path, "claims") })
  await using runtime = await testRuntime({ register() {
    RuntimeMaintenance.configure({ required: ["sessions"] })
    registerWorkspace(coordinator)
  } })
  await runtime.run(async () => {
    const nativeHost = process.platform === "darwin" ? DarwinJob : LinuxTree
    const start = nativeHost.start
    let retained: { remove(): Promise<void> } | undefined
    const lost = new Error("The native supervisor start acknowledgement was lost")
    using fault = spyOn(nativeHost, "start").mockImplementation(async (...input) => {
      retained = await start(...input)
      throw lost
    })
    const claim = await coordinator.acquire({ id: crypto.randomUUID(), owner: JSON.stringify([runtime.host.root, "unknown-start"]), ancestors: [], kind: "process", roots: [directory.path] })
    try {
      await expect(OwnedProcess.prepare({ command: process.execPath, args: ["-e", "process.stdin.resume()"], cwd: directory.path, env: {}, ownership: claim })).rejects.toBe(lost)
    } finally { await retained?.remove() }
    expect(await coordinator.inspect()).toHaveLength(0)
    const lease = await RuntimeMaintenance.begin({ purpose: "organization-backup", requestID: actor.requestID, actor })
    await expect(RuntimeMaintenance.drain(lease)).rejects.toThrow("native")
    await expect(RuntimeMaintenance.release(lease)).rejects.toThrow()
    expect((await RuntimeMaintenance.status())?.phase).toBe("draining")
  })
}, 20_000)

nativeTest.each(["canonical", "alias"] as const)("an empty registry cannot certify a previous %s Home writer retained by the native coordinator", async (location) => {
  await using directory = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(directory.path, "claims") })
  await using runtime = await testRuntime({ register() {
    RuntimeMaintenance.configure({ required: ["sessions"] })
    registerWorkspace(coordinator)
  } })
  await runtime.run(async () => {
    const ownerHome = location === "alias" ? path.join(directory.path, "home-alias") : runtime.host.root
    if (location === "alias") await fs.symlink(runtime.host.root, ownerHome, process.platform === "win32" ? "junction" : "dir")
    await using prior = await RuntimeContext.exit(() => processFixture(coordinator, directory.path, JSON.stringify([ownerHome, "prior-native-session"])))
    const lease = await RuntimeMaintenance.begin({ purpose: "organization-backup", requestID: actor.requestID, actor })
    try {
      await expect(RuntimeMaintenance.drain(lease)).rejects.toThrow("native")
      expect((await RuntimeMaintenance.status())?.phase).toBe("draining")
      expect(await Bun.file(prior.output).exists()).toBe(false)
    } finally { await prior.finish() }
    await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
    expect(await Bun.file(prior.output).text()).toBe("native-tail")
    await RuntimeMaintenance.release(lease)
    expect(await coordinator.inspect()).toHaveLength(0)
  })
}, 20_000)
