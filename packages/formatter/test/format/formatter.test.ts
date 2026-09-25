import { expect, spyOn, test } from "bun:test"
import * as Formatter from "../../src/formatter"
import { FileTime } from "@ericsanchezok/synergy-harness/file/time"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { FormatterProcess } from "../../src/process"
import { Format } from "../../src/index"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import path from "node:path"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

test("formatter discovery combines executable availability with actual project opt-ins", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ config: { formatter: { oxfmt: { disabled: false } } } })
    const available = new Set<string>()
    const which = spyOn(Bun, "which").mockImplementation((command) =>
      available.has(command) ? `/fixture/${command}` : null,
    )
    let probe = { exitCode: 0, stdout: "Air: An R language server and formatter" }
    const spawn = spyOn(FormatterProcess, "run").mockImplementation(async () => probe)
    try {
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          for (const name of [
            "gofmt",
            "mix",
            "zig",
            "ktlint",
            "rubocop",
            "standardrb",
            "htmlbeautifier",
            "dart",
            "terraform",
            "latexindent",
            "gleam",
            "shfmt",
            "nixfmt",
          ] as const) {
            const formatter = Formatter[name]
            expect(await formatter.enabled()).toBe(false)
            available.add(formatter.command[0]!)
            expect(await formatter.enabled()).toBe(true)
          }
          expect(await Formatter.prettier.enabled()).toBe(false)
          expect(await Formatter.oxfmt.enabled()).toBe(false)
          await Bun.write(
            path.join(tmp.path, "package.json"),
            JSON.stringify({ devDependencies: { prettier: "1", oxfmt: "1" } }),
          )
          expect(await Formatter.prettier.enabled()).toBe(true)
          expect(await Formatter.oxfmt.enabled()).toBe(true)
          for (const [name, command, filename] of [
            ["biome", null, "biome.jsonc"],
            ["clang", null, ".clang-format"],
            ["ocamlformat", "ocamlformat", ".ocamlformat"],
            ["rustfmt", "rustfmt", ".rustfmt.toml"],
            ["cargofmt", "cargo", "Cargo.toml"],
          ] as const) {
            expect(await Formatter[name].enabled()).toBe(false)
            if (command) available.add(command)
            await Bun.write(path.join(tmp.path, filename), "{}")
            expect(await Formatter[name].enabled()).toBe(true)
          }
          expect(await Formatter.ruff.enabled()).toBe(false)
          available.add("ruff")
          expect(await Formatter.ruff.enabled()).toBe(false)
          await Bun.write(path.join(tmp.path, "pyproject.toml"), "[tool.ruff]\n")
          expect(await Formatter.ruff.enabled()).toBe(true)
          await Bun.write(path.join(tmp.path, "pyproject.toml"), "[project]\n")
          await Bun.write(path.join(tmp.path, "requirements.txt"), "ruff==0.1\n")
          expect(await Formatter.ruff.enabled()).toBe(true)
          await Bun.write(path.join(tmp.path, "ruff.toml"), "line-length = 100\n")
          expect(await Formatter.ruff.enabled()).toBe(true)
          expect(await Formatter.uvformat.enabled()).toBe(false)
          available.delete("ruff")
          available.add("uv")
          expect(await Formatter.uvformat.enabled()).toBe(true)
          probe.exitCode = 1
          expect(await Formatter.uvformat.enabled()).toBe(false)
          available.add("air")
          expect(await Formatter.rlang.enabled()).toBe(true)
          probe.stdout = "different air executable"
          expect(await Formatter.rlang.enabled()).toBe(false)
          await Format.reload()
          expect((await Format.status()).find((item) => item.name === "oxfmt")?.enabled).toBe(true)
        },
      })
    } finally {
      which.mockRestore()
      spawn.mockRestore()
      await Format.reload()
    }
  }))

