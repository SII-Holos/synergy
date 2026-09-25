#!/usr/bin/env bun
import assert from "node:assert/strict"
import path from "node:path"
import { readPackedArchives, withInstalledPackages } from "./package-install-check"

export async function checkInstalledComposition(archiveDirectory: string) {
  const archives = await readPackedArchives(archiveDirectory)
  const prefix = "@ericsanchezok/synergy-"
  const version = archives.find((pkg) => pkg.name === prefix + "cli")!.version
  await withInstalledPackages(archives, [prefix + "cli"], async (directory, installedEnv) => {
    const root = path.join(directory, "home/.synergy")
    const env = {
      ...installedEnv,
      SYNERGY_HOME: path.join(directory, "home"),
      SYNERGY_RUNTIME_ROOT: root,
      SYNERGY_TEST_HOME: path.join(directory, "home"),
      SYNERGY_LINK_HOME: path.join(directory, "link"),
      SYNERGY_BUN_EXECUTABLE: process.execPath,
      SYNERGY_FIXTURE_VERSION: version,
      SYNERGY_CONFIG_CONTENT: JSON.stringify({
        execution: { agentWorkerMinIdle: 0 },
        pluginMarketplace: { enabled: false },
        boss: { enabled: false },
      }),
    }
    async function run(command: string[], overrides: Record<string, string> = {}) {
      const child = Bun.spawn(command, {
        cwd: directory,
        env: { ...env, ...overrides },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
      const timeout = setTimeout(() => child.kill(), 180_000)
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        assert.equal(code, 0, `${command.slice(1).join(" ")} failed: ${stderr}\n${stdout}`)
        return stdout
      } finally {
        clearTimeout(timeout)
      }
    }
    const cli = (...args: string[]) =>
      run([process.execPath, path.join(directory, "node_modules/.bin/synergy"), ...args])
    const list = async () =>
      JSON.parse(await cli("list", "--json")) as Array<{ id: string; explicit: boolean; requiredBy: string[] }>
    assert.match(await cli("--help"), /send/)
    assert.deepEqual((await list()).map((pkg) => pkg.id).sort(), [])
    await cli("install", "mcp", "lsp", "server", "--trust-host-code")
    for (const id of ["mcp", "lsp", "server"]) assert.ok((await list()).some((pkg) => pkg.id === id && pkg.explicit))
    console.log("PASS installed CLI: core → independent MCP/LSP/HTTP")
    await Bun.write(
      path.join(directory, "managed-runtime.mjs"),
      await Bun.file(new URL("../test/package/fixture/managed-runtime.mjs", import.meta.url)).text(),
    )
    console.log((await run(["node", "managed-runtime.mjs"])).trim())
    await cli("update", "mcp", "--trust-host-code")
    await cli("remove", "mcp")
    assert.ok(!(await list()).some((pkg) => pkg.id === "mcp"))
    assert.ok((await list()).some((pkg) => pkg.id === "lsp"))
    await cli("remove", "lsp", "server")

    const preset = path.join(directory, "company-preset")
    const packages = { [prefix + "mcp"]: version, [prefix + "lsp"]: version }
    await Bun.write(
      path.join(preset, "package.json"),
      JSON.stringify({
        name: "company-agent-preset",
        version: "1.0.0",
        dependencies: packages,
        synergy: {
          formatVersion: 1,
          kind: "preset",
          id: "company-agent",
          version: "1.0.0",
          compatibility: { synergy: version },
          packages,
        },
      }),
    )
    await cli("install", preset, "--trust-host-code")
    assert.ok(
      (await list()).some(
        (pkg) => pkg.id === "mcp" && !pkg.explicit && pkg.requiredBy.includes("company-agent-preset"),
      ),
    )
    await cli("remove", "company-agent")
    assert.deepEqual((await list()).map((pkg) => pkg.id).sort(), [])
    console.log("PASS installed CLI: update/remove and company preset dependency pruning")

    const component = path.join(directory, "company-settings")
    await Bun.write(
      path.join(component, "package.json"),
      JSON.stringify({
        name: "company-settings-component",
        version: "1.0.0",
        type: "module",
        exports: { "./component": "./index.js" },
        peerDependencies: { [prefix + "harness"]: version },
        dependencies: { zod: "4.1.8" },
        synergy: {
          formatVersion: 1,
          kind: "component",
          id: "company-settings",
          version: "1.0.0",
          compatibility: { synergy: version },
          apiVersion: 1,
          entry: "./index.js",
          export: "companySettings",
          requires: { "local-runtime": version },
        },
      }),
    )
    await Bun.write(
      path.join(component, "index.js"),
      `import {ConfigExtensions} from "@ericsanchezok/synergy-harness/config";
import {z} from "zod";
export function companySettings() { return { id: "company-settings", version: "1.0.0", apiVersion: 1, requires: {"local-runtime": ${JSON.stringify(version)}}, register() { ConfigExtensions.register("company-settings", {shape:{company: z.object({team:z.string()}).optional()}}); } }; }`,
    )
    await cli("install", component, "--trust-host-code")
    assert.ok((await list()).some((pkg) => pkg.id === "company-settings"))
    assert.ok((await Bun.file(path.join(root, "schema/config.schema.json")).json()).properties.company)
    await cli("remove", "company-settings")
    await list()
    assert.ok(!(await Bun.file(path.join(root, "schema/config.schema.json")).json()).properties.company)
    console.log("PASS installed CLI: company component registers and removes its active schema")

    await cli("install", "web", "--trust-host-code")
    const selected = await list()
    for (const id of ["web", "full", "web-app", "mcp", "lsp", "browser-runtime", "library", "server"])
      assert.ok(
        selected.some((pkg) => pkg.id === id),
        `Web preset missing ${id}`,
      )
    console.log((await run(["node", "managed-runtime.mjs"], { SYNERGY_FIXTURE_WEB: "1" })).trim())
    await cli("remove", "web")
    assert.deepEqual((await list()).map((pkg) => pkg.id).sort(), [])
    console.log("PASS installed CLI: Web/full installation and return to core preserve the Home")
  })
}

if (import.meta.main) await checkInstalledComposition(path.resolve(process.argv[2] ?? ".artifacts/packages"))
