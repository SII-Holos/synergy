import {
  classifySemanticCategory,
  semanticCategoryForKnownTool,
  type SemanticCategory,
} from "@ericsanchezok/synergy-util/activity"
import type { IconName } from "../icon"
import type { MessageDescriptor } from "@lingui/core"
import { getSemanticIcon } from "../semantic-icon"
import { CLASSIFIER_LABEL_DESC, TOOL_LABEL_DESC, TOOL_TITLE_DESC } from "../tool-title-descriptors"

export const LATTICE_TOOL_TITLE_DESCRIPTORS: Record<string, MessageDescriptor> = {
  pathway_read: { id: "tool.title.pathwayRead", message: "Read Pathway" },
  pathway_write: { id: "tool.title.pathwayWrite", message: "Write Pathway" },
  lattice_submit: { id: "tool.title.latticeSubmit", message: "Submit Lattice action" },
}

export const LATTICE_ACTION_DESCRIPTORS: Record<string, MessageDescriptor> = {
  submit_requirements: { id: "tool.title.latticeSubmitRequirements", message: "Align requirements" },
  submit_pathway: { id: "tool.title.latticeSubmitPathway", message: "Submit Pathway" },
  submit_pathway_review: { id: "tool.title.latticeSubmitPathwayReview", message: "Complete Pathway review" },
  submit_blueprint: { id: "tool.title.latticeSubmitBlueprint", message: "Select Blueprint" },
  submit_blueprint_review: {
    id: "tool.title.latticeSubmitBlueprintReview",
    message: "Complete Blueprint review",
  },
  approve_execution: { id: "tool.title.latticeApproveExecution", message: "Approve Blueprint execution" },
}

export const LATTICE_SOURCE_DESCRIPTORS: Record<string, MessageDescriptor> = {
  tool: { id: "tool.label.latticeSourceChat", message: "Chat" },
  chat: { id: "tool.label.latticeSourceChat", message: "Chat" },
  panel: { id: "tool.label.latticeSourcePanel", message: "Panel" },
}

export function getLatticeToolPresentation(
  tool: string,
  input: Record<string, any> = {},
  metadata: Record<string, any> = {},
): { icon: IconName; title: MessageDescriptor; subtitle?: string; args?: string[] } | undefined {
  if (tool === "pathway_read") {
    const completed = typeof metadata.completed === "number" ? metadata.completed : undefined
    const total = typeof metadata.total === "number" ? metadata.total : undefined
    return {
      icon: "route",
      title: LATTICE_TOOL_TITLE_DESCRIPTORS.pathway_read!,
      subtitle: typeof metadata.currentStepTitle === "string" ? metadata.currentStepTitle : undefined,
      args: completed !== undefined && total !== undefined ? [`${completed}/${total}`] : undefined,
    }
  }

  if (tool === "pathway_write") {
    const steps = Array.isArray(input.futureSteps)
      ? input.futureSteps
      : Array.isArray(input.steps)
        ? input.steps
        : undefined
    const stepCount = steps?.length
    return {
      icon: "list-checks",
      title: LATTICE_TOOL_TITLE_DESCRIPTORS.pathway_write!,
      subtitle: typeof metadata.currentStepTitle === "string" ? metadata.currentStepTitle : undefined,
      args: stepCount !== undefined ? [String(stepCount)] : undefined,
    }
  }

  if (tool !== "lattice_submit") return undefined
  const action = typeof input.action === "string" ? input.action : ""
  const title = LATTICE_ACTION_DESCRIPTORS[action] ?? LATTICE_TOOL_TITLE_DESCRIPTORS.lattice_submit!
  const blueprintTitle = typeof metadata.blueprintTitle === "string" ? metadata.blueprintTitle : undefined
  const reason = typeof input.reason === "string" ? input.reason : undefined
  const goal = action === "submit_requirements" && typeof input.goal === "string" ? input.goal : undefined
  const source = typeof metadata.source === "string" ? metadata.source : undefined
  const sourceDescriptor = source ? LATTICE_SOURCE_DESCRIPTORS[source] : undefined
  return {
    icon: "circle-check",
    title,
    subtitle: blueprintTitle ?? reason ?? goal,
    args: sourceDescriptor ? [sourceDescriptor.message ?? sourceDescriptor.id] : undefined,
  }
}

/**
 * UI presentation for semantic tool categories classified by the shared activity utility.
 * Exact mappings, pattern fallbacks, and input-shape heuristics live in
 * `@ericsanchezok/synergy-util/activity` so runtime grouping and UI titles stay aligned.
 */

