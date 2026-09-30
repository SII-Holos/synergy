import assert from "node:assert/strict"
import path from "node:path"
import { OwnedProcess } from "../../../src/process/owned-process"
import { WorkspaceCoordinator } from "../../../src/workspace/coordinator"

const directory = process.argv[2]!
const launcher = path.join(directory, "launcher.ts")
const marker = path.join(directory, "activated")
await Bun.write(
  launcher,
  `import { OwnedProtocol } from ${JSON.stringify(path.resolve(import.meta.dir, "../../../src/process/owned-protocol.ts"))};
import { runOwnedProcessWorker } from ${JSON.stringify(path.resolve(import.meta.dir, "../../../src/process/owned-worker.ts"))};
const send = OwnedProtocol.send;
OwnedProtocol.send = (socket, value) => {
  send(socket, value);
  if (value && typeof value === "object" && "channel" in value && value.channel === "stderr")
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
};
await runOwnedProcessWorker(process.argv[3]);`,
)
process.env.SYNERGY_INSTALLATION_PIN = JSON.stringify({ id: crypto.randomUUID(), sha256: "a".repeat(64) })
process.env.SYNERGY_LAUNCHER_COMMAND = JSON.stringify([process.execPath, launcher])
const coordinator = new WorkspaceCoordinator({ directory: path.join(directory, "claims") })
const lease = await coordinator.acquire({
  id: "binding-failure",
  owner: "probe",
  ancestors: [],
  kind: "process",
  roots: [directory],
})
const failure = await OwnedProcess.prepare({
  command: process.execPath,
  args: ["-e", `await Bun.write(${JSON.stringify(marker)}, 'effect')`],
  cwd: directory,
  env: process.env,
  lease: {
    ...lease,
    async bindProcess() {
      throw new Error("binding unavailable")
    },
  },
}).then(
  async (process) => {
    await process.stop()
    throw new Error("Unbound command became ready")
  },
  (error: unknown) => error,
)
assert(failure instanceof Error)
assert.equal(failure.message, "binding unavailable")
assert.equal(await Bun.file(marker).exists(), false)
assert.deepEqual(await coordinator.inspect(), [])
console.log(JSON.stringify({ error: failure.message, activated: false, claims: 0 }))
