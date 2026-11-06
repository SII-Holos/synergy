import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { InstallationGenerations } from "@ericsanchezok/synergy-plugin-host/installation/generations"
import { version } from "../package.json" with { type: "json" }

const launcher = fileURLToPath(new URL("../src/launcher.ts", import.meta.url))

test("metadata runners receive early IPC after registering and retain their context until shutdown", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-component-runner-"))
  let child: Bun.Subprocess | undefined
  try {
    const directory = await InstallationGenerations.stage(home)
    const modules = path.join(directory, "node_modules/@ericsanchezok")
    await Bun.write(
      path.join(modules, "synergy-cli/package.json"),
      JSON.stringify({ name: "@ericsanchezok/synergy-cli", version, exports: { "./index": "./index.ts" } }),
    )
    await Bun.write(
      path.join(modules, "synergy-cli/index.ts"),
      await Bun.file(new URL("../src/index.ts", import.meta.url)).text(),
    )
    await Bun.write(
      path.join(modules, "synergy-harness/package.json"),
      JSON.stringify({
        name: "@ericsanchezok/synergy-harness",
        version,
        exports: { "./lifecycle": "./context.js", "./lifecycle/context": "./context.js", "./global": "./global.js" },
      }),
    )
    await Bun.write(
      path.join(modules, "synergy-harness/context.js"),
      'export const RuntimeContext = {create: () => ({run: callback => callback(), dispose: () => process.send({type:"disposed"})})}',
    )
    await Bun.write(
      path.join(modules, "synergy-harness/global.js"),
      "export const Global = {initialize: async () => {}}",
    )
    await Bun.write(
      path.join(modules, "synergy-local-runtime/package.json"),
      JSON.stringify({ name: "@ericsanchezok/synergy-local-runtime", version, exports: { "./host": "./host.js" } }),
    )
    await Bun.write(path.join(modules, "synergy-local-runtime/host.js"), "export const createLocalHost = () => ({})")
    await Bun.write(
      path.join(directory, "reader/runner.js"),
      'export function main() { return new Promise(resolve => { process.on("message", message => { process.send({type:"echo",message,pid:process.pid}); if(message.type === "shutdown") resolve(); }); process.send({type:"registered"}); }); }',
    )
    const generation = await InstallationGenerations.commit(home, {
      directory,
      hostVersion: version,
      roots: {},
      trustHostCode: true,
      packages: {
        reader: {
          directory: "reader",
          version,
          spec: version,
          metadata: {
            formatVersion: 1,
            apiVersion: 1,
            kind: "component",
            id: "reader",
            version,
            compatibility: { synergy: "*" },
            entry: "./runner.js",
            export: "main",
            runners: { "fixture-runner": { entry: "./runner.js", export: "main" } },
          },
        },
      },
    })
    const messages: unknown[] = []
    child = Bun.spawn([process.execPath, launcher, "__fixture-runner"], {
      env: {
        ...process.env,
        SYNERGY_HOME: home,
        SYNERGY_RUNTIME_ROOT: home,
        SYNERGY_INSTALLATION_ROOT: home,
        SYNERGY_INSTALLATION_PIN: JSON.stringify({ id: generation.id, sha256: generation.sha256 }),
      },
      stdout: "ignore",
      stderr: "pipe",
      serialization: "advanced",
      ipc: (message) => messages.push(message),
    })
    const stderr = new Response(child.stderr as ReadableStream<Uint8Array>).text()
    child.send({ type: "start" })
    const deadline = Date.now() + 3000
    while (
      !messages.some((message) => JSON.stringify(message).includes('"start"')) &&
      Date.now() < deadline &&
      child.exitCode === null
    )
      await Bun.sleep(10)
    if (child.exitCode !== null) throw new Error(await stderr)
    expect(messages).toContainEqual({ type: "registered" })
    expect(messages).toContainEqual({ type: "echo", message: { type: "start" }, pid: child.pid })
    expect(messages).not.toContainEqual({ type: "disposed" })
    child.send({ type: "shutdown" })
    expect(await child.exited, await stderr).toBe(0)
    expect(messages).toContainEqual({ type: "disposed" })
  } finally {
    child?.kill("SIGKILL")
    await child?.exited
    await fs.rm(home, { recursive: true, force: true })
  }
}, 10000)
