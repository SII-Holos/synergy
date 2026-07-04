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

  export const MCP_DEFER_THRESHOLD = 100

  export const RESIDENT: Info = { mode: "resident" }

  export const BUILTIN_GROUPS: GroupInfo[] = [
    {
      id: "browser",
      title: "Browser",
      description:
        "Interactive browser automation, page inspection, screenshots, downloads, console and network diagnostics.",
      whenToExpand:
        "Expand when a task needs a real browser: JS-heavy sites, localhost UI verification, screenshots, clicking, typing, page state inspection, or browser debugging.",
      tools: [
        "browser_annotate",
        "browser_navigate",
        "browser_snapshot",
        "browser_screenshot",
        "browser_inspect",
        "browser_wait",
        "browser_click",
        "browser_type",
        "browser_scroll",
        "browser_console",
        "browser_network",
        "browser_download",
        "browser_downloads",
        "browser_viewport",
        "browser_read",
        "browser_clipboard",
        "browser_list",
        "browser_navigation",
        "browser_action",
        "browser_eval",
        "browser_view",
        "browser_assets",
      ],
    },
    {
      id: "agenda",
      title: "Agenda",
      description: "Scheduling, one-time wake-ups, recurring automation, manual triggers, and agenda execution logs.",
      whenToExpand:
        "Expand when the user asks to remind, schedule, monitor over time, create recurring work, inspect scheduled tasks, or manage prior agenda runs.",
      tools: [
        "agenda_schedule",
        "agenda_watch",
        "agenda_list",
        "agenda_update",
        "agenda_cancel",
        "agenda_trigger",
        "agenda_logs",
      ],
    },
    {
      id: "session",
      title: "Session",
      description: "Browse, search, read, control, and message Synergy sessions across scopes and channels.",
      whenToExpand:
        "Expand when the task depends on previous conversations, session history, another active session, channel delivery, or session control actions.",
      tools: ["session_list", "session_read", "session_search", "session_send", "session_control"],
    },
    {
      id: "note",
      title: "Notes",
      description:
        "Project and global long-form notes, Blueprint notes, evolving plans, research records, and structured note edits.",
      whenToExpand:
        "Expand when information should live as an editable document, when reading or writing Blueprint notes, or when a task asks for stored project/global notes.",
      tools: ["note_list", "note_read", "note_search", "note_write", "note_edit", "note_archive", "note_delete"],
    },
    {
      id: "memory",
      title: "Memory",
      description:
        "Long-term knowledge atoms: search, read, write, and correct durable user, workflow, and knowledge memories.",
      whenToExpand:
        "Expand when you need explicit long-term recall beyond auto-injected context, or when established durable knowledge should be stored or corrected.",
      tools: ["memory_write", "memory_edit", "memory_search", "memory_get"],
    },
  ]

  const BUILTIN_GROUP_BY_ID = new Map(BUILTIN_GROUPS.map((group) => [group.id, group]))
  const BUILTIN_GROUP_BY_TOOL = new Map<string, GroupInfo>()
  for (const group of BUILTIN_GROUPS) {
    for (const tool of group.tools) {
      BUILTIN_GROUP_BY_TOOL.set(tool, group)
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

  export function mcpExposure(totalVisibleMcpTools: number, serverName: string): Info {
    if (totalVisibleMcpTools < MCP_DEFER_THRESHOLD) return RESIDENT
    return {
      mode: "group",
      group: mcpGroupID(serverName),
      title: `MCP: ${serverName}`,
      description: `Tools exposed by the connected MCP server "${serverName}".`,
      whenToExpand:
        "Expand when a task specifically needs this MCP server or search_tools returns one of its tools as the best match.",
    }
  }

  export function builtinGroup(id: string): GroupInfo | undefined {
    return BUILTIN_GROUP_BY_ID.get(id)
  }

  export function builtinGroupForTool(toolID: string): GroupInfo | undefined {
    return BUILTIN_GROUP_BY_TOOL.get(toolID)
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

  export function groupTable(groups: GroupInfo[] = BUILTIN_GROUPS): string {
    return [
      "| Group | What it does | When to expand |",
      "| --- | --- | --- |",
      ...groups.map((group) => `| ${group.id} | ${group.description} | ${group.whenToExpand} |`),
    ].join("\n")
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
