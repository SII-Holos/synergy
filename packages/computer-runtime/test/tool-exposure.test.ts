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
import { computer } from "../src/component"
import { ComputerActionTool, ComputerAppsTool, ComputerObserveTool } from "../src/tools"

const env = {
  SYNERGY_CONFIG_CONTENT: JSON.stringify({ provider: { openai: { options: { apiKey: "fixture-key" } } } }),
}
const tools = [ComputerAppsTool, ComputerObserveTool, ComputerActionTool]
const members = tools.map((tool) => tool.id).sort()
const agent = Agent.Info.parse({
  name: "exposure-fixture",
  mode: "primary",
  options: {},
  controlProfile: "full_access",
  permission: PermissionNext.fromConfig({ "*": "allow" }),
})

test("computer defers exactly its three native tools without changing their model contracts", async () => {
  await using runtime = await testRuntime({ env, register: () => computer().register() })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      async fn() {
        const model = await Provider.getModel("openai", "gpt-4o")
        const session = await Session.create({ controlProfile: "full_access", workspace: null })
        const input = { agent, model, session, sessionID: session.id, includeMCP: false }
        const before = await ToolResolver.definitions(input)
        const beforeIDs = before.map((tool) => tool.id)
        expect(beforeIDs.filter((id) => members.includes(id))).toEqual([])
        expect(ToolExposure.builtinGroup("computer")?.tools.toSorted()).toEqual(members)
        const catalog = await ToolDiscovery.collect({ ...input, providerID: model.providerID })
        expect(
          ToolDiscovery.availableGroups(catalog)
            .find((group) => group.id === "computer")
            ?.tools.toSorted(),
        ).toEqual(members)
        expect(ToolDiscovery.visibleTools(catalog).filter((id) => members.includes(id))).toEqual([])
        const context: Tool.Context = {
          sessionID: session.id,
          messageID: "msg_computer_exposure",
          agent: agent.name,
          abort: new AbortController().signal,
          extra: { model },
          metadata() {},
          async ask() {
            throw new Error("Discovery must not request approval")
          },
        }
        const search = await SearchToolsTool.init({ agent })
        const found = await search.execute({ query: "computer", limit: 8 }, context)
        expect(found.metadata.results).toContainEqual(
          expect.objectContaining({ type: "group", id: "computer", active: false, matchedToolPreview: members }),
        )
        expect((await Session.get(session.id)).toolState?.expandedGroups ?? []).toEqual([])
        const originals = await Promise.all(
          tools.map(async (tool) => {
            const initialized = await tool.init()
            return {
              id: tool.id,
              description: initialized.description,
              schema: z.toJSONSchema(initialized.parameters, { io: "input" }),
            }
          }),
        )
        const expand = await ExpandToolsTool.init({ agent })
        const expanded = await expand.execute({ groups: ["computer"] }, context)
        expect(expanded.metadata.newlyVisibleTools).toEqual(members)
        expect(expanded.metadata.availableRequestedTools).toEqual(members)
        const updated = await Session.get(session.id)
        expect(updated.toolState?.expandedGroups).toEqual(["computer"])
        const after = await ToolResolver.definitions({ ...input, session: updated })
        expect(
          after
            .filter((tool) => !beforeIDs.includes(tool.id))
            .map((tool) => tool.id)
            .sort(),
        ).toEqual(members)
        const registered = await ToolRegistry.tools(model.providerID, agent)
        for (const original of originals) {
          const resolved = after.find((tool) => tool.id === original.id)!
          expect(resolved.description).toBe(original.description)
          expect<unknown>(resolved.inputSchema).toEqual(
            ProviderTransform.schema(model, structuredClone(original.schema), { tool: original.id }),
          )
          const definition = registered.find((tool) => tool.id === original.id)!
          expect(z.toJSONSchema(definition.parameters, { io: "input" })).toEqual(original.schema)
        }
        const discovered = await ToolDiscovery.collect({ ...input, session: updated, providerID: model.providerID })
        expect(ToolDiscovery.visibleTools(discovered).filter((id) => members.includes(id))).toEqual(members)
        await Session.remove(session.id)
      },
    }),
  )
})

test.each(["permission-denied", "user-disabled", "owner-absent"] as const)(
  "computer cannot expose unavailable tools when %s, even with retained expansion",
  async (availability) => {
    await using runtime = await testRuntime({
      env,
      register() {
        if (availability !== "owner-absent") computer().register()
      },
    })
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
              ...(availability === "permission-denied" ? { "computer_*": "deny" as const } : {}),
            }),
          }
          const userTools =
            availability === "user-disabled" ? { "*": false, expand_tools: true, search_tools: true } : undefined
          const session = await Session.create({ controlProfile: "full_access", workspace: null })
          await Session.update(session.id, (draft) => {
            draft.toolState = { expandedGroups: ["computer"] }
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
          expect(ToolDiscovery.availableGroups(catalog).some((group) => group.id === "computer")).toBe(false)
          expect(ToolDiscovery.nonResidentEntries(catalog).some((entry) => members.includes(entry.id))).toBe(false)
          const expand = await ExpandToolsTool.init({ agent: selectedAgent })
          const expanded = await expand.execute(
            { groups: ["computer"] },
            {
              sessionID: session.id,
              messageID: "msg_computer_unavailable",
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
          expect((await ToolResolver.definitions(input)).filter((tool) => members.includes(tool.id))).toEqual([])
          if (availability === "owner-absent") {
            expect((await ToolRegistry.ids()).filter((id) => members.includes(id))).toEqual([])
            expect(ToolExposure.builtinGroup("computer")).toBeUndefined()
          }
          await Session.remove(session.id)
        },
      }),
    )
  },
)
