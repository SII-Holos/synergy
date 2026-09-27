import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ExecutionProtocol } from "@ericsanchezok/synergy-harness/environment/executor"
import { NativeExecutor } from "../../src/environment/native-executor"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"

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
