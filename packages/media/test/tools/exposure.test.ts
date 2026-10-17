import { expect, test } from "bun:test"
import { z } from "zod"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { ProviderTransform } from "@ericsanchezok/synergy-harness/provider/transform"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { ToolResolver } from "@ericsanchezok/synergy-harness/test/support/internals"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { ToolDiscovery } from "@ericsanchezok/synergy-harness/test/internal/tool/discovery"
import { ExpandToolsTool } from "@ericsanchezok/synergy-harness/test/internal/tool/expand-tools"
import { SearchToolsTool } from "@ericsanchezok/synergy-harness/test/internal/tool/search-tools"
import { ToolExposure } from "@ericsanchezok/synergy-harness/tool/exposure"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { RenderTool } from "../../src/tools/render"
import { testRuntime as mediaRuntime } from "../support/runtime"

const env = {
  SYNERGY_CONFIG_CONTENT: JSON.stringify({ provider: { openai: { options: { apiKey: "fixture-key" } } } }),
}
const agent = Agent.Info.parse({
  name: "exposure-fixture",
  mode: "primary",
  options: {},
  permission: PermissionNext.fromConfig({ "*": "allow" }),
})

test("visuals defers only render and expands its unchanged model contract", async () => {
  await using runtime = await mediaRuntime(env)
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      async fn() {
        const model = await Provider.getModel("openai", "gpt-4o")
        const session = await Session.create({ workspace: null })
        const input = { agent, model, session, sessionID: session.id, includeMCP: false }
        const before = await ToolResolver.definitions(input)
        const beforeIDs = before.map((tool) => tool.id)
        expect(beforeIDs).not.toContain("render")
        expect(beforeIDs).toContain("runtime_reload")
        expect(beforeIDs).toContain("scan_document")
        expect(ToolExposure.builtinGroup("visuals")?.tools).toEqual(["render"])
        for (const id of ["runtime_reload", "openai_image_gen", "openai_image_edit"])
          expect(ToolExposure.normalize(id)).toEqual({ mode: "resident" })

        const catalog = await ToolDiscovery.collect({ ...input, providerID: model.providerID })
        expect(ToolDiscovery.availableGroups(catalog).find((group) => group.id === "visuals")?.tools).toEqual([
          "render",
        ])
        expect(ToolDiscovery.visibleTools(catalog)).not.toContain("render")
        const context: Tool.Context = {
          sessionID: session.id,
          messageID: "msg_visuals_exposure",
          agent: agent.name,
          abort: new AbortController().signal,
          extra: { model },
          metadata() {},
          async ask() {
            throw new Error("Discovery must not request approval")
          },
        }
        const search = await SearchToolsTool.init({ agent })
        const found = await search.execute({ query: "render", limit: 8 }, context)
        expect(found.metadata.results).toContainEqual(
          expect.objectContaining({ type: "group", id: "visuals", active: false, matchedToolPreview: ["render"] }),
        )
        expect((await Session.get(session.id)).toolState?.expandedGroups ?? []).toEqual([])

        const original = await RenderTool.init()
        const schema = z.toJSONSchema(original.parameters, { io: "input" })
        const expand = await ExpandToolsTool.init({ agent })
        const expanded = await expand.execute({ groups: ["visuals"] }, context)
        expect(expanded.metadata.newlyVisibleTools).toEqual(["render"])
        expect(expanded.metadata.availableRequestedTools).toEqual(["render"])
        const updated = await Session.get(session.id)
        expect(updated.toolState?.expandedGroups).toEqual(["visuals"])
        const after = await ToolResolver.definitions({ ...input, session: updated })
        expect(after.filter((tool) => !beforeIDs.includes(tool.id)).map((tool) => tool.id)).toEqual(["render"])
        const resolved = after.find((tool) => tool.id === "render")!
        expect(resolved.description).toBe(original.description)
        expect<unknown>(resolved.inputSchema).toEqual(
          ProviderTransform.schema(model, structuredClone(schema), { tool: "render" }),
        )
        const registered = (await ToolRegistry.tools(model.providerID, agent)).find((tool) => tool.id === "render")!
        expect(z.toJSONSchema(registered.parameters, { io: "input" })).toEqual(schema)
        const discovered = await ToolDiscovery.collect({ ...input, session: updated, providerID: model.providerID })
        expect(ToolDiscovery.visibleTools(discovered)).toContain("render")
        await Session.remove(session.id)
      },
    }),
  )
})

test.each(["permission-denied", "user-disabled", "owner-absent"] as const)(
  "visuals cannot expose render when %s, even with retained expansion",
  async (availability) => {
    await using runtime = await (availability === "owner-absent" ? testRuntime({ env }) : mediaRuntime(env))
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        async fn() {
          const model = await Provider.getModel("openai", "gpt-4o")
          const selectedAgent = {
            ...agent,
            permission: PermissionNext.fromConfig({
              "*": "allow",
              ...(availability === "permission-denied" ? { render: "deny" as const } : {}),
            }),
          }
          const userTools = availability === "user-disabled" ? { render: false } : undefined
          const session = await Session.create({ workspace: null })
          await Session.update(session.id, (draft) => {
            draft.toolState = { expandedGroups: ["visuals"] }
          })
          const input = {
            agent: selectedAgent,
            model,
            session: await Session.get(session.id),
            sessionID: session.id,
            userTools,
            includeMCP: false,
          }
          const catalog = await ToolDiscovery.collect({ ...input, providerID: model.providerID })
          expect(ToolDiscovery.availableGroups(catalog).some((group) => group.id === "visuals")).toBe(false)
          expect(ToolDiscovery.nonResidentEntries(catalog).some((entry) => entry.id === "render")).toBe(false)
          const expand = await ExpandToolsTool.init({ agent: selectedAgent })
          const expanded = await expand.execute(
            { groups: ["visuals"] },
            {
              sessionID: session.id,
              messageID: "msg_visuals_unavailable",
              agent: selectedAgent.name,
              abort: new AbortController().signal,
              extra: { model, userTools },
              metadata() {},
              async ask() {
                throw new Error("Expansion must not request approval")
              },
            },
          )
          expect(expanded.metadata.newlyVisibleTools).toEqual([])
          expect(expanded.metadata.availableRequestedTools).toEqual([])
          expect((await ToolResolver.definitions(input)).map((tool) => tool.id)).not.toContain("render")
          if (availability === "owner-absent") {
            expect(await ToolRegistry.ids()).not.toContain("render")
            expect(ToolExposure.builtinGroup("visuals")).toBeUndefined()
          }
          await Session.remove(session.id)
        },
      }),
    )
  },
)
