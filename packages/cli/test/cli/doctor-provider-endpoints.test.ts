import { expect, test } from "bun:test"
import yargs from "yargs"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { registerLocalRuntime } from "@ericsanchezok/synergy-runtime-local/register"
import { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { DoctorCommand } from "../../src/cli/cmd/doctor"
import { UI } from "../../src/util/ui"

registerLocalRuntime()
const invoke = (args: string[]) => yargs(args).exitProcess(false).command(DoctorCommand).parseAsync()

// Doctor's provider endpoint probes read their own providers, so this case points a single
// provider at loopback over plain HTTP: no DNS, no TLS handshake, and no external network.
test("doctor reports provider endpoint routing and TLS checks", async () => {
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
    await Config.domainUpdate(
      "providers",
      {
        provider: {
          "endpoint-fixture": {
            npm: "@ai-sdk/openai-compatible",
            name: "Endpoint fixture",
            options: { apiKey: "local-test-key", baseURL: "http://127.0.0.1:1/v1" },
            models: { "fixture-model": { name: "Fixture model", limit: { context: 8192, output: 1024 } } },
          },
        },
      },
      { mode: "replace-domain" },
    )
    await Provider.reload()
    await invoke(["doctor"])
    const output = messages.join("")
    expect(output).toContain("Synergy Doctor")
    expect(output).toContain("Provider endpoint checks")
    expect(output).toContain("Provider endpoint routing")
    expect(output).toContain("Provider endpoint TLS")
    expect(output).toContain("Sandbox checks")
    expect(output).not.toContain("could not be read")

    messages.length = 0
    console.log = log
    process.stdout.write = write
    UI.error = error
    UI.println = println
    await Config.domainUpdate("providers", config, { mode: "replace-domain" })
    await Provider.reload()
  } finally {
    process.exitCode = exitCode ?? 0
    process.chdir(cwd)
    console.log = log
    process.stdout.write = write
    UI.error = error
    UI.println = println
    await Config.domainUpdate("providers", config, { mode: "replace-domain" })
    await Provider.reload()
  }
}, 60000)
