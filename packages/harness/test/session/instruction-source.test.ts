import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { ConfigSource } from "../../src/config/source"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { InstructionFiles } from "../../src/session/instruction-files"
import { InstructionSource } from "../../src/session/instruction-source"
import { SystemPrompt } from "../../src/session/system"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"

test("a host instruction source replaces implicit sources per Runtime and preserves source failure", async () => {
  await using files = await tmpdir()
  const privateFile = path.join(files.path, "private.md")
  await Bun.write(privateFile, "private explicit instructions")
  let unavailable = false
  const failure = new Error("The host instruction snapshot is unavailable")
  await using hosted = await testRuntime({
    register() {
      ConfigSource.register({ resolve: async () => ({ instructions: [privateFile] }) })
      InstructionSource.register({
        async load(input) {
          expect(input.scope.type).toBe("home")
          expect(input.workspace).toBeNull()
          if (unavailable) throw failure
          return ["explicit host instructions"]
        },
      })
      expect(() => InstructionSource.register({ load: async () => [] })).toThrow("already")
    },
  })
  await using personal = await testRuntime()
  await Bun.write(path.join(hosted.host.root, "config", "AGENTS.md"), "hosted global instructions")
  await Bun.write(path.join(personal.host.root, "config", "AGENTS.md"), "personal global instructions")
  const hostedPrompt = () => hosted.run(() => ScopeContext.provide({ scope: Scope.home(), fn: SystemPrompt.custom }))
  expect(await hostedPrompt()).toEqual(["explicit host instructions"])
  const personalPrompt = await personal.run(() =>
    ScopeContext.provide({ scope: Scope.home(), fn: SystemPrompt.custom }),
  )
  expect(personalPrompt.join("\n")).toContain("personal global instructions")
  unavailable = true
  await expect(hostedPrompt()).rejects.toBe(failure)
  await hosted.run(() => expect(() => InstructionSource.register({ load: async () => [] })).toThrow("before opening"))
})

test("the project instruction source keeps selected project rules and excludes globals, explicit additions and escaped files", async () => {
  await using files = await tmpdir()
  const project = path.join(files.path, "project")
  const nested = path.join(project, "nested")
  const escaped = path.join(files.path, "external.md")
  await Bun.write(path.join(files.path, "AGENTS.md"), "ancestor instructions")
  await Bun.write(escaped, "private outside instructions")
  await Bun.write(path.join(project, "AGENTS.md"), "project root instructions")
  await Bun.write(path.join(nested, "AGENTS.md"), "project nested instructions")
  await using runtime = await testRuntime({
    register() {
      ConfigSource.register({
        resolve: async () => ({
          instructions: [escaped],
          project_doc_fallback_filenames: ["../external.md"],
        }),
      })
      InstructionSource.register({ load: () => InstructionFiles.project() })
    },
  })
  await Bun.write(path.join(runtime.host.root, "config", "AGENTS.md"), "global instructions")
  await runtime.run(async () => {
    const scope = (await Scope.fromDirectory(project)).scope
    const load = () =>
      ScopeContext.provide({
        scope,
        workspace: { type: "main", path: nested, scopeID: scope.id },
        fn: SystemPrompt.custom,
      })
    const initial = (await load()).join("\n")
    expect(initial).toContain("project root instructions")
    expect(initial).toContain("project nested instructions")
    expect(initial).not.toContain("ancestor instructions")
    expect(initial).not.toContain("global instructions")
    expect(initial).not.toContain("private outside instructions")
    await fs.rm(path.join(project, "AGENTS.md"))
    expect((await load()).join("\n")).not.toContain("private outside instructions")
    if (process.platform !== "win32") {
      await fs.symlink(escaped, path.join(project, "AGENTS.md"))
      expect((await load()).join("\n")).not.toContain("private outside instructions")
    }
    expect(await ScopeContext.provide({ scope, workspace: null, fn: SystemPrompt.custom })).toEqual([])
  })
})

test.skipIf(process.platform === "win32")(
  "project instructions do not follow a file replaced by a private symlink after discovery",
  async () => {
    await using files = await tmpdir()
    const project = path.join(files.path, "project")
    const instructions = path.join(project, "AGENTS.md")
    const privateFile = path.join(files.path, "private.md")
    await Bun.write(instructions, "project rules")
    await Bun.write(privateFile, "private replacement rules")
    await using runtime = await testRuntime({
      register() {
        ConfigSource.register({ resolve: async () => ({}) })
        InstructionSource.register({ load: () => InstructionFiles.project() })
      },
    })
    await runtime.run(async () => {
      const scope = (await Scope.fromDirectory(project)).scope
      const stat = fs.stat.bind(fs)
      let replaced = false
      let reads = 0
      using observer = spyOn(fs, "stat").mockImplementation((async (...args: Parameters<typeof fs.stat>) => {
        const result = await stat(...args)
        if (args[0] === instructions && ++reads === 2) {
          replaced = true
          await fs.rm(instructions)
          await fs.symlink(privateFile, instructions)
        }
        return result
      }) as typeof fs.stat)
      const parts = await ScopeContext.provide({ scope, fn: SystemPrompt.custom })
      expect(replaced).toBe(true)
      expect(parts.join("\n")).not.toContain("private replacement rules")
    })
  },
)
