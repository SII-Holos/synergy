import { Config } from "../config/config"
import z from "zod"
import { Provider } from "../provider/provider"
import { generateObject, type ModelMessage } from "ai"
import { SystemPrompt } from "../session/system"
import { ScopeContext } from "../scope/context"
import { ScopedState } from "../scope/scoped-state"
import { Truncate } from "../tool/truncation"

import PROMPT_GENERATE from "./generate.txt"
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

export namespace Agent {
  const log = Log.create({ service: "agent" })

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
      prompt: z.string().optional(),
      options: z.record(z.string(), z.any()),
      steps: z.number().int().positive().optional(),
      external: ExternalAgent.Info.optional(),
    })
    .meta({
      ref: "Agent",
    })
  export type Info = z.infer<typeof Info>

  const state = ScopedState.create(async () => {
    const cfg = await Config.current()
    const evolutionActive =
      ((cfg as any).engram?.memory?.enabled ?? true) && (cfg as any).engram?.experience?.encode !== false
    const role = (r: Provider.ModelRole) => Provider.resolveRoleModelSync(cfg, r)

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
        }
      if (value.model) item.model = Provider.parseModel(value.model)
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
        ...(agent.model ? { model: Provider.parseModel(agent.model) } : {}),
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

  export async function defaultAgent() {
    return (await list())[0]?.name
  }

  export async function generate(input: { description: string; model?: { providerID: string; modelID: string } }) {
    const cfg = await Config.current()
    const defaultModel = input.model ?? (await Provider.defaultModel())
    const model = await Provider.getModel(defaultModel.providerID, defaultModel.modelID)
    const language = await Provider.getLanguage(model)
    const system: string[] = []
    system.push(PROMPT_GENERATE)
    const existing = await list()
    const result = await generateObject({
      experimental_telemetry: {
        isEnabled: cfg.experimental?.openTelemetry,
        metadata: {
          userId: cfg.username ?? "unknown",
        },
      },
      temperature: 0.3,
      messages: [
        ...system.map(
          (item): ModelMessage => ({
            role: "system",
            content: item,
          }),
        ),
        {
          role: "user",
          content: `Create an agent configuration based on this request: \"${input.description}\".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
        },
      ],
      model: language,
      schema: z.object({
        identifier: z.string(),
        whenToUse: z.string(),
        systemPrompt: z.string(),
      }),
    })
    return result.object
  }
}
