import assert from "node:assert/strict"
import path from "node:path"
import { buffer } from "node:stream/consumers"
import fs from "node:fs"
import { NativePty } from "../../../src/process/native-pty"
import { OwnedProcess } from "../../../src/process/owned-process"
import { WorkspaceCoordinator } from "../../../src/workspace/coordinator"
import { FileRename } from "../../../src/file/rename"

const directory = process.argv[2]!
function stage(value: string) {
  fs.writeFileSync(path.join(directory, "stage.json"), JSON.stringify({ stage: value }))
}
stage("file-publication")
const source = path.join(directory, "source")
const destination = path.join(directory, "destination")
await Bun.write(source, "preserved")
FileRename.exclusive(source, destination)
assert.equal(await Bun.file(destination).text(), "preserved")
await Bun.write(source, "new")
assert.throws(() => FileRename.exclusive(source, destination), /changed|conflict/i)
assert.equal(await Bun.file(destination).text(), "preserved")
const coordinator = new WorkspaceCoordinator({ directory: path.join(directory, "claims") })
const lease = await coordinator.acquire({
  id: "binding-probe",
  owner: "probe",
  ancestors: [],
  kind: "process",
  roots: [directory],
})
stage("prepare-owned-process")
const owned = await OwnedProcess.prepare({
  command: process.execPath,
  args: ["-e", "process.stdout.write('owned-output'); process.stderr.write('owned-error')"],
  cwd: directory,
  env: process.env,
  ownership: lease,
})
const stdout = buffer(owned.child.stdout),
  stderr = buffer(owned.child.stderr)
try {
  stage("activate-owned-process")
  await owned.activate()
  stage("complete-owned-process")
  await owned.completion
  assert.equal((await stdout).toString(), "owned-output")
  assert.equal((await stderr).toString(), "owned-error")
  assert.equal(owned.child.exitCode, 0)
  assert.deepEqual(await coordinator.inspect(), [])
} finally {
  await owned.stop()
}
stage("spawn-terminal")
const terminal = NativePty.spawn({
  command: process.execPath,
  args: ["-e", "process.stdout.write('terminal-output')"],
  cwd: directory,
  env: { PATH: process.env.PATH ?? "" },
})
try {
  terminal.resize(91, 32)
  const output = (await buffer(terminal.stdout)).toString()
  if (process.platform === "win32") assert.equal(output.split("terminal-output").length, 2)
  else assert.equal(output, "terminal-output")
  assert.equal(await terminal.exited, 0)
} finally {
  terminal.close()
}
stage("completed")
console.log(JSON.stringify({ jit: process.env.BUN_JSC_useJIT, files: true, process: true, terminal: true }))
