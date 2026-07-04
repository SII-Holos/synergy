import { Config } from "../config/config"
import z from "zod"
import { Provider } from "../provider/provider"
import { Identifier } from "../id/id"
import { LLM } from "../session/llm"
import type { MessageV2 } from "../session/message-v2"
import { ScopedState } from "../scope/scoped-state"
import { Truncate } from "../tool/truncation"

import { createBuiltinInternalAgents } from "./builtin-internal"
import { createBuiltinLegacySubagents } from "./builtin-legacy-subagents"
import { createBuiltinPrimaryAgents } from "./builtin-primary"
import { createBuiltinMaxSubagents } from "./builtin-max-subagents"
import { buildSynergyPrompt } from "./prompt/synergy/builder"
import { buildSynergyMaxPrompt } from "./prompt/synergy-max/builder"
import { buildSupervisorPrompt } from "./prompt/supervisor/builder"

import { PermissionNext } from "@/permission/next"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import { Log } from "@/util/log"
import { ExternalAgent } from "@/external-agent/bridge"
import { ExternalAgentDiscovery } from "@/external-agent/discovery"
import { Plugin } from "../plugin"
import { MODEL_ROLE_IDS, ModelRole, type ModelRole as ModelRoleType } from "../provider/model-role"

export namespace Agent {
  const log = Log.create({ service: "agent" })

  const ModelRef = z.object({
    providerID: z.string(),
    modelID: z.string(),
  })

  const MODEL_ROLE_SUMMARY_IDS = ["default", ...MODEL_ROLE_IDS] as const
  const ModelRoleSummaryID = z.enum(MODEL_ROLE_SUMMARY_IDS)

  const ModelRoleField = z.enum([
    "model",
    "nano_model",
    "mini_model",
    "mid_model",
    "thinking_model",
    "long_context_model",
    "creative_model",
    "vision_model",
  ])

  const ModelRoleUsage = z
    .object({
      name: z.string(),
      description: z.string().optional(),
      mode: z.enum(["subagent", "primary", "all"]),
      hidden: z.boolean().optional(),
      visibleTo: z.array(z.string()).optional(),
      native: z.boolean().optional(),
      source: z.enum(["builtin", "config", "plugin", "external"]).optional(),
      modelSource: z.enum(["role", "explicit"]).optional(),
      model: ModelRef.optional(),
      defaultVariant: z.string().optional(),
    })
    .meta({ ref: "ModelRoleUsage" })

  export const ModelRoleSummary = z
    .object({
      id: ModelRoleSummaryID,
      role: ModelRole.optional(),
      field: ModelRoleField,
      label: z.string(),
      summary: z.string(),
      fallbackChain: z.array(ModelRoleField),
      configuredModel: ModelRef.optional(),
      resolvedModel: ModelRef.extend({ via: ModelRoleField }).optional(),
      usedBy: z.array(ModelRoleUsage),
      requiresExplicitModel: z.boolean().optional(),
      disabledReason: z.string().optional(),
    })
    .meta({ ref: "ModelRoleSummary" })
  export type ModelRoleSummary = z.infer<typeof ModelRoleSummary>

  const MODEL_ROLE_DEFINITIONS: Array<{
    id: z.infer<typeof ModelRoleSummaryID>
    role?: ModelRoleType
    field: z.infer<typeof ModelRoleField>
    label: string
    summary: string
    requiresExplicitModel?: boolean
    disabledReason?: string
  }> = [
    {
      id: "default",
      field: "model",
      label: "Default",
      summary: "Main conversation model when no specialist role applies.",
    },
    {
      id: "nano",
      role: "nano",
      field: "nano_model",
      label: "Nano",
      summary: "Cheap quick tasks like titles and summaries.",
    },
    {
      id: "mini",
      role: "mini",
      field: "mini_model",
      label: "Mini",
      summary: "Lightweight routing, intent, and extraction.",
    },
    {
      id: "mid",
      role: "mid",
      field: "mid_model",
      label: "Mid",
      summary: "Routine background agents and code exploration.",
    },
    {
      id: "thinking",
      role: "thinking",
      field: "thinking_model",
      label: "Thinking",
      summary: "Deep reasoning for architecture, implementation, and reviews.",
    },
    {
      id: "long",
      role: "long",
      field: "long_context_model",
      label: "Long context",
      summary: "Compaction and very long inputs.",
    },
    {
      id: "creative",
      role: "creative",
      field: "creative_model",
      label: "Creative",
      summary: "Writing, design, and visual work.",
    },
    {
      id: "vision",
      role: "vision",
      field: "vision_model",
      label: "Vision",
      summary: "Enables screenshot and image analysis.",
      requiresExplicitModel: true,
      disabledReason: "Image analysis is disabled until a vision model is configured.",
    },
  ]

