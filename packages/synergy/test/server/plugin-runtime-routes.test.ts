import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { runtimeStartOptions } from "../../src/server/plugin-runtime-routes"
import { ScopeContext } from "../../src/scope/context"

describe("plugin runtime routes", () => {
  test("runtime start options use the active scope", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const options = runtimeStartOptions({
          id: "scoped-plugin",
          name: "Scoped Plugin",
          hooks: {} as any,
          manifest: {
            name: "scoped-plugin",
            version: "1.0.0",
            main: "./runtime/index.js",
            description: "Scoped Plugin",
          },
          pluginDir: "/tmp/scoped-plugin",
          entryPath: "/tmp/scoped-plugin/runtime/index.js",
          source: "local",
          runtimeMode: "process",
          agents: {},
        })

        expect(options.scope).toMatchObject({
          id: scope.id,
          directory: scope.directory,
          worktree: scope.worktree,
        })
      },
    })
  })
})
