import { expect, test } from "bun:test"
import { z } from "zod"
import { Agent } from "../../src/agent/agent"
import { AgentBuiltins } from "../../src/agent/builtins"
import { PermissionNext } from "../../src/permission/next"
import { Provider } from "../../src/provider/provider"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { ToolResolver } from "../../src/session/tool-resolver"
import { ToolDiscovery } from "../../src/tool/discovery"
import { ToolRegistry } from "../../src/tool/registry"
import { Tool } from "../../src/tool/tool"
import { testRuntime } from "../support/runtime"

for (const vision of [false, true])
  test(`image eligibility agrees across resolution and discovery with vision owner ${vision}`, async () => {
    await using runtime = await testRuntime({
      env: { SYNERGY_CONFIG_CONTENT: JSON.stringify({ provider: { openai: { options: { apiKey: "fixture-key" } } } }) },
      register() {
        if (vision)
          AgentBuiltins.register("vision-fixture", () => ({
            "multimodal-looker": Agent.Info.parse({
              name: "multimodal-looker",
              mode: "primary",
              hidden: true,
              options: {},
              permission: [],
              model: { providerID: "openai", modelID: "gpt-4o" },
            }),
          }))
        ToolRegistry.registerToolProvider("image-fixture", () =>
          ["look_at", "view_image"].map((id) =>
            Tool.define(id, {
              description: id,
              parameters: z.object({}),
              async execute() {
                throw new Error("Catalog must not execute")
              },
            }),
          ),
        )
      },
    })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const base = await Provider.getModel("openai", "gpt-4o")
          for (const image of [false, true])
            for (const restricted of [false, true])
              for (const denied of [false, true]) {
                const model = {
                  ...base,
                  capabilities: {
                    ...base.capabilities,
                    input: {
                      ...base.capabilities.input,
                      image,
                      supportedImageMediaTypes: restricted ? ["image/png"] : undefined,
                    },
                  },
                }
                const agent = Agent.Info.parse({
                  name: "fixture",
                  mode: "primary",
                  options: {},
                  permission: PermissionNext.fromConfig(
                    denied ? { "*": "allow", look_at: "deny", view_image: "deny" } : { "*": "allow" },
                  ),
                })
                const expected = (["view_image", "look_at"] as const)
                  .filter((id) => !denied && (id === "view_image" ? image : vision && (!image || restricted)))
                  .sort()
                const input = { agent, model, sessionID: "image-fixture", includeMCP: false }
                const resolved = await ToolResolver.availability(input)
                expect(
                  resolved.visible
                    .map((tool) => tool.id)
                    .filter((id) => id === "look_at" || id === "view_image")
                    .sort(),
                ).toEqual(expected)
                const discovery = await ToolDiscovery.collect({ ...input, providerID: model.providerID })
                expect(
                  discovery.tools
                    .filter((tool) => !discovery.disabled.has(tool.id))
                    .map((tool) => tool.id)
                    .filter((id) => id === "look_at" || id === "view_image")
                    .sort(),
                ).toEqual(expected)
              }
        },
      }),
    )
  })
