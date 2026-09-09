import { describe, expect, test } from "bun:test"
import { createIsolatedTestEnv } from "@ericsanchezok/synergy-testing/env"
import path from "node:path"

async function invoke(argv: string[]) {
  const isolation = await createIsolatedTestEnv()
  try {
    const child = Bun.spawn(
      [process.execPath, "run", path.resolve(import.meta.dirname, "../../src/index.ts"), ...argv],
      {
        cwd: path.resolve(import.meta.dirname, "../.."),
        env: isolation.env,
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { stdout, stderr, code }
  } finally {
    await isolation.dispose()
  }
}

describe("standalone CLI composition", () => {
  test("no arguments prints core help without starting a server", async () => {
    const result = await invoke([])
    expect(result.code).toBe(0)
    expect(result.stdout + result.stderr).toContain("send [message..]")
    expect(result.stdout + result.stderr).not.toContain("start synergy server")
  })

  test("uninstalled product commands fail clearly", async () => {
    const result = await invoke(["browser"])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Command "browser" is unavailable in this installation.')
  })
})

test("command-loading failures set nonzero status and leave no process listeners", async () => {
  const { runCli } = await import("../../src/main")
  const originalExitCode = process.exitCode
  const originalError = console.error
  const errors: unknown[] = []
  const listeners = process.listenerCount("uncaughtException")
  console.error = (...args) => {
    errors.push(...args)
  }
  try {
    await runCli({
      argv: ["server"],
      runtimeFactory: async () => {
        throw new Error("runtime should not start")
      },
      commands: [
        {
          command: "server",
          describe: "test server",
          load: async () => {
            throw new Error("command load failed")
          },
        },
      ],
    })
    expect(process.exitCode).toBe(1)
    expect(errors.map(String).join(" ")).toContain("command load failed")
    expect(process.listenerCount("uncaughtException")).toBe(listeners)
  } finally {
    process.exitCode = originalExitCode ?? 0
    console.error = originalError
  }
})

test("host contributes its default command without loading unselected commands", async () => {
  const { runCli } = await import("../../src/main")
  const calls: string[] = []
  await runCli({
    argv: [],
    defaultCommand: "server",
    beforeCommand: async (command) => {
      calls.push(`before:${command}`)
    },
    runtimeFactory: async () => {
      throw new Error("runtime factory belongs to the selected command")
    },
    commands: [
      {
        command: ["$0", "server"],
        describe: "test server",
        load: async () => {
          calls.push("load:server")
          return {
            command: ["$0", "server"],
            handler: () => {
              calls.push("run:server")
            },
          }
        },
      },
      {
        command: "browser",
        describe: "test browser",
        load: async () => {
          throw new Error("unselected loader ran")
        },
      },
    ],
  })
  expect(calls).toEqual(["before:server", "load:server", "run:server"])
})

test("source entry is importable and dispatches ordinary help without a worker or runtime", async () => {
  const { main, runCoreWorker } = await import("../../src/index")
  const argv = process.argv
  const exit = process.exitCode
  const write = process.stderr.write
  const stdout = process.stdout.write
  const output: string[] = []
  const capture = ((chunk: string | Uint8Array) => {
    output.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  try {
    process.argv = [process.execPath, "synergy", "--help"]
    process.stderr.write = capture
    process.stdout.write = capture
    expect(await runCoreWorker()).toBe(false)
    await main()
    expect(process.exitCode ?? 0).toBe(exit ?? 0)
  } finally {
    process.argv = argv
    process.exitCode = exit ?? 0
    process.stderr.write = write
    process.stdout.write = stdout
  }
})

test("the single parser accepts host-owned data commands and rejects namespace collisions", async () => {
  const { runCli } = await import("../../src/main")
  const exit = process.exitCode
  const errors: unknown[] = []
  const error = console.error
  const invoked: string[] = []
  console.error = (...args) => {
    errors.push(...args)
  }
  try {
    await runCli({
      argv: ["--log-level", "ERROR", "data", "custom"],
      runtimeFactory: async () => {
        throw new Error("unused runtime")
      },
      dataCommands: async () => [
        {
          command: "custom",
          handler: () => {
            invoked.push("data-custom")
          },
        },
      ],
    })
    expect(invoked).toEqual(["data-custom"])
    await runCli({
      argv: ["--help"],
      runtimeFactory: async () => {
        throw new Error("unused runtime")
      },
      pluginCommands: async () => [{ command: "send", handler() {} }],
    })
    expect(process.exitCode).toBe(1)
    expect(errors.map(String).join(" ")).toContain("namespace send conflicts")
    expect(process.listenerCount("uncaughtException")).toBe(0)
  } finally {
    console.error = error
    process.exitCode = exit ?? 0
  }
})

test("selected command failures preserve error messages, exit status, and listener cleanup", async () => {
  const { runCli } = await import("../../src/main")
  const { Provider } = await import("@ericsanchezok/synergy-harness/provider/provider")
  const { UI } = await import("../../src/util/ui")
  const { ConfigDomain } = await import("@ericsanchezok/synergy-harness/config/domain")
  const errors: string[] = []
  const originalError = UI.error
  const consoleError = console.error
  const exitCode = process.exitCode
  const configPath = ConfigDomain.filepath("general")
  const previousConfig = await Bun.file(configPath)
    .text()
    .catch(() => undefined)
  const listeners = process.listenerCount("unhandledRejection")
  UI.error = (message) => errors.push(message)
  console.error = (...args) => errors.push(args.map(String).join(" "))
  try {
    await Bun.write(configPath, '{"logLevel":"WARN"}')
    for (const failure of [
      new Provider.ModelNotFoundError({ providerID: "fixture", modelID: "missing" }),
      new Error("command fixture failed"),
      "non-error failure",
    ]) {
      process.exitCode = 0
      await runCli({
        argv: ["--log-level", "ERROR", "inspect-fixture"],
        runtimeFactory: async () => {
          throw new Error("unneeded runtime")
        },
        commands: [
          {
            command: "inspect-fixture",
            describe: "inspect fixture",
            load: async () => ({
              command: "inspect-fixture",
              handler() {
                throw failure
              },
            }),
          },
        ],
      })
      expect(process.exitCode).toBe(1)
      expect(process.listenerCount("unhandledRejection")).toBe(listeners)
    }
    expect(errors.join("\n")).toContain("Model not found: fixture/missing")
    expect(errors.join("\n")).toContain("command fixture failed")
    expect(errors.join("\n")).toContain("non-error failure")
    expect(errors.join("\n")).toContain("Unexpected error")
  } finally {
    if (previousConfig === undefined) await Bun.file(configPath).delete()
    else await Bun.write(configPath, previousConfig)
    process.exitCode = exitCode ?? 0
    UI.error = originalError
    console.error = consoleError
  }
})
