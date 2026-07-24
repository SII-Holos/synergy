import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { copyHolosCliAsset, HOLOS_CLI_RUNTIME_PATH } from "../../script/holos-cli-assets"
import { createClarusCliRunner, resolveClarusCliEntry } from "../../src/channel/provider/clarus/cli-runner"
import { Global } from "../../src/global"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  )
})

async function cliFixture(contents: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-clarus-cli-fixture-"))
  temporaryDirectories.push(directory)
  const entry = path.join(directory, "index.js")
  await fs.writeFile(entry, contents)
  return entry
}

describe("Clarus CLI runner", () => {
  test("prefers the CLI asset adjacent to an installed Synergy runtime", async () => {
    const runtime = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-clarus-cli-runtime-"))
    temporaryDirectories.push(runtime)
    const executable = path.join(runtime, "bin", "synergy")
    await fs.mkdir(path.dirname(executable), { recursive: true })
    await fs.writeFile(executable, "")
    copyHolosCliAsset(runtime)

    expect(resolveClarusCliEntry(executable)).toBe(path.join(runtime, HOLOS_CLI_RUNTIME_PATH, "index.js"))
  })

  test("resolves the package dependency while running from source", () => {
    expect(resolveClarusCliEntry()).toEndWith(path.join("@sii-holos", "holos-cli", "dist", "index.js"))
  })

  test("isolates the child environment and removes credential files", async () => {
    const entry = await cliFixture(`
      import { readFile } from "node:fs/promises"
      const configIndex = process.argv.indexOf("--config")
      const config = JSON.parse(await readFile(process.argv[configIndex + 1], "utf8"))
      console.log(JSON.stringify({ secretEnv: process.env.SYNERGY_SECRET_TEST, bun: process.env.BUN_BE_BUN, agentId: config.agent_id, configPath: process.argv[configIndex + 1] }))
    `)
    const stale = path.join(Global.Path.state, `clarus-cli-stale-${crypto.randomUUID()}`)
    await fs.mkdir(stale, { recursive: true })
    await fs.writeFile(path.join(stale, "config.json"), "stale-secret")
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await fs.utimes(stale, old, old)
    process.env.SYNERGY_SECRET_TEST = "must-not-cross-boundary"
    try {
      const runner = createClarusCliRunner({
        apiUrl: "https://example.invalid",
        credential: { agentId: "agent-1", agentSecret: "agent-secret" },
        entry,
      })

      const result = (await runner.json(["runtime", "info", "run-1"])) as {
        bun: string
        agentId: string
        configPath: string
      }
      expect(result).toMatchObject({ bun: "1", agentId: "agent-1" })
      expect(result).not.toHaveProperty("secretEnv")
      expect(await fs.stat(result.configPath).catch(() => undefined)).toBeUndefined()
      expect(await fs.stat(stale).catch(() => undefined)).toBeUndefined()
    } finally {
      delete process.env.SYNERGY_SECRET_TEST
      await fs.rm(stale, { recursive: true, force: true })
    }
  })

  test("does not expose CLI stderr or credentials in errors", async () => {
    const entry = await cliFixture(`
      console.error("agent-secret /private/clarus-cli/config.json")
      process.exit(7)
    `)
    const runner = createClarusCliRunner({
      apiUrl: "https://example.invalid",
      credential: { agentId: "agent-1", agentSecret: "agent-secret" },
      entry,
    })

    await expect(runner.json([])).rejects.toThrow("Holos CLI failed with exit code 7")
    await expect(runner.json([])).rejects.not.toThrow("agent-secret")
  })
})
