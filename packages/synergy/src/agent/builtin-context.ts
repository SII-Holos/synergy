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
  | "analysis"
  | "implementation"
  | "documentation"
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

function baseToolPermissions(profile: SubagentPermissionProfile): PermissionNext.Ruleset {
  const common = PermissionNext.fromConfig({
    "*": "deny",
    question: "deny",
    dagwrite: "deny",
    dagread: "deny",
    dagpatch: "deny",
    runtime_reload: "deny",
    task: "deny",
    read: "allow",
    lookat: "allow",
    grep: "allow",
    ast_grep: "allow",
    glob: "allow",
    bash: "allow",
    external_directory: {
      "*": "ask",
      [Truncate.DIR]: "allow",
    },
  })

  if (profile === "implementation" || profile === "documentation") {
    return PermissionNext.merge(
      common,
      PermissionNext.fromConfig({
        edit: "ask",
        write: "ask",
      }),
    )
  }

  if (profile === "quality") {
    return PermissionNext.merge(
      common,
      PermissionNext.fromConfig({
        edit: "ask",
        write: "ask",
        process: "allow",
      }),
    )
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
    permission: PermissionNext.merge(
      ctx.defaults,
      ctx.user,
      baseToolPermissions(definition.permission),
      PermissionNext.fromConfig({ question: "deny" }),
    ),
    mode: "subagent",
    native: true,
    model: ctx.role(definition.model ?? "mid"),
    steps: definition.steps,
    temperature: definition.temperature,
    topP: definition.topP,
  }
}
