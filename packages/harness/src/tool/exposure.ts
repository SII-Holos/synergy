export namespace ToolExposure {
  export type Info =
    | {
        mode: "resident"
      }
    | {
        mode: "group"
        group: string
        title?: string
        description?: string
        whenToExpand?: string
      }
    | {
        mode: "search"
        title?: string
        keywords?: string[]
      }
    | {
        mode: "internal"
      }

  export interface GroupInfo {
    id: string
    title: string
    description: string
    whenToExpand: string
    tools: string[]
  }

  export interface ToolState {
    expandedGroups?: string[]
    activatedTools?: string[]
  }

  export interface SearchEntry {
    type: "group" | "tool"
    id: string
    title: string
    description: string
    group?: string
    groupTitle?: string
    keywords?: string[]
    active: boolean
    tools?: string[]
    score?: number
  }

  export const RESIDENT: Info = { mode: "resident" }

  export const BUILTIN_GROUPS: GroupInfo[] = [
    {
      id: "session",
      title: "Session",
      description:
        "Browse, search, read, control, and message Synergy sessions across scopes and channels. Includes scope discovery for cross-project session creation.",
      whenToExpand:
        "Expand when the task depends on previous conversations, session history, another active session, channel delivery, session control actions, or choosing a scopeID for cross-project session creation.",
      tools: ["session_list", "session_read", "session_search", "session_send", "session_control", "scope_list"],
    },
  ]

  const BUILTIN_GROUP_BY_ID = new Map(BUILTIN_GROUPS.map((group) => [group.id, group]))
  const BUILTIN_GROUP_BY_TOOL = new Map<string, GroupInfo>()
  for (const group of BUILTIN_GROUPS) {
    for (const tool of group.tools) {
      BUILTIN_GROUP_BY_TOOL.set(tool, group)
    }
  }

  export function registerGroups(owner: string, groups: GroupInfo[]) {
    for (const group of groups) {
      const existing = BUILTIN_GROUP_BY_ID.get(group.id)
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(group))
          throw new Error(`Conflicting tool group ${group.id} from ${owner}`)
        continue
      }
      BUILTIN_GROUPS.push(group)
      BUILTIN_GROUP_BY_ID.set(group.id, group)
      for (const tool of group.tools) BUILTIN_GROUP_BY_TOOL.set(tool, group)
    }
  }

  export function sanitizeID(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]/g, "_")
  }

  export function mcpToolID(serverName: string, toolName: string): string {
    return `mcp__${sanitizeID(serverName)}__${sanitizeID(toolName)}`
  }

  export function mcpGroupID(serverName: string): string {
    return `mcp:${sanitizeID(serverName)}`
  }

  export function mcpGroup(serverName: string, tools: string[]): GroupInfo {
    return {
      id: mcpGroupID(serverName),
      title: `MCP: ${serverName}`,
      description: `Tools exposed by the connected MCP server "${serverName}".`,
      whenToExpand:
        "Expand when a task specifically needs this MCP server or search_tools returns one of its tools as the best match.",
      tools,
    }
  }

  export function mcpExposure(serverName: string, expandByDefault?: boolean): Info {
    if (expandByDefault === true) return RESIDENT
    return {
      mode: "group",
      group: mcpGroupID(serverName),
      title: `MCP: ${serverName}`,
      description: `Tools exposed by the connected MCP server "${serverName}".`,
      whenToExpand:
        "Expand when a task specifically needs this MCP server or search_tools returns one of its tools as the best match.",
    }
  }

  /**
   * Resolve whether an MCP server's tools stay resident (always visible) by
   * default. Per-server `expandByDefault` wins; `mcpDefaults` supplies the
   * next fallback; `builtinDefault` covers servers staged from the builtin
   * catalog so the shipped search servers stay resident like the first-party
   * tools they replaced; the ultimate default is folded (false).
   */
  export function mcpExpandByDefault(server: unknown, defaults?: unknown, builtinDefault?: boolean): boolean {
    const resolvedServer = (server ?? {}) as { expandByDefault?: boolean }
    const resolvedDefaults = (defaults ?? {}) as { expandByDefault?: boolean }
    return resolvedServer.expandByDefault ?? resolvedDefaults.expandByDefault ?? builtinDefault ?? false
  }

  export function builtinGroup(id: string): GroupInfo | undefined {
    return BUILTIN_GROUP_BY_ID.get(id)
  }

  export function builtinGroupForTool(toolID: string): GroupInfo | undefined {
    return BUILTIN_GROUP_BY_TOOL.get(toolID)
  }
  /**
   * Stable group id for orchestration tools (task delegation, DAG planning)
   * folded behind expand_tools for lightweight agents.
   */
  export const ORCHESTRATION_GROUP = "orchestration"

  export const ORCHESTRATION_GROUP_INFO: GroupInfo = {
    id: ORCHESTRATION_GROUP,
    title: "Orchestration",
    description:
      "Specialist delegation (task) and DAG planning (dagwrite, dagpatch, dagread) for parallel or multi-phase work.",
    whenToExpand:
      'Expand with expand_tools({ groups: ["orchestration"] }) when the user asks for parallel or delegated work, when the request is clearly a large multi-part task, or when you already know you will dispatch specialists or plan a DAG.',
    tools: [],
  }

  /**
   * Fold a resident orchestration tool behind the shared orchestration group
   * for agents that declare it in their deferredTools list. Exposures that are
   * already grouped, searched, or internal pass through unchanged, and tools
   * outside the deferred list are untouched.
   */
  export function deferredExposure(toolID: string, exposure: Info | undefined, deferredTools?: string[]): Info {
    if (!deferredTools?.includes(toolID)) return exposure ?? RESIDENT
    const normalized = normalize(toolID, exposure)
    if (normalized.mode !== "resident") return normalized
    return {
      mode: "group",
      group: ORCHESTRATION_GROUP,
      title: ORCHESTRATION_GROUP_INFO.title,
      description: ORCHESTRATION_GROUP_INFO.description,
      whenToExpand: ORCHESTRATION_GROUP_INFO.whenToExpand,
    }
  }

  export function normalize(toolID: string, explicit?: Info): Info {
    if (explicit) return explicit
    const group = builtinGroupForTool(toolID)
    if (group) return { mode: "group", group: group.id }
    return RESIDENT
  }

  export function isVisible(
    toolID: string,
    exposure: Info | undefined,
    state: ToolState | undefined,
    options?: {
      forcedGroups?: Iterable<string>
      forcedTools?: Iterable<string>
    },
  ): boolean {
    const normalized = normalize(toolID, exposure)
    if (new Set(options?.forcedTools ?? []).has(toolID)) return true
    if (normalized.mode === "resident") return true
    if (normalized.mode === "search") return new Set(state?.activatedTools ?? []).has(toolID)
    if (normalized.mode === "internal") return false

    const expanded = new Set(state?.expandedGroups ?? [])
    for (const group of options?.forcedGroups ?? []) {
      expanded.add(group)
    }
    return expanded.has(normalized.group)
  }

  export function userAllows(toolID: string, userTools?: Record<string, boolean>) {
    if (!userTools) return true
    if (userTools[toolID] === true) return true
    if (userTools[toolID] === false) return false
    return userTools["*"] !== false
  }

  export function groupTable(groups: GroupInfo[] = BUILTIN_GROUPS): string {
    return [
      "| Group | What it does | When to expand |",
      "| --- | --- | --- |",
      ...groups.map((group) => `| ${group.id} | ${group.description} | ${group.whenToExpand} |`),
    ].join("\n")
  }
  export const MCP_GROUP_TABLE_MAX_SERVERS = 10
  export const MCP_GROUP_TABLE_MAX_TOOL_NAMES = 6

  export interface McpServerGroupSummary {
    serverName: string
    toolNames: string[]
  }

  /**
   * Render the "Connected MCP groups" table appended to the expand_tools
   * description. Returns "" when no servers are present so callers can drop
   * the section (and its heading) entirely.
   */
  export function mcpGroupTable(servers: McpServerGroupSummary[]): string {
    if (servers.length === 0) return ""
    const visible = servers.slice(0, MCP_GROUP_TABLE_MAX_SERVERS)
    const rows = visible.map((server) => {
      const names = unique(server.toolNames).slice(0, MCP_GROUP_TABLE_MAX_TOOL_NAMES)
      const remainder = unique(server.toolNames).length - names.length
      const nameList = remainder > 0 ? `${names.join(", ")} … and ${remainder} more` : names.join(", ")
      const groupID = mcpGroupID(server.serverName)
      return `| ${groupID} | ${server.serverName} (${unique(server.toolNames).length} tools): ${nameList} | Expand with expand_tools({groups:["${groupID}"]}) when a task needs this server. |`
    })
    const remainderServers = servers.length - visible.length
    if (remainderServers > 0) rows.push(`| … | +${remainderServers} more servers | … |`)
    return ["| Group | What it does | When to expand |", "| --- | --- | --- |", ...rows].join("\n")
  }

  export function state(input?: ToolState): Required<ToolState> {
    return {
      expandedGroups: unique(input?.expandedGroups ?? []),
      activatedTools: unique(input?.activatedTools ?? []),
    }
  }

  export function unique(values: Iterable<string>): string[] {
    return [...new Set([...values].filter(Boolean))].sort()
  }

  export function expansionForTool(
    toolID: string,
    exposure: Info | undefined,
    state: ToolState | undefined,
  ): { kind: "group"; group: string } | { kind: "activate"; tool: string } | { kind: "none" } {
    const normalized = normalize(toolID, exposure)
    if (normalized.mode === "group") {
      const expanded = new Set(state?.expandedGroups ?? [])
      return expanded.has(normalized.group) ? { kind: "none" } : { kind: "group", group: normalized.group }
    }
    if (normalized.mode === "search") {
      const activated = new Set(state?.activatedTools ?? [])
      return activated.has(toolID) ? { kind: "none" } : { kind: "activate", tool: toolID }
    }
    return { kind: "none" }
  }

  export function expandState(
    state: ToolState | undefined,
    groups?: Iterable<string>,
    tools?: Iterable<string>,
  ): Required<ToolState> {
    return {
      expandedGroups: unique([...(state?.expandedGroups ?? []), ...(groups ?? [])]),
      activatedTools: unique([...(state?.activatedTools ?? []), ...(tools ?? [])]),
    }
  }

  export function groupFromExposure(exposure: Info | undefined): string | undefined {
    return exposure?.mode === "group" ? exposure.group : undefined
  }

  export function groupInfoFromExposure(toolID: string, exposure: Info | undefined): GroupInfo | undefined {
    const normalized = normalize(toolID, exposure)
    if (normalized.mode !== "group") return undefined
    const builtin = builtinGroup(normalized.group)
    if (builtin) return builtin
    return {
      id: normalized.group,
      title: normalized.title ?? normalized.group,
      description: normalized.description ?? `Tools in the ${normalized.group} group.`,
      whenToExpand:
        normalized.whenToExpand ??
        "Expand when search_tools returns this group or when the task clearly depends on this group of tools.",
      tools: [toolID],
    }
  }

  export function searchText(entry: Pick<SearchEntry, "id" | "title" | "description" | "group" | "keywords">): string {
    return [entry.id, entry.title, entry.description, entry.group, ...(entry.keywords ?? [])]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
  }

  export function score(
    entry: Pick<SearchEntry, "id" | "title" | "description" | "group" | "keywords">,
    query: string,
  ) {
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) return 0
    const text = searchText(entry)
    const terms = normalizedQuery.split(/\s+/).filter(Boolean)
    let result = 0
    for (const term of terms) {
      if (entry.id.toLowerCase() === term) result += 12
      if (entry.group?.toLowerCase() === term) result += 10
      if (entry.title.toLowerCase().includes(term)) result += 6
      if (text.includes(term)) result += 2
    }
    if (text.includes(normalizedQuery)) result += 8
    return result
  }
}
