import { RuntimeContext } from "../lifecycle/context"
export namespace ToolExposure {
  export type Info = (
    | {
        mode: "resident"
      }
    | {
        mode: "group"
        group: string
        title?: string
        description?: string
        summary?: string
      }
    | {
        mode: "search"
        title?: string
        keywords?: string[]
      }
    | {
        mode: "internal"
      }
  ) & {
    keywords?: string[]
    /** Required tools co-exposed transitively; unavailable companions suppress the dependent tool. */
    companions?: readonly string[]
  }

  export interface GroupInfo {
    id: string
    title: string
    description: string
    tools: string[]
    keywords?: string[]
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

  const builtinGroups: GroupInfo[] = [
    {
      id: "session",
      title: "Session",
      description:
        "Browse previous conversations, search history, control or message other Synergy sessions, and discover scopes for cross-project session creation.",
      tools: ["session_list", "session_read", "session_search", "session_send", "session_control", "scope_list"],
    },
  ]

  const selection = RuntimeContext.state(() => ({ defaults: undefined as Set<string> | undefined, initialized: false }))

  export function selectDefaultGroups(ids: readonly string[]) {
    RuntimeContext.assertCompositionOpen("default tool groups")
    if (selection().initialized || selection().defaults)
      throw new Error("Select default tool groups before group registration")
    if (ids.some((id) => !builtinGroups.some((group) => group.id === id))) throw new Error("Unknown default tool group")
    selection().defaults = new Set(ids)
  }

  const groupState = RuntimeContext.state(() => {
    const selected = selection()
    selected.initialized = true
    const groups = structuredClone(
      builtinGroups.filter((group) => !selected.defaults || selected.defaults.has(group.id)),
    )
    const byID = new Map(groups.map((group) => [group.id, group]))
    const byTool = new Map(groups.flatMap((group) => group.tools.map((tool) => [tool, group] as const)))
    return { groups, byID, byTool }
  })
  export function groups(): readonly GroupInfo[] {
    return groupState().groups
  }

  export function registerGroups(owner: string, groups: GroupInfo[]) {
    RuntimeContext.assertCompositionOpen("tool groups")
    for (const group of groups) {
      const existing = groupState().byID.get(group.id)
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(group))
          throw new Error(`Conflicting tool group ${group.id} from ${owner}`)
        continue
      }
      groupState().groups.push(group)
      groupState().byID.set(group.id, group)
      for (const tool of group.tools) groupState().byTool.set(tool, group)
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

  export function mcpExposure(serverName: string, expandByDefault?: boolean): Info {
    if (expandByDefault === true) return RESIDENT
    return {
      mode: "group",
      group: mcpGroupID(serverName),
      title: `MCP: ${serverName}`,
      description: `Tools exposed by the connected MCP server "${serverName}".`,
    }
  }

  /**
   * Resolve whether an MCP server's tools stay resident (always visible) by
   * default. Per-server `expandByDefault` wins; `mcpDefaults` supplies the
   * next fallback; `builtinDefault` allows an owning capability to supply a
   * default. The ultimate default is folded (false).
   */
  export function mcpExpandByDefault(server: unknown, defaults?: unknown, builtinDefault?: boolean): boolean {
    const resolvedServer = (server ?? {}) as { expandByDefault?: boolean }
    const resolvedDefaults = (defaults ?? {}) as { expandByDefault?: boolean }
    return resolvedServer.expandByDefault ?? resolvedDefaults.expandByDefault ?? builtinDefault ?? false
  }

  export function builtinGroup(id: string): GroupInfo | undefined {
    return groupState().byID.get(id)
  }

  export function builtinGroupForTool(toolID: string): GroupInfo | undefined {
    return groupState().byTool.get(toolID)
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
      companions: normalized.companions,
      mode: "group",
      group: ORCHESTRATION_GROUP,
      title: ORCHESTRATION_GROUP_INFO.title,
      description: ORCHESTRATION_GROUP_INFO.description,
    }
  }

  export function normalize(toolID: string, explicit?: Info): Info {
    if (explicit) {
      if (explicit.mode === "group" && "whenToExpand" in explicit) {
        const { whenToExpand: _legacy, ...current } = explicit
        return current
      }
      return explicit
    }
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

  /** Apply companion closure only to candidates that already passed all availability and authorization filters. */
  export function resolveVisibility(
    tools: readonly { id: string; exposure?: Info }[],
    state: ToolState | undefined,
    options?: { forcedGroups?: Iterable<string>; forcedTools?: Iterable<string> },
  ) {
    const exposures = new Map(tools.map((tool) => [tool.id, normalize(tool.id, tool.exposure)]))
    const available = new Set(exposures.keys())
    let changed = true
    while (changed) {
      changed = false
      for (const id of available) {
        if (
          exposures
            .get(id)
            ?.companions?.some((other) => !available.has(other) || exposures.get(other)?.mode === "internal")
        ) {
          available.delete(id)
          changed = true
        }
      }
    }
    const visible = new Set([...available].filter((id) => isVisible(id, exposures.get(id), state, options)))
    for (const id of visible) for (const other of exposures.get(id)?.companions ?? []) visible.add(other)
    return { available, visible }
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
      tools: [toolID],
    }
  }

  export function availableGroups(entries: ReadonlyArray<{ id: string; exposure?: Info }>): GroupInfo[] {
    const groups = new Map<string, GroupInfo & { summaries: string[]; keywords: string[] }>()
    for (const entry of entries.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      const exposure = normalize(entry.id, entry.exposure)
      const info = groupInfoFromExposure(entry.id, exposure)
      if (!info || exposure.mode !== "group") continue
      const group = groups.get(info.id) ?? { ...info, tools: [], summaries: [], keywords: [] }
      if (group.title === group.id && exposure.title) group.title = exposure.title
      if (group.description === `Tools in the ${group.id} group.` && exposure.description)
        group.description = exposure.description
      group.tools.push(entry.id)
      if (exposure.summary) group.summaries.push(exposure.summary)
      group.keywords.push(...(info.keywords ?? []), ...(exposure.keywords ?? []))
      groups.set(info.id, group)
    }
    return [...groups.values()]
      .map(({ summaries, ...group }) => ({
        ...group,
        tools: unique(group.tools).sort(),
        keywords: unique(group.keywords ?? []).sort(),
        description: summaries.length ? unique(summaries).sort().join("; ") + "." : group.description,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
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
