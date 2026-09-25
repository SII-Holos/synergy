import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { InstallationGenerations } from "@ericsanchezok/synergy-plugin-host/installation/generations"
import { version } from "../package.json" with { type: "json" }

const launcher = fileURLToPath(new URL("../src/launcher.ts", import.meta.url))

test("an installed worker cannot bootstrap an unpinned home", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-unpinned-worker-"))
  try {
    const child = Bun.spawn([process.execPath, launcher, "__owned-process-runner", "unused"], {
      env: { ...process.env, SYNERGY_HOME: home, SYNERGY_RUNTIME_ROOT: home, SYNERGY_INSTALLATION_PIN: undefined },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(code).toBe(1)
    expect(stderr).toContain("requires its parent installation pin")
    expect(await fs.readdir(home)).toEqual([])
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test("the launcher verifies modules before import and workers retain the foreground generation", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-launcher-"))
  const root = path.join(home, ".synergy")
  async function generation(tag: string, previous?: string) {
    const directory = await InstallationGenerations.stage(root)
    const modules = path.join(directory, "node_modules/@ericsanchezok")
    await Bun.write(
      path.join(modules, "synergy-harness/package.json"),
      JSON.stringify({ name: "@ericsanchezok/synergy-harness", version, exports: { "./lifecycle": "./lifecycle.js" } }),
    )
    await Bun.write(
      path.join(modules, "synergy-harness/lifecycle.js"),
      'throw new Error("Harness must not load during verification")',
    )
    await Bun.write(
      path.join(modules, "synergy-cli/package.json"),
      JSON.stringify({ name: "@ericsanchezok/synergy-cli", version, exports: { "./index": "./index.js" } }),
    )
    await Bun.write(
      path.join(modules, "synergy-cli/index.js"),
      `export async function main(components, ready) { console.log(JSON.stringify({tag:${JSON.stringify(tag)},version:globalThis.SYNERGY_VERSION,pin:JSON.parse(process.env.SYNERGY_INSTALLATION_PIN),command:JSON.parse(process.env.SYNERGY_LAUNCHER_COMMAND)})); if(process.send) { process.on("message", message => process.send({echo:message})); ready?.(); process.send({tag:${JSON.stringify(tag)}}); } }`,
    )
    return InstallationGenerations.commit(root, {
      directory,
      previous,
      hostVersion: version,
      roots: {},
      packages: {},
      trustHostCode: true,
    })
  }
  async function run(pin?: { id: string; sha256: string }, command = [Bun.argv[0], launcher]) {
    const messages: unknown[] = []
    const process = Bun.spawn([...command, ...(pin ? ["__storage-worker-runner"] : [])], {
      env: {
        ...globalThis.process.env,
        SYNERGY_HOME: home,
        SYNERGY_RUNTIME_ROOT: root,
        SYNERGY_INSTALLATION_PIN: pin ? JSON.stringify(pin) : undefined,
        SYNERGY_INSTALLATION_ROOT: root,
      },
      ...(pin ? { ipc: (message: unknown) => messages.push(message) } : {}),
      serialization: "advanced",
      stdout: "pipe",
      stderr: "pipe",
    })
    if (pin) process.send({ early: true })
    const [code, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ])
    return { code, stdout, stderr, messages }
  }
  try {
    const first = await generation("first")
    const second = await generation("second", first.id)
    const foreground = await run()
    expect(foreground.code).toBe(0)
    expect(JSON.parse(foreground.stdout)).toMatchObject({ tag: "second", version, pin: { id: second.id } })
    const worker = await run({ id: first.id, sha256: first.sha256 }, JSON.parse(foreground.stdout).command)
    expect(worker.code, worker.stderr).toBe(0)
    expect(worker.messages).toContainEqual({ tag: "first" })
    expect(worker.messages).toContainEqual({ echo: { early: true } })
    expect(JSON.parse(worker.stdout)).toMatchObject({ tag: "first", pin: { id: first.id } })
    await Bun.write(
      path.join(first.directory, "node_modules/@ericsanchezok/synergy-cli/index.js"),
      'console.log("unverified-code")',
    )
    const tampered = await run({ id: first.id, sha256: first.sha256 })
    expect(tampered.code).not.toBe(0)
    expect(tampered.stdout).toBe("")
    expect(tampered.stderr).toContain("integrity mismatch")
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
}, 15_000)
