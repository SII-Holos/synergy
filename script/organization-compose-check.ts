#!/usr/bin/env bun
import { mkdtemp, mkdir, rm, chmod } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const image = process.argv[2]
if (!image) throw new Error("Usage: bun script/organization-compose-check.ts <built organization image>")
const directory = await mkdtemp(path.join(os.tmpdir(), "synergy-org-compose-"))
const bootstrapDirectory = path.join(directory, "bootstrap")
const project = `synergy-org-test-${crypto.randomUUID()}`
const args = [
  "docker",
  "compose",
  "-f",
  path.resolve(import.meta.dir, "../packages/organization/deploy/compose.yml"),
  "-p",
  project,
]
const env = {
  ...process.env,
  SYNERGY_ORGANIZATION_IMAGE: image,
  SYNERGY_ORGANIZATION_ORIGIN: "https://organization.example",
  SYNERGY_ORGANIZATION_BOOTSTRAP: bootstrapDirectory,
  SYNERGY_ORGANIZATION_PORT: "0",
}
async function compose(command: string[]) {
  const child = Bun.spawn([...args, ...command], { env, stdout: "pipe", stderr: "pipe" })
  const timeout = setTimeout(() => child.kill("SIGTERM"), 120_000)
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (code) throw new Error(`Compose ${command[0]} failed: ${stderr}`)
    return stdout
  } finally {
    clearTimeout(timeout)
  }
}
try {
  await mkdir(bootstrapDirectory, { mode: 0o777 })
  await chmod(bootstrapDirectory, 0o777)
  await compose(["config", "--quiet"])
  await compose(["run", "--rm", "initialize"])
  const bootstrap = JSON.parse(
    await compose([
      "run",
      "--rm",
      "--entrypoint",
      "bun",
      "initialize",
      "--no-install",
      "-e",
      "console.log(await Bun.file('/bootstrap/initialization.json').text())",
    ]),
  )
  for (let iteration = 0; iteration < 2; iteration++) {
    await compose(iteration ? ["restart", "organization"] : ["up", "-d", "--wait", "organization"])
    const address = (await compose(["port", "organization", "4080"])).trim()
    let healthy = false
    for (let attempt = 0; attempt < 60; attempt++) {
      const response = await fetch(`http://${address}/org/v1/ready`).catch(() => undefined)
      if (response?.ok && (await response.json()).ready === true) {
        healthy = true
        break
      }
      await Bun.sleep(500)
    }
    if (!healthy) throw new Error("Organization Compose readiness did not settle")
    const logs = await compose(["logs", "--no-color", "organization"])
    if (!logs.includes(bootstrap.orgID) || !logs.includes('"executesAgents":false'))
      throw new Error("Organization Compose deployment identity did not survive restart")
    if (logs.includes(bootstrap.token)) throw new Error("Organization Compose exposed its bootstrap secret")
  }
  console.log("Organization Compose initialization, readiness and persistent restart passed")
} finally {
  try {
    await compose(["down", "--volumes", "--remove-orphans"])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
