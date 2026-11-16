import { describe, expect, test } from "bun:test"
import { createIsolatedTestEnv } from "@ericsanchezok/synergy-testing/env"
import path from "node:path"
import fs from "node:fs/promises"
import { FEATURE_CONFIG_FILENAME } from "@ericsanchezok/synergy-util/feature-config"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

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
  test("no arguments prints core help without starting a server", () =>
    runtime.run(async () => {
      const result = await invoke([])
      expect(result.code).toBe(0)
      expect(result.stdout + result.stderr).toContain("send [message..]")
      expect(result.stdout + result.stderr).not.toContain("start synergy server")
    }))

  test("uninstalled product commands fail clearly", () =>
    runtime.run(async () => {
      const result = await invoke(["browser"])
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('Command "browser" is unavailable in this installation.')
    }))
})

describe("standalone CLI feature cold start", () => {
  for (const scenario of [
    { name: "saved opt-in enables the core experiment", customHost: false, saved: true, explicit: null },
    { name: "an absent preference leaves the core experiment off", customHost: false, saved: false, explicit: null },
    { name: "a custom host reads its own saved opt-in", customHost: true, saved: true, explicit: null },
    { name: "a custom host does not inherit the default Home opt-in", customHost: true, saved: false, explicit: null },
    { name: "an explicit disabled plan overrides a saved opt-in", customHost: false, saved: true, explicit: false },
    {
      name: "an explicit enabled plan overrides an absent preference",
      customHost: false,
      saved: false,
      explicit: true,
    },
  ]) {
    test(
      scenario.name,
      async () => {
        const isolation = await createIsolatedTestEnv()
        const home = isolation.env.SYNERGY_TEST_HOME!
        const selectedHome = scenario.customHost ? path.join(home, "selected-home") : home
        const root = path.join(home, scenario.customHost ? "selected-root" : ".synergy")
        const featureID = "session-long-term-memory"
        try {
          await fs.mkdir(selectedHome, { recursive: true })
          const preferences = [
            { root: path.join(home, ".synergy"), selected: scenario.customHost ? !scenario.saved : scenario.saved },
            ...(scenario.customHost ? [{ root, selected: scenario.saved }] : []),
          ]
          for (const preference of preferences) {
            if (!preference.selected) continue
            const directory = path.join(preference.root, "config", "synergy.d")
            await fs.mkdir(directory, { recursive: true })
            await Bun.write(
              path.join(directory, FEATURE_CONFIG_FILENAME),
              JSON.stringify({ features: { optIn: [featureID] } }),
            )
          }
          const child = Bun.spawn(
            [
              process.execPath,
              "--eval",
              `
              import { createRuntimeCli } from "./src/runtime-cli.ts"
              import { createLocalHost } from "@ericsanchezok/synergy-local-runtime"
              import { RuntimeComponents } from "@ericsanchezok/synergy-harness/lifecycle"
              import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
              import { Features } from "@ericsanchezok/synergy-harness/lifecycle/features"
              import { Config } from "@ericsanchezok/synergy-harness/config/config"
              import { FeatureSelection } from "@ericsanchezok/synergy-util/features"
              const explicit = ${JSON.stringify(scenario.explicit)}
              const cli = explicit === null
                ? await createRuntimeCli()
                : await createRuntimeCli([], {
                    features: FeatureSelection.resolve([], { optIn: explicit ? [${JSON.stringify(featureID)}] : [] }),
                  })
              await using opened = await cli.runtimeFactory({
                mode: "oneshot",
                host: ${scenario.customHost ? `createLocalHost({ home: ${JSON.stringify(selectedHome)}, root: ${JSON.stringify(root)} })` : "undefined"},
                environment: false,
                migrationOutput: "silent",
                logging: { level: "ERROR" },
              })
              console.log(JSON.stringify(opened.run(() => ({
                home: RuntimeContext.current().host.home,
                root: RuntimeContext.current().host.root,
                components: RuntimeComponents.selected().map((component) => component.id),
                feature: Features.catalog().find((feature) => feature.id === ${JSON.stringify(featureID)}),
                enabled: Features.enabled(${JSON.stringify(featureID)}),
                library: "library" in Config.Info.shape,
              }))))
            `,
            ],
            {
              cwd: path.resolve(import.meta.dirname, "../.."),
              env: { ...isolation.env, SYNERGY_HOME: home, SYNERGY_RUNTIME_ROOT: undefined },
              stdout: "pipe",
              stderr: "pipe",
            },
          )
          const [stdout, stderr, code] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ])
          expect(code, stderr + stdout).toBe(0)
          const result = JSON.parse(stdout)
          const enabled = scenario.explicit ?? scenario.saved
          expect(result).toMatchObject({
            home: selectedHome,
            root,
            components: ["local-runtime", "plugin-host"],
            feature: { id: featureID, available: true, selected: enabled, enabled, pendingRestart: false },
            enabled,
            library: false,
          })
        } finally {
          await isolation.dispose()
        }
      },
      30_000,
    )
  }
})

