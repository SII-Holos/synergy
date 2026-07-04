import { describe, expect, test } from "bun:test"
import z from "zod"
import { Agent } from "../../src/agent/agent"
import { PermissionNext } from "../../src/permission/next"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { ToolResolver } from "../../src/session/tool-resolver"
import { ExpandToolsTool } from "../../src/tool/expand-tools"
import { ToolDiscovery } from "../../src/tool/discovery"
import { ToolExposure } from "../../src/tool/exposure"
import { SearchToolsTool } from "../../src/tool/search-tools"
import { Tool } from "../../src/tool/tool"
import { ToolRegistry } from "../../src/tool/registry"
import { Log } from "../../src/util/log"
import { PluginManifest } from "../../../plugin/src/manifest"
import { tool as pluginTool } from "../../../plugin/src/tool"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const model = {
  id: "test-model",
  providerID: "test-provider",
  name: "Test Model",
  limit: { context: 100_000, output: 8_192 },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  api: { id: "test-model", npm: "@ai-sdk/openai" },
  capabilities: {
    toolcall: true,
    attachment: false,
    reasoning: false,
    temperature: true,
    input: { text: true, image: false, audio: false, video: false },
    output: { text: true, image: false, audio: false, video: false },
  },
  options: {},
} as any

const imageModel = {
  ...model,
  capabilities: {
    ...model.capabilities,
    input: { ...model.capabilities.input, image: true },
  },
} as any

const allowAllAgent: Agent.Info = {
  name: "synergy",
  mode: "primary",
  permission: PermissionNext.fromConfig({ "*": "allow" }),
  options: {},
}

async function definitionIDs(
  session: Session.Info,
  input?: { agent?: Agent.Info; model?: typeof model; userTools?: Record<string, boolean> },
) {
  const defs = await ToolResolver.definitions({
    agent: input?.agent ?? allowAllAgent,
    model: input?.model ?? model,
    sessionID: session.id,
    session,
    userTools: input?.userTools,
    includeMCP: false,
  })
  return new Set(defs.map((def) => def.id))
}

async function definitions(session: Session.Info) {
  return ToolResolver.definitions({
    agent: allowAllAgent,
    model,
    sessionID: session.id,
    session,
    includeMCP: false,
  })
}

function toolContext(sessionID: string): Tool.Context {
  return {
    sessionID,
    messageID: "message_test",
    agent: "synergy",
    abort: new AbortController().signal,
    extra: { model },
    metadata() {},
    async ask() {},
  }
}