test("file edits invoke configured formatter processes and isolate failures from other formatters", () =>
  runtime.run(async () => {
    const { WorkspaceEvents } = await import("@ericsanchezok/synergy-harness/workspace/events")
    const { File } = await import("@ericsanchezok/synergy-local-runtime/file")
    await using tmp = await tmpdir({
      config: {
        formatter: {
          missing: { command: ["/nonexistent-synergy-formatter-fixture", "$FILE"], extensions: [".fixture"] },
          failed: { command: [process.execPath, "-e", "process.exit(7)"], extensions: [".fixture"] },
          fixture: {
            command: [process.execPath, "-e", "await Bun.write(process.argv[1], process.env.FORMAT_VALUE)", "$FILE"],
            extensions: [".fixture"],
            environment: { FORMAT_VALUE: "formatted by fixture" },
          },
          disabled: { disabled: true, command: ["/never-run"], extensions: [".fixture"] },
        },
      },
    })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await Format.reload()
        Format.init()
        const filepath = path.join(tmp.path, "input.fixture")
        await Bun.write(filepath, "original")
        await WorkspaceEvents.publish(File.Event.Edited, {
          file: filepath,
          contentVersion: FileTime.version(await Bun.file(filepath).bytes()),
        })
        expect(await Bun.file(filepath).text()).toBe("formatted by fixture")
        const unmatched = path.join(tmp.path, "input.unmatched")
        await Bun.write(unmatched, "untouched")
        await WorkspaceEvents.publish(File.Event.Edited, {
          file: unmatched,
          contentVersion: FileTime.version("untouched"),
        })
        expect(await Bun.file(unmatched).text()).toBe("untouched")
        expect((await Format.status()).some((formatter) => formatter.name === "disabled")).toBe(false)
      },
    })
    await Format.reload()
  }))

test("global formatter opt-out leaves file edits untouched", () =>
  runtime.run(async () => {
    const { WorkspaceEvents } = await import("@ericsanchezok/synergy-harness/workspace/events")
    const { File } = await import("@ericsanchezok/synergy-local-runtime/file")
    await using tmp = await tmpdir({ config: { formatter: false } })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await Format.reload()
        expect(await Format.status()).toEqual([])
        Format.init()
        const filepath = path.join(tmp.path, "disabled.py")
        await Bun.write(filepath, "unchanged")
        await WorkspaceEvents.publish(File.Event.Edited, {
          file: filepath,
          contentVersion: FileTime.version(await Bun.file(filepath).bytes()),
        })
        expect(await Bun.file(filepath).text()).toBe("unchanged")
      },
    })
    await Format.reload()
  }))

test("formatting runs once in the owning Workspace when one Scope has multiple directories", () =>
  runtime.run(async () => {
    const { WorkspaceEvents } = await import("@ericsanchezok/synergy-harness/workspace/events")
    const { Session } = await import("@ericsanchezok/synergy-harness/session")
    const { File } = await import("@ericsanchezok/synergy-local-runtime/file")
    await using first = await tmpdir({
      config: {
        formatter: {
          fixture: {
            command: [
              process.execPath,
              "-e",
              "const p=process.argv[1];await Bun.write(p,(await Bun.file(p).text())+'|'+process.cwd())",
              "$FILE",
            ],
            extensions: [".fixture"],
          },
        },
      },
    })
    await using second = await tmpdir()
    const scope = await first.scope()
    const sessions = await ScopeContext.provide({
      scope,
      fn: async () => [
        await Session.create({}),
        await Session.create({ workspace: { type: "directory", scopeID: scope.id, path: second.path } }),
      ],
    })
    for (const session of sessions)
      await ScopeContext.provide({
        scope,
        workspace: session.workspace,
        fn() {
          Format.init()
          Format.init()
        },
      })
    const file = path.join(second.path, "once.fixture")
    await Bun.write(file, "original")
    await ScopeContext.provide({
      scope,
      workspace: sessions[1]!.workspace,
      fn: () => WorkspaceEvents.publish(File.Event.Edited, { file, contentVersion: FileTime.version("original") }),
    })
    expect(await Bun.file(file).text()).toBe("original|" + second.path)
  }))

test("a stale edit cannot run a formatter over newer file content", () =>
  runtime.run(async () => {
    const { WorkspaceEvents } = await import("@ericsanchezok/synergy-harness/workspace/events")
    const { File } = await import("@ericsanchezok/synergy-local-runtime/file")
    await using tmp = await tmpdir({
      config: {
        formatter: {
          fixture: {
            command: [process.execPath, "-e", "await Bun.write(process.argv[1], 'formatted stale event')", "$FILE"],
            extensions: [".fixture"],
          },
        },
      },
    })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      async fn() {
        await Format.reload()
        Format.init()
        const file = path.join(tmp.path, "stale.fixture")
        await Bun.write(file, "newer file content")
        await WorkspaceEvents.publish(File.Event.Edited, { file, contentVersion: FileTime.version("old content") })
        expect(await Bun.file(file).text()).toBe("newer file content")
        await Format.reload()
      },
    })
  }))

