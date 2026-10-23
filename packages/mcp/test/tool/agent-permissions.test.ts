import { afterAll, expect, spyOn, test } from "bun:test"
import { jsonSchema } from "ai"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { EnforcementGate } from "@ericsanchezok/synergy-harness/enforcement/gate"
import { RuntimeComponents } from "@ericsanchezok/synergy-harness/lifecycle"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { ToolDiscovery } from "@ericsanchezok/synergy-harness/test/internal/tool/discovery"
import { ExpandToolsTool } from "@ericsanchezok/synergy-harness/test/internal/tool/expand-tools"
import { SearchToolsTool } from "@ericsanchezok/synergy-harness/test/internal/tool/search-tools"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ToolResolver } from "@ericsanchezok/synergy-harness/test/support/internals"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import type { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { plugins } from "@ericsanchezok/synergy-plugin-host/component"
import { MCP } from "../../src"
import { mcp } from "../../src/component"

const runtime = await testRuntime({
  composition: RuntimeComponents.compose([localRuntime({ workers: false, environment: false }), plugins(), mcp()]),
})
afterAll(() => runtime.close())

const model = {
  id: "fixture",
  providerID: "fixture",
  api: { id: "fixture" },
  capabilities: { input: { image: false } },
} as Parameters<typeof ToolResolver.availability>[0]["model"]
const schema = { type: "object" as const, properties: {}, additionalProperties: false }
const entries: MCP.ToolEntry[] = ["read", "update", "delete"].map((toolName) => ({
  id: `mcp__fixture__${toolName}`,
  serverName: "fixture",
  toolName,
  requiresWorkspace: false,
  inputSchema: schema,
  tool: {
    description: `Fixture ${toolName}`,
    inputSchema: jsonSchema(schema),
    async execute() {
      throw new Error("Discovery and expansion must not execute MCP tools")
    },
  },
}))
const ids = entries.map((entry) => entry.id).sort()

function context(session: Session.Info, agent: Agent.Info): Tool.Context {
  return {
    sessionID: session.id,
    messageID: "msg_mcp_access",
    agent: agent.name,
    abort: new AbortController().signal,
    extra: { model },
    metadata() {},
    async ask() {
      throw new Error("Discovery and expansion must not request execution approval")
    },
  }
}

for (const controlProfile of ["guarded", "autonomous", "full_access"] as const) {
  test(`primary and child MCP discovery preserves ${controlProfile} execution policy`, () =>
    runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          using source = spyOn(MCP, "toolEntries").mockResolvedValue(entries)
          const parent = await Session.create({ workspaceID: null, controlProfile })
          const child = await Session.create({ parentID: parent.id })
          for (const [name, session] of [
            [PrimaryAgentIdentity.names.general, parent],
            ["inspector", child],
          ] as const) {
            const agent = await Agent.get(name)
            const input = { agent, model, session, sessionID: session.id }
            const before = await ToolResolver.availability(input)
            expect(before.visible.filter((tool) => ids.includes(tool.id))).toEqual([])
            expect([...before.autoExpandable]).toEqual(expect.arrayContaining(ids))
            const search = await SearchToolsTool.init({ agent })
            const found = await search.execute({ query: "fixture", limit: 8 }, context(session, agent))
            expect(found.metadata.results).toEqual(
              expect.arrayContaining([expect.objectContaining({ id: "mcp:fixture", matchedToolPreview: ids })]),
            )
            const expand = await ExpandToolsTool.init({ agent })
            const expanded = await expand.execute({ groups: ["mcp:fixture"] }, context(session, agent))
            expect(expanded.metadata.newlyVisibleTools).toEqual(ids)
            const current = await Session.get(session.id)
            const after = await ToolResolver.availability({ ...input, session: current })
            expect(
              after.visible
                .filter((tool) => ids.includes(tool.id))
                .map((tool) => tool.id)
                .sort(),
            ).toEqual(ids)
            const profileId = await Session.resolveEffectiveControlProfile({ sessionID: session.id })
            expect(profileId).toBe(controlProfile)
            const gate = await EnforcementGate.create({
              activeWorkspace: null,
              workspaceType: "main",
              profileId,
              registeredMcpTools: new Set(ids),
            })
            for (const id of ids) {
              expect(gate.evaluate(id, {}).decision).toBe(controlProfile === "guarded" ? "ask" : "allow")
            }
          }
        },
      }),
    ))
}

test("explicit configuration and per-call restrictions survive MCP expansion under full access", () =>
  runtime.run(async () => {
    await using project = await tmpdir({
      config: {
        permission: { mcp__fixture__update: "deny" },
        agent: { inspector: { permission: { mcp__fixture__read: "deny" } } },
      },
    })
    await ScopeContext.provide({
      scope: await project.scope(),
      fn: async () => {
        using source = spyOn(MCP, "toolEntries").mockResolvedValue(entries)
        const agent = await Agent.get("inspector")
        const session = await Session.create({ workspaceID: null, controlProfile: "full_access" })
        const input = { agent, model, session, sessionID: session.id }
        const catalog = await ToolDiscovery.collect({ ...input, providerID: model.providerID })
        expect(ToolDiscovery.availableGroups(catalog).find((group) => group.id === "mcp:fixture")?.tools).toEqual([
          "mcp__fixture__delete",
        ])
        const expand = await ExpandToolsTool.init({ agent })
        const result = await expand.execute({ groups: ["mcp:fixture"] }, context(session, agent))
        expect(result.metadata.newlyVisibleTools).toEqual(["mcp__fixture__delete"])
        const current = await Session.get(session.id)
        const visible = await ToolResolver.availability({ ...input, session: current })
        expect(visible.visible.filter((tool) => ids.includes(tool.id)).map((tool) => tool.id)).toEqual([
          "mcp__fixture__delete",
        ])
        const restricted = { ...input, session: current, userTools: { mcp__fixture__delete: false } }
        expect((await ToolResolver.availability(restricted)).visible.filter((tool) => ids.includes(tool.id))).toEqual(
          [],
        )
        expect(
          ToolDiscovery.availableGroups(
            await ToolDiscovery.collect({ ...restricted, providerID: model.providerID }),
          ).find((group) => group.id === "mcp:fixture"),
        ).toBeUndefined()
      },
    })
  }))
