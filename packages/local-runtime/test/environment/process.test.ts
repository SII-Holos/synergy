import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { once } from "node:events"
import { EnvironmentProcess } from "@ericsanchezok/synergy-harness/environment/process"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { EnvironmentExecution } from "@ericsanchezok/synergy-harness/environment/execution"
import { ExecutionProtocol } from "@ericsanchezok/synergy-harness/environment/executor"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { WorkspaceBinding, WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceMounts } from "@ericsanchezok/synergy-harness/workspace/mount"
import { WorkspaceBlobs, WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { WorkspaceOperations } from "@ericsanchezok/synergy-harness/workspace/operations"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { registerNativeEnvironment } from "../../src/environment/native"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"

test("activation observes native readiness before paused output applies backpressure", async () => {
  await using tmp = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(tmp.path, "claims") })
  await using runtime = await testRuntime({
    register() {
      WorkspaceAccess.register(coordinator)
      registerNativeEnvironment({ coordinator })
    },
  })
  await runtime.run(async () => {
    const environment = await Environment.bind({ scopeID: "scope", ownerID: "owner", provider: "native", spec: {} })
    await using resources = await EnvironmentResources.resolve({
      scopeID: "scope",
      environmentID: environment.id,
      needs: { execution: "exec" },
    })
    const executor = resources.executor!
    const waits = spyOn(executor, "waitForChange")
    const start = executor.start.bind(executor)
    const status = executor.status.bind(executor)
    const deadline = Date.now() + 20_000
    let accepted: ExecutionProtocol.Status | undefined
    let delayed = false
    executor.start = async (request) => {
      const result = await start(request)
      expect(result.state).toBe("accepted")
      accepted = result
      return result
    }
    executor.status = async (id) => {
      if (accepted && !delayed) {
        delayed = true
        while (Date.now() < deadline) {
          const physical = await status(id)
          if (physical && ExecutionProtocol.terminal(physical)) {
            expect(physical).toMatchObject({ state: "exited", exitCode: 0, treeDrained: true, streamsDrained: true })
            return accepted
          }
          await Bun.sleep(10)
        }
        throw new Error("Native output did not finish before the fixture cleanup deadline")
      }
      return status(id)
    }
    const expected = Buffer.from("activation-保存\n".repeat(524_288))
    const execution = await EnvironmentProcess.prepare({
      id: "activation-before-output",
      scopeID: "scope",
      resources,
      command: {
        command: process.execPath,
        args: ["-e", 'await Bun.write(Bun.stdout, "activation-保存\\n".repeat(524_288))'],
        cwd: resources.directory!,
        env: {},
        useRoots: [],
      },
    })
    const chunks: Buffer[] = []
    execution.child.stdout.pause()
    execution.child.stderr.resume()
    const readable = once(execution.child.stdout, "readable")
    let completed = false
    void execution.completion.then(
      () => (completed = true),
      () => {},
    )
    const timeout = Promise.withResolvers<never>()
    const timer = setTimeout(
      () => timeout.reject(new Error("Activation remained blocked while native output was paused")),
      Math.max(1, deadline - Date.now()),
    )
    try {
      await Promise.race([execution.activate(), timeout.promise])
      await Promise.race([readable, timeout.promise])
      expect(delayed).toBe(true)
      expect(execution.child.stdout.readableLength).toBeGreaterThan(0)
      expect(completed).toBe(false)
      execution.child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk))
      execution.child.stdout.resume()
      await Promise.race([execution.completion, timeout.promise])
      expect(Buffer.concat(chunks)).toEqual(expected)
      expect(waits.mock.calls.filter(([, status]) => ExecutionProtocol.terminal(status))).toHaveLength(0)
      expect((await EnvironmentExecution.get(execution.executionID, "scope")).state).toBe("completed")
      expect(execution.child.exitCode).toBe(0)
      expect(await coordinator.inspect()).toEqual([])
    } finally {
      clearTimeout(timer)
      execution.child.stdout.resume()
      execution.child.stderr.resume()
      try {
        await execution.stop()
      } finally {
        waits.mockRestore()
        executor.start = start
        executor.status = status
      }
    }
  })
}, 30_000)