test(
  "formatter reload cancels queued native work without starting it",
  () =>
    runtime.run(async () => {
      const { WorkspaceEvents } = await import("@ericsanchezok/synergy-harness/workspace/events")
      const { File } = await import("@ericsanchezok/synergy-local-runtime/file")
      await using tmp = await tmpdir({
        config: {
          formatter: {
            fixture: {
              command: [process.execPath, "-e", "await Bun.write(process.argv[1], 'unexpected formatter')", "$FILE"],
              extensions: [".fixture"],
            },
          },
        },
      })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        async fn() {
          await Format.reload()
          Format.init()
          const file = path.join(tmp.path, "queued.fixture")
          await Bun.write(file, "original")
          const started = Promise.withResolvers<void>()
          const release = Promise.withResolvers<void>()
          const blocked = WorkspaceAccess.write([tmp.path], async () => {
            started.resolve()
            await release.promise
          })
          await started.promise
          let settled = false
          const formatting = WorkspaceEvents.publish(File.Event.Edited, {
            file,
            contentVersion: FileTime.version("original"),
          }).then(() => {
            settled = true
          })
          try {
            await Bun.sleep(200)
            expect(settled).toBe(false)
            await Format.reload()
            await formatting
            expect(await Bun.file(file).text()).toBe("original")
          } finally {
            release.resolve()
            await blocked
            await formatting
            await Format.reload()
          }
        },
      })
    }),
  10000,
)

test(
  "formatting rechecks the edit version after waiting for another writer",
  () =>
    runtime.run(async () => {
      const { WorkspaceEvents } = await import("@ericsanchezok/synergy-harness/workspace/events")
      const { File } = await import("@ericsanchezok/synergy-local-runtime/file")
      await using tmp = await tmpdir({
        config: {
          formatter: {
            fixture: {
              command: [process.execPath, "-e", "await Bun.write(process.argv[1], 'stale formatter')", "$FILE"],
              extensions: [".fixture"],
            },
          },
        },
      })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        async fn() {
          await Format.reload()
          Format.init()
          const file = path.join(tmp.path, "queued.fixture")
          await Bun.write(file, "original")
          const started = Promise.withResolvers<void>(),
            release = Promise.withResolvers<void>()
          const blocked = WorkspaceAccess.write([tmp.path], async () => {
            started.resolve()
            await release.promise
          })
          await started.promise
          const formatting = WorkspaceEvents.publish(File.Event.Edited, {
            file,
            contentVersion: FileTime.version("original"),
          })
          try {
            await Bun.sleep(100)
            await Bun.write(file, "newer")
          } finally {
            release.resolve()
            await blocked
          }
          await formatting
          expect(await Bun.file(file).text()).toBe("newer")
          await Format.reload()
        },
      })
    }),
  10000,
)

test(
  "a formatter retains write ownership until its detached descendants finish",
  () =>
    runtime.run(async () => {
      const { WorkspaceEvents } = await import("@ericsanchezok/synergy-harness/workspace/events")
      const { File } = await import("@ericsanchezok/synergy-local-runtime/file")
      await using control = await tmpdir()
      const ready = path.join(control.path, "ready"),
        finish = path.join(control.path, "finish")
      const descendant = `await Bun.write(${JSON.stringify(ready)}, 'ready'); while (!(await Bun.file(${JSON.stringify(finish)}).exists())) await Bun.sleep(10); await Bun.write(process.argv[1], 'descendant formatted')`
      await using tmp = await tmpdir({
        config: {
          formatter: {
            fixture: {
              command: [
                process.execPath,
                "-e",
                `const {spawn}=await import('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(descendant)},process.argv[1]],{env:{},detached:true,stdio:'ignore'}).unref()`,
                "$FILE",
              ],
              extensions: [".fixture"],
            },
          },
        },
      })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        async fn() {
          await Format.reload()
          Format.init()
          const file = path.join(tmp.path, "tree.fixture")
          await Bun.write(file, "original")
          let settled = false
          const formatting = WorkspaceEvents.publish(File.Event.Edited, {
            file,
            contentVersion: FileTime.version("original"),
          }).then(() => {
            settled = true
          })
          try {
            const deadline = Date.now() + 5000
            while (
              (await Bun.file(ready)
                .text()
                .catch(() => "")) !== "ready" &&
              Date.now() < deadline
            )
              await Bun.sleep(10)
            expect(await Bun.file(ready).text()).toBe("ready")
            expect(settled).toBe(false)
            await expect(
              WorkspaceAccess.write([control.path], async () => {}, AbortSignal.timeout(100)),
            ).rejects.toMatchObject({ name: "TimeoutError" })
          } finally {
            await Bun.write(finish, "finish")
            await formatting
            await Format.reload()
          }
          expect(await Bun.file(file).text()).toBe("descendant formatted")
        },
      })
    }),
  15000,
)

afterRuntimeTests(() => runtime.close())
