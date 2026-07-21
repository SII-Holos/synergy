import { describe, expect, test } from "bun:test"
import { getCurrentPluginTask } from "../../src/plugin/host-services"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { tmpdir } from "../fixture/fixture"

describe("current plugin task", () => {
  test("resolves durable ownership from the invoking child Session", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const parent = await Session.create({})
        const child = await Session.create({ parentID: parent.id })
        await Session.update(child.id, (session) => {
          session.cortex = {
            taskID: "cortex_task_plugin_current",
            parentSessionID: parent.id,
            parentMessageID: "msg_plugin_current_parent",
            description: "Run a plugin-owned stage",
            agent: "plugin-agent",
            status: "running",
            startedAt: 100,
            owner: {
              pluginId: "example-plugin",
              pluginGeneration: "generation-a",
              scopeId: scope.id,
              correlationId: "stage-run-a",
            },
          }
        })

        await expect(
          getCurrentPluginTask({
            pluginId: "example-plugin",
            pluginGeneration: "generation-a",
            scopeId: scope.id,
            sessionId: child.id,
          }),
        ).resolves.toMatchObject({
          taskId: "cortex_task_plugin_current",
          sessionId: child.id,
          status: "running",
          owner: { correlationId: "stage-run-a" },
        })

        await expect(
          getCurrentPluginTask({
            pluginId: "example-plugin",
            pluginGeneration: "generation-b",
            scopeId: scope.id,
            sessionId: child.id,
          }),
        ).resolves.toBeUndefined()
      },
    })
  })
})