test.each(["resume", "stop", "abort"])(
  "process close waits for paused output before %s",
  async (action) => {
    await using tmp = await tmpdir()
    const coordinator = new WorkspaceCoordinator({ directory: path.join(tmp.path, "claims") })
    await using runtime = await testRuntime({
      register() {
        WorkspaceAccess.register(coordinator)
        registerNativeEnvironment({ coordinator })
      },
    })
    await runtime.run(async () => {
      const environment = await Environment.bind({ scopeID: "scope", ownerID: "owner", provider: "native", spec: {} })
      await using resources = await EnvironmentResources.resolve({
        scopeID: "scope",
        environmentID: environment.id,
        needs: { execution: "exec" },
      })
      const controller = new AbortController()
      const execution = await EnvironmentProcess.prepare({
        id: "paused-output",
        scopeID: "scope",
        resources,
        signal: controller.signal,
        command: {
          command: process.execPath,
          args: [
            "-e",
            'await Bun.write(Bun.stdout, "x".repeat(48000)); await Bun.write(Bun.stderr, "y".repeat(32000))',
          ],
          cwd: resources.directory!,
          env: {},
          useRoots: [],
        },
      })
      const output: Buffer[] = []
      const errors: Buffer[] = []
      execution.child.stdout.on("data", (chunk: Buffer) => output.push(chunk)).pause()
      execution.child.stderr.on("data", (chunk: Buffer) => errors.push(chunk)).pause()
      const written = Promise.all([once(execution.child.stdout, "finish"), once(execution.child.stderr, "finish")])
      const stdoutEnded = once(execution.child.stdout, "end")
      const stderrEnded = once(execution.child.stderr, "end")
      let closed = false
      let completed = false
      execution.child.once("close", () => (closed = true))
      void execution.completion.then(() => (completed = true))
      try {
        await execution.activate()
        execution.child.stdin.end()
        await written
        expect((await EnvironmentExecution.get("paused-output", "scope")).state).toBe("completed")
        expect(closed).toBe(false)
        expect(completed).toBe(false)
        execution.child.stdout.resume()
        await stdoutEnded
        expect(closed).toBe(false)
        if (action === "resume") execution.child.stderr.resume()
        if (action === "stop") await execution.stop()
        if (action === "abort") controller.abort()
        await stderrEnded
        await execution.completion
        expect(closed).toBe(true)
        expect(Buffer.concat(output)).toEqual(Buffer.alloc(48000, "x"))
        expect(Buffer.concat(errors)).toEqual(Buffer.alloc(32000, "y"))
      } finally {
        execution.child.stdout.resume()
        execution.child.stderr.resume()
        await execution.stop()
      }
    })
  },
  15_000,
)

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

test.each(["command", "mutation"])(
  "a stale %s checkpoint cannot overwrite a newer save or replay effects",
  async (kind) => {
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
      await expect(
        kind === "command"
          ? run("older", "old")
          : WorkspaceOperations.write({
              ...selection,
              id: "older",
              path: "result",
              data: Buffer.from("old"),
              expectedVersion: null,
            }),
      ).rejects.toThrow("save interrupted")
      expect(await Bun.file(path.join(resources.directory!, "result")).text()).toBe("old")
      fail = false
      await run("newer", "new")
      const published = (await WorkspaceCatalog.get(workspace.id, scopeID)).content
      const complete = kind === "command" ? EnvironmentExecution.complete : WorkspaceOperations.reconcile
      const get = kind === "command" ? EnvironmentExecution.get : WorkspaceOperations.get
      await expect(complete("older", scopeID)).rejects.toThrow("checkpoint publication")
      expect((await WorkspaceCatalog.get(workspace.id, scopeID)).content).toEqual(published)
      expect((await get("older", scopeID)).state).toBe("unsaved")
      await complete("older", scopeID)
      expect((await get("older", scopeID)).state).toBe("completed")
      expect((await WorkspaceCatalog.get(workspace.id, scopeID)).content).toEqual(published)
      expect(await Bun.file(path.join(resources.directory!, "count")).text()).toBe(kind === "command" ? "11" : "1")
      await resources.release()
      await Environment.deallocate(environment.id, { scopeID })
      expect(new TextDecoder().decode(await WorkspaceContent.read(selection, "result"))).toBe("new")
      expect(await coordinator.inspect()).toEqual([])
    })
  },
  30_000,
)

test("idle native execution waits for changes without repeatedly reading authority", async () => {
  await using tmp = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(tmp.path, "claims") })
  await using runtime = await testRuntime({
    register() {
      WorkspaceAccess.register(coordinator)
      registerNativeEnvironment({ coordinator })
    },
  })
  await runtime.run(async () => {
    const environment = await Environment.bind({ scopeID: "idle", ownerID: "idle", provider: "native", spec: {} })
    await using resources = await EnvironmentResources.resolve({
      scopeID: "idle",
      environmentID: environment.id,
      needs: { execution: "exec" },
    })
    const operation = await EnvironmentProcess.prepare({
      id: "idle-change",
      scopeID: "idle",
      resources,
      command: {
        command: process.execPath,
        args: [
          "-e",
          'console.log("ready"); for await (const chunk of Bun.stdin.stream()) { console.log("done"); break }',
        ],
        cwd: resources.directory!,
        env: {},
        useRoots: [],
      },
    })
    const ready = Promise.withResolvers<void>()
    const chunks: Buffer[] = []
    operation.child.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk)
      if (Buffer.concat(chunks).includes("ready")) ready.resolve()
    })
    operation.child.stderr.resume()
    try {
      await operation.activate()
      await ready.promise
      const reads = spyOn(Storage, "readMany")
      try {
        await Bun.sleep(750)
        expect(reads.mock.calls.length).toBeLessThan(30)
      } finally {
        reads.mockRestore()
      }
      operation.child.stdin.end("finish\n")
      await operation.completion
      expect(Buffer.concat(chunks).toString()).toBe("ready\ndone\n")
      expect(operation.child.exitCode).toBe(0)
    } finally {
      await operation.stop()
    }
  })
}, 20_000)

