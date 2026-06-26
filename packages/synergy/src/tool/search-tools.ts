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

const MATCHED_TOOL_PREVIEW_LIMIT = 8

export const SearchToolsTool = Tool.define("search_tools", async (initCtx) => ({
  description: [
    "Discover non-resident tool capabilities that are not currently visible to the model. This tool searches deferred groups and search-only tools; it does not enable, expand, activate, execute, or grant permission to any tool.",
    'When a result has type="group" or includes a group field, prefer expand_tools({ groups: [group] }) so the whole capability group becomes available on the next model request or subsequent turns.',
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

    if (matches.length === 0) {
      return {
        title: "No deferred tools found",
        output: [
          `No deferred tool groups or search-only tools matched "${params.query}".`,
          "",
          "No session state changed. Try a broader capability query, or expand a known group directly if the domain is clear.",
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

    const resultMetadata = aggregateMatches(matches, catalog).slice(0, params.limit)

    const lines = resultMetadata.map((entry, index) => {
      const target = entry.type === "group" ? `group ${entry.id}` : `tool ${entry.id}`
      const state = entry.active ? "already active" : entry.disabled ? "unavailable if expanded" : "deferred"
      const matchedTools =
        entry.type === "group" && entry.matchedToolCount > 0
          ? `\n   matchedTools: ${formatMatchedTools(entry.matchedToolPreview, entry.matchedToolCount)}`
          : ""
      return `${index + 1}. ${target} - ${state}${matchedTools}\n   next: ${entry.next}`
    })

    return {
      title: `Tool search: ${resultMetadata.length} match${resultMetadata.length === 1 ? "" : "es"}`,
      output: [
        `Found ${resultMetadata.length} deferred capability match${resultMetadata.length === 1 ? "" : "es"} for "${params.query}".`,
        "",
        "No session state changed.",
        "",
        ...lines,
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

type ScoredEntry = ToolExposure.SearchEntry & { score: number }

type SearchResult =
  | {
      type: "group"
      id: string
      title: string
      active: boolean
      disabled: boolean
      score: number
      matchedToolCount: number
      matchedToolPreview: string[]
      next: string
    }
  | {
      type: "tool"
      id: string
      title: string
      active: boolean
      disabled: boolean
      score: number
      next: string
    }

function aggregateMatches(matches: ScoredEntry[], catalog: ToolDiscovery.Catalog): SearchResult[] {
  const groups = new Map<
    string,
    {
      id: string
      title: string
      active: boolean
      disabled: boolean
      score: number
      matchedTools: string[]
    }
  >()
  const standaloneTools: SearchResult[] = []

  for (const entry of matches) {
    if (entry.type === "group" || entry.group) {
      const groupID = entry.group ?? entry.id
      const groupInfo = catalog.groups.find((group) => group.id === groupID)
      const existing = groups.get(groupID)
      const group = existing ?? {
        id: groupID,
        title: groupInfo?.title ?? entry.groupTitle ?? entry.title,
        active: groupIsActive(groupID, catalog),
        disabled: groupInfo ? groupInfo.tools.every((id) => catalog.disabled.has(id)) : catalog.disabled.has(entry.id),
        score: 0,
        matchedTools: [],
      }

      group.score = Math.max(group.score, entry.score)
      if (entry.type === "tool") group.matchedTools.push(entry.id)
      groups.set(groupID, group)
      continue
    }

    standaloneTools.push({
      type: "tool",
      id: entry.id,
      title: entry.title,
      active: entry.active,
      disabled: catalog.disabled.has(entry.id),
      score: entry.score,
      next: `expand_tools({ "tools": ["${entry.id}"] })`,
    })
  }

  const groupResults: SearchResult[] = [...groups.values()].map((group) => {
    const matchedTools = ToolExposure.unique(group.matchedTools)
    return {
      type: "group",
      id: group.id,
      title: group.title,
      active: group.active,
      disabled: group.disabled,
      score: group.score,
      matchedToolCount: matchedTools.length,
      matchedToolPreview: matchedTools.slice(0, MATCHED_TOOL_PREVIEW_LIMIT),
      next: `expand_tools({ "groups": ["${group.id}"] })`,
    }
  })

  return [...groupResults, ...standaloneTools].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
}

function groupIsActive(groupID: string, catalog: ToolDiscovery.Catalog) {
  return catalog.state.expandedGroups.includes(groupID)
}

function formatMatchedTools(preview: string[], total: number) {
  const remaining = total - preview.length
  return remaining > 0 ? `${preview.join(", ")} (+${remaining} more)` : preview.join(", ")
}