export interface CategorySpec {
  icon: IconName
  descriptor: MessageDescriptor
  /** Human-readable label for the category (used as fallback title) */
  subtitleKeys: string[]
  /** Ordered list of input keys to try for subtitle extraction */
  argsKeys?: string[]
  /** Optional extra keys for args badges */
}

export const CATEGORIES: Record<SemanticCategory, CategorySpec> = {
  "file-read": {
    icon: "glasses",
    descriptor: CLASSIFIER_LABEL_DESC["file-read"],
    subtitleKeys: ["filePath", "file_path", "path", "filename"],
  },
  "file-write": {
    icon: "file-pen",
    descriptor: CLASSIFIER_LABEL_DESC["file-write"],
    subtitleKeys: ["filePath", "file_path", "path", "filename"],
  },
  shell: {
    icon: "terminal",
    descriptor: CLASSIFIER_LABEL_DESC["shell"],
    subtitleKeys: ["description", "command", "cmd", "script"],
  },
  search: {
    icon: "regex",
    descriptor: CLASSIFIER_LABEL_DESC["search"],
    subtitleKeys: ["pattern", "query", "regex", "search"],
    argsKeys: ["include", "lang", "language"],
  },
  web: {
    icon: "globe",
    descriptor: CLASSIFIER_LABEL_DESC["web"],
    subtitleKeys: ["url", "query"],
    argsKeys: ["format", "categories"],
  },
  browser: {
    icon: "panel-right",
    descriptor: CLASSIFIER_LABEL_DESC["browser"],
    subtitleKeys: ["url", "title", "action", "type"],
    argsKeys: ["action", "kind", "captureKind"],
  },
  memory: {
    icon: "brain",
    descriptor: CLASSIFIER_LABEL_DESC["memory"],
    subtitleKeys: ["query", "title"],
  },
  note: {
    icon: "notebook-pen",
    descriptor: CLASSIFIER_LABEL_DESC["note"],
    subtitleKeys: ["title", "pattern"],
    argsKeys: ["scope", "mode"],
  },
  blueprint: {
    icon: getSemanticIcon("blueprint.main"),
    descriptor: CLASSIFIER_LABEL_DESC["blueprint"],
    subtitleKeys: ["title", "loopID", "id"],
    argsKeys: ["status"],
  },
  task: {
    icon: "list-todo",
    descriptor: CLASSIFIER_LABEL_DESC["task"],
    subtitleKeys: ["description", "prompt"],
  },
  dag: {
    icon: "route",
    descriptor: CLASSIFIER_LABEL_DESC["dag"],
    subtitleKeys: [],
  },
  schedule: {
    icon: "clipboard-check",
    descriptor: CLASSIFIER_LABEL_DESC["schedule"],
    subtitleKeys: ["title", "id"],
    argsKeys: ["status"],
  },
  session: {
    icon: "message-square",
    descriptor: CLASSIFIER_LABEL_DESC["session"],
    subtitleKeys: ["target", "pattern"],
    argsKeys: ["scope"],
  },
  "session-control": {
    icon: "radar",
    descriptor: CLASSIFIER_LABEL_DESC["session-control"],
    subtitleKeys: ["target"],
    argsKeys: ["action"],
  },
  network: {
    icon: "cable",
    descriptor: CLASSIFIER_LABEL_DESC["network"],
    subtitleKeys: ["linkID"],
    argsKeys: ["action"],
  },
  analyze: {
    icon: "scan-eye",
    descriptor: CLASSIFIER_LABEL_DESC["analyze"],
    subtitleKeys: ["goal", "file_path", "description"],
  },
  config: {
    icon: "rotate-cw",
    descriptor: CLASSIFIER_LABEL_DESC["config"],
    subtitleKeys: ["target", "name", "reason"],
  },
  communication: {
    icon: "mail",
    descriptor: CLASSIFIER_LABEL_DESC["communication"],
    subtitleKeys: ["to", "target", "subject", "output_path", "input_paths", "prompt"],
  },
  skill: {
    icon: "sparkles",
    descriptor: CLASSIFIER_LABEL_DESC["skill"],
    subtitleKeys: ["name"],
  },
  research: {
    icon: "flask-conical",
    descriptor: CLASSIFIER_LABEL_DESC["research"],
    subtitleKeys: ["action", "title", "project"],
    argsKeys: ["action"],
  },
  generic: {
    icon: "settings",
    descriptor: CLASSIFIER_LABEL_DESC["generic"],
    subtitleKeys: [],
  },
}

// ── Classifier ──────────────────────────────────────────────────────

export interface ClassifiedTool {
  category: SemanticCategory
  spec: CategorySpec
  /** English fallback or pass-through title. */
  title: string
  /** Static descriptor for Synergy-owned tools; absent for external tool names. */
  titleDescriptor?: MessageDescriptor
  subtitle?: string
  args?: string[]
  /** ICU plural count descriptor to resolve at render time, plus values. */
  countDescriptor?: MessageDescriptor
  countValues?: Record<string, number>
}

