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
  | "testWrite"
  | "docsWrite"
  | "quality"
  | "externalResearch"
  | "research"

export interface SubagentDefinition {
  name: string
  description: string
  prompt: string
  model?: Provider.ModelRole
  permission: SubagentPermissionProfile
  steps?: number
  temperature?: number
  topP?: number
}

function commandTools(): PermissionNext.Ruleset {
  return PermissionNext.fromConfig({
    bash: "allow",
    process: "allow",
  })
}

function writeTools(): PermissionNext.Ruleset {
  return PermissionNext.fromConfig({
    edit: "ask",
    write: "ask",
  })
}

function baseToolPermissions(profile: SubagentPermissionProfile): PermissionNext.Ruleset {
  const common = PermissionNext.fromConfig({
    "*": "deny",
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
    read: "allow",
    look_at: "allow",
    grep: "allow",
    ast_grep: "allow",
    glob: "allow",
    external_directory: {
      "*": "ask",
      [Truncate.DIR]: "allow",
    },
  })

  if (profile === "codeWrite" || profile === "testWrite") {
    return PermissionNext.merge(common, writeTools(), commandTools())
  }

  if (profile === "docsWrite") {
    return PermissionNext.merge(common, writeTools())
  }

  if (profile === "quality" || profile === "review") {
    return PermissionNext.merge(common, commandTools())
  }

  if (profile === "externalResearch") {
    return PermissionNext.merge(
      common,
      PermissionNext.fromConfig({
        websearch: "allow",
        webfetch: "allow",
        skill: {
          "agent-browser": "allow",
          "git-guide": "allow",
        },
      }),
    )
  }

  if (profile === "research") {
    return PermissionNext.merge(
      common,
      PermissionNext.fromConfig({
        websearch: "allow",
        webfetch: "allow",
        arxiv_search: "allow",
        arxiv_download: "ask",
      }),
    )
  }

  return common
}

export function createSubagent(ctx: BuiltinAgentContext, definition: SubagentDefinition): Agent.Info {
  return {
    name: definition.name,
    description: definition.description,
    prompt: definition.prompt,
    options: {},
    permission: PermissionNext.merge(ctx.defaults, ctx.user, baseToolPermissions(definition.permission)),
    mode: "subagent",
    native: true,
    model: ctx.role(definition.model ?? "mid"),
    steps: definition.steps,
    temperature: definition.temperature,
    topP: definition.topP,
  }
}
