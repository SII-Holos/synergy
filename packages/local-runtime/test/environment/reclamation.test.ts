import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ExecutionProtocol } from "@ericsanchezok/synergy-harness/environment/executor"
import { AtomicFile } from "@ericsanchezok/synergy-util/atomic-file"
import { NativeExecutor } from "../../src/environment/native-executor"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"

test("local release reclaims output while retaining immutable restart and duplicate receipts", async () => {
  await using tmp = await tmpdir()
  const options = {
    target: { environmentID: "environment", allocationID: "allocation", generation: 1 },
    directory: path.join(tmp.path, "receipts"),
    coordinator: new WorkspaceCoordinator({ directory: path.join(tmp.path, "claims") }),
  }
  const command = {
    command: process.execPath,
    args: ["-e", "process.stdout.write('x'.repeat(512 * 1024))"],
    cwd: tmp.path,
    env: {},
    useRoots: [],
  }
  const request = { id: "output", target: options.target, command, digest: ExecutionProtocol.digest(command) }
  const directory = path.join(options.directory, createHash("sha256").update(request.id).digest("hex"))
  let terminal: ExecutionProtocol.Status | undefined
  {
    await using executor = await NativeExecutor.open(options)
    await executor.start(request)
    const deadline = Date.now() + 35_000
    do {
      terminal = await executor.status(request.id)
      if (terminal && ExecutionProtocol.terminal(terminal)) break
      if (Date.now() > deadline) throw new Error(`Execution did not drain: ${JSON.stringify(terminal)}`)
      await executor.waitForChange(request.id, terminal!, 100)
    } while (true)
    expect(terminal?.error).toBeUndefined()
    expect(terminal?.exitCode).toBe(0)
    const output = await executor.output(request.id, 0, 128)
    expect(output.reduce((size, chunk) => size + Buffer.from(chunk.data, "base64").length, 0)).toBe(512 * 1024)
    const filename = path.join(directory, "receipt.json")
    const receipt = Bun.file(filename)
    {
      const write = AtomicFile.writeJsonAtomic
      using held = spyOn(AtomicFile, "writeJsonAtomic").mockImplementation((file, data, settings) => {
        if (file === filename && JSON.parse(data).payloadsAcknowledged) throw new Error("ACK write interrupted")
        return write(file, data, settings)
      })
      await expect(executor.release(request.id)).rejects.toThrow("ACK write interrupted")
    }
    expect((await receipt.json()).payloadsAcknowledged).toBeUndefined()
    expect(await executor.output(request.id, 0, 128)).toEqual(output)
    {
      using interrupted = spyOn(executor.files, "releaseBlobs").mockRejectedValueOnce(new Error("cleanup interrupted"))
      await expect(executor.release(request.id)).rejects.toThrow("cleanup interrupted")
    }
    expect((await receipt.json()).payloadsAcknowledged).toBe(true)
    expect((await fs.readdir(directory)).length).toBeGreaterThan(1)
    await expect(executor.output(request.id, 0, 128)).rejects.toThrow("released")
    expect(await executor.start(request)).toEqual(terminal)
  }
  await using recovered = await NativeExecutor.open(options)
  expect(await recovered.status(request.id)).toEqual(terminal)
  expect(await recovered.start(request)).toEqual(terminal)
  await expect(recovered.output(request.id, 0, 128)).rejects.toThrow("released")
  await Promise.all([recovered.release(request.id), recovered.release(request.id)])
  expect(await fs.readdir(directory)).toEqual(["receipt.json"])
  await expect(
    recovered.start({
      ...request,
      command: { ...command, args: [] },
      digest: ExecutionProtocol.digest({ ...command, args: [] }),
    }),
  ).rejects.toThrow("different input")
}, 45_000)
