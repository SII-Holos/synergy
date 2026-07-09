import { PermissionNext } from "@/permission/next"
import type { Provider } from "../provider/provider"
import { Truncate } from "../tool/truncation"
import type { Agent } from "./agent"

export interface BuiltinAgentContext {
  defaults: PermissionNext.Ruleset
  user: PermissionNext.Ruleset
  role: (role: Provider.ModelRole) => { providerID: string; modelID: string } | undefined
  evolutionActive: boolean
}

export type SubagentPermissionProfile =
  | "readOnly"
  | "review"
  | "codeWrite"
  | "anchoredCodeWrite"
  | "testWrite"
  | "anchoredTestWrite"
  | "docsWrite"
  | "anchoredDocsWrite"
  | "quality"
  | "memory"
  | "note"
  | "sessionHistory"
  | "externalResearch"
  | "research"
  | "supervisor"
  | "lightLoopReviewer"

export interface SubagentDefinition {
  name: string
  description: string
  prompt: string
  model?: Provider.ModelRole
  permission: SubagentPermissionProfile
  visibleTo?: string[]
  delegationGroups?: string[]
  hidden?: boolean
  steps?: number
  temperature?: number
  topP?: number
}

export function resolveAgentModelRole(ctx: BuiltinAgentContext, role: Provider.ModelRole) {
  return {
    modelRole: role,
    model: ctx.role(role),
    modelSource: "role" as const,
  }
}

function classicWriteTools(): PermissionNext.Ruleset {
  return PermissionNext.fromConfig({
    edit: "ask",
    write: "ask",
  })
}

function classicReadTools(): PermissionNext.Ruleset {
  return PermissionNext.fromConfig({
    read: "allow",
    grep: "allow",
    ast_grep: "allow",
    view_file: "deny",
    scan_files: "deny",
    parse_code: "deny",
  })
}

function anchoredReadTools(): PermissionNext.Ruleset {
  return PermissionNext.fromConfig({
    read: "deny",
    grep: "deny",
    ast_grep: "deny",
    view_file: "allow",
    scan_files: "allow",
    parse_code: "allow",
    scan_document: "allow",
  })
}

function anchoredWriteTools(): PermissionNext.Ruleset {
  return PermissionNext.fromConfig({
    edit: "deny",
    write: "deny",
    revise_file: "ask",
    save_file: "ask",
  })
}

function baseToolPermissions(profile: SubagentPermissionProfile): PermissionNext.Ruleset {
  const common = PermissionNext.fromConfig({
    "*": "deny",
    "mcp__*": "allow",
    question: "deny",
    dagwrite: "deny",
    dagread: "deny",
    dagpatch: "deny",
    task: "deny",
    task_list: "deny",
    task_output: "deny",
    task_cancel: "deny",
    runtime_reload: "deny",
    todowrite: "allow",
    todoread: "allow",
    bash: "allow",
    process: "allow",
    skill: "allow",
    websearch: "allow",
    webfetch: "allow",
    look_at: "allow",
    glob: "allow",
    list: "allow",
    arxiv_search: "allow",
    arxiv_download: "ask",
    memory_search: "allow",
    memory_get: "allow",
    note_list: "allow",
    note_read: "allow",
    note_search: "allow",
    note_write: "allow",
    note_edit: "allow",
    session_list: "allow",
    session_read: "allow",
    session_search: "allow",
    agenda_list: "allow",
    agenda_logs: "allow",
    external_directory: {
      "*": "ask",
      [Truncate.DIR]: "allow",
    },
  })

  if (profile === "codeWrite" || profile === "testWrite") {
    return PermissionNext.merge(common, classicReadTools(), classicWriteTools())
  }

  if (profile === "anchoredCodeWrite" || profile === "anchoredTestWrite") {
    return PermissionNext.merge(common, anchoredReadTools(), anchoredWriteTools())
  }

  if (profile === "docsWrite") {
    return PermissionNext.merge(common, classicReadTools(), classicWriteTools())
  }

  if (profile === "anchoredDocsWrite") {
    return PermissionNext.merge(common, anchoredReadTools(), anchoredWriteTools())
  }

  if (profile === "memory") {
    return PermissionNext.merge(
      common,
      classicReadTools(),
      PermissionNext.fromConfig({
        memory_search: "allow",
        memory_get: "allow",
        memory_write: "allow",
        memory_edit: "allow",
      }),
    )
  }

  if (profile === "note") {
    return PermissionNext.merge(
      common,
      classicReadTools(),
      PermissionNext.fromConfig({
        note_list: "allow",
        note_read: "allow",
        note_search: "allow",
        note_write: "allow",
        note_edit: "allow",
        note_archive: "allow",
        note_delete: "allow",
      }),
    )
  }

  if (profile === "sessionHistory") {
    return PermissionNext.merge(
      common,
      classicReadTools(),
      PermissionNext.fromConfig({
        session_list: "allow",
        session_read: "allow",
        session_search: "allow",
        session_send: "deny",
        session_control: "deny",
      }),
    )
  }

  if (profile === "supervisor") {
    return PermissionNext.merge(
      common,
      anchoredReadTools(),
      PermissionNext.fromConfig({
        dagwrite: "allow",
        dagread: "allow",
        dagpatch: "allow",
        task: "allow",
        task_list: "allow",
        task_output: "allow",
        task_cancel: "allow",
        session_send: "deny",
        session_control: "deny",
        note_list: "allow",
        note_read: "allow",
        note_search: "allow",
        note_write: "deny",
        note_edit: "deny",
        blueprint_loop_restart: "allow",
        blueprint_loop_finish: "allow",
      }),
    )
  }

  if (profile === "lightLoopReviewer") {
    return PermissionNext.merge(
      common,
      anchoredReadTools(),
      PermissionNext.fromConfig({
        dagwrite: "allow",
        dagread: "allow",
        dagpatch: "allow",
        task: "allow",
        task_list: "allow",
        task_output: "allow",
        task_cancel: "allow",
        session_send: "deny",
        session_control: "deny",
        note_list: "allow",
        note_read: "allow",
        note_search: "allow",
        note_write: "deny",
        note_edit: "deny",
        memory_write: "deny",
        memory_edit: "deny",
        light_loop_approve: "allow",
        light_loop_reject: "allow",
      }),
    )
  }

  return PermissionNext.merge(common, classicReadTools())
}

export function createSubagent(ctx: BuiltinAgentContext, definition: SubagentDefinition): Agent.Info {
  return {
    name: definition.name,
    description: definition.description,
    prompt: definition.prompt,
    options: {},
    permission: PermissionNext.merge(ctx.defaults, baseToolPermissions(definition.permission), ctx.user),
    mode: "subagent",
    native: true,
    visibleTo: definition.visibleTo ?? ["synergy-max", "supervisor"],
    delegationGroups: definition.delegationGroups,
    hidden: definition.hidden,
    ...resolveAgentModelRole(ctx, definition.model ?? "mid"),
    steps: definition.steps,
    temperature: definition.temperature,
    topP: definition.topP,
  }
}