test("command-loading failures set nonzero status and leave no process listeners", () =>
  runtime.run(async () => {
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
  }))

test("owner-initialized commands do not create an ambient Home even when their handler fails", async () => {
  const { runCli } = await import("../../src/main")
  const isolation = await createIsolatedTestEnv()
  const home = process.env.SYNERGY_HOME
  const root = process.env.SYNERGY_RUNTIME_ROOT
  const exit = process.exitCode
  const error = console.error
  const errors: string[] = []
  process.env.SYNERGY_HOME = isolation.env.SYNERGY_TEST_HOME
  delete process.env.SYNERGY_RUNTIME_ROOT
  console.error = (...args) => errors.push(args.map(String).join(" "))
  try {
    await runCli({
      argv: ["independent"],
      register() {},
      runtimeFactory: async () => {
        throw new Error("Agent Runtime must not open")
      },
      commands: [
        {
          command: "independent",
          describe: "service with its own lifecycle",
          initialization: "owner",
          load: async () => ({
            command: "independent",
            handler() {
              throw new Error("explicit service Home required")
            },
          }),
        },
      ],
    })
    expect(process.exitCode).toBe(1)
    expect(errors.join("\n")).toContain("explicit service Home required")
    expect(await fs.readdir(isolation.env.SYNERGY_TEST_HOME!, { recursive: true })).toEqual([])
  } finally {
    if (home === undefined) delete process.env.SYNERGY_HOME
    else process.env.SYNERGY_HOME = home
    if (root === undefined) delete process.env.SYNERGY_RUNTIME_ROOT
    else process.env.SYNERGY_RUNTIME_ROOT = root
    process.exitCode = exit ?? 0
    console.error = error
    await isolation.dispose()
  }
})

test("version is available when plugin storage cannot be opened", () =>
  runtime.run(async () => {
    const { runCli } = await import("../../src/main")
    const original = process.exitCode
    let discovered = false
    try {
      await runCli({
        argv: ["--version"],
        runtimeFactory: async () => {
          throw new Error("version must not open a runtime")
        },
        pluginCommands: async () => {
          discovered = true
          throw new Error("interrupted storage")
        },
      })
      expect(discovered).toBe(false)
      expect(process.exitCode ?? 0).toBe(original ?? 0)
    } finally {
      process.exitCode = original ?? 0
    }
  }))

test("host contributes its default command without loading unselected commands", () =>
  runtime.run(async () => {
    const { runCli } = await import("../../src/main")
    const calls: string[] = []
    await runCli({
      argv: [],
      defaultCommand: "server",
      pluginCommands: async () => {
        throw new Error("Plugin metadata cannot open an interrupted storage upgrade")
      },
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
  }))

test("source entry is importable and dispatches ordinary help without a worker or runtime", () =>
  runtime.run(async () => {
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
  }))

test("the single parser accepts host-owned data commands and rejects namespace collisions", () =>
  runtime.run(async () => {
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
  }))

test("selected command failures preserve error messages, exit status, and listener cleanup", () =>
  runtime.run(async () => {
    const { runCli } = await import("../../src/main")
    const { Provider } = await import("@ericsanchezok/synergy-harness/provider/provider")
    const { UI } = await import("@ericsanchezok/synergy-util/terminal")
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
  }))

afterRuntimeTests(() => runtime.close())
