import { describe, expect, mock, test } from "bun:test"
import { jsonSchema, tool, type JSONSchema7 } from "ai"
import { z } from "zod"
import { Agent } from "../../src/agent/agent"
import { PermissionNext } from "../../src/permission/next"
import { Scope } from "../../src/scope"
import { Session } from "../../src/session"
import { ToolDiscovery } from "../../src/tool/discovery"
import { ExpandToolsTool } from "../../src/tool/expand-tools"
import { ToolExposure } from "../../src/tool/exposure"
import { ToolMcpSource } from "../../src/tool/mcp-source"
import { SearchToolsTool } from "../../src/tool/search-tools"
import { Tool } from "../../src/tool/tool"
import { ScopeContext } from "../../src/scope/context"
import { ToolResolver } from "../../src/session/tool-resolver"
import { ToolRegistry } from "../../src/tool/registry"
import { tmpdir } from "../support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

const allowAllAgent = {
  name: "synergy",
  permission: PermissionNext.fromConfig({ "*": "allow" }),
  controlProfile: "full_access",
} as any

const model = {
  id: "test-model",
  modelID: "test-model",
  providerID: "test-provider",
  api: { id: "test-model" },
  capabilities: { input: { image: false } },
} as any

const ephemeralTool: ToolResolver.EphemeralTool = {
  id: "ephemeral_probe",
  description: "Inspect a value",
  inputSchema: { type: "object", properties: { value: { type: "string" } }, additionalProperties: false },
  async execute() {
    return { title: "probe", output: "ok" }
  },
}

function processor() {
  return {
    message: { id: "msg_availability", rootID: "msg_availability_root", parentID: "msg_availability_root" },
    partFromToolCall: () => undefined,
    modelInputFromToolCall: () => undefined,
    beginExecution: () => undefined,
    executeOnce: (_callID: string, execute: () => Promise<unknown>) => execute(),
  } as any
}

describe("ToolResolver availability reuse", () => {
  test("collects tool definitions once when the caller supplies the availability it already resolved", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const originalTools = ToolRegistry.catalog
      let collections = 0

      try {
        ;(ToolRegistry.catalog as any) = mock(async () => {
          collections++
          return []
        })

        await ScopeContext.provide({
          scope: await tmp.scope(),
          fn: async () => {
            const input = {
              agent: allowAllAgent,
              model,
              sessionID: "ses_availability_once",
              ephemeralTools: [ephemeralTool],
              userTools: { ephemeral_probe: true },
              includeMCP: false,
            }

            const availability = await ToolResolver.availability(input)
            expect(collections).toBe(1)
            expect(availability.visible.map((item) => item.id)).toEqual(["ephemeral_probe"])
            expect(availability.autoExpandable.size).toBe(0)

            const resolved = await ToolResolver.resolveWithAvailability(
              { ...input, processor: processor() },
              availability,
            )

            expect(collections).toBe(1)
            expect(resolved.definitions.map((item) => item.id)).toEqual(["ephemeral_probe"])
            expect(resolved.activeToolIDs).toEqual(["ephemeral_probe"])
            expect(Object.keys(resolved.executionTools)).toEqual(["ephemeral_probe"])
            expect(resolved.executorKinds).toEqual({ ephemeral_probe: "control_plane" })
            expect(resolved.autoExpandable).toBe(availability.autoExpandable)
          },
        })
      } finally {
        ;(ToolRegistry.catalog as any) = originalTools
      }
    }))

  test("collects its own definitions when no availability is supplied", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const originalTools = ToolRegistry.catalog
      let collections = 0

      try {
        ;(ToolRegistry.catalog as any) = mock(async () => {
          collections++
          return []
        })

        await ScopeContext.provide({
          scope: await tmp.scope(),
          fn: async () => {
            const resolved = await ToolResolver.resolveWithAvailability({
              agent: allowAllAgent,
              model,
              sessionID: "ses_availability_self",
              processor: processor(),
              ephemeralTools: [ephemeralTool],
              userTools: { ephemeral_probe: true },
              includeMCP: false,
            })

            expect(collections).toBe(1)
            expect(resolved.definitions.map((item) => item.id)).toEqual(["ephemeral_probe"])
          },
        })
      } finally {
        ;(ToolRegistry.catalog as any) = originalTools
      }
    }))
})

