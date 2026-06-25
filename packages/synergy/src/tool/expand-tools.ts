import { Agent } from "@/agent/agent"
import { Session } from "@/session"
import z from "zod"
import { ToolDiscovery } from "./discovery"
import { ToolExposure } from "./exposure"
import { Tool } from "./tool"

const parameters = z
  .object({
    groups: z
      .array(z.string())
      .optional()
      .describe("Tool group IDs to expand, such as browser, agenda, session, note, memory."),
    tools: z.array(z.string()).optional().describe("Search-only individual tool IDs to activate."),
    reason: z.string().optional().describe("Brief reason this capability is needed."),
  })
  .refine((value) => (value.groups?.length ?? 0) > 0 || (value.tools?.length ?? 0) > 0, {
    message: "Provide at least one group or tool to expand.",
  })

export const ExpandToolsTool = Tool.define("expand_tools", async (initCtx) => ({
  description: [
    "Change tool visibility for the current session by expanding deferred groups or activating search-only tools. The expanded state is stored on the session and remains stable across future turns, session restore, and context compaction until the session ends or the state is explicitly cleared.",
    "This tool does not execute external actions, does not call the expanded tools, and does not bypass permissions, agent policy, sandboxing, disabled user tools, or runtime availability. Tools that are permission-hidden may still remain hidden after expansion.",
    "Known built-in groups:",
    ToolExposure.groupTable(),
    "Usage guidance: if the capability domain is known, call expand_tools({ groups: [...] }) directly. If the tool or group name is uncertain, call search_tools first, then expand the returned group or activate the returned search-only tool.",
    "Important timing: expanded tools become visible when Synergy builds the tool list for the next model step or a subsequent turn. Do not assume a newly expanded tool can be called inside the same tool call.",
  ].join("\n\n"),
  parameters,
  formatValidationError(error) {
    return [
      `The expand_tools tool was called with invalid arguments: ${error.message}`,
      'Next step: call expand_tools with at least one group or tool, for example {"groups":["browser"],"reason":"verify the local UI"}.',
    ].join("\n")
  },
  async execute(params: z.infer<typeof parameters>, ctx) {
    const agent = initCtx?.agent ?? (await Agent.get(ctx.agent))
    if (!agent) {
      return {
        title: "Tool expansion unavailable",
        output:
          "expand_tools could not resolve the current agent. Try again from an active session, or ask the user to restart this session.",
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
    const groupByID = new Map(catalog.groups.map((group) => [group.id, group]))
    const toolByID = new Map(catalog.tools.map((tool) => [tool.id, tool]))
    const current = ToolExposure.state(session.toolState)

    const requestedGroups = ToolExposure.unique(params.groups ?? [])
    const requestedTools = ToolExposure.unique(params.tools ?? [])
    const expandedGroups = new Set(current.expandedGroups)
    const activatedTools = new Set(current.activatedTools)

    const newlyExpandedGroups: string[] = []
    const newlyActivatedTools: string[] = []
    const alreadyActive: string[] = []
    const unknownGroups: string[] = []
    const unknownTools: string[] = []
    const groupToolInputs: Array<{ tool: string; group: string }> = []
    const permissionHidden: string[] = []

    for (const groupID of requestedGroups) {
      const group = groupByID.get(groupID)
      if (!group) {
        unknownGroups.push(groupID)
        continue
      }
      if (expandedGroups.has(groupID)) {
        alreadyActive.push(groupID)
      } else {
        expandedGroups.add(groupID)
        newlyExpandedGroups.push(groupID)
      }
      for (const toolID of group.tools) {
        if (catalog.disabled.has(toolID)) permissionHidden.push(toolID)
      }
    }

    for (const toolID of requestedTools) {
      const tool = toolByID.get(toolID)
      if (!tool) {
        unknownTools.push(toolID)
        continue
      }

      if (tool.exposure.mode === "resident") {
        alreadyActive.push(toolID)
        continue
      }

      if (tool.exposure.mode === "group") {
        if (expandedGroups.has(tool.exposure.group)) {
          alreadyActive.push(toolID)
        } else {
          groupToolInputs.push({ tool: toolID, group: tool.exposure.group })
        }
        continue
      }

      if (activatedTools.has(toolID)) {
        alreadyActive.push(toolID)
      } else {
        activatedTools.add(toolID)
        newlyActivatedTools.push(toolID)
      }
      if (catalog.disabled.has(toolID)) permissionHidden.push(toolID)
    }

    const updatedState = {
      expandedGroups: ToolExposure.unique(expandedGroups),
      activatedTools: ToolExposure.unique(activatedTools),
    }
    const changed =
      updatedState.expandedGroups.join("\0") !== current.expandedGroups.join("\0") ||
      updatedState.activatedTools.join("\0") !== current.activatedTools.join("\0")

    if (changed) {
      await Session.update(session.id, (draft) => {
        draft.toolState = updatedState
      })
    }

    const currentVisibleTools = ToolDiscovery.visibleTools({ ...catalog, state: current })
    const updatedVisibleTools = ToolDiscovery.visibleTools({ ...catalog, state: updatedState })
    const currentVisibleToolSet = new Set(currentVisibleTools)
    const newlyVisibleTools = updatedVisibleTools.filter((toolID) => !currentVisibleToolSet.has(toolID))
    const availableNextStep = changed || alreadyActive.length > 0
    const issues = {
      unknownGroups,
      unknownTools,
      groupToolInputs,
      permissionHidden: ToolExposure.unique(permissionHidden),
    }
    const guidance = guidanceFor({
      requestedGroups,
      requestedTools,
      unknownGroups,
      unknownTools,
      groupToolInputs,
      permissionHidden,
      availableGroups: catalog.groups.map((group) => group.id),
    })
    const result = {
      changed,
      expandedGroups: updatedState.expandedGroups,
      activatedTools: updatedState.activatedTools,
      newlyExpandedGroups,
      newlyActivatedTools,
      newlyVisibleTools,
      visibleToolCount: updatedVisibleTools.length,
      alreadyActive: ToolExposure.unique(alreadyActive),
      availableNextStep,
      issues,
      guidance,
    }

    return {
      title: changed ? "Tools expanded" : "Tool expansion checked",
      output: [
        changed
          ? "Tool visibility state was updated for this session."
          : "No new tool visibility state was added; requested capabilities were already active or need a corrected request.",
        "",
        `availableNextStep: ${availableNextStep}`,
        params.reason ? `Reason recorded: ${params.reason}` : undefined,
        "",
        `expandedGroups: ${result.expandedGroups.length ? result.expandedGroups.join(", ") : "(none)"}`,
        `activatedTools: ${result.activatedTools.length ? result.activatedTools.join(", ") : "(none)"}`,
        result.newlyVisibleTools.length ? `newlyVisibleTools: ${result.newlyVisibleTools.join(", ")}` : undefined,
        `visibleToolCount: ${result.visibleToolCount}`,
        result.alreadyActive.length ? `alreadyActive: ${result.alreadyActive.join(", ")}` : undefined,
        issues.unknownGroups.length
          ? `unknownGroups: ${issues.unknownGroups.join(", ")}. Available groups: ${catalog.groups.map((group) => group.id).join(", ")}.`
          : undefined,
        issues.unknownTools.length
          ? `unknownTools: ${issues.unknownTools.join(", ")}. Next step: call search_tools with the capability or tool name.`
          : undefined,
        issues.groupToolInputs.length
          ? `group tools passed individually: ${issues.groupToolInputs
              .map((item) => `${item.tool} -> expand_tools({ groups: ["${item.group}"] })`)
              .join(", ")}.`
          : undefined,
        issues.permissionHidden.length
          ? `permissionHidden: ${issues.permissionHidden.join(", ")}. Expansion cannot override permissions; choose another tool or ask the user to adjust permissions.`
          : undefined,
        guidance !== DEFAULT_GUIDANCE ? `guidance: ${guidance}` : undefined,
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n"),
      metadata: result as Record<string, any>,
    }
  },
}))

function guidanceFor(input: {
  requestedGroups: string[]
  requestedTools: string[]
  unknownGroups: string[]
  unknownTools: string[]
  groupToolInputs: Array<{ tool: string; group: string }>
  permissionHidden: string[]
  availableGroups: string[]
}) {
  const lines: string[] = []
  if (input.unknownGroups.length > 0) {
    lines.push(`Unknown group. Re-call expand_tools with one of: ${input.availableGroups.join(", ")}.`)
  }
  if (input.unknownTools.length > 0) {
    lines.push(
      "Unknown tool. Call search_tools(query) first, then expand the returned group or activate the exact tool id.",
    )
  }
  if (input.groupToolInputs.length > 0) {
    lines.push(
      `Group-scoped tools should be expanded by group: ${input.groupToolInputs
        .map((item) => `${item.tool} belongs to ${item.group}`)
        .join("; ")}.`,
    )
  }
  if (input.permissionHidden.length > 0) {
    lines.push("Some requested tools may remain hidden because permissions, user tool settings, or policy deny them.")
  }
  if (lines.length === 0) {
    lines.push(DEFAULT_GUIDANCE)
  }
  return lines.join("\n")
}

const DEFAULT_GUIDANCE = "Continue with the newly visible tools on the next model step or later turn."