export function classifyTool(
  toolName: string,
  input: Record<string, any> = {},
  metadata: Record<string, any> = {},
): ClassifiedTool {
  const category = classifySemanticCategory(toolName, input)

  const spec = CATEGORIES[category]

  const titleDescriptor = toolTitleDescriptor(toolName, spec)
  const title = titleDescriptor?.message ?? humanizeToolName(toolName)

  const subtitle =
    toolName === "lattice_submit" && typeof input.action === "string"
      ? input.action
      : toolName === "response_card" && typeof input.title === "string"
        ? input.title
        : (extractField(metadata, spec.subtitleKeys) ?? extractField(input, spec.subtitleKeys))

  const args = buildArgs(input, metadata, spec)
  const count = classifyCount(toolName, category, metadata)

  return { category, spec, title, titleDescriptor, subtitle, args, ...count }
}

function toolTitleDescriptor(name: string, spec: CategorySpec): MessageDescriptor | undefined {
  const latticeDescriptor = LATTICE_TOOL_TITLE_DESCRIPTORS[name]
  if (latticeDescriptor) return latticeDescriptor
  const exactDescriptor: MessageDescriptor | undefined = Object.hasOwn(TOOL_TITLE_DESC, name)
    ? TOOL_TITLE_DESC[name]
    : undefined
  if (exactDescriptor) return exactDescriptor
  return semanticCategoryForKnownTool(name) ? spec.descriptor : undefined
}

function humanizeToolName(name: string): string {
  return name
    .replace(/[-_]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim()
}

function extractField(input: Record<string, any>, keys: string[]): string | undefined {
  for (const key of keys) {
    const val = input[key]
    if (typeof val === "string" && val.length > 0) return val
    if (Array.isArray(val) && val.length > 0 && typeof val[0] === "string") return val[0]
  }
  return undefined
}
type CountPresentation = Pick<ClassifiedTool, "countDescriptor" | "countValues">

const TOOL_COUNT_DESCRIPTORS: Partial<Record<string, MessageDescriptor>> = {
  session_list: TOOL_LABEL_DESC.sessions,
  scope_list: TOOL_LABEL_DESC.scopes,
  task_list: TOOL_LABEL_DESC.tasks,
  note_list: TOOL_LABEL_DESC.notes,
  worktree_list: TOOL_LABEL_DESC.targets,
}

const CATEGORY_COUNT_DESCRIPTORS: Partial<Record<SemanticCategory, MessageDescriptor>> = {
  session: TOOL_LABEL_DESC.sessions,
  note: TOOL_LABEL_DESC.notes,
  blueprint: TOOL_LABEL_DESC.blueprints,
  task: TOOL_LABEL_DESC.tasks,
  memory: TOOL_LABEL_DESC.results,
  search: TOOL_LABEL_DESC.results,
  schedule: TOOL_LABEL_DESC.items,
  "file-read": TOOL_LABEL_DESC.files,
  "file-write": TOOL_LABEL_DESC.files,
}

function classifyCount(toolName: string, category: SemanticCategory, metadata: Record<string, any>): CountPresentation {
  const count = metadata.matchCount ?? metadata.count ?? metadata.total
  if (typeof count !== "number") return {}

  if (typeof metadata.noteCount === "number") {
    return {
      countDescriptor:
        category === "blueprint" || toolName.includes("blueprint")
          ? TOOL_LABEL_DESC.matchesInBlueprints
          : TOOL_LABEL_DESC.matchesInNotes,
      countValues: { matchCount: count, noteCount: metadata.noteCount },
    }
  }

  return {
    countDescriptor: TOOL_COUNT_DESCRIPTORS[toolName] ?? CATEGORY_COUNT_DESCRIPTORS[category] ?? TOOL_LABEL_DESC.items,
    countValues: { count },
  }
}

function buildArgs(
  input: Record<string, any>,
  metadata: Record<string, any>,
  spec: CategorySpec,
): string[] | undefined {
  const args: string[] = []

  if (spec.argsKeys) {
    for (const k of spec.argsKeys) {
      const v = input[k]
      if (typeof v === "string" && v.length > 0) args.push(v)
    }
  }

  const status = metadata.status ?? metadata.action
  if (typeof status === "string" && status.length > 0 && status.length < 20) {
    args.push(status.charAt(0).toUpperCase() + status.slice(1))
  }

  return args.length > 0 ? args : undefined
}

// Re-export for convenient access
export { CLASSIFIER_LABEL_DESC }