test("a replaced directory reports checkpoint failure after output drainage and replay does not execute again", async () => {
  await using tmp = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(tmp.path, "claims") })
  await using runtime = await testRuntime({
    register() {
      WorkspaceAccess.register(coordinator)
      registerNativeEnvironment({ coordinator })
    },
  })
  await runtime.run(async () => {
    const scope = await tmp.scope()
    const root = path.join(tmp.path, "workspace")
    await fs.mkdir(root)
    const workspace = await WorkspaceBinding.register(scope.id, root)
    const environment = await Environment.bind({ scopeID: scope.id, ownerID: "owner", provider: "native", spec: {} })
    await using resources = await EnvironmentResources.resolve({
      scopeID: scope.id,
      workspaceID: workspace.id,
      environmentID: environment.id,
      needs: { execution: "exec" },
    })
    const files = resources.executor!.files!
    const original = files.checkpoint.bind(files)
    const replacement = Promise.withResolvers<void>()
    let checkpoints = 0
    files.checkpoint = async (input) => {
      if (input.executionID === "replaced-process") {
        checkpoints++
        await fs.rename(root, root + "-previous")
        await fs.mkdir(root)
        await Bun.write(path.join(root, "replacement"), "untouched")
        replacement.resolve()
      }
      return original(input)
    }
    const command = {
      command: process.execPath,
      args: [
        "-e",
        "import {appendFileSync} from 'node:fs'; appendFileSync('count', '1'); process.stdout.write('x'.repeat(1024))",
      ],
      cwd: resources.directory!,
      env: {},
      useRoots: [],
    }
    const execution = await EnvironmentProcess.prepare({
      id: "replaced-process",
      scopeID: scope.id,
      resources,
      command,
    })
    let settled = false
    void execution.completion.then(
      () => (settled = true),
      () => (settled = true),
    )
    execution.child.stdout.pause()
    execution.child.stderr.resume()
    try {
      await execution.activate()
      await replacement.promise
      const deadline = Date.now() + 5000
      while ((await EnvironmentExecution.get(execution.executionID, scope.id)).state !== "completed") {
        if (Date.now() >= deadline) throw new Error("Replaced execution did not finish resource cleanup")
        await Bun.sleep(10)
      }
      expect(settled).toBe(false)
      expect(execution.child.stdout.readableLength).toBe(1024)
      const output: Buffer[] = []
      execution.child.stdout.on("data", (chunk: Buffer) => output.push(chunk))
      execution.child.stdout.resume()
      await expect(execution.completion).rejects.toMatchObject({
        name: "EnvironmentProcessError",
        data: {
          stage: "saving",
          checkpointFailures: [
            {
              mount: WorkspaceMounts.reference(resources.workspace!),
              failure: { code: "WORKSPACE_DIRECTORY_IDENTITY_CHANGED" },
            },
          ],
        },
      })
      expect(Buffer.concat(output)).toEqual(Buffer.alloc(1024, "x"))
      expect(execution.child.exitCode).toBe(0)
      const replay = await EnvironmentProcess.prepare({ id: "replaced-process", scopeID: scope.id, resources, command })
      const replayed: Buffer[] = []
      replay.child.stdout.on("data", (chunk: Buffer) => replayed.push(chunk))
      replay.child.stderr.resume()
      await replay.activate()
      await expect(replay.completion).rejects.toMatchObject({
        name: "EnvironmentProcessError",
        data: { checkpointFailures: expect.any(Array) },
      })
      expect(Buffer.concat(replayed)).toEqual(Buffer.alloc(1024, "x"))
      expect(checkpoints).toBe(1)
      expect(await Bun.file(path.join(root + "-previous", "count")).text()).toBe("1")
      expect(await Bun.file(path.join(root, "count")).exists()).toBe(false)
      await resources.release()
      expect(await Environment.uses(environment.id)).toEqual([])
      expect(await coordinator.inspect()).toEqual([])
    } finally {
      files.checkpoint = original
      execution.child.stdout.resume()
      execution.child.stderr.resume()
    }
  })
}, 30_000)
