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
      description:
        "Time-based scheduling and deferred execution. Set one-time wake-ups to continue work after a delay (agenda_watch), create recurring tasks that run in fresh sessions (agenda_schedule), list/inspect/update/cancel scheduled items, manually trigger runs, and review execution logs.",
      whenToExpand:
        "Expand in these high-frequency scenarios. (1) The user says 'remind me in X minutes' or 'check back later' — use agenda_watch instead of blocking the turn. (2) You need to defer a follow-up so the user is not held hostage to a long-running session: set a watch to resume after background work completes. (3) The user wants a recurring task: daily summaries, weekly reports, periodic checks, cron-like automation. (4) The task requires multi-session orchestration or you want to split a long effort across time. (5) The user asks to list, update, cancel, or manually trigger a scheduled task. (6) You are investigating whether a scheduled task ran or need to read its execution log. (7) The user asks about 'schedule', 'reminder', 'wake me up', 'every day', 'every week', 'later today', 'in an hour', 'recurring', or 'check back'.",
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
        "Durable long-term knowledge atoms that survive across sessions. Memory is the primary mechanism to persist user preferences, collaboration rules, identity facts, workflow habits, technical decisions, project conventions, and relationship context so they shape future interactions automatically. Each memory has a category (user, self, relationship, interaction, workflow, coding, writing, knowledge) and a recallMode (always injects every session, contextual auto-retrieves when relevant, search_only loads on demand).",
      whenToExpand:
        "Expand in these high-frequency scenarios. (1) The user explicitly asks you to remember something ('remember this', 'do not forget', 'note that I prefer...'). (2) The user shares a durable preference, constraint, identity fact, collaboration rule, or communication norm that should persist beyond this session. (3) You learned a correctable fact about the user, project, or working relationship that future sessions would not quickly recover from code/docs — write or edit a memory. (4) You are about to make a decision that prior conversations may have already settled — search memory first with memory_search to avoid repeating mistakes or violating established rules. (5) The user asks about 'how I usually', 'my default', 'what we agreed on', 'the way we work', 'previous conversation', or 'do you remember'. (6) You are debugging a recurring problem and suspect past sessions have relevant context you may not have auto-injected. (7) The user corrects a boundary mistake (overstepping, representation, consent) — persist it as a durable trust signal, not a verbal promise.",
      tools: ["memory_write", "memory_edit", "memory_search", "memory_get"],
    },
    {
      id: "email",
      title: "Email",
      description: "Compose, send, and read emails via SMTP/IMAP. Supports plain text and HTML mail.",
      whenToExpand:
        "Expand when the user asks to send an email, check inbox, read mail, or search for specific emails.",
      tools: ["email_send", "email_read"],
    },
    {
      id: "worktree",
      title: "Worktree",
      description:
        "Git worktree management for isolated parallel workspaces. Create independent checkout directories from the same repo (worktree_enter), clean up when done (worktree_leave), and list existing worktrees (worktree_list). Each worktree has its own working directory, index, and local state — ideal for working on multiple branches simultaneously without stashing, running experimental changes in isolation, or reviewing PRs in a clean checkout without contaminating the main workspace.",
      whenToExpand:
        "Expand in these scenarios. (1) You need to work on a separate branch while keeping the current working tree intact — use worktree_enter to create or switch to an isolated checkout. (2) You are about to make experimental, risky, or large-scale changes that should not mutate the current workspace. (3) The user asks you to review a PR, test a branch, or switch context without losing in-progress uncommitted work. (4) The user's prompt mentions 'checkout another branch', 'try this on a clean copy', 'test this branch', 'review PR', 'switch to', or 'worktree'. (5) You are handling multiple independent task streams in parallel and want physical workspace isolation. (6) You previously created a worktree and now need to return to it or clean it up.",
      tools: ["worktree_enter", "worktree_leave", "worktree_list"],
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