  export const Info = z
    .object({
      name: z.string(),
      description: z.string().optional(),
      mode: z.enum(["subagent", "primary", "all"]),
      native: z.boolean().optional(),
      hidden: z.boolean().optional(),
      visibleTo: z.array(z.string()).optional(),
      topP: z.number().optional(),
      temperature: z.number().optional(),
      color: z.string().optional(),
      permission: PermissionNext.Ruleset,
      controlProfile: z.enum(["guarded", "autonomous", "full_access"]).optional(),
      model: z
        .object({
          modelID: z.string(),
          providerID: z.string(),
        })
        .optional(),
      modelRole: ModelRole.optional(),
      modelSource: z.enum(["role", "explicit"]).optional(),
      source: z.enum(["builtin", "config", "plugin", "external"]).optional(),
      prompt: z.string().optional(),
      options: z.record(z.string(), z.any()),
      steps: z.number().int().positive().optional(),
      external: ExternalAgent.Info.optional(),
      defaultVariant: z.string().optional(),
    })
    .meta({
      ref: "Agent",
    })
  export type Info = z.infer<typeof Info>

  const state = ScopedState.create(async () => {
    const cfg = await Config.current()
    const evolutionActive =
      ((cfg as any).library?.memory?.enabled ?? true) && (cfg as any).library?.experience?.encode !== false
    const role = (r: ModelRoleType) => Provider.resolveRoleModelSync(cfg, r)

    const defaults = PermissionNext.fromConfig({
      "*": "allow",

      arxiv_search: "deny",
      arxiv_download: "ask",

      read: {
        "*.env": "ask",
        "*.env.*": "ask",
        ".env": "ask",
        "*.pem": "ask",
        "*.key": "ask",
        "*_rsa": "ask",
        "*credentials*": "ask",
        "*secret*": "ask",
      },

      edit: "ask",
      write: "ask",

      question: "deny",
      dagwrite: "deny",
      dagread: "deny",
      dagpatch: "deny",
      external_directory: {
        "*": "ask",
        [Truncate.DIR]: "allow",
      },
    })
    const user = PermissionNext.fromConfig(cfg.permission ?? {})

    const builtinContext = { defaults, user, role, evolutionActive }
    const result: Record<string, Info> = {
      ...createBuiltinPrimaryAgents(builtinContext),
      ...createBuiltinLegacySubagents(builtinContext),
      ...createBuiltinMaxSubagents(builtinContext),
      ...createBuiltinInternalAgents(builtinContext),
    }
    for (const item of Object.values(result)) {
      item.source ??= "builtin"
    }

    for (const [key, value] of Object.entries(cfg.agent ?? {})) {
      if (value.disable) {
        delete result[key]
        continue
      }
      let item = result[key]
      if (!item)
        item = result[key] = {
          name: key,
          mode: "all",
          permission: PermissionNext.merge(defaults, user),
          options: {},
          native: false,
          source: "config",
        }
      if (value.modelRole) {
        item.modelRole = value.modelRole
        item.model = role(value.modelRole)
        item.modelSource = "role"
      }
      if (value.model) {
        item.model = Provider.parseModel(value.model)
        item.modelSource = "explicit"
      }
      item.prompt = value.prompt ?? item.prompt
      item.description = value.description ?? item.description
      item.temperature = value.temperature ?? item.temperature
      item.topP = value.top_p ?? item.topP
      item.mode = value.mode ?? item.mode
      item.hidden = value.hidden ?? item.hidden
      item.name = value.name ?? item.name
      item.color = value.color ?? item.color
      item.steps = value.steps ?? item.steps
      item.options = mergeDeep(item.options, value.options ?? {})
      item.permission = PermissionNext.merge(item.permission, PermissionNext.fromConfig(value.permission ?? {}))
      item.defaultVariant = value.defaultVariant ?? item.defaultVariant
      if (value.controlProfile !== undefined) item.controlProfile = value.controlProfile as Agent.Info["controlProfile"]
    }

    // Merge plugin-contributed agents (lower priority than config agents)
    const pluginAgents = await Plugin.agentEntries()
    for (const [key, agent] of Object.entries(pluginAgents)) {
      if (result[key]) {
        log.info("plugin agent skipped, name already exists", { name: key })
        continue
      }
      result[key] = {
        name: agent.name,
        description: agent.description,
        prompt: agent.prompt,
        mode: agent.mode ?? "all",
        permission: PermissionNext.merge(defaults, user, PermissionNext.fromConfig(agent.permission ?? {})),
        options: {},
        native: false,
        source: "plugin",
        ...(agent.modelRole
          ? { modelRole: agent.modelRole, model: role(agent.modelRole), modelSource: "role" as const }
          : {}),
        ...(agent.model ? { model: Provider.parseModel(agent.model), modelSource: "explicit" as const } : {}),
        temperature: agent.temperature,
        topP: agent.topP,
        steps: agent.steps,
        hidden: agent.hidden,
        color: agent.color,
      }
    }

    for (const [name, item] of Object.entries(result)) {
      // Skip agents that explicitly deny memory_write/memory_edit (e.g. synergy-max).
      // The blanket allow-patch uses PermissionNext.merge() which appends rules, and
      // PermissionNext.evaluate() uses findLast() — so this patch would silently
      // override any explicit "deny" configured in the agent's own permission builder.
      const hasExplicitMemoryDeny = item.permission.some(
        (r) => (r.permission === "memory_write" || r.permission === "memory_edit") && r.action === "deny",
      )
      if (hasExplicitMemoryDeny) continue

      if (item.mode === "primary" && item.hidden !== true) {
        item.permission = PermissionNext.merge(
          item.permission,
          PermissionNext.fromConfig({
            memory_write: "allow",
            memory_edit: "allow",
          }),
        )
      }
    }

    // Ensure Truncate.DIR is allowed unless explicitly configured

    for (const name in result) {
      const agent = result[name]
      const explicit = agent.permission.some(
        (r) => r.permission === "external_directory" && r.pattern === Truncate.DIR && r.action === "deny",
      )
      if (explicit) continue

      result[name].permission = PermissionNext.merge(
        result[name].permission,
        PermissionNext.fromConfig({ external_directory: { [Truncate.DIR]: "allow" } }),
      )
    }

    // Discover and register external agents
    const externalConfig = cfg.external_agent ?? {}
    const externalDescriptions: Record<string, string> = {
      codex:
        "OpenAI Codex agent. Strong at autonomous multi-step coding: implementing features, debugging, refactoring, and running shell commands. Best when the task is well-scoped and implementation-focused.",
      "claude-code":
        "Anthropic Claude Code agent. Excels at complex reasoning, nuanced code review, large-scale refactoring, and tasks requiring deep understanding of codebases. Supports extended thinking for hard problems.",
      openclaw:
        "OpenClaw multi-model agent platform. Versatile generalist with 39+ built-in tools including web search, browser, image generation, and multi-provider model routing. Good for tasks that need diverse tool access beyond pure coding.",
    }
    try {
      await import("@/external-agent/adapter/codex")
      await import("@/external-agent/adapter/claude-code")
      await import("@/external-agent/adapter/openclaw")
    } catch (e) {
      log.warn("failed to import external agent adapters", { error: String(e) })
    }
    const discovered = await ExternalAgentDiscovery.discover()
    log.info("external agent discovery results", {
      discovered: [...discovered.keys()],
    })
    for (const [name, info] of discovered) {
      const overrides = externalConfig[name]
      if (overrides?.disabled) {
        log.info("external agent disabled by config", { name })
        continue
      }
      if (overrides?.auto_discover === false) {
        log.info("external agent auto_discover disabled", { name })
        continue
      }
      const { disabled: _, path, model, auto_discover: __, ...adapterConfig } = overrides ?? {}
      const externalField = {
        adapter: info.adapter,
        path: path ?? info.path,
        version: info.version,
        config: {
          ...(model ? { model } : {}),
          ...adapterConfig,
        },
      }
      if (result[name]) {
        // Merge external info into existing agent entry
        log.info("merging external agent into existing agent", { name })
        result[name].external = externalField
      } else {
        result[name] = {
          name,
          description: externalDescriptions[name] ?? `External agent: ${name}`,
          mode: "all",
          native: false,
          permission: PermissionNext.merge(defaults, user),
          options: {},
          external: externalField,
          source: "external",
        }
      }
    }

    const agentInfos = Object.values(result).map((agent) => ({
      name: agent.name,
      description: agent.description ?? "",
      mode: agent.mode,
      hidden: agent.hidden,
      visibleTo: agent.visibleTo,
    }))
    if (result.synergy) result.synergy.prompt = buildSynergyPrompt(agentInfos)
    if (result["synergy-max"]) result["synergy-max"].prompt = buildSynergyMaxPrompt(agentInfos)
    if (result.supervisor) result.supervisor.prompt = buildSupervisorPrompt(agentInfos)

    return result
  })

