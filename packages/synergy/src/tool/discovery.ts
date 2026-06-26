import type { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { PermissionNext } from "@/permission/next"
import type { Provider } from "@/provider/provider"
import { SessionModePolicy } from "@/session/tool-mode-policy"
import type { Info as SessionInfo } from "@/session/types"
import type { ToolDiagnostic } from "./diagnostic"
import { ToolExposure } from "./exposure"

export namespace ToolDiscovery {
  export interface Entry {
    id: string
    title: string
    description: string
    exposure: ToolExposure.Info
    group?: string
    groupTitle?: string
    keywords?: string[]
    source: "tool" | "mcp"
  }

  export interface Catalog {
    groups: ToolExposure.GroupInfo[]
    tools: Entry[]
    state: Required<ToolExposure.ToolState>
    disabled: Set<string>
    diagnostics: Map<string, ToolDiagnostic>
  }

  export async function collect(input: {
    providerID: string
    agent: Agent.Info
    session?: SessionInfo
    includeMCP?: boolean
  }): Promise<Catalog> {
    const { ToolRegistry } = await import("./registry")
    const groupByID = new Map(
      ToolExposure.BUILTIN_GROUPS.map((group) => [group.id, { ...group, tools: [...group.tools] }]),
    )
    const tools: Entry[] = []

    for (const item of await ToolRegistry.tools(input.providerID, input.agent)) {
      const exposure = ToolExposure.normalize(item.id, item.exposure)
      const group = ToolExposure.groupInfoFromExposure(item.id, exposure)
      if (group) mergeGroup(groupByID, group)
      tools.push({
        id: item.id,
        title: titleForTool(item.id, exposure),
        description: item.description,
        exposure,
        group: exposure.mode === "group" ? exposure.group : undefined,
        groupTitle: group?.title,
        keywords: exposure.mode === "search" ? exposure.keywords : undefined,
        source: "tool",
      })
    }

    if (input.includeMCP !== false) {
      const entries = await MCP.toolEntries()
      const deferMCP = entries.length >= ToolExposure.MCP_DEFER_THRESHOLD
      const toolsByServer = new Map<string, string[]>()
      for (const entry of entries) {
        if (deferMCP) {
          const existing = toolsByServer.get(entry.serverName) ?? []
          existing.push(entry.id)
          toolsByServer.set(entry.serverName, existing)
        }
      }
      for (const [serverName, ids] of toolsByServer) {
        mergeGroup(groupByID, ToolExposure.mcpGroup(serverName, ids))
      }

      for (const entry of entries) {
        const exposure = ToolExposure.mcpExposure(entries.length, entry.serverName)
        const group = ToolExposure.groupInfoFromExposure(entry.id, exposure)
        tools.push({
          id: entry.id,
          title: entry.toolName,
          description: entry.tool.description ?? "",
          exposure,
          group: exposure.mode === "group" ? exposure.group : undefined,
          groupTitle: group?.title,
          source: "mcp",
        })
      }
    }

    const permissionDisabled = PermissionNext.disabled(
      tools.map((tool) => tool.id),
      PermissionNext.merge(input.agent.permission, PermissionNext.sessionRuleset(input.session)),
    )
    const disabled = new Set<string>()
    const diagnostics = new Map<string, ToolDiagnostic>()
    for (const tool of tools) {
      const modeDiagnostic = SessionModePolicy.visibility({ toolName: tool.id, session: input.session })
      if (modeDiagnostic) {
        disabled.add(tool.id)
        diagnostics.set(tool.id, modeDiagnostic)
        continue
      }
      if (permissionDisabled.has(tool.id)) {
        disabled.add(tool.id)
        diagnostics.set(
          tool.id,
          SessionModePolicy.unavailable({ toolName: tool.id, reason: "permission", session: input.session }),
        )
      }
    }

    return {
      groups: [...groupByID.values()].sort((a, b) => a.id.localeCompare(b.id)),
      tools,
      state: ToolExposure.state(input.session?.toolState),
      disabled,
      diagnostics,
    }
  }

  export function nonResidentEntries(catalog: Catalog): ToolExposure.SearchEntry[] {
    const activeGroups = new Set(catalog.state.expandedGroups)
    const activeTools = new Set(catalog.state.activatedTools)
    const groups = catalog.groups
      .filter((group) => group.tools.length > 0)
      .map((group) => ({ ...group, tools: group.tools.filter((toolID) => !catalog.disabled.has(toolID)) }))
      .filter((group) => group.tools.length > 0)
      .map(
        (group): ToolExposure.SearchEntry => ({
          type: "group",
          id: group.id,
          title: group.title,
          description: group.description,
          group: group.id,
          active: activeGroups.has(group.id),
          tools: group.tools,
        }),
      )

    const tools = catalog.tools
      .filter((tool) => !catalog.disabled.has(tool.id))
      .filter((tool) => tool.exposure.mode !== "resident" && tool.exposure.mode !== "internal")
      .map(
        (tool): ToolExposure.SearchEntry => ({
          type: "tool",
          id: tool.id,
          title: tool.title,
          description: tool.description,
          group: tool.group,
          groupTitle: tool.groupTitle,
          keywords: tool.keywords,
          active:
            tool.exposure.mode === "search"
              ? activeTools.has(tool.id)
              : Boolean(tool.group && activeGroups.has(tool.group)),
        }),
      )

    return [...groups, ...tools]
  }

  export function visibleTools(catalog: Catalog, forcedGroups?: Iterable<string>, forcedTools?: Iterable<string>) {
    return catalog.tools
      .filter((tool) => ToolExposure.isVisible(tool.id, tool.exposure, catalog.state, { forcedGroups, forcedTools }))
      .filter((tool) => !catalog.disabled.has(tool.id))
      .map((tool) => tool.id)
      .sort()
  }

  function mergeGroup(groupByID: Map<string, ToolExposure.GroupInfo>, incoming: ToolExposure.GroupInfo) {
    const existing = groupByID.get(incoming.id)
    if (!existing) {
      groupByID.set(incoming.id, { ...incoming, tools: ToolExposure.unique(incoming.tools) })
      return
    }
    existing.tools = ToolExposure.unique([...existing.tools, ...incoming.tools])
    if (!existing.title && incoming.title) existing.title = incoming.title
    if (!existing.description && incoming.description) existing.description = incoming.description
    if (!existing.whenToExpand && incoming.whenToExpand) existing.whenToExpand = incoming.whenToExpand
  }

  function titleForTool(toolID: string, exposure: ToolExposure.Info) {
    if (exposure.mode === "search" && exposure.title) return exposure.title
    if (exposure.mode === "group" && exposure.title) return exposure.title
    return toolID
      .split(/[_-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  }

  export function providerIDFromModel(model?: Provider.Model) {
    return model?.providerID ?? "default"
  }
}
