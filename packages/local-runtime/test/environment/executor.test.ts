import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ExecutionProtocol } from "@ericsanchezok/synergy-harness/environment/executor"
import { NativeExecutor } from "../../src/environment/native-executor"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"

test.skipIf(process.platform !== "linux")(
  "an unavailable native library does not hide its cause behind claim cleanup",
  async () => {
    await using tmp = await tmpdir()
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "fixtures/unavailable-native.ts"), tmp.path],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000)
    try {
      const [code, output, error] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ code, output, error }).toEqual({ code: 0, output: "unavailable without effects\n", error: "" })
    } finally {
      clearTimeout(timer)
      child.kill()
      await child.exited
    }
  },
  15000,
)

test("native executor deduplicates effects, drains output and retains the writer until saved", async () => {
  await using tmp = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(tmp.path, "locks") })
  const target = { environmentID: "native", allocationID: "allocation", generation: 1 }
  await using executor = await NativeExecutor.open({ target, directory: path.join(tmp.path, "receipts"), coordinator })
  const marker = path.join(tmp.path, "effect")
  const command = {
    command: process.execPath,
    args: [
      "-e",
      `await Bun.write(${JSON.stringify(marker)}, "one"); process.stdout.write("output"); process.stderr.write("error")`,
    ],
    cwd: tmp.path,
    env: {},
    writableRoots: [tmp.path],
  }
  const request = { id: "operation", target, command, digest: ExecutionProtocol.digest(command) }
  await Promise.all([executor.start(request), executor.start(request)])
  let status = await executor.status(request.id)
  for (let attempt = 0; status && !ExecutionProtocol.terminal(status) && attempt < 400; attempt++) {
    await Bun.sleep(10)
    status = await executor.status(request.id)
  }
  expect(status?.state).toBe("exited")
  expect(status?.exitCode).toBe(0)
  const chunks = await executor.output(request.id, 0, 128)
  expect(
    chunks
      .filter((chunk) => chunk.stream === "stdout")
      .map((chunk) => Buffer.from(chunk.data, "base64").toString())
      .join(""),
  ).toBe("output")
  expect(
    chunks
      .filter((chunk) => chunk.stream === "stderr")
      .map((chunk) => Buffer.from(chunk.data, "base64").toString())
      .join(""),
  ).toBe("error")
  expect(await coordinator.inspect()).toHaveLength(1)
  await executor.close()
  await using recovered = await NativeExecutor.open({ target, directory: path.join(tmp.path, "receipts"), coordinator })
  expect((await recovered.status(request.id))?.state).toBe("exited")
  await recovered.release(request.id)
  expect(await coordinator.inspect()).toHaveLength(0)
  await Bun.write(marker, "changed")
  await recovered.start(request)
  expect(await Bun.file(marker).text()).toBe("changed")
}, 30_000)

test("cancel before dispatch remains cancelled and changed inputs or generations are rejected", async () => {
  await using tmp = await tmpdir()
  const target = { environmentID: "native", allocationID: "allocation", generation: 1 }
  await using executor = await NativeExecutor.open({
    target,
    directory: path.join(tmp.path, "receipts"),
    coordinator: new WorkspaceCoordinator({ directory: path.join(tmp.path, "locks") }),
  })
  const command = {
    command: process.execPath,
    args: ["-e", "throw new Error('must not run')"],
    cwd: tmp.path,
    env: {},
    writableRoots: [],
  }
  const request = { id: "operation", target, command, digest: ExecutionProtocol.digest(command) }
  await executor.cancel(request.id, request.digest)
  expect((await executor.start(request)).state).toBe("cancelled")
  await expect(executor.start({ ...request, target: { ...target, generation: 2 } })).rejects.toThrow("allocation")
  const changed = { ...command, args: ["-e", ""] }
  await expect(
    executor.start({ ...request, command: changed, digest: ExecutionProtocol.digest(changed) }),
  ).rejects.toThrow("different input")
})

