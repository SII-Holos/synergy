import { expect, test } from "bun:test"
import path from "node:path"
import { EnvironmentProcess } from "@ericsanchezok/synergy-harness/environment/process"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { EnvironmentExecution } from "@ericsanchezok/synergy-harness/environment/execution"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceBlobs, WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { registerNativeEnvironment } from "../../src/environment/native"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"

test("process streams finish only after checkpoint publication and reuse operation identity", async () => {
  await using tmp = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(tmp.path, "claims") })
  let fail = false
  await using runtime = await testRuntime({
    register() {
      WorkspaceAccess.register(coordinator)
      registerNativeEnvironment({ coordinator })
      WorkspaceBlobs.register("fixture", {
        async put(hash, bytes) {
          if (fail) throw new Error("save failed")
          await Storage.writeBinary(["fixture", hash], bytes)
        },
        get: (hash) => Storage.readBinary(["fixture", hash]),
      })
    },
  })
  await runtime.run(async () => {
    const environment = await Environment.bind({ scopeID: "scope", ownerID: "owner", provider: "native", spec: {} })
    const workspace = await WorkspaceCatalog.create({
      scopeID: "scope",
      backend: { provider: "objects", spec: { blobStore: "fixture" } },
    })
    const selection = { scopeID: "scope", workspaceID: workspace.id, environmentID: environment.id }
    await using resources = await EnvironmentResources.resolve({ ...selection, needs: { execution: "exec" } })
    const command = {
      command: process.execPath,
      args: [
        "-e",
        "for await (const b of Bun.stdin.stream()) process.stdout.write(b); await Bun.write('result', 'once')",
      ],
      cwd: resources.directory!,
      env: {},
      useRoots: [resources.directory!],
    }
    const execution = await EnvironmentProcess.prepare({ id: "process", scopeID: "scope", resources, command })
    expect(await Bun.file(path.join(resources.directory!, "result")).exists()).toBe(false)
    const output: Buffer[] = []
    execution.child.stdout.on("data", (chunk: Buffer) => output.push(chunk))
    fail = true
    await execution.activate()
    execution.child.stdin.end(Buffer.from([0, 1, 127, 255]))
    await expect(execution.completion).rejects.toMatchObject({ name: "EnvironmentProcessError" })
    expect(Buffer.concat(output)).toEqual(Buffer.from([0, 1, 127, 255]))
    expect((await EnvironmentExecution.get("process", "scope")).state).toBe("unsaved")
    await expect(Environment.deallocate(environment.id, { scopeID: "scope" })).rejects.toMatchObject({
      name: "EnvironmentBusy",
    })
    fail = false
    await EnvironmentExecution.complete("process", "scope")
    const replay = await EnvironmentProcess.prepare({ id: "process", scopeID: "scope", resources, command })
    replay.child.stdout.resume()
    replay.child.stderr.resume()
    await replay.activate()
    await replay.completion
    await resources.release()
    await Environment.deallocate(environment.id, { scopeID: "scope" })
    expect(await WorkspaceContent.read(selection, "result")).toEqual(new TextEncoder().encode("once"))
  })
}, 30_000)

test("process completion saves its explicitly selected Workspace independently of permission grants", async () => {
  await using tmp = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(tmp.path, "claims") })
  await using runtime = await testRuntime({
    register() {
      WorkspaceAccess.register(coordinator)
      registerNativeEnvironment({ coordinator })
      WorkspaceBlobs.register("fixture", {
        put: (hash, bytes) => Storage.writeBinary(["fixture", hash], bytes),
        get: (hash) => Storage.readBinary(["fixture", hash]),
      })
    },
  })
  await runtime.run(async () => {
    const environment = await Environment.bind({ scopeID: "scope", ownerID: "owner", provider: "native", spec: {} })
    const workspace = await WorkspaceCatalog.create({
      scopeID: "scope",
      backend: { provider: "objects", spec: { blobStore: "fixture" } },
    })
    await using resources = await EnvironmentResources.resolve({
      scopeID: "scope",
      workspaceID: workspace.id,
      environmentID: environment.id,
      needs: { execution: "exec" },
    })
    const execution = await EnvironmentProcess.prepare({
      id: "readonly",
      scopeID: "scope",
      resources,
      command: {
        command: process.execPath,
        args: ["-e", "await Bun.sleep(60_000)"],
        cwd: resources.directory!,
        env: {},
        useRoots: [],
      },
    })
    execution.child.stdout.resume()
    execution.child.stderr.resume()
    await execution.activate()
    while (execution.child.alive() !== true) await Bun.sleep(10)
    expect(execution.child.pid).toBeGreaterThan(0)
    await execution.stop()
    const saved = await EnvironmentExecution.get("readonly", "scope")
    expect(saved.state).toBe("completed")
    expect(saved.saved?.[workspace.id]).toMatchObject({ revision: 1 })
    expect(saved.status?.state).toBe("cancelled")
    await resources.release()
    await Environment.deallocate(environment.id, { scopeID: "scope" })
  })
}, 15_000)

test("a stale checkpoint cannot overwrite a newer save and recovery never replays the command", async () => {
  await using tmp = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(tmp.path, "claims") })
  let fail = false
  await using runtime = await testRuntime({
    register() {
      WorkspaceAccess.register(coordinator)
      registerNativeEnvironment({ coordinator })
      WorkspaceBlobs.register("fixture", {
        async put(hash, bytes) {
          if (fail) throw new Error("save interrupted")
          await Storage.writeBinary(["fixture", hash], bytes)
        },
        get: (hash) => Storage.readBinary(["fixture", hash]),
      })
    },
  })
  await runtime.run(async () => {
    const scopeID = "scope"
    const environment = await Environment.bind({ scopeID, ownerID: "owner", provider: "native", spec: {} })
    const workspace = await WorkspaceCatalog.create({
      scopeID,
      backend: { provider: "objects", spec: { blobStore: "fixture" } },
    })
    const selection = { scopeID, workspaceID: workspace.id, environmentID: environment.id }
    await using resources = await EnvironmentResources.resolve({ ...selection, needs: { execution: "exec" } })
    async function run(id: string, value: string) {
      const operation = await EnvironmentProcess.prepare({
        id,
        scopeID,
        resources,
        command: {
          command: process.execPath,
          args: [
            "-e",
            "import {appendFileSync} from 'node:fs'; appendFileSync('count', '1'); await Bun.write('result', process.argv[1])",
            value,
          ],
          cwd: resources.directory!,
          env: {},
          useRoots: [],
        },
      })
      operation.child.stdout.resume()
      operation.child.stderr.resume()
      await operation.activate()
      return operation.completion
    }
    fail = true
    await expect(run("older", "old")).rejects.toThrow("save interrupted")
    fail = false
    await run("newer", "new")
    const published = (await WorkspaceCatalog.get(workspace.id, scopeID)).content
    await expect(EnvironmentExecution.complete("older", scopeID)).rejects.toThrow("checkpoint publication")
    expect((await WorkspaceCatalog.get(workspace.id, scopeID)).content).toEqual(published)
    expect((await EnvironmentExecution.get("older", scopeID)).state).toBe("unsaved")
    await EnvironmentExecution.complete("older", scopeID)
    expect((await WorkspaceCatalog.get(workspace.id, scopeID)).content).toEqual(published)
    expect(await Bun.file(path.join(resources.directory!, "count")).text()).toBe("11")
    await resources.release()
    await Environment.deallocate(environment.id, { scopeID })
    expect(new TextDecoder().decode(await WorkspaceContent.read(selection, "result"))).toBe("new")
    expect(await coordinator.inspect()).toEqual([])
  })
}, 30_000)