  export async function reload() {
    log.info("reloading agent state")
    await state.resetAll()
    log.info("agent state reloaded")
  }

  export async function get(agent: string) {
    return state().then((x) => x[agent])
  }

  export async function getAvailableModel(agent: Info): Promise<{ providerID: string; modelID: string } | undefined> {
    if (!agent.model) return undefined
    const available = await Provider.isModelAvailable(agent.model)
    return available ? agent.model : undefined
  }

  export async function list() {
    const cfg = await Config.current()
    return pipe(
      await state(),
      values(),
      sortBy([(x) => (cfg.default_agent ? x.name === cfg.default_agent : x.name === "synergy"), "desc"]),
    )
  }

  export async function modelRoleSummaries(): Promise<ModelRoleSummary[]> {
    const cfg = await Config.current()
    const agents = await list()

    return MODEL_ROLE_DEFINITIONS.map((definition) => {
      const fallbackChain = (
        definition.role ? Provider.getRoleFallbackChain(definition.role) : [definition.field]
      ) as Array<z.infer<typeof ModelRoleField>>
      const configuredModel = parseConfigModel(cfg[definition.field])
      const resolvedModel = resolveSummaryModel(cfg, definition.role, fallbackChain)
      const usedBy = agents
        .filter((agent) =>
          definition.role ? agent.modelRole === definition.role : !agent.modelRole && agent.modelSource !== "explicit",
        )
        .map((agent) => ({
          name: agent.name,
          description: agent.description,
          mode: agent.mode,
          hidden: agent.hidden,
          visibleTo: agent.visibleTo,
          native: agent.native,
          source: agent.source,
          modelSource: agent.modelSource,
          model: agent.model,
          defaultVariant:
            agent.defaultVariant ?? (agent.modelRole ? (cfg.role_variant as any)?.[agent.modelRole] : undefined),
        }))

      return {
        id: definition.id,
        role: definition.role,
        field: definition.field,
        label: definition.label,
        summary: definition.summary,
        fallbackChain,
        configuredModel,
        resolvedModel,
        usedBy,
        requiresExplicitModel: definition.requiresExplicitModel,
        disabledReason: definition.requiresExplicitModel && !resolvedModel ? definition.disabledReason : undefined,
      }
    })
  }

