import { mock } from "bun:test"
import assert from "node:assert/strict"
import path from "node:path"
import { ExecutionProtocol } from "@ericsanchezok/synergy-harness/environment/executor"
import { WorkspaceCoordinator } from "../../../src/workspace/coordinator"

const directory = process.argv[2]!
mock.module("../../../src/process/native-pty", () => ({
  NativePty: { libraryPath: () => path.join(directory, "missing-library.so") },
}))
const { NativeExecutor } = await import("../../../src/environment/native-executor")
const coordinator = new WorkspaceCoordinator({ directory: path.join(directory, "claims") })
const target = { environmentID: "native", allocationID: "allocation", generation: 1 }
await using executor = await NativeExecutor.open({ target, directory: path.join(directory, "receipts"), coordinator })
const marker = path.join(directory, "effect")
const command = {
  command: process.execPath,
  args: ["-e", `await Bun.write(${JSON.stringify(marker)}, "one")`],
  cwd: directory,
  env: {},
  useRoots: [directory],
}
await executor.start({ id: "unavailable", target, command, digest: ExecutionProtocol.digest(command) })
const deadline = Date.now() + 5000
for (;;) {
  const status = await executor.status("unavailable")
  if (status && ExecutionProtocol.terminal(status)) {
    assert.equal(
      status.error,
      "Native Linux process library is unavailable; run bun dev prepare or reinstall the runtime",
    )
    assert.equal(status.effectsStarted, false)
    assert.equal(await Bun.file(marker).exists(), false)
    assert.deepEqual(await coordinator.inspect(), [])
    break
  }
  if (Date.now() >= deadline) throw new Error("Execution never settled")
  await Bun.sleep(10)
}
console.log("unavailable without effects")
