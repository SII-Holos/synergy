import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentControl } from "@ericsanchezok/synergy-harness/environment/control"
import { EnvironmentExecution } from "@ericsanchezok/synergy-harness/environment/execution"
import { ExecutionProtocol } from "@ericsanchezok/synergy-harness/environment/executor"
import { EnvironmentProviders } from "@ericsanchezok/synergy-harness/environment/provider"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { WorkspaceBinding, WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceBlobs, WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { WorkspaceMounts } from "@ericsanchezok/synergy-harness/workspace/mount"
import { testRuntime, testWorkspaceCoordinator } from "../support/runtime"

async function bindDirectory(project: Awaited<ReturnType<typeof tmpdir>>) {
  const scope = await project.scope()
  const root = path.join(project.path, "folder")
  await fs.mkdir(root)
  await Bun.write(path.join(root, "original.txt"), "original")
  const workspace = await WorkspaceBinding.register(scope.id, root)
  const environment = await Environment.bind({ scopeID: scope.id, ownerID: "owner", provider: "native", spec: {} })
  const mounted = await WorkspaceMounts.attach({
    scopeID: scope.id,
    workspaceID: workspace.id,
    environmentID: environment.id,
    directory: root,
  })
  return { scopeID: scope.id, root, environment, mounted }
}

function onceCommand(home: string, root: string, marker: string, objectRoot?: string): ExecutionProtocol.Command {
  return {
    command: process.execPath,
    args: [
      "-e",
      [
        'import { appendFile } from "node:fs/promises"',
        `await appendFile(${JSON.stringify(marker)}, "once\\n")`,
        'await Bun.write("execution.txt", "native data\\n")',
        ...(objectRoot
          ? [
              `await Bun.write(${JSON.stringify(path.join(objectRoot, "object.bin"))}, new Uint8Array([0, 1, 127, 128, 255]))`,
            ]
          : []),
        'process.stdout.write("finished\\n")',
        'process.stderr.write("diagnostic\\n")',
      ].join("\n"),
    ],
    cwd: root,
    env: { HOME: home, USERPROFILE: home, SYNERGY_HOME: home, SYNERGY_TEST_HOME: home },
    useRoots: [root, path.dirname(marker), ...(objectRoot ? [objectRoot] : [])],
  }
}

async function terminal(id: string, scopeID: string) {
  const deadline = Date.now() + 10_000
  for (;;) {
    const info = await EnvironmentExecution.reconcile(id, scopeID)
    if (info.status && ExecutionProtocol.terminal(info.status)) return info
    if (Date.now() >= deadline) throw new Error(`Native execution did not drain: ${JSON.stringify(info)}`)
    await Bun.sleep(20)
  }
}

async function output(id: string, scopeID: string) {
  const chunks = await EnvironmentExecution.output(id, scopeID)
  const text = (stream: "stdout" | "stderr") =>
    Buffer.concat(
      chunks.filter((chunk) => chunk.stream === stream).map((chunk) => Buffer.from(chunk.data, "base64")),
    ).toString()
  return { stdout: text("stdout"), stderr: text("stderr") }
}

async function replaceDirectory(root: string) {
  await fs.rename(root, root + "-previous")
  await fs.mkdir(root)
  await Bun.write(path.join(root, "replacement.txt"), "replacement")
}

test("startup recovers a legacy unsaved native result after directory replacement without rerunning it", async () => {
  await using home = await tmpdir()
  await using project = await tmpdir()
  await using first = await testRuntime({ home: home.path })
  const id = "legacy-unsaved-directory"
  const marker = path.join(project.path, "runs.txt")
  const fixture = await first.run(async () => {
    const fixture = await bindDirectory(project)
    await EnvironmentExecution.start({
      id,
      scopeID: fixture.scopeID,
      environmentID: fixture.environment.id,
      command: onceCommand(first.host.home, fixture.root, marker),
      workspaces: [WorkspaceMounts.reference(fixture.mounted)],
    })
    const execution = await terminal(id, fixture.scopeID)
    expect(execution.status).toMatchObject({
      exitCode: 0,
      effectsStarted: true,
      treeDrained: true,
      streamsDrained: true,
    })
    expect(await output(id, fixture.scopeID)).toEqual({ stdout: "finished\n", stderr: "diagnostic\n" })
    await replaceDirectory(fixture.root)
    const legacy = { ...execution, state: "unsaved" }
    expect(legacy).not.toHaveProperty("checkpointFailures")
    expect(legacy).not.toHaveProperty("saved")
    await Storage.write(StoragePath.environmentExecution(fixture.scopeID, id), legacy)
    expect((await EnvironmentExecution.get(id, fixture.scopeID)).state).toBe("unsaved")
    expect(await Environment.uses(fixture.environment.id)).toHaveLength(1)
    expect(await testWorkspaceCoordinator().inspect()).toMatchObject([{ durable: true, drained: true }])
    return fixture
  })
  await first.close()

  await using second = await testRuntime({ home: home.path })
  const checkpointFailures = await second.run(async () => {
    const recovered = await EnvironmentExecution.get(id, fixture.scopeID)
    expect(recovered.state).toBe("completed")
    expect(recovered.saved).toEqual({})
    expect(recovered.checkpointFailures).toEqual([
      {
        mount: WorkspaceMounts.reference(fixture.mounted),
        failure: expect.objectContaining({
          name: "WorkspaceDirectoryIdentityChangedError",
          code: "WORKSPACE_DIRECTORY_IDENTITY_CHANGED",
        }),
      },
    ])
    expect(await output(id, fixture.scopeID)).toEqual({ stdout: "finished\n", stderr: "diagnostic\n" })
    expect(await Environment.uses(fixture.environment.id)).toEqual([])
    expect(await EnvironmentExecution.listActive(fixture.scopeID)).toEqual([])
    expect(await testWorkspaceCoordinator().inspect()).toEqual([])
    const latest = await WorkspaceCatalog.get(fixture.mounted.id, fixture.scopeID)
    const rebound = await WorkspaceBinding.rebind(latest.id, {
      scopeID: fixture.scopeID,
      expectedRevision: latest.revision,
      path: fixture.root,
    })
    expect(rebound.binding.generation).toBe(fixture.mounted.binding.generation + 1)
    expect(rebound.activeMount).toBeUndefined()
    await WorkspaceBinding.validate(rebound.id, fixture.scopeID)
    expect(await Bun.file(marker).text()).toBe("once\n")
    expect(await Bun.file(path.join(fixture.root, "execution.txt")).exists()).toBe(false)
    expect(await Bun.file(path.join(fixture.root, "replacement.txt")).text()).toBe("replacement")
    expect(await Bun.file(path.join(fixture.root + "-previous", "execution.txt")).text()).toBe("native data\n")
    return recovered.checkpointFailures
  })
  await second.close()

  await using third = await testRuntime({ home: home.path })
  await third.run(async () => {
    const recovered = await EnvironmentControl.recoverExecution({
      scopeID: fixture.scopeID,
      environmentID: fixture.environment.id,
      operationID: id,
    })
    expect(recovered.state).toBe("completed")
    expect(recovered.checkpointFailures).toEqual(checkpointFailures)
    expect(await output(id, fixture.scopeID)).toEqual({ stdout: "finished\n", stderr: "diagnostic\n" })
    expect(await Bun.file(marker).text()).toBe("once\n")
    expect(await testWorkspaceCoordinator().inspect()).toEqual([])
  })
}, 45_000)

test("startup retries a native release with a lost acknowledgement without repeating its saved checkpoint", async () => {
  await using home = await tmpdir()
  await using project = await tmpdir()
  const id = "lost-native-release-ack"
  const marker = path.join(project.path, "runs.txt")
  let checkpoints = 0
  let releases = 0
  let loseAcknowledgement = true
  const register = () => {
    const provider = EnvironmentProviders.get("native")
    const connect = provider.connect!.bind(provider)
    const observed = new WeakSet()
    provider.connect = async (request, target) => {
      const executor = await connect(request, target)
      if (observed.has(executor)) return executor
      observed.add(executor)
      const files = executor.files!
      const checkpoint = files.checkpoint.bind(files)
      files.checkpoint = async (input) => {
        if (input.executionID === id) checkpoints++
        return checkpoint(input)
      }
      const release = executor.release.bind(executor)
      executor.release = async (operationID) => {
        await release(operationID)
        if (operationID !== id) return
        releases++
        if (!loseAcknowledgement) return
        loseAcknowledgement = false
        throw new Error("native release acknowledgement lost")
      }
      return executor
    }
  }
  await using first = await testRuntime({ home: home.path, register })
  const fixture = await first.run(async () => {
    const fixture = await bindDirectory(project)
    await EnvironmentExecution.start({
      id,
      scopeID: fixture.scopeID,
      environmentID: fixture.environment.id,
      command: onceCommand(first.host.home, fixture.root, marker),
      workspaces: [WorkspaceMounts.reference(fixture.mounted)],
    })
    expect((await terminal(id, fixture.scopeID)).status?.exitCode).toBe(0)
    await replaceDirectory(fixture.root)
    await expect(EnvironmentExecution.complete(id, fixture.scopeID)).rejects.toThrow(
      "native release acknowledgement lost",
    )
    const saved = await EnvironmentExecution.get(id, fixture.scopeID)
    expect(saved.state).toBe("saved")
    expect(saved.saved).toEqual({})
    expect(saved.checkpointFailures).toEqual([
      {
        mount: WorkspaceMounts.reference(fixture.mounted),
        failure: expect.objectContaining({
          name: "WorkspaceDirectoryIdentityChangedError",
          code: "WORKSPACE_DIRECTORY_IDENTITY_CHANGED",
        }),
      },
    ])
    expect(await Environment.uses(fixture.environment.id)).toHaveLength(1)
    expect(await testWorkspaceCoordinator().inspect()).toEqual([])
    expect(await output(id, fixture.scopeID)).toEqual({ stdout: "finished\n", stderr: "diagnostic\n" })
    expect(checkpoints).toBe(1)
    expect(releases).toBe(1)
    return { ...fixture, saved }
  })
  await first.close()

  await using second = await testRuntime({ home: home.path, register })
  await second.run(async () => {
    const recovered = await EnvironmentExecution.get(id, fixture.scopeID)
    expect(recovered.state).toBe("completed")
    expect(recovered.saved).toEqual(fixture.saved.saved)
    expect(recovered.checkpointFailures).toEqual(fixture.saved.checkpointFailures)
    expect(checkpoints).toBe(1)
    expect(releases).toBe(2)
    expect(await Environment.uses(fixture.environment.id)).toEqual([])
    expect(await testWorkspaceCoordinator().inspect()).toEqual([])
    expect(await output(id, fixture.scopeID)).toEqual({ stdout: "finished\n", stderr: "diagnostic\n" })
    const latest = await WorkspaceCatalog.get(fixture.mounted.id, fixture.scopeID)
    const rebound = await WorkspaceBinding.rebind(latest.id, {
      scopeID: fixture.scopeID,
      expectedRevision: latest.revision,
      path: fixture.root,
    })
    expect(rebound.binding.generation).toBe(fixture.mounted.binding.generation + 1)
    expect(rebound.activeMount).toBeUndefined()
    await WorkspaceBinding.validate(rebound.id, fixture.scopeID)
    expect(await Bun.file(marker).text()).toBe("once\n")
    expect(await Bun.file(path.join(fixture.root, "execution.txt")).exists()).toBe(false)
    expect(await Bun.file(path.join(fixture.root + "-previous", "execution.txt")).text()).toBe("native data\n")
  })
}, 45_000)

test("a replaced directory cannot release a native execution while its captured object upload remains unsaved", async () => {
  await using home = await tmpdir()
  await using project = await tmpdir()
  const id = "mixed-mount-upload-recovery"
  const marker = path.join(project.path, "runs.txt")
  let failUpload = false
  let failedUploads = 0
  const register = () => {
    WorkspaceBlobs.register("native-recovery-fixture", {
      async put(hash, bytes) {
        if (failUpload) {
          failedUploads++
          throw new Error("object upload unavailable")
        }
        await Storage.writeBinary(["native_recovery_blob", hash], bytes)
      },
      get: (hash) => Storage.readBinary(["native_recovery_blob", hash]),
    })
  }
  await using first = await testRuntime({ home: home.path, register })
  const fixture = await first.run(async () => {
    const fixture = await bindDirectory(project)
    const object = await WorkspaceCatalog.create({
      scopeID: fixture.scopeID,
      backend: { provider: "objects", spec: { blobStore: "native-recovery-fixture" } },
    })
    const objectMount = await WorkspaceMounts.attach({
      scopeID: fixture.scopeID,
      workspaceID: object.id,
      environmentID: fixture.environment.id,
    })
    await EnvironmentExecution.start({
      id,
      scopeID: fixture.scopeID,
      environmentID: fixture.environment.id,
      command: onceCommand(first.host.home, fixture.root, marker, objectMount.activeMount!.path),
      workspaces: [WorkspaceMounts.reference(fixture.mounted), WorkspaceMounts.reference(objectMount)],
    })
    const execution = await terminal(id, fixture.scopeID)
    expect(execution.status?.exitCode).toBe(0)
    expect(execution.workspaces).toEqual([
      WorkspaceMounts.reference(fixture.mounted),
      WorkspaceMounts.reference(objectMount),
    ])
    expect(execution.status?.before?.map((reference) => reference.workspaceID)).toEqual([object.id])
    await replaceDirectory(fixture.root)
    failUpload = true
    await expect(EnvironmentExecution.complete(id, fixture.scopeID)).rejects.toThrow("object upload unavailable")
    const unsaved = await EnvironmentExecution.get(id, fixture.scopeID)
    expect(unsaved.state).toBe("unsaved")
    expect(unsaved.saved).toBeUndefined()
    expect(unsaved.outputCursor).toBe(execution.status!.cursor)
    expect(failedUploads).toBe(1)
    expect(await Environment.uses(fixture.environment.id)).toHaveLength(1)
    expect(await testWorkspaceCoordinator().inspect()).toMatchObject([{ durable: true, drained: true }])
    await expect(
      WorkspaceBinding.rebind(fixture.mounted.id, {
        scopeID: fixture.scopeID,
        expectedRevision: fixture.mounted.revision,
        path: fixture.root,
      }),
    ).rejects.toMatchObject({ name: "EnvironmentBusy" })
    await expect(Environment.deallocate(fixture.environment.id, { scopeID: fixture.scopeID })).rejects.toMatchObject({
      name: "EnvironmentBusy",
    })
    expect(await Bun.file(marker).text()).toBe("once\n")
    return { ...fixture, objectMount }
  })
  await first.close()

  await using second = await testRuntime({ home: home.path, register })
  await second.run(async () => {
    expect((await EnvironmentExecution.get(id, fixture.scopeID)).state).toBe("unsaved")
    expect(failedUploads).toBe(2)
    expect(await Environment.uses(fixture.environment.id)).toHaveLength(1)
    expect(await testWorkspaceCoordinator().inspect()).toMatchObject([{ durable: true, drained: true }])
    failUpload = false
    const completed = await EnvironmentControl.recoverExecution({
      scopeID: fixture.scopeID,
      environmentID: fixture.environment.id,
      operationID: id,
    })
    expect(completed.state).toBe("completed")
    expect(completed.checkpointFailures).toEqual([
      {
        mount: WorkspaceMounts.reference(fixture.mounted),
        failure: expect.objectContaining({
          name: "WorkspaceDirectoryIdentityChangedError",
          code: "WORKSPACE_DIRECTORY_IDENTITY_CHANGED",
        }),
      },
    ])
    const selection = { workspaceID: fixture.objectMount.id, scopeID: fixture.scopeID }
    const { info, store } = await WorkspaceContent.resolve(selection, true)
    expect(info.content?.manifest).toBeString()
    expect(completed.saved).toEqual({ [info.id]: info.content! })
    const manifest = await WorkspaceContent.manifest(info, store)
    const entry = manifest.entries.find((entry) => entry.path === "object.bin")
    expect(entry).toMatchObject({ kind: "file", size: 5 })
    if (entry?.kind !== "file") throw new Error("Saved object checkpoint has no file")
    const bytes = await Promise.all(entry.chunks.map((chunk) => store.get(chunk.hash, chunk.size)))
    expect(Buffer.concat(bytes)).toEqual(Buffer.from([0, 1, 127, 128, 255]))
    expect(await Environment.uses(fixture.environment.id)).toEqual([])
    expect(await testWorkspaceCoordinator().inspect()).toEqual([])
    expect(await output(id, fixture.scopeID)).toEqual({ stdout: "finished\n", stderr: "diagnostic\n" })
    const latest = await WorkspaceCatalog.get(fixture.mounted.id, fixture.scopeID)
    const rebound = await WorkspaceBinding.rebind(latest.id, {
      scopeID: fixture.scopeID,
      expectedRevision: latest.revision,
      path: fixture.root,
    })
    expect(rebound.binding.generation).toBe(fixture.mounted.binding.generation + 1)
    expect(await Bun.file(marker).text()).toBe("once\n")
    expect(await Bun.file(path.join(fixture.root, "execution.txt")).exists()).toBe(false)
    await Environment.deallocate(fixture.environment.id, { scopeID: fixture.scopeID })
    expect(await WorkspaceContent.read(selection, "object.bin")).toEqual(new Uint8Array([0, 1, 127, 128, 255]))
  })
}, 45_000)

test("a live native process still blocks rebinding a replaced directory until cancellation drains it", async () => {
  await using home = await tmpdir()
  await using project = await tmpdir()
  await using runtime = await testRuntime({ home: home.path })
  await runtime.run(async () => {
    const fixture = await bindDirectory(project)
    const id = "live-directory-rebind"
    const started = await EnvironmentExecution.start({
      id,
      scopeID: fixture.scopeID,
      environmentID: fixture.environment.id,
      command: {
        command: process.execPath,
        args: ["-e", 'process.stdout.write("ready\\n"); await Bun.stdin.text()'],
        cwd: fixture.root,
        env: {
          HOME: runtime.host.home,
          USERPROFILE: runtime.host.home,
          SYNERGY_HOME: runtime.host.home,
          SYNERGY_TEST_HOME: runtime.host.home,
        },
        useRoots: [fixture.root],
      },
      workspaces: [WorkspaceMounts.reference(fixture.mounted)],
    })
    let pid: number | undefined
    try {
      const deadline = Date.now() + 10_000
      for (;;) {
        const execution = await EnvironmentExecution.reconcile(id, fixture.scopeID)
        if ((await output(id, fixture.scopeID)).stdout === "ready\n") break
        if (execution.status && ExecutionProtocol.terminal(execution.status))
          throw new Error(`Native readiness process exited: ${JSON.stringify(execution.status)}`)
        if (Date.now() >= deadline) throw new Error("Native process did not report readiness")
        await Bun.sleep(20)
      }
      const executor = await EnvironmentExecution.connect(started)
      pid = executor.localPID?.(id)
      if (!pid) throw new Error("Native process has no local PID")
      process.kill(pid, 0)
      await replaceDirectory(fixture.root)
      await expect(
        WorkspaceBinding.rebind(fixture.mounted.id, {
          scopeID: fixture.scopeID,
          expectedRevision: fixture.mounted.revision,
          path: fixture.root,
        }),
      ).rejects.toMatchObject({ name: "EnvironmentBusy" })
      const recovered = await EnvironmentControl.recoverExecution({
        scopeID: fixture.scopeID,
        environmentID: fixture.environment.id,
        operationID: id,
      })
      expect(recovered.state).toBe("running")
      expect(recovered.checkpointFailures).toBeUndefined()
      expect(recovered.status && ExecutionProtocol.terminal(recovered.status)).toBe(false)
      expect(await Environment.uses(fixture.environment.id)).toHaveLength(1)
      expect(await testWorkspaceCoordinator().inspect()).toMatchObject([
        { kind: "process", durable: true, processBound: true, state: "active" },
      ])
      process.kill(pid, 0)
    } finally {
      await EnvironmentExecution.cancel(id, fixture.scopeID)
      await terminal(id, fixture.scopeID)
      await EnvironmentExecution.complete(id, fixture.scopeID)
    }
    const completed = await EnvironmentExecution.get(id, fixture.scopeID)
    expect(completed.state).toBe("completed")
    expect(completed.status).toMatchObject({ state: "cancelled", treeDrained: true, streamsDrained: true })
    expect(completed.checkpointFailures).toMatchObject([
      { mount: WorkspaceMounts.reference(fixture.mounted), failure: { code: "WORKSPACE_DIRECTORY_IDENTITY_CHANGED" } },
    ])
    expect(await output(id, fixture.scopeID)).toEqual({ stdout: "ready\n", stderr: "" })
    expect(await Environment.uses(fixture.environment.id)).toEqual([])
    expect(await testWorkspaceCoordinator().inspect()).toEqual([])
    let livenessError: unknown
    try {
      process.kill(pid!, 0)
    } catch (error) {
      livenessError = error
    }
    expect(livenessError).toMatchObject({ code: "ESRCH" })
    const latest = await WorkspaceCatalog.get(fixture.mounted.id, fixture.scopeID)
    const rebound = await WorkspaceBinding.rebind(latest.id, {
      scopeID: fixture.scopeID,
      expectedRevision: latest.revision,
      path: fixture.root,
    })
    expect(rebound.binding.generation).toBe(fixture.mounted.binding.generation + 1)
    await WorkspaceBinding.validate(rebound.id, fixture.scopeID)
  })
}, 30_000)
