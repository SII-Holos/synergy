import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { AgentConfigTool } from "../../src/tools/agent-config"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"

import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { ToolResolver } from "@ericsanchezok/synergy-harness/test/support/internals"
import { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { ModelsDev } from "@ericsanchezok/synergy-harness/provider/models-schemas"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

let original: Awaited<ReturnType<typeof Config.domainGet>>
beforeEach(() =>
  runtime.run(async () => {
    original = await Config.domainGet("agents")
  }),
)
afterEach(() =>
  runtime.run(async () => {
    await Config.domainUpdate("agents", original, { mode: "replace-domain" })
    await Agent.reload()
  }),
)

const ctx = {
  sessionID: "ses_agent_config_tool",
  messageID: "msg_agent_config_tool",
  callID: "call_agent_config_tool",
  agent: PrimaryAgentIdentity.names.coding,
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

describe("tool.agent_config", () => {
  test("the production tool catalog admits transformed input schemas and runtime validation still rejects invalid actions", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const agent = (await Agent.get(PrimaryAgentIdentity.names.coding))!
          const model = Provider.fromModelsDevProvider(
            ModelsDev.Provider.parse({
              id: "test",
              name: "Test",
              npm: "@ai-sdk/openai",
              env: [],
              models: {
                test: {
                  id: "test",
                  name: "Test",
                  release_date: "2026-01-01",
                  attachment: false,
                  reasoning: false,
                  tool_call: true,
                  limit: { context: 64000, output: 4096 },
                },
              },
            }),
          ).models.test
          const available = await ToolResolver.availability({
            agent,
            model,
            sessionID: ctx.sessionID,
            includeMCP: false,
            userTools: { agent_config: true },
          })
          expect(available.diagnostics.get("agent_config")).toBeUndefined()
          const tool = await AgentConfigTool.init()
          expect(ToolResolver.registryInputSchema(tool).type).toBe("object")
          expect(
            tool.parameters.safeParse({ input: { action: "create", name: "bad", temperature: "hot" } }).success,
          ).toBe(false)
        },
      })
    }))
  test("create writes a markdown agent and the agent resolves", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await AgentConfigTool.init()
          const result = await tool.execute(
            {
              input: {
                action: "create",
                name: "doc-writer",
                description: "Writes documentation from code.",
                mode: "subagent",
                prompt: "You write documentation.",
              },
            },
            ctx,
          )

          expect(result.title).toContain("doc-writer")
          expect(result.metadata.action).toBe("create")
          expect(result.metadata.source).toBe("markdown")
          const agent = await Agent.get("doc-writer")
          expect(agent?.description).toBe("Writes documentation from code.")
        },
      })
    }))

  test("update changes a field and preserves the rest", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await AgentConfigTool.init()
          await tool.execute(
            {
              input: {
                action: "create",
                name: "reviewer",
                description: "before",
                prompt: "Review code.",
                mode: "subagent",
              },
            },
            ctx,
          )
          const result = await tool.execute(
            { input: { action: "update", name: "reviewer", description: "after" } },
            ctx,
          )

          expect(result.metadata.action).toBe("update")
          const agent = await Agent.get("reviewer")
          expect(agent?.description).toBe("after")
          expect(agent?.prompt).toBe("Review code.")
        },
      })
    }))

  test("create with an unresolved visibleTo reference is rejected with the offending name", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await AgentConfigTool.init()
          await expect(
            tool.execute(
              {
                input: {
                  action: "create",
                  name: "hidden-helper",
                  prompt: "helper",
                  visibleTo: ["typo-caller"],
                },
              },
              ctx,
            ),
          ).rejects.toThrow(/visibleTo.*typo-caller/)
        },
      })
    }))

  test("set_default rejects a subagent-only target", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await AgentConfigTool.init()
          await expect(tool.execute({ input: { action: "set_default", name: "developer" } }, ctx)).rejects.toThrow(
            /primary/,
          )
        },
      })
    }))

  test("remove with disable strategy writes disable and the agent disappears", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await AgentConfigTool.init()
          const result = await tool.execute({ input: { action: "remove", name: "explore" } }, ctx)

          expect(result.metadata.strategy).toBe("disable")
          expect(await Agent.get("explore")).toBeUndefined()
        },
      })
    }))

  test("list returns built-in agents", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await AgentConfigTool.init()
          const result = await tool.execute({ input: { action: "list" } }, ctx)

          expect(result.metadata.count).toBeGreaterThan(0)
          expect(result.output).toContain(PrimaryAgentIdentity.names.general)
        },
      })
    }))

  test("parameters schema keeps an object root wrapping the action union", () =>
    runtime.run(async () => {
      const tool = await AgentConfigTool.init()
      expect(tool.parameters.safeParse({ input: { action: "list" } }).success).toBe(true)
      expect(tool.parameters.safeParse({ action: "list" }).success).toBe(false)
    }))
})

test("describe includes the bounded prompt and permissions in model-visible output", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await AgentConfigTool.init()
        await tool.execute(
          {
            input: {
              action: "create",
              name: "inspectable",
              prompt: "Inspect this prompt.",
              permission: { edit: "deny" },
            },
          },
          ctx,
        )
        const result = await tool.execute({ input: { action: "describe", name: "inspectable" } }, ctx)
        expect(result.output).toContain("Inspect this prompt.")
        expect(result.output).toContain('"permissionRules"')
        expect(result.output).toContain('"deny"')
        const disabled = await tool.execute({ input: { action: "update", name: "inspectable", disable: true } }, ctx)
        expect(disabled.output).toContain("disabled")
        expect(await Agent.get("inspectable")).toBeUndefined()
      },
    })
  }))

afterRuntimeTests(() => runtime.close())
