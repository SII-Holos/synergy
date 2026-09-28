import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { OwnedProcess } from "../../../src/process/owned-process"
import { WorkspaceCoordinator } from "../../../src/workspace/coordinator"

const directory = process.argv[2]!
const launcher = path.join(directory, "launcher.ts")
const marker = path.join(directory, "activated")
await Bun.write(launcher, "process.stderr.write('supervisor-init-failed:' + 'x'.repeat(16384)); process.exit(27)")
process.env.SYNERGY_INSTALLATION_PIN = JSON.stringify({ id: crypto.randomUUID(), sha256: "a".repeat(64) })
process.env.SYNERGY_LAUNCHER_COMMAND = JSON.stringify([process.execPath, launcher])
const coordinator = new WorkspaceCoordinator({ directory: path.join(directory, "claims") })
const lease = await coordinator.acquire({
  id: "startup-exit",
  owner: "probe",
  ancestors: [],
  kind: "process",
  roots: [directory],
})
const abort = new AbortController()
const timer = setTimeout(() => abort.abort(new Error("Supervisor exit was not observed")), 5000)
try {
  const failure = await OwnedProcess.prepare({
    command: process.execPath,
    args: ["-e", `await Bun.write(${JSON.stringify(marker)},'effect')`],
    cwd: directory,
    env: process.env,
    lease,
    signal: abort.signal,
  }).then(
    async (process) => {
      await process.stop()
      throw new Error("Failed supervisor became ready")
    },
    (error: unknown) => error,
  )
  assert(failure instanceof Error)
  assert.match(failure.message, /Native process supervisor exited before startup.*27.*supervisor-init-failed/s)
  assert(failure.message.length < 5000)
  assert.equal(await Bun.file(marker).exists(), false)
  assert.deepEqual(await coordinator.inspect(), [])
  console.log(JSON.stringify({ error: "supervisor-init-failed", code: 27, activated: false, claims: 0 }))
} finally {
  clearTimeout(timer)
  await fs.rm(launcher, { force: true })
}
