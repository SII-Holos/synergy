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

interface ExpandToolsIssues {
  unknownGroups: string[]
  unknownTools: string[]
  groupToolInputs: Array<{ tool: string; group: string }>
  permissionHidden: string[]
}

export const ExpandToolsTool = Tool.define("expand_tools", async (initCtx) => ({
  description: [
    "Change tool visibility for the current session by expanding deferred groups or activating search-only tools. The expanded state is stored on the session and remains stable across future turns, session restore, and context compaction until the session ends or the state is explicitly cleared.",
    "This tool does not execute external actions, does not call the expanded tools, and does not bypass permissions, agent policy, sandboxing, disabled user tools, or runtime availability. Tools that are permission-hidden may still remain hidden after expansion.",
    "Known built-in groups:",
    ToolExposure.groupTable(),
    "Usage guidance: if the capability domain is known, call expand_tools({ groups: [...] }) directly. If the tool or group name is uncertain, call search_tools first, then expand the returned group or activate the returned search-only tool.",
    "After expand_tools returns, use the listed tools directly. Tools omitted from the list may still be hidden by permissions, user settings, policy, or runtime availability.",
  ].join("\n\n"),
  parameters,
  formatValidationError(error) {
    return [
      `The expand_tools tool was called with invalid arguments: ${error.message}`,
      'Call expand_tools with at least one group or tool, for example {"groups":["browser"],"reason":"verify the local UI"}.',
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
    const updatedVisibleToolSet = new Set(updatedVisibleTools)
    const requestedGroupTools = requestedGroups.flatMap((groupID) => groupByID.get(groupID)?.tools ?? [])
    const availableRequestedTools = ToolExposure.unique(
      [...requestedGroupTools, ...requestedTools].filter((toolID) => updatedVisibleToolSet.has(toolID)),
    )
    const availableNextStep = changed || alreadyActive.length > 0
    const issues: ExpandToolsIssues = {
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
      availableRequestedTools,
      visibleToolCount: updatedVisibleTools.length,
      alreadyActive: ToolExposure.unique(alreadyActive),
      availableNextStep,
      availableOn: "next_model_request",
      issues,
      guidance,
    }

    const output = formatOutput({
      changed,
      reason: params.reason,
      availableRequestedTools,
      issues,
      availableGroups: catalog.groups.map((group) => group.id),
    })

    return {
      title: changed ? "Tools expanded" : "Tool expansion checked",
      output,
      metadata: result as Record<string, any>,
    }
  },
}))
function formatOutput(input: {
  changed: boolean
  reason?: string
  availableRequestedTools: string[]
  issues: ExpandToolsIssues
  availableGroups: string[]
}) {
  const hasIssues =
    input.issues.unknownGroups.length > 0 ||
    input.issues.unknownTools.length > 0 ||
    input.issues.groupToolInputs.length > 0 ||
    input.issues.permissionHidden.length > 0
  const status = input.changed
    ? hasIssues
      ? "Tool visibility was partially updated."
      : "Tool visibility was updated."
    : input.availableRequestedTools.length > 0
      ? "Requested tools are already available."
      : "No requested tools were made available."

  const issueLines = formatIssueLines(input.issues, input.availableGroups)

  return [
    status,
    input.reason ? `Reason: ${input.reason}` : undefined,
    input.availableRequestedTools.length > 0 ? "" : undefined,
    input.availableRequestedTools.length > 0 ? "You can call these tools directly:" : undefined,
    input.availableRequestedTools.length > 0 ? input.availableRequestedTools.join(", ") : undefined,
    issueLines.length > 0 ? "" : undefined,
    ...issueLines,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")
}

function formatIssueLines(issues: ExpandToolsIssues, availableGroups: string[]) {
  const lines: string[] = []
  if (issues.unknownGroups.length > 0) {
    lines.push(`Unknown groups: ${issues.unknownGroups.join(", ")}. Available groups: ${availableGroups.join(", ")}.`)
  }
  if (issues.unknownTools.length > 0) {
    lines.push(`Unknown tools: ${issues.unknownTools.join(", ")}. Use search_tools with the capability or tool name.`)
  }
  if (issues.groupToolInputs.length > 0) {
    lines.push(
      `Expand group-scoped tools by group: ${issues.groupToolInputs
        .map((item) => `${item.tool} -> expand_tools({ groups: ["${item.group}"] })`)
        .join(", ")}.`,
    )
  }
  if (issues.permissionHidden.length > 0) {
    lines.push(
      `Unavailable because permissions, user tool settings, or policy hide them: ${issues.permissionHidden.join(", ")}.`,
    )
  }
  return lines
}

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

const DEFAULT_GUIDANCE = "Use the listed tools directly."
