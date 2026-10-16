import { afterAll, expect, mock, spyOn, test } from "bun:test"
import { jsonSchema } from "ai"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { ToolDiscovery } from "@ericsanchezok/synergy-harness/test/internal/tool/discovery"
import { ExpandToolsTool } from "@ericsanchezok/synergy-harness/test/internal/tool/expand-tools"
import { SearchToolsTool } from "@ericsanchezok/synergy-harness/test/internal/tool/search-tools"
import { ToolResolver } from "@ericsanchezok/synergy-harness/test/support/internals"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ToolMcpSource } from "@ericsanchezok/synergy-harness/tool/mcp-source"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { MCP } from "../../src"
import { testRuntime as harnessRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
import { registerConfig } from "../../src/config-schema"
import { registerMcpToolSource } from "../../src/tool-source"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

const model = {
  id: "fixture",
  providerID: "fixture",
  api: { id: "fixture" },
  capabilities: { input: { image: false } },
} as Parameters<typeof ToolResolver.availability>[0]["model"]
const agent = Agent.Info.parse({
  name: "online-fixture",
  mode: "primary",
  options: {},
  permission: PermissionNext.fromConfig({ "*": "allow" }),
})
const execute = mock(async () => ({ content: [{ type: "text", text: "source result" }] }))
const schema = {
  type: "object" as const,
  properties: { query: { type: "string" as const } },
  required: ["query"],
  additionalProperties: false,
}
const entries = [
  ["anysearch", "search"],
  ["anysearch", "batch_search"],
  ["anysearch", "get_sub_domains"],
  ["anysearch", "extract"],
  ["scholight", "search_papers"],
  ["scholight", "extract_url"],
].map(([serverName, toolName]) => ({
  id: `mcp__${serverName}__${toolName}`,
  serverName: serverName!,
  toolName: toolName!,
  source: "builtin" as const,
  requiresWorkspace: false,
  tool: { description: "Original remote description", inputSchema: jsonSchema(schema), execute },
  inputSchema: schema,
}))

async function fixture(
  run: (session: Session.Info, context: Tool.Context) => Promise<void>,
  config: Record<string, unknown> = {},
  tools: MCP.ToolEntry[] = entries,
) {
  await runtime.run(async () => {
    await using project = await tmpdir({ config })
    await ScopeContext.provide({
      scope: await project.scope(),
      fn: async () => {
        using source = spyOn(MCP, "toolEntries").mockResolvedValue(tools)
        const session = await Session.create({ workspaceID: null })
        await run(session, {
          sessionID: session.id,
          messageID: "msg_online",
          agent: agent.name,
          abort: new AbortController().signal,
          extra: { model },
          metadata() {},
          async ask() {
            throw new Error("Discovery cannot ask for execution permission")
          },
        })
      },
    })
  })
}

test("built-in online capabilities share one discoverable group and preserve native contracts", () =>
  fixture(async (session, context) => {
    const availability = await ToolResolver.availability({ agent, model, session, sessionID: session.id })
    expect(availability.visible.some((tool) => entries.some((entry) => entry.id === tool.id))).toBe(false)
    const catalog = await ToolDiscovery.collect({ providerID: model.providerID, model, agent, session })
    const groups = ToolDiscovery.availableGroups(catalog)
    expect(groups.filter((group) => group.tools.some((id) => id.startsWith("mcp__")))).toEqual([
      expect.objectContaining({ id: "online", tools: entries.map((entry) => entry.id).sort() }),
    ])
    const directory = availability.visible.find((tool) => tool.id === "expand_tools")!.description
    expect(directory).toContain("online (Online search and reading)")
    expect(directory).toContain("AI paper discovery")
    expect(directory).not.toContain("Original remote description")
    const search = await SearchToolsTool.init({ agent })
    for (const query of ["paper search", "查找论文", "联网", "news"]) {
      const result = await search.execute({ query, limit: 8 }, context)
      expect(result.metadata.results).toEqual(expect.arrayContaining([expect.objectContaining({ id: "online" })]))
      expect(result.output).toContain("AI paper discovery")
    }
    const source = await ToolMcpSource.get()!.toolEntries()
    for (const entry of source) {
      expect(entry.inputSchema).toBe(schema)
      expect(entry.tool.execute).toBe(execute)
      expect(entry.tool.description).toBe("Original remote description")
    }
    const expand = await ExpandToolsTool.init({ agent })
    const result = await expand.execute({ groups: ["online"] }, context)
    expect(result.metadata.availableRequestedTools).toEqual(entries.map((entry) => entry.id).sort())
    const updated = await Session.get(session.id)
    const visible = await ToolResolver.availability({ agent, model, session: updated, sessionID: session.id })
    for (const entry of entries) {
      const definition = visible.visible.find((tool) => tool.id === entry.id)!
      expect(definition).toBeDefined()
      expect(definition.inputSchema).toBe(schema)
      expect(definition.description).not.toBe("Original remote description")
      expect(catalog.tools.find((tool) => tool.id === entry.id)!.description).toBe(definition.description)
    }
    expect(execute).not.toHaveBeenCalled()
  }))

test("partial online availability advertises only available capabilities", () =>
  fixture(async (session, context) => {
    const denied = { ...agent, permission: PermissionNext.fromConfig({ "*": "allow", "mcp__scholight__*": "deny" }) }
    const input = {
      agent: denied,
      model,
      session,
      sessionID: session.id,
      userTools: { mcp__anysearch__extract: false },
    }
    const catalog = await ToolDiscovery.collect({ ...input, providerID: model.providerID })
    const group = ToolDiscovery.availableGroups(catalog).find((group) => group.id === "online")!
    expect(group.tools).toEqual(
      entries
        .filter((entry) => entry.serverName === "anysearch" && entry.toolName !== "extract")
        .map((entry) => entry.id)
        .sort(),
    )
    expect(group.description).not.toContain("AI paper discovery")
    const visible = await ToolResolver.availability(input)
    expect(visible.visible.find((tool) => tool.id === "expand_tools")!.description).not.toContain("AI paper discovery")
    const expand = await ExpandToolsTool.init({ agent: denied })
    const expanded = await expand.execute(
      { groups: ["online"] },
      { ...context, extra: { model, userTools: input.userTools } },
    )
    expect(expanded.metadata.availableRequestedTools).toEqual(group.tools)
  }))

test("explicit residency overrides folding without changing the online contract", () =>
  fixture(
    async (session) => {
      const input = { agent, model, session, sessionID: session.id }
      const availability = await ToolResolver.availability(input)
      expect(
        availability.visible
          .filter((tool) => tool.id.startsWith("mcp__"))
          .map((tool) => tool.id)
          .sort(),
      ).toEqual(
        entries
          .filter((entry) => entry.serverName === "anysearch")
          .map((entry) => entry.id)
          .sort(),
      )
      const catalog = await ToolDiscovery.collect({ ...input, providerID: model.providerID })
      expect(ToolDiscovery.availableGroups(catalog).find((group) => group.id === "online")!.tools).toEqual(
        entries
          .filter((entry) => entry.serverName === "scholight")
          .map((entry) => entry.id)
          .sort(),
      )
    },
    { mcp: { anysearch: { expandByDefault: true } } },
  ))

test("user-owned same-name servers and unknown built-in tools keep their original presentation", () =>
  fixture(
    async (session) => {
      const catalog = await ToolDiscovery.collect({ providerID: model.providerID, model, agent, session })
      expect(ToolDiscovery.availableGroups(catalog).some((group) => group.id === "online")).toBe(false)
      for (const entry of catalog.tools.filter((tool) => tool.source === "mcp")) {
        expect(entry.group).toBe("mcp:anysearch")
        expect(entry.description).toBe("Original remote description")
      }
    },
    {},
    [
      { ...entries[0]!, source: "config" as const },
      { ...entries[0]!, id: "mcp__anysearch__future", toolName: "future" },
      ...["constructor", "toString", "hasOwnProperty"].map((toolName) => ({
        ...entries[0]!,
        id: `mcp__anysearch__${toolName}`,
        toolName,
      })),
    ],
  ))

test("old server expansion does not implicitly expand online and points at the current group", () =>
  fixture(async (session, context) => {
    await Session.update(session.id, (draft) => {
      draft.toolState = { expandedGroups: ["mcp:anysearch"], activatedTools: [] }
    })
    const restored = await Session.get(session.id)
    const availability = await ToolResolver.availability({ agent, model, session: restored, sessionID: session.id })
    expect(availability.visible.some((tool) => tool.id.startsWith("mcp__"))).toBe(false)
    const expand = await ExpandToolsTool.init({ agent })
    const result = await expand.execute({ groups: ["mcp:anysearch"] }, context)
    expect(result.metadata.changed).toBe(false)
    expect(result.metadata.issues.unknownGroups).toEqual(["mcp:anysearch"])
    expect(result.output).toContain("online")
    expect((await Session.get(session.id)).toolState).toEqual(restored.toolState)
  }))

test("global residency and per-server folding keep their existing precedence", () =>
  fixture(
    async (session) => {
      const available = await ToolResolver.availability({ agent, model, session, sessionID: session.id })
      expect(
        available.visible
          .filter((tool) => tool.id.startsWith("mcp__"))
          .map((tool) => tool.id)
          .sort(),
      ).toEqual(
        entries
          .filter((entry) => entry.serverName === "anysearch")
          .map((entry) => entry.id)
          .sort(),
      )
      const catalog = await ToolDiscovery.collect({ providerID: model.providerID, model, agent, session })
      expect(ToolDiscovery.availableGroups(catalog).find((group) => group.id === "online")!.tools).toEqual(
        entries
          .filter((entry) => entry.serverName === "scholight")
          .map((entry) => entry.id)
          .sort(),
      )
    },
    { mcpDefaults: { expandByDefault: true }, mcp: { scholight: { expandByDefault: false } } },
  ))

test("one connected provider does not advertise the missing provider or require it for expansion", () =>
  fixture(
    async (session, context) => {
      const catalog = await ToolDiscovery.collect({ providerID: model.providerID, model, agent, session })
      const group = ToolDiscovery.availableGroups(catalog).find((group) => group.id === "online")!
      expect(group.tools).toEqual(
        entries
          .filter((entry) => entry.serverName === "anysearch")
          .map((entry) => entry.id)
          .sort(),
      )
      expect(group.description).not.toContain("AI paper discovery")
      const expand = await ExpandToolsTool.init({ agent })
      expect((await expand.execute({ groups: ["online"] }, context)).metadata.availableRequestedTools).toEqual(
        group.tools,
      )
    },
    {},
    entries.filter((entry) => entry.serverName === "anysearch"),
  ))

test("online expansion survives Runtime reopen and cannot leak to another Runtime", async () => {
  await using home = await runtimeHome()
  await using project = await tmpdir()
  const open = () =>
    harnessRuntime({
      home: home.host.home,
      composition: {
        register() {
          registerLocalRuntime()
          registerConfig()
          registerMcpToolSource()
        },
      },
    })
  let sessionID = ""
  const first = await open()
  const scope = await first.run(() => project.scope())
  try {
    await first.run(() =>
      ScopeContext.provide({
        scope,
        fn: async () => {
          using source = spyOn(MCP, "toolEntries").mockResolvedValue(entries)
          const session = await Session.create({ workspaceID: null })
          sessionID = session.id
          await Session.update(sessionID, (draft) => {
            draft.toolState = { expandedGroups: ["online"], activatedTools: [] }
          })
          expect(
            (
              await ToolResolver.availability({ agent, model, session: await Session.get(sessionID), sessionID })
            ).visible.some((tool) => tool.id === entries[0]!.id),
          ).toBe(true)
        },
      }),
    )
  } finally {
    await first.close()
  }
  await using reopened = await open()
  await reopened.run(() =>
    ScopeContext.provide({
      scope,
      fn: async () => {
        using source = spyOn(MCP, "toolEntries").mockResolvedValue(entries)
        const restored = await Session.get(sessionID)
        expect(restored.toolState).toEqual({ expandedGroups: ["online"], activatedTools: [] })
        expect(
          (await ToolResolver.availability({ agent, model, session: restored, sessionID })).visible
            .filter((tool) => tool.id.startsWith("mcp__"))
            .map((tool) => tool.id)
            .sort(),
        ).toEqual(entries.map((entry) => entry.id).sort())
        await runtime.run(() =>
          ScopeContext.provide({
            scope: Scope.home(),
            workspace: null,
            fn: async () => {
              const fresh = await Session.create({ workspaceID: null })
              const hidden = await ToolResolver.availability({ agent, model, session: fresh, sessionID: fresh.id })
              expect(hidden.visible.some((tool) => tool.id.startsWith("mcp__"))).toBe(false)
            },
          }),
        )
        expect(
          (await ToolResolver.availability({ agent, model, session: restored, sessionID })).visible.some(
            (tool) => tool.id === entries[0]!.id,
          ),
        ).toBe(true)
      },
    }),
  )
})