  function parseConfigModel(value: unknown): { providerID: string; modelID: string } | undefined {
    if (typeof value !== "string" || !value) return undefined
    return Provider.parseModel(value)
  }

  function resolveSummaryModel(
    cfg: Config.Info,
    role: ModelRoleType | undefined,
    fallbackChain: Array<z.infer<typeof ModelRoleField>>,
  ): ({ providerID: string; modelID: string } & { via: z.infer<typeof ModelRoleField> }) | undefined {
    for (const field of fallbackChain) {
      const model = parseConfigModel(cfg[field])
      if (model) return { ...model, via: field }
    }
    if (!role) return undefined
    const resolved = Provider.resolveRoleModelSync(cfg, role)
    if (!resolved) return undefined
    return { ...resolved, via: fallbackChain[0] }
  }

  export async function defaultAgent() {
    return (await list())[0]?.name
  }

  export async function generate(input: { description: string; model?: { providerID: string; modelID: string } }) {
    const agent = await get("agent-generator")
    if (!agent) throw new Error("agent-generator agent is unavailable")

    const agentModel = input.model ?? (await getAvailableModel(agent)) ?? (await Provider.defaultModel())
    const model = await Provider.getModel(agentModel.providerID, agentModel.modelID)
    const sessionID = Identifier.ascending("session")
    const user: MessageV2.User = {
      id: Identifier.ascending("message"),
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: agent.name,
      model: { providerID: model.providerID, modelID: model.id },
    }
    const existing = await list()
    const result = await LLM.stream({
      agent,
      user,
      tools: {},
      model,
      small: true,
      messages: [
        {
          role: "user",
          content: `Create an agent configuration based on this request: \"${input.description}\".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
        },
      ],
      abort: AbortSignal.timeout(30_000),
      sessionID,
      system: [],
      retries: 1,
    })
    const text = (await result.text.catch(() => "")) ?? ""
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) throw new Error("agent generator did not return JSON")
    return z
      .object({
        identifier: z.string(),
        whenToUse: z.string(),
        systemPrompt: z.string(),
      })
      .parse(JSON.parse(match[0]))
  }
}
