import { Agent } from "@/agent/agent"
import { Session } from "@/session"
import z from "zod"
import { ToolDiscovery } from "./discovery"
import { ToolExposure } from "./exposure"
import { Tool } from "./tool"

const parameters = z.object({
  query: z.string().min(1).describe("Capability, tool, group, or task to search for."),
  limit: z.coerce.number().int().positive().max(20).default(8).describe("Maximum number of matches to return."),
})

export const SearchToolsTool = Tool.define("search_tools", async (initCtx) => ({
  description: [
    "Discover non-resident tool capabilities that are not currently visible to the model. This tool searches deferred groups and search-only tools; it does not enable, expand, activate, execute, or grant permission to any tool.",
    'When a result has type="group" or includes a group field, prefer expand_tools({ groups: [group] }) so the whole capability group becomes available on the next model step or subsequent turns.',
    "When a result is a search-only individual tool with no group, use expand_tools({ tools: [id] }) to activate it. If you already know the capability domain, call expand_tools directly instead of searching first.",
  ].join("\n\n"),
  parameters,
  async execute(params: z.infer<typeof parameters>, ctx) {
    const agent = initCtx?.agent ?? (await Agent.get(ctx.agent))
    if (!agent) {
      return {
        title: "Tool search unavailable",
        output:
          "search_tools could not resolve the current agent. Try again from an active session, or ask the user to restart this session.",
        metadata: {
          error: "agent_not_found",
          guidance: "Retry from an active session with a resolvable agent.",
        } as Record<string, any>,
      }
    }

    const session = await Session.get(ctx.sessionID)
    const catalog = await ToolDiscovery.collect({
      providerID: ToolDiscovery.providerIDFromModel(ctx.extra?.model),
      agent,
      session,
    })

    const matches = ToolDiscovery.nonResidentEntries(catalog)
      .map((entry) => ({ ...entry, score: ToolExposure.score(entry, params.query) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.id.localeCompare(b.id))
      .slice(0, params.limit)

    if (matches.length === 0) {
      return {
        title: "No deferred tools found",
        output: [
          `No deferred tool groups or search-only tools matched "${params.query}".`,
          "",
          "No session state changed. Try a broader capability query, or call expand_tools with one of the known groups if the domain is clear.",
          "",
          "Known groups:",
          catalog.groups.map((group) => `- ${group.id}: ${group.description}`).join("\n"),
        ].join("\n"),
        metadata: {
          query: params.query,
          changed: false,
          results: [],
          groups: catalog.groups.map((group) => group.id),
          guidance: "Search again with a broader query, or expand a known group directly.",
        } as Record<string, any>,
      }
    }

    const resultMetadata = matches.map((entry) => ({
      type: entry.type,
      id: entry.id,
      title: entry.title,
      group: entry.group,
      groupTitle: entry.groupTitle,
      active: entry.active,
      disabled:
        entry.type === "tool" ? catalog.disabled.has(entry.id) : entry.tools?.every((id) => catalog.disabled.has(id)),
      score: entry.score,
      next:
        entry.type === "group" || entry.group
          ? `expand_tools({ "groups": ["${entry.group ?? entry.id}"] })`
          : `expand_tools({ "tools": ["${entry.id}"] })`,
    }))

    const lines = resultMetadata.map((entry, index) => {
      const target = entry.type === "group" ? `group ${entry.id}` : `tool ${entry.id}`
      const group = entry.group && entry.type !== "group" ? ` (group: ${entry.group})` : ""
      const state = entry.active ? "already active" : entry.disabled ? "permission-hidden if expanded" : "deferred"
      return `${index + 1}. ${target}${group} - ${state}\n   ${entry.next}`
    })

    return {
      title: `Tool search: ${matches.length} match${matches.length === 1 ? "" : "es"}`,
      output: [
        `Found ${matches.length} deferred tool match${matches.length === 1 ? "" : "es"} for "${params.query}".`,
        "",
        "No session state changed. Use expand_tools next if one of these capabilities is needed.",
        "",
        ...lines,
        "",
        "Structured results:",
        JSON.stringify(resultMetadata, null, 2),
      ].join("\n"),
      metadata: {
        query: params.query,
        changed: false,
        results: resultMetadata,
        guidance:
          "Groups should be expanded with expand_tools(groups:[...]); search-only individual tools should be activated with expand_tools(tools:[...]).",
      } as Record<string, any>,
    }
  },
}))
