import { AgentBuiltins } from "./builtins"
import { PrimaryAgentIdentity } from "./primary-identity"
import { PermissionNext } from "../permission/next"
import type { Provider } from "../provider/provider"
import { Truncate } from "../tool/truncation"
import type { Agent } from "./agent"

export interface BuiltinAgentContext {
  defaults: PermissionNext.Ruleset
  user: PermissionNext.Ruleset
  role: (role: Provider.ModelRole) => { providerID: string; modelID: string } | undefined
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
  | "sessionHistory"
  | "externalResearch"
  | "research"

export interface SubagentDefinition {
  name: string
  description: string
  prompt: string
  model?: Provider.ModelRole
  permission: SubagentPermissionProfile | PermissionNext.Ruleset
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
    view_file: "deny",
    scan_files: "deny",
  })
}

function anchoredReadTools(): PermissionNext.Ruleset {
  return PermissionNext.fromConfig({
    read: "deny",
    grep: "deny",
    view_file: "allow",
    scan_files: "allow",
  })
}

function anchoredWriteTools(): PermissionNext.Ruleset {
  return PermissionNext.fromConfig({
    edit: "deny",
    write: "deny",
    revise_file: "ask",
    resolve_conflicts: "ask",
    save_file: "ask",
  })
}

function baseToolPermissions(profile: SubagentPermissionProfile): PermissionNext.Ruleset {
  const common = PermissionNext.fromConfig({
    "*": "deny",
    expand_tools: "allow",
    search_tools: "allow",
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
    webfetch: "allow",
    glob: "allow",
    list: "allow",
    external_directory: {
      "*": "ask",
      [Truncate.directory()]: "allow",
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

  if (profile === "sessionHistory") {
    return PermissionNext.merge(
      common,
      classicReadTools(),
      PermissionNext.fromConfig({
        session_list: "allow",
        scope_list: "allow",
        session_read: "allow",
        session_search: "allow",
        session_send: "deny",
        session_control: "deny",
      }),
    )
  }

  return PermissionNext.merge(common, classicReadTools())
}

export function createSubagent(ctx: BuiltinAgentContext, definition: SubagentDefinition): Agent.Info {
  const agent: Agent.Info = {
    name: definition.name,
    description: definition.description,
    prompt: definition.prompt,
    options: {},
    permission: PermissionNext.merge(
      ctx.defaults,
      typeof definition.permission === "string" ? baseToolPermissions(definition.permission) : definition.permission,
      ctx.user,
    ),
    mode: "subagent",
    native: true,
    visibleTo: definition.visibleTo ?? [PrimaryAgentIdentity.names.coding, "supervisor"],
    delegationGroups: definition.delegationGroups,
    hidden: definition.hidden,
    ...resolveAgentModelRole(ctx, definition.model ?? "mid"),
    steps: definition.steps,
    temperature: definition.temperature,
    topP: definition.topP,
  }
  if (typeof definition.permission === "string") AgentBuiltins.tagProfile(agent, definition.permission)
  return agent
}
