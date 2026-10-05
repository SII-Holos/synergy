import assert from "node:assert/strict"
import path from "node:path"
import { text } from "node:stream/consumers"
import { openAgentRuntime } from "@ericsanchezok/synergy-agent-runtime"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { createLocalHost } from "@ericsanchezok/synergy-local-runtime"
import { OwnedProcess } from "@ericsanchezok/synergy-local-runtime/process/owned-process"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { InstallationGenerations } from "@ericsanchezok/synergy-plugin-host/installation/generations"

const root = process.env.SYNERGY_RUNTIME_ROOT!
const generation = await InstallationGenerations.current(root)
assert.ok(generation)
process.env.SYNERGY_INSTALLATION_PIN = JSON.stringify({ id: generation.id, sha256: generation.sha256 })
process.env.SYNERGY_INSTALLATION_ROOT = root
process.env.SYNERGY_LAUNCHER_COMMAND = JSON.stringify([
  process.execPath,
  path.join(process.cwd(), "node_modules/.bin/synergy"),
])
const host = createLocalHost()
const runtime = await openAgentRuntime({
  host,
  home: host.root,
  mode: "oneshot",
  components: [localRuntime({ workers: false })],
})
try {
  await runtime.run(() =>
    WorkspaceAccess.withinTask(async () => {
      const lease = await WorkspaceAccess.process([process.cwd()])
      const processHandle = await OwnedProcess.prepare({
        command: process.execPath,
        args: [
          "-e",
          "let bytes=0; const hash=new Bun.CryptoHasher('sha256'); for await (const chunk of Bun.stdin.stream()) {bytes+=chunk.length; hash.update(chunk)}; console.log(JSON.stringify({bytes,sha256:hash.digest('hex')}))",
        ],
        cwd: process.cwd(),
        env: {},
        ownership: lease,
      })
      try {
        const output = text(processHandle.child.stdout)
        const error = text(processHandle.child.stderr)
        await processHandle.activate()
        const bytes = Buffer.alloc(16 * 1024 * 1024 + 137)
        for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251
        processHandle.child.stdin.end(bytes)
        await processHandle.completion
        assert.equal(processHandle.child.exitCode, 0, await error)
        assert.deepEqual(JSON.parse(await output), {
          bytes: bytes.length,
          sha256: Bun.CryptoHasher.hash("sha256", bytes, "hex"),
        })
      } finally {
        await processHandle.stop()
      }
    }),
  )
} finally {
  await runtime.close()
}
console.log("PASS installed native worker: verified launcher, complete input bytes, process and Runtime drainage")
