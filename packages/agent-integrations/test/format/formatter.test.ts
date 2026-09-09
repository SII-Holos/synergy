import { expect, spyOn, test } from "bun:test"
import * as Formatter from "../../src/format/formatter"
import { Format } from "../../src/format"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import path from "node:path"

test("formatter discovery combines executable availability with actual project opt-ins", async () => {
  await using tmp = await tmpdir({ config: { formatter: { oxfmt: { disabled: false } } } })
  const available = new Set<string>()
  const which = spyOn(Bun, "which").mockImplementation((command) =>
    available.has(command) ? `/fixture/${command}` : null,
  )
  let probe = { exitCode: 0, stdout: "Air: An R language server and formatter" }
  const spawn = spyOn(Bun, "spawn").mockImplementation(
    () => ({ exited: Promise.resolve(probe.exitCode), stdout: new Response(probe.stdout).body }) as never,
  )
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
})

test("file edits invoke configured formatter processes and isolate failures from other formatters", async () => {
  const { Bus } = await import("@ericsanchezok/synergy-harness/bus")
  const { File } = await import("@ericsanchezok/synergy-runtime-local/file")
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
      await Bus.publish(File.Event.Edited, { file: filepath })
      expect(await Bun.file(filepath).text()).toBe("formatted by fixture")
      const unmatched = path.join(tmp.path, "input.unmatched")
      await Bun.write(unmatched, "untouched")
      await Bus.publish(File.Event.Edited, { file: unmatched })
      expect(await Bun.file(unmatched).text()).toBe("untouched")
      expect((await Format.status()).some((formatter) => formatter.name === "disabled")).toBe(false)
    },
  })
  await Format.reload()
})

test("global formatter opt-out leaves file edits untouched", async () => {
  const { Bus } = await import("@ericsanchezok/synergy-harness/bus")
  const { File } = await import("@ericsanchezok/synergy-runtime-local/file")
  await using tmp = await tmpdir({ config: { formatter: false } })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      await Format.reload()
      expect(await Format.status()).toEqual([])
      Format.init()
      const filepath = path.join(tmp.path, "disabled.py")
      await Bun.write(filepath, "unchanged")
      await Bus.publish(File.Event.Edited, { file: filepath })
      expect(await Bun.file(filepath).text()).toBe("unchanged")
    },
  })
  await Format.reload()
})
