import fs from "node:fs/promises"
import path from "node:path"
import { InstallationGenerations } from "../../../src/installation/generations"
import { version } from "../../../package.json" with { type: "json" }

export async function startupInstallation(home: string, bootstrapURL: string, activationURL: string) {
  const directory = await InstallationGenerations.stage(home)
  const modules = path.join(directory, "node_modules/@ericsanchezok")
  for (const [name, exports] of Object.entries({
    "synergy-cli": { "./index": "./index.ts" },
    "synergy-harness": {
      "./lifecycle": "./context.js",
      "./lifecycle/context": "./context.js",
      "./global": "./global.js",
    },
    "synergy-local-runtime": { "./host": "./host.js" },
    "synergy-util": { "./installed-launcher": "./installed-launcher.ts" },
    "synergy-plugin-host": { "./plugin-runtime/runner": "./runner.ts" },
  })) {
    await Bun.write(
      path.join(modules, name, "package.json"),
      JSON.stringify({ name: `@ericsanchezok/${name}`, version, exports }),
    )
  }
  await Bun.write(
    path.join(modules, "synergy-cli/index.ts"),
    Bun.file(new URL("../../../../cli/src/index.ts", import.meta.url)),
  )
  await Bun.write(
    path.join(modules, "synergy-util/installed-launcher.ts"),
    'export const CORE_RUNNERS = ["plugin-runtime-runner"]',
  )
  await Bun.write(
    path.join(modules, "synergy-harness/context.js"),
    "export const RuntimeContext = {create: () => ({run: callback => callback()})}",
  )
  await Bun.write(path.join(modules, "synergy-local-runtime/host.js"), "export const createLocalHost = () => ({})")
  await Bun.write(
    path.join(modules, "synergy-harness/global.js"),
    `export const Global = {initialize: async () => { await (await fetch(${JSON.stringify(bootstrapURL)})).text() }}`,
  )
  for (const name of ["runner", "protocol", "context-factory"]) {
    await Bun.write(
      path.join(modules, `synergy-plugin-host/${name}.ts`),
      Bun.file(new URL(`../../../src/plugin-runtime/${name}.ts`, import.meta.url)),
    )
  }
  const entryPath = path.join(home, "plugin.ts")
  await Bun.write(
    entryPath,
    `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(path.join(home, "entry"))}, ${JSON.stringify("entry\n")}); export default {id:"startup-fixture",version:"1.0.0",handlerIds:[],contributions:[],async activate(){fs.appendFileSync(${JSON.stringify(path.join(home, "activations"))}, ${JSON.stringify("activate\n")}); await (await fetch(${JSON.stringify(activationURL)})).text()}}`,
  )
  const generation = await InstallationGenerations.commit(home, {
    directory,
    hostVersion: version,
    roots: {},
    packages: {},
    trustHostCode: true,
  })
  return {
    generation,
    entryPath,
    tamper: () =>
      fs.appendFile(
        path.join(generation.directory, "node_modules/@ericsanchezok/synergy-harness/global.js"),
        "\nthrow new Error('tampered')",
      ),
  }
}
