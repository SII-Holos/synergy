import { expect, test } from "bun:test"
import yargs from "yargs"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Global } from "@ericsanchezok/synergy-harness/global"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { registerLocalRuntime } from "@ericsanchezok/synergy-runtime-local/register"
import { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { ModelsCommand } from "../../src/cli/cmd/models"
import { DoctorCommand } from "../../src/cli/cmd/doctor"
import { DebugCommand } from "../../src/cli/cmd/debug"
import path from "node:path"
import { UI } from "../../src/util/ui"

registerLocalRuntime()
const invoke = (args: string[]) =>
  yargs(args).exitProcess(false).command(ModelsCommand).command(DoctorCommand).command(DebugCommand).parseAsync()

test("read-only CLI commands inspect the real isolated workspace and return provider metadata", async () => {
  await using tmp = await tmpdir({ git: true })
  const exitCode = process.exitCode
  const cwd = process.cwd()
  const log = console.log
  const write = process.stdout.write
  const error = UI.error
  const println = UI.println
  const messages: string[] = []
  const config = await Config.domainGet("providers")
  console.log = (...args) => {
    messages.push(args.map(String).join(" "))
  }
  process.stdout.write = ((chunk: string | Uint8Array) => {
    messages.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  UI.error = (message) => {
    messages.push(message)
  }
  UI.println = (...args) => {
    messages.push(args.join(" "))
  }
  try {
    process.chdir(tmp.path)
    await Bun.write(path.join(tmp.path, "evidence.txt"), "research-evidence\n")
    await invoke(["debug", "paths"])
    expect(messages.join("")).toContain(Global.Path.data)
    messages.length = 0
    await invoke(["debug", "rg", "files", "--glob", "*.txt", "--limit", "1"])
    expect(messages.join("")).toContain("evidence.txt")
    messages.length = 0
    await invoke(["debug", "rg", "tree", "--limit", "3"])
    expect(messages.join("")).toContain("evidence.txt")
    messages.length = 0
    await invoke(["debug", "rg", "search", "research-evidence", "--glob", "*.txt", "--limit", "1"])
    expect(messages.join("")).toContain("research-evidence")
    messages.length = 0
    await invoke(["debug", "file", "tree", tmp.path])
    expect(messages.join("")).toContain("evidence.txt")
    messages.length = 0
    await invoke(["debug", "file", "read", "evidence.txt"])
    expect(messages.join("")).toContain("research-evidence")
    messages.length = 0
    await invoke(["debug", "file", "list", "."])
    expect(messages.join("")).toContain("evidence.txt")
    messages.length = 0
    await invoke(["debug", "file", "search", "evidence"])
    expect(messages.join("")).toContain("evidence.txt")
    messages.length = 0
    await invoke(["debug", "file", "status"])
    expect(messages.join("")).toContain("evidence.txt")
    messages.length = 0
    await invoke(["debug", "agent", "synergy"])
    expect(messages.join("")).toContain('"name": "synergy"')
    messages.length = 0
    await Config.domainUpdate(
      "providers",
      {
        provider: {
          "research-fixture": {
            npm: "@ai-sdk/openai-compatible",
            name: "Research fixture",
            options: { apiKey: "local-test-key", baseURL: "http://127.0.0.1:1/v1" },
            models: { "fixture-model": { name: "Fixture model", limit: { context: 8192, output: 1024 } } },
          },
        },
      },
      { mode: "replace-domain" },
    )
    await Provider.reload()
    await invoke(["models", "research-fixture", "--verbose"])
    expect(messages.join("")).toContain("research-fixture/fixture-model")
    expect(messages.join("")).toContain('"context": 8192')
    messages.length = 0
    await invoke(["models"])
    expect(messages.join("")).toContain("research-fixture/fixture-model")
    messages.length = 0
    await invoke(["models", "missing-read-command-provider"])
    expect(messages.join("")).toContain("Provider not found")
    messages.length = 0
    await invoke(["doctor"])
    expect(messages.join("")).toContain("Synergy Doctor")
    expect(messages.join("")).toContain("Sandbox checks")
    expect(messages.join("")).toContain("Installation")
  } finally {
    process.exitCode = exitCode ?? 0
    process.chdir(cwd)
    console.log = log
    process.stdout.write = write
    UI.println = println
    UI.error = error
    await Config.domainUpdate("providers", config, { mode: "replace-domain" })
    await Provider.reload()
  }
}, 30000)
