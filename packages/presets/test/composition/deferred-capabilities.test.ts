import { expect, spyOn, test } from "bun:test"
import { jsonSchema } from "ai"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { ToolResolver } from "@ericsanchezok/synergy-harness/test/support/internals"
import { ExpandToolsTool } from "@ericsanchezok/synergy-harness/test/internal/tool/expand-tools"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import type { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { MCP } from "@ericsanchezok/synergy-mcp"
import { testRuntime } from "../support/runtime"

const model = {
  id: "fixture",
  providerID: "fixture",
  api: { id: "fixture" },
  capabilities: { input: { image: true } },
} as Provider.Model
const online = [
  ["anysearch", "search"],
  ["scholight", "search_papers"],
].map(([serverName, toolName]) => ({
  id: `mcp__${serverName}__${toolName}`,
  serverName: serverName!,
  toolName: toolName!,
  source: "builtin" as const,
  tool: { description: "Remote contract", inputSchema: jsonSchema({ type: "object" }) },
  inputSchema: { type: "object" as const },
}))
const members = [
  "render",
  "computer_apps",
  "computer_observe",
  "computer_action",
  ...online.map((tool) => tool.id),
].sort()

test("all primary identities share deferred visuals, computer and online without changing core tools", async () => {
  await using runtime = await testRuntime({ desktop: true })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        using source = spyOn(MCP, "toolEntries").mockResolvedValue(online)
        for (const name of Object.values(PrimaryAgentIdentity.names)) {
          const agent = await Agent.get(name)
          expect(agent).toBeDefined()
          const session = await Session.create({ workspaceID: null })
          const input = { agent: agent!, model, session, sessionID: session.id }
          const before = await ToolResolver.availability(input)
          expect(before.visible.some((tool) => members.includes(tool.id))).toBe(false)
          expect(before.visible.map((tool) => tool.id)).toContain("runtime_reload")
          const tasks = before.visible
            .map((tool) => tool.id)
            .filter((id) => id.startsWith("task") || id.startsWith("dag"))
          expect(tasks.length).toBe(name === PrimaryAgentIdentity.names.lightweight ? 0 : 7)
          const directory = before.visible.find((tool) => tool.id === "expand_tools")!.description
          for (const group of ["visuals (Visuals)", "computer (Computer)", "online (Online search and reading)"])
            expect(directory).toContain(group)
          const context: Tool.Context = {
            sessionID: session.id,
            messageID: "msg_capability_groups",
            agent: name,
            abort: new AbortController().signal,
            extra: { model },
            metadata() {},
            async ask() {
              throw new Error("Expansion must not request execution approval")
            },
          }
          const expand = await ExpandToolsTool.init({ agent: agent! })
          const result = await expand.execute({ groups: ["visuals", "computer", "online"] }, context)
          expect(result.metadata.availableRequestedTools).toEqual(members)
          const restored = await Session.get(session.id)
          const after = await ToolResolver.availability({ ...input, session: restored })
          expect(
            after.visible
              .filter((tool) => members.includes(tool.id))
              .map((tool) => tool.id)
              .sort(),
          ).toEqual(members)
          expect(after.visible.find((tool) => tool.id === "runtime_reload")!.inputSchema).toEqual(
            before.visible.find((tool) => tool.id === "runtime_reload")!.inputSchema,
          )
        }
      },
    }),
  )
})