test("execution validates committed file bytes after physical admission and does not replay a rejected command", async () => {
  await using tmp = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(tmp.path, "claims") })
  const target = { environmentID: "native", allocationID: "allocation", generation: 1 }
  await using executor = await NativeExecutor.open({ target, directory: path.join(tmp.path, "receipts"), coordinator })
  const file = path.join(tmp.path, "source")
  await Bun.write(file, "before")
  const blocker = await coordinator.acquire({
    id: "other-writer",
    owner: "other",
    ancestors: [],
    kind: "operation",
    roots: [tmp.path],
  })
  const command = {
    command: process.execPath,
    args: ["-e", "await Bun.write('source', 'stale formatting')"],
    cwd: tmp.path,
    env: {},
    writableRoots: [tmp.path],
    preconditions: [
      {
        path: file,
        canonical: file,
        version: `sha256:${new Bun.CryptoHasher("sha256").update("before").digest("hex")}`,
      },
    ],
  }
  const request = { id: "conditional", target, command, digest: ExecutionProtocol.digest(command) }
  try {
    await executor.start(request)
    const deadline = Date.now() + 10000
    while (!(await coordinator.inspect()).some((claim) => claim.state === "waiting")) {
      if (Date.now() > deadline) throw new Error("Command never queued")
      await Bun.sleep(10)
    }
    await Bun.write(file, "foreign write")
  } finally {
    await blocker.release()
  }
  let status = await executor.status(request.id)
  for (let i = 0; !ExecutionProtocol.terminal(status!) && i < 400; i++) {
    await Bun.sleep(10)
    status = await executor.status(request.id)
  }
  expect(status?.effectsStarted).toBe(false)
  expect(status?.failure?.name).toBe("WorkspaceFileWriteConflictError")
  expect(await Bun.file(file).text()).toBe("foreign write")
  await executor.release(request.id)
  await Bun.write(file, "before")
  expect((await executor.start(request)).failure?.name).toBe("WorkspaceFileWriteConflictError")
  expect(await Bun.file(file).text()).toBe("before")
  expect(await coordinator.inspect()).toEqual([])
}, 15000)

test("a failed launch with verified process and stream drainage remains saveable", async () => {
  await using tmp = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(tmp.path, "claims") })
  const target = { environmentID: "native", allocationID: "allocation", generation: 1 }
  await using executor = await NativeExecutor.open({ target, directory: path.join(tmp.path, "receipts"), coordinator })
  const command = {
    command: path.join(tmp.path, "missing-executable"),
    args: [],
    cwd: tmp.path,
    env: {},
    writableRoots: [tmp.path],
  }
  await executor.start({ id: "missing", target, command, digest: ExecutionProtocol.digest(command) })
  let status = await executor.status("missing")
  for (let i = 0; !ExecutionProtocol.terminal(status!) && i < 400; i++) {
    await Bun.sleep(10)
    status = await executor.status("missing")
  }
  expect(status?.state).toBe("exited")
  expect(status?.error).toBeDefined()
  expect(status?.treeDrained).toBe(true)
  expect(status?.streamsDrained).toBe(true)
  expect(await coordinator.inspect()).toHaveLength(1)
  await executor.release("missing")
  expect(await coordinator.inspect()).toEqual([])
}, 15000)

test("a process binding failure preserves its cause and releases the unactivated claim", async () => {
  await using tmp = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(tmp.path, "claims") })
  const target = { environmentID: "native", allocationID: "allocation", generation: 1 }
  let rejectBinding = true
  await using executor = await NativeExecutor.open({
    target,
    directory: path.join(tmp.path, "receipts"),
    coordinator,
    acquire: async (command, signal) => {
      const lease = await coordinator.acquire({
        id: crypto.randomUUID(),
        owner: target.environmentID,
        ancestors: [],
        kind: "process",
        roots: command.writableRoots,
        retainAfterExit: true,
        durable: true,
        signal,
      })
      return {
        ...lease,
        bindProcess: async (pid, options) => {
          if (rejectBinding) {
            rejectBinding = false
            throw new Error("binding unavailable")
          }
          await lease.bindProcess(pid, options)
        },
      }
    },
  })
  const marker = path.join(tmp.path, "effect")
  const command = {
    command: process.execPath,
    args: ["-e", `await Bun.write(${JSON.stringify(marker)}, "one")`],
    cwd: tmp.path,
    env: {},
    writableRoots: [tmp.path],
  }
  const settle = async (id: string) => {
    await executor.start({ id, target, command, digest: ExecutionProtocol.digest(command) })
    const deadline = Date.now() + 5000
    for (;;) {
      const status = await executor.status(id)
      if (status && ExecutionProtocol.terminal(status)) return status
      if (Date.now() >= deadline) throw new Error("Execution never settled")
      await Bun.sleep(10)
    }
  }
  const failed = await settle("unbound")
  expect(failed.error).toBe("binding unavailable")
  expect(failed.effectsStarted).toBe(false)
  expect(await Bun.file(marker).exists()).toBe(false)
  expect(await coordinator.inspect()).toEqual([])
  const next = await settle("next")
  expect(next.exitCode).toBe(0)
  expect(await Bun.file(marker).text()).toBe("one")
  await executor.release("next")
  expect(await coordinator.inspect()).toEqual([])
}, 15000)
