import { afterAll, expect, test } from "bun:test"
import path from "node:path"
import { parse as parseJsonc } from "jsonc-parser"
import { migrations } from "../../src/config/migration"
import { Global } from "../../src/global"
import { Scope } from "../../src/scope"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "../support/fixture"

const runtime = await testRuntime()

test("retiring Link removes obsolete concurrency and permission keys from global and project config", () =>
  runtime.run(async () => {
    const globalFile = path.join(Global.Path.config, "synergy.d", "120-runtime.jsonc")
    await Bun.write(
      globalFile,
      '{ "execution": { "toolExecutorConcurrency": { "link": 8, "file": 4 } }, "watcher": { "ignore": ["build"] } }\n',
    )
    const legacyFile = path.join(Global.Path.config, "synergy.jsonc")
    await Bun.write(
      legacyFile,
      '{ "permission": { "shell_remote_execute": "allow", "shell": "ask" }, "holos": { "enabled": true } }\n',
    )
    await using project = await tmpdir({ git: true })
    const projectFile = path.join(project.path, ".synergy", "synergy.d", "120-runtime.jsonc")
    await Bun.write(
      projectFile,
      '// keep this comment\n{ "execution": { "toolExecutorConcurrency": { "link": 2, "plugin": 3 } } }\n',
    )
    await Scope.fromDirectory(project.path)

    const migration = migrations.find((entry) => entry.id === "20260929-config-retire-synergy-link")
    expect(migration).toBeDefined()
    await migration!.up(() => {})
    await migration!.up(() => {})

    expect(parseJsonc(await Bun.file(globalFile).text())).toEqual({
      execution: { toolExecutorConcurrency: { file: 4 } },
      watcher: { ignore: ["build"] },
    })
    expect(parseJsonc(await Bun.file(legacyFile).text())).toEqual({
      permission: { shell: "ask" },
      holos: { enabled: true },
    })
    expect(parseJsonc(await Bun.file(projectFile).text())).toEqual({
      execution: { toolExecutorConcurrency: { plugin: 3 } },
    })
    expect(await Bun.file(projectFile).text()).toContain("// keep this comment")
  }))

afterAll(() => runtime.close())
