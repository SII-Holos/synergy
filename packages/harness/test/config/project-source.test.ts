import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Config } from "../../src/config/config"
import { ConfigSource } from "../../src/config/source"
import { ProjectConfig } from "../../src/config/project-source"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"

const keys = ["project_doc_max_bytes", "project_doc_fallback_filenames"]
const scopeAt = (directory: string): Scope.Project => ({
  type: "project",
  id: "selected-project",
  local: { directory, worktree: directory, sandboxes: [] },
  time: { created: 1, updated: 1 },
})
const filename = (directory: string) => path.join(directory, ".synergy", "synergy.d", "60-agents.jsonc")

test("selected project configuration reads canonical allowed fields without private discovery or reference expansion", async () => {
  await using files = await tmpdir()
  const project = path.join(files.path, "project")
  const selected = scopeAt(project)
  await Bun.write(filename(files.path), '{"project_doc_max_bytes":1}')
  await Bun.write(
    filename(project),
    '{// selected configuration\n"project_doc_max_bytes":128,"project_doc_fallback_filenames":["{env:HOME}","{file:../private}"],"default_agent":"private",}',
  )
  await Bun.write(path.join(project, ".synergy", "synergy.d", "20-providers.jsonc"), "unselected invalid file")
  await Bun.write(path.join(project, ".synergy", "synergy.d", "99-custom.jsonc"), '{"project_doc_max_bytes":3}')
  await Bun.write(path.join(project, "synergy.json"), '{"project_doc_max_bytes":4}')
  await using runtime = await testRuntime({
    register: () => ConfigSource.register({ resolve: ({ scope }) => ProjectConfig.fields(scope, keys) }),
  })
  await Bun.write(path.join(runtime.host.root, "config", "synergy.d", "60-agents.jsonc"), '{"project_doc_max_bytes":2}')
  await runtime.run(async () => {
    expect(await ProjectConfig.fields(Scope.home(), keys)).toEqual({})
    expect(await ProjectConfig.fields({ ...selected, local: null }, keys)).toEqual({})
    expect(await ProjectConfig.fields(selected, [])).toEqual({})
    expect(await ProjectConfig.fields(selected, keys)).toEqual({
      project_doc_max_bytes: 128,
      project_doc_fallback_filenames: ["{env:HOME}", "{file:../private}"],
    })
    await ScopeContext.provide({
      scope: selected,
      fn: async () => {
        const configuration = await Config.current()
        expect(configuration.project_doc_max_bytes).toBe(128)
        expect(configuration.default_agent).toBeUndefined()
        await fs.writeFile(filename(project), '{"project_doc_max_bytes":256}')
        expect((await Config.resolveExecution()).project_doc_max_bytes).toBe(256)
        await fs.writeFile(filename(project), '{"project_doc_max_bytes":-1}')
        await expect(Config.resolveExecution()).rejects.toThrow()
      },
    })
    await expect(ProjectConfig.fields(selected, ["features"])).rejects.toThrow("registered project fields")
    await expect(ProjectConfig.fields(selected, ["not-registered"])).rejects.toThrow("registered project fields")
    await fs.unlink(filename(project))
    expect(await ProjectConfig.fields(selected, keys)).toEqual({})
    expect(await Bun.file(path.join(project, "synergy.json")).text()).toBe('{"project_doc_max_bytes":4}')
  })
})

test("malformed, oversized and non-regular project configuration fails without exposing file contents", async () => {
  await using files = await tmpdir()
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    for (const content of ['{"private":"DO_NOT_ECHO",', "[]", "null", ""]) {
      await Bun.write(filename(files.path), content)
      const result = await ProjectConfig.fields(scopeAt(files.path), keys).catch((error: unknown) => error)
      expect(result).toBeInstanceOf(ProjectConfig.InvalidError)
      if (!(result instanceof ProjectConfig.InvalidError)) throw new Error("Expected structured config failure")
      expect(result.data.reason).toBe("invalid_json")
      expect(JSON.stringify(result.toObject())).not.toContain("DO_NOT_ECHO")
    }
    await Bun.write(filename(files.path), " ".repeat(4 * 1024 * 1024 + 1))
    await expect(ProjectConfig.fields(scopeAt(files.path), keys)).rejects.toMatchObject({
      data: { reason: "too_large" },
    })
    await fs.unlink(filename(files.path))
    await fs.mkdir(filename(files.path))
    await expect(ProjectConfig.fields(scopeAt(files.path), keys)).rejects.toMatchObject({
      data: { reason: "not_regular" },
    })
  })
})

test("selected project configuration refuses a directory link outside the project", async () => {
  await using files = await tmpdir()
  await using runtime = await testRuntime()
  const project = path.join(files.path, "project")
  const external = path.join(files.path, "private")
  await Bun.write(filename(external), '{"project_doc_max_bytes":1}')
  await fs.mkdir(project)
  await fs.symlink(path.join(external, ".synergy"), path.join(project, ".synergy"), "junction")
  await runtime.run(async () => {
    await expect(ProjectConfig.fields(scopeAt(project), keys)).rejects.toMatchObject({
      data: { reason: "outside_project" },
    })
  })
})

test("configuration replacement during a descriptor read cannot publish mismatched bytes", async () => {
  await using files = await tmpdir()
  await using runtime = await testRuntime()
  const target = filename(files.path)
  await Bun.write(target, '{"project_doc_max_bytes":1}')
  const original = fs.stat
  let replaced = false
  using change = spyOn(fs, "stat").mockImplementation(
    new Proxy(original, {
      async apply(fn, receiver, args) {
        if (!replaced && args[0] === target) {
          replaced = true
          await fs.rename(target, `${target}.old`)
          await fs.writeFile(target, '{"project_doc_max_bytes":2}')
        }
        return Reflect.apply(fn, receiver, args)
      },
    }),
  )
  await runtime.run(async () => {
    await expect(ProjectConfig.fields(scopeAt(files.path), keys)).rejects.toMatchObject({ data: { reason: "changed" } })
    expect(replaced).toBe(true)
  })
})