test("expand_tools catalog factors only MCP prefixes and keeps every authorized ID through search and expansion", async () => {
  const inputSchema: JSONSchema7 = {
    type: "object",
    properties: { resource: { type: "string" } },
    required: ["resource"],
    additionalProperties: false,
  }
  const servers = Array.from({ length: 12 }, (_, index) => ({
    name: `catalog-api.v${index}`,
    tools: ["lookup__detail", "read-file.v1", ...Array.from({ length: 8 }, (_, toolIndex) => `operation-${toolIndex}`)],
  }))
  servers.push(
    { name: "catalog-single", tools: ["one"] },
    { name: "catalog-mismatch", tools: ["first", "second"] },
    { name: "catalog-resident", tools: ["resident-read"] },
  )
  const mcpEntries: ToolMcpSource.Entry[] = servers.flatMap((server) =>
    server.tools.map((toolName) => ({
      id: server.name === "catalog-mismatch" ? `opaque_${toolName}` : ToolExposure.mcpToolID(server.name, toolName),
      serverName: server.name,
      toolName,
      requiresWorkspace: false,
      inputSchema,
      tool: tool({
        description: `Inspect ${toolName}`,
        inputSchema: jsonSchema<{ resource: string }>(inputSchema),
        async execute(): Promise<string> {
          throw new Error("Catalog must not execute MCP tools")
        },
      }),
    })),
  )
  const deniedID = mcpEntries[2]!.id
  const userDisabledID = mcpEntries[3]!.id
  const agent = Agent.Info.parse({
    name: "catalog-fixture",
    mode: "primary",
    options: {},
    permission: PermissionNext.fromConfig({ "*": "allow", [deniedID]: "deny", catalog_denied: "deny" }),
    controlProfile: "full_access",
  })
  const definitions = [
    { id: "catalog_zeta", exposure: { mode: "group", group: "catalog-native", title: "Native" } },
    { id: "catalog_alpha", exposure: { mode: "group", group: "catalog-native", title: "Native" } },
    { id: "catalog_denied", exposure: { mode: "group", group: "catalog-native", title: "Native" } },
    { id: "mcp__synthetic__first", exposure: { mode: "group", group: "catalog-synthetic" } },
    { id: "mcp__synthetic__second", exposure: { mode: "group", group: "catalog-synthetic" } },
    { id: "catalog_resident", exposure: { mode: "resident" } },
    { id: "catalog_search_only", exposure: { mode: "search" } },
  ] satisfies Array<{ id: string; exposure: ToolExposure.Info }>
  await using catalogRuntime = await testRuntime({
    register() {
      ToolExposure.selectDefaultGroups([])
      ToolRegistry.registerToolProvider("catalog-fixture", () =>
        definitions.map((definition) =>
          Tool.define(
            definition.id,
            {
              description: `Inspect ${definition.id}`,
              parameters: z.object({ resource: z.string() }),
              async execute() {
                throw new Error("Catalog must not execute native tools")
              },
            },
            { exposure: definition.exposure },
          ),
        ),
      )
      ToolMcpSource.register({
        async exposureConfiguration() {
          return { expandByDefault: (serverName) => serverName === "catalog-resident" }
        },
        toolEntries: async () => mcpEntries,
        toolCallTimeout: () => undefined,
        async deferredGroupCatalog() {
          return {
            totalTools: mcpEntries.length - 1,
            servers: servers
              .filter((server) => server.name !== "catalog-resident")
              .map((server) => ({ serverName: server.name, toolNames: server.tools })),
          }
        },
        normalizeResult() {
          throw new Error("Catalog must not normalize tool results")
        },
      })
    },
  })
  await catalogRuntime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspaceID: null })
        const userTools = { [userDisabledID]: false }
        const input = { agent, model, session, sessionID: session.id, userTools }
        const availability = await ToolResolver.availability(input)
        const residentIDs = ["search_tools", "expand_tools", "catalog_resident", mcpEntries.at(-1)!.id]
        expect(availability.visible.map((definition) => definition.id)).toEqual(residentIDs)
        const mcpGroups = servers.filter((server) => server.name !== "catalog-resident")
        const groupRows = [
          "catalog-native (Native): catalog_zeta, catalog_alpha",
          "catalog-synthetic (catalog-synthetic): mcp__synthetic__first, mcp__synthetic__second",
          ...mcpGroups.map((server) => {
            const ids = mcpEntries
              .filter(
                (entry) => entry.serverName === server.name && entry.id !== deniedID && entry.id !== userDisabledID,
              )
              .map((entry) => entry.id)
            const groupID = ToolExposure.mcpGroupID(server.name)
            const heading = `${groupID} (MCP: ${server.name})`
            if (server.name === "catalog-mismatch") return `${heading}: ${ids.join(", ")}`
            const prefix = `mcp__${ToolExposure.sanitizeID(server.name)}__`
            return `${heading}: prefix=${prefix}; suffixes: ${ids.map((id) => id.slice(prefix.length)).join(", ")}`
          }),
        ]
        const description = availability.visible.find((definition) => definition.id === "expand_tools")!.description
        const emittedRows = description.split("Available groups:\n")[1]!.split("\n")
        expect(emittedRows).toEqual(groupRows)
        const emittedIDs = emittedRows.flatMap((row) => {
          const names = row.slice(row.indexOf("): ") + 3)
          if (!names.startsWith("prefix=")) return names.split(", ")
          const [prefix, suffixes] = names.slice("prefix=".length).split("; suffixes: ")
          return suffixes!.split(", ").map((suffix) => `${prefix}${suffix}`)
        })
        expect(emittedIDs).toEqual([
          "catalog_zeta",
          "catalog_alpha",
          "mcp__synthetic__first",
          "mcp__synthetic__second",
          ...mcpEntries
            .filter(
              (entry) =>
                entry.serverName !== "catalog-resident" && entry.id !== deniedID && entry.id !== userDisabledID,
            )
            .map((entry) => entry.id),
        ])
        expect(description).toContain("full tool ID = prefix + suffix")
        expect(description).toContain("Expand the group to get tool schemas before calling; do not guess parameters.")
        expect(description).not.toContain(deniedID)
        expect(description).not.toContain(userDisabledID)
        expect(description).not.toContain("catalog_denied")
        const catalog = await ToolDiscovery.collect({ ...input, providerID: model.providerID })
        const groups = ToolDiscovery.availableGroups(catalog)
        const groupIDs = groups.map((group) => group.id)
        const expectedDeferred = [
          ...definitions
            .filter((definition) => definition.exposure.mode !== "resident" && definition.id !== "catalog_denied")
            .map((definition) => definition.id),
          ...mcpEntries
            .filter(
              (entry) =>
                entry.serverName !== "catalog-resident" && entry.id !== deniedID && entry.id !== userDisabledID,
            )
            .map((entry) => entry.id),
        ]
        expect([...availability.autoExpandable].sort()).toEqual(expectedDeferred.toSorted())
        expect(groups.flatMap((group) => group.tools).sort()).toEqual(
          expectedDeferred.filter((id) => id !== "catalog_search_only").toSorted(),
        )
        const context: Tool.Context = {
          sessionID: session.id,
          messageID: "msg_tool_catalog",
          agent: agent.name,
          abort: new AbortController().signal,
          extra: { model, userTools },
          metadata() {},
          async ask() {
            throw new Error("Discovery must not request execution permission")
          },
        }
        const search = await SearchToolsTool.init({ agent })
        const searchResult = await search.execute({ query: mcpEntries[0]!.id, limit: 8 }, context)
        expect(searchResult.metadata.results).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: ToolExposure.mcpGroupID(servers[0]!.name),
              matchedToolPreview: expect.arrayContaining([mcpEntries[0]!.id]),
            }),
          ]),
        )
        expect((await Session.get(session.id)).toolState).toEqual(session.toolState)
        const expand = await ExpandToolsTool.init({ agent })
        expect(availability.visible.find((definition) => definition.id === "expand_tools")!.inputSchema).toEqual(
          ToolResolver.registryInputSchema(expand),
        )
        const expanded = await expand.execute({ groups: groupIDs, tools: ["catalog_search_only"] }, context)
        expect(expanded.metadata.newlyVisibleTools).toEqual(expectedDeferred.toSorted())
        const updated = await Session.get(session.id)
        expect(updated.toolState).toEqual({
          expandedGroups: groupIDs.toSorted(),
          activatedTools: ["catalog_search_only"],
        })
        const after = await ToolResolver.availability({ ...input, session: updated })
        expect(after.visible.map((definition) => definition.id).sort()).toEqual(
          [...residentIDs, ...expectedDeferred].sort(),
        )
        expect(after.autoExpandable.size).toBe(0)
        for (const entry of mcpEntries.filter((entry) => entry.id !== deniedID && entry.id !== userDisabledID)) {
          const definition = after.visible.find((definition) => definition.id === entry.id)!
          expect(definition.inputSchema).toBe(entry.inputSchema)
          expect(definition.description).toBe(entry.tool.description!)
        }
        expect(after.visible.some((definition) => definition.id === deniedID || definition.id === userDisabledID)).toBe(
          false,
        )
      },
    }),
  )
})

afterRuntimeTests(() => runtime.close())