describe("tool exposure", () => {
  test("defaults to resident and classifies built-in groups and explicit search/internal tools", () => {
    const explicit = Tool.define(
      "explicit_search_tool",
      {
        description: "Only visible after activation.",
        parameters: z.object({}),
        async execute() {
          return { title: "explicit_search_tool", output: "ok", metadata: {} }
        },
      },
      { exposure: { mode: "search", title: "Explicit Search Tool", keywords: ["needle"] } },
    )
    const internal = Tool.define(
      "internal_helper_tool",
      {
        description: "Only visible when force-enabled by the host.",
        parameters: z.object({}),
        async execute() {
          return { title: "internal_helper_tool", output: "ok", metadata: {} }
        },
      },
      { exposure: { mode: "internal" } },
    )

    expect(ToolExposure.normalize("ordinary_tool")).toEqual({ mode: "resident" })
    expect(ToolExposure.normalize("browser_navigate")).toEqual({ mode: "group", group: "browser" })
    expect(explicit.exposure).toEqual({ mode: "search", title: "Explicit Search Tool", keywords: ["needle"] })
    expect(internal.exposure).toEqual({ mode: "internal" })
  })

  test("ToolResolver hides look_at when the active model supports image input", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})

        expect((await definitionIDs(session)).has("look_at")).toBe(true)
        expect((await definitionIDs(session, { model: imageModel })).has("look_at")).toBe(false)
      },
    })
  })

  test("ToolResolver hides deferred groups until the session expands them", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        let ids = await definitionIDs(session)

        expect(ids.has("search_tools")).toBe(true)
        expect(ids.has("expand_tools")).toBe(true)
        expect(ids.has("browser_navigate")).toBe(false)
        expect(ids.has("agenda_list")).toBe(false)
        expect(ids.has("session_list")).toBe(false)
        expect(ids.has("note_list")).toBe(false)
        expect(ids.has("memory_get")).toBe(false)

        await Session.update(session.id, (draft) => {
          draft.toolState = { expandedGroups: ["browser"] }
        })

        const expanded = await Session.get(session.id)
        ids = await definitionIDs(expanded)
        expect(ids.has("browser_navigate")).toBe(true)
        expect(ids.has("browser_screenshot")).toBe(true)
        expect(ids.has("agenda_list")).toBe(false)

        expect((await Session.get(session.id)).toolState?.expandedGroups).toEqual(["browser"])
      },
    })
  })

  test("search-only tools are visible only after explicit activation", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const id = `search_only_test_${Math.random().toString(36).slice(2)}`
        await ToolRegistry.register(
          Tool.define(
            id,
            {
              description: "A test-only deferred tool.",
              parameters: z.object({}),
              async execute() {
                return { title: id, output: "ok", metadata: {} }
              },
            },
            { exposure: { mode: "search", title: "Test Deferred Tool", keywords: ["deferred-test"] } },
          ),
        )

        const session = await Session.create({})
        expect((await definitionIDs(session)).has(id)).toBe(false)

        await Session.update(session.id, (draft) => {
          draft.toolState = { activatedTools: [id] }
        })

        expect((await definitionIDs(await Session.get(session.id))).has(id)).toBe(true)
      },
    })
  })

  test("internal tools are hidden from search and visible only when force-enabled", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const id = `internal_test_${Math.random().toString(36).slice(2)}`
        await ToolRegistry.register(
          Tool.define(
            id,
            {
              description: "A test-only internal tool.",
              parameters: z.object({}),
              async execute() {
                return { title: id, output: "ok", metadata: {} }
              },
            },
            { exposure: { mode: "internal" } },
          ),
        )

        const session = await Session.create({})
        expect((await definitionIDs(session)).has(id)).toBe(false)
        expect((await definitionIDs(session, { userTools: { [id]: true } })).has(id)).toBe(true)

        const search = await SearchToolsTool.init({ agent: allowAllAgent })
        const searchResult = await search.execute({ query: id, limit: 8 }, toolContext(session.id))
        expect((searchResult.metadata.results as Array<any>).some((entry) => entry.id === id)).toBe(false)
      },
    })
  })

  test("search_tools is read-only and expand_tools persists session state", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const search = await SearchToolsTool.init({ agent: allowAllAgent })
        const searchResult = await search.execute({ query: "memory note", limit: 8 }, toolContext(session.id))
        const searchResults = searchResult.metadata.results as Array<any>
        const memoryResult = searchResults.find((result) => result.id === "memory")
        const noteResult = searchResults.find((result) => result.id === "note")
        expect(memoryResult).toMatchObject({ type: "group", id: "memory" })
        expect(memoryResult.matchedToolPreview).toContain("memory_search")
        expect(noteResult).toMatchObject({ type: "group", id: "note" })
        expect(searchResults.some((result) => result.type === "tool" && result.id.startsWith("memory_"))).toBe(false)
        expect(searchResult.output).not.toContain("Structured results")
        expect((await Session.get(session.id)).toolState).toBeUndefined()

        const expand = await ExpandToolsTool.init({ agent: allowAllAgent })
        const result = await expand.execute(
          { groups: ["browser"], reason: "test browser expansion" },
          toolContext(session.id),
        )
        expect(result.metadata.availableNextStep).toBe(true)
        expect(result.metadata.availableOn).toBe("next_model_request")
        expect(result.metadata.availableRequestedTools).toContain("browser_navigate")
        expect(result.metadata.newlyVisibleTools).toContain("browser_navigate")
        expect(result.metadata.newlyVisibleTools).not.toContain("search_tools")
        expect(result.metadata.visibleTools).toBeUndefined()
        expect(result.output).toContain("You can call these tools directly:")
        expect(result.output).toContain("browser_navigate")
        expect(result.output).not.toContain("availableNextStep")
        expect(result.output).not.toContain("availableOn")
        expect(result.output).not.toContain("activatedTools: (none)")
        expect(result.output).not.toContain("visibleToolCount")
        expect(result.output).not.toContain("Structured result")
        expect((await Session.get(session.id)).toolState?.expandedGroups).toEqual(["browser"])
      },
    })
  })

  test("permissions and user tool settings still hide expanded tools", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        await Session.update(session.id, (draft) => {
          draft.toolState = { expandedGroups: ["browser"] }
        })
        const expanded = await Session.get(session.id)
        const denyNavigate: Agent.Info = {
          ...allowAllAgent,
          permission: PermissionNext.fromConfig({ "*": "allow", browser_navigate: "deny" }),
        }

        expect((await definitionIDs(expanded, { agent: denyNavigate })).has("browser_navigate")).toBe(false)
        expect(
          (await definitionIDs(expanded, { userTools: { browser_navigate: false } })).has("browser_navigate"),
        ).toBe(false)
        expect((await definitionIDs(expanded, { agent: denyNavigate })).has("browser_screenshot")).toBe(true)
      },
    })
  })

  test("Plan Mode keeps bash visible and forces the note group without exposing other deferred groups", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        await Session.update(session.id, (draft) => {
          draft.blueprint = { planMode: true }
        })

        const ids = await definitionIDs(await Session.get(session.id))
        expect(ids.has("bash")).toBe(true)
        expect(ids.has("edit")).toBe(false)
        expect(ids.has("search_tools")).toBe(true)
        expect(ids.has("expand_tools")).toBe(true)
        expect(ids.has("note_read")).toBe(true)
        expect(ids.has("note_write")).toBe(true)
        expect(ids.has("memory_get")).toBe(false)
        expect(ids.has("agenda_list")).toBe(false)
      },
    })
  })

  test("Plan Mode does not override explicit permission denial for bash", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        await Session.update(session.id, (draft) => {
          draft.blueprint = { planMode: true }
        })
        const denyBash: Agent.Info = {
          ...allowAllAgent,
          permission: PermissionNext.fromConfig({ "*": "allow", bash: "deny" }),
        }

        const availability = await ToolResolver.availability({
          agent: denyBash,
          model,
          sessionID: session.id,
          session: await Session.get(session.id),
          includeMCP: false,
        })

        expect(availability.visible.some((def) => def.id === "bash")).toBe(false)
        expect(availability.diagnostics.get("bash")?.code).toBe("permission_denied")
      },
    })
  })

  test("Plan Mode resolve keeps hidden tools inactive while preserving semantic diagnostic wrappers", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        await Session.update(session.id, (draft) => {
          draft.blueprint = { planMode: true }
        })
        const executions = new Map<string, Promise<any>>()
        const processor = {
          message: { id: "message_test" },
          partFromToolCall: () => undefined,
          trackExecution: (id: string, promise: Promise<any>) => executions.set(id, promise),
        } as any

        const resolved = await ToolResolver.resolveWithAvailability({
          agent: allowAllAgent,
          model,
          sessionID: session.id,
          processor,
          session: await Session.get(session.id),
          includeMCP: false,
        })

        expect(resolved.activeToolIDs).toContain("bash")
        expect(resolved.activeToolIDs).not.toContain("edit")
        expect(resolved.tools.edit).toBeDefined()

        await expect(
          (resolved.tools.edit as any).execute({ filePath: "x" }, { toolCallId: "call_edit" }),
        ).rejects.toThrow("Plan Mode")
        const outcome = await executions.get("call_edit")
        expect(outcome.status).toBe("error")
        expect(outcome.metadata.toolDiagnostic.code).toBe("plan_mode_blocked")
      },
    })
  })

  test("default tool budget is lower than expanded built-in groups", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const base = await definitions(session)
        await Session.update(session.id, (draft) => {
          draft.toolState = { expandedGroups: ToolExposure.BUILTIN_GROUPS.map((group) => group.id) }
        })
        const expanded = await definitions(await Session.get(session.id))

        const baseChars = base.reduce(
          (sum, def) => sum + def.description.length + JSON.stringify(def.inputSchema).length,
          0,
        )
        const expandedChars = expanded.reduce(
          (sum, def) => sum + def.description.length + JSON.stringify(def.inputSchema).length,
          0,
        )

        expect(base.length).toBeLessThan(expanded.length - 20)
        expect(expandedChars - baseChars).toBeGreaterThan(10_000)
      },
    })
  })

  test("MCP deferral threshold uses the total visible MCP tool count", () => {
    expect(ToolExposure.mcpExposure(ToolExposure.MCP_DEFER_THRESHOLD - 1, "github")).toEqual({ mode: "resident" })
    expect(ToolExposure.mcpExposure(ToolExposure.MCP_DEFER_THRESHOLD, "github")).toMatchObject({
      mode: "group",
      group: "mcp:github",
    })
    expect(ToolExposure.mcpToolID("github server", "list/repos")).toBe("mcp__github_server__list_repos")
  })

  test("plugin tools can declare exposure and default to resident compatibility", () => {
    const deferred = pluginTool({
      description: "Deferred plugin tool",
      exposure: { mode: "search", title: "Deferred Plugin", keywords: ["plugin"] },
      args: {},
      async execute() {
        return "ok"
      },
    })
    const compatible = pluginTool({
      description: "Compatible plugin tool",
      args: {},
      async execute() {
        return "ok"
      },
    })
    const manifest = PluginManifest.parse({
      name: "demo-plugin",
      version: "1.0.0",
      description: "Demo plugin",
      contributes: {
        tools: [
          {
            name: "plugin_search",
            description: "Search-only plugin tool",
            exposure: { mode: "search", title: "Plugin Search", keywords: ["plugin"] },
          },
          {
            id: "plugin_grouped",
            name: "grouped",
            description: "Grouped plugin tool",
            exposure: {
              mode: "group",
              group: "plugin:demo",
              title: "Demo Plugin",
              description: "Demo plugin tools",
              whenToExpand: "Expand when using the demo plugin.",
            },
          },
        ],
      },
    })

    expect(deferred.exposure).toEqual({ mode: "search", title: "Deferred Plugin", keywords: ["plugin"] })
    expect(compatible.exposure).toBeUndefined()
    expect(manifest.contributes?.tools?.[0]?.exposure).toEqual({
      mode: "search",
      title: "Plugin Search",
      keywords: ["plugin"],
    })
    expect(manifest.contributes?.tools?.[1]?.exposure).toMatchObject({ mode: "group", group: "plugin:demo" })
  })

  test("ToolDiscovery marks grouped tool results with expandable groups", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const catalog = await ToolDiscovery.collect({
          providerID: model.providerID,
          agent: allowAllAgent,
          session,
          includeMCP: false,
        })
        const browserTool = ToolDiscovery.nonResidentEntries(catalog).find((entry) => entry.id === "browser_screenshot")

        expect(browserTool?.type).toBe("tool")
        expect(browserTool?.group).toBe("browser")
        expect(browserTool?.active).toBe(false)
      },
    })
  })
})
