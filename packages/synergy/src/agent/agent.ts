import { Config } from "../config/config"
import z from "zod"
import { Provider } from "../provider/provider"
import { generateObject, type ModelMessage } from "ai"
import { SystemPrompt } from "../session/system"
import { Instance } from "../scope/instance"
import { Truncate } from "../tool/truncation"

import PROMPT_GENERATE from "./generate.txt"
import { buildCompactionPrompt } from "./prompt/compaction/builder"
import PROMPT_CHRONICLER from "./prompt/chronicler.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TITLE from "./prompt/title.txt"
import { buildMasterPrompt } from "./prompt/master/builder"
import { buildSynergyPrompt } from "./prompt/synergy/builder"

import { buildScribePrompt } from "./prompt/scribe/builder"
import PROMPT_MULTIMODAL_LOOKER from "./prompt/multimodal-looker.txt"
import PROMPT_SCOUT from "./prompt/scout.txt"
import PROMPT_ADVISOR from "./prompt/advisor.txt"
import { buildScholarPrompt } from "./prompt/scholar/builder"
import PROMPT_INTENT from "./prompt/intent.txt"
import PROMPT_REWARD from "./prompt/reward.txt"
import PROMPT_SCRIPT from "./prompt/script.txt"
import PROMPT_GENESIS from "./prompt/genesis.txt"
import PROMPT_ANIMA from "./prompt/anima.txt"

import { PermissionNext } from "@/permission/next"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import { Log } from "@/util/log"
import { ExternalAgent } from "@/external-agent/bridge"
import { ExternalAgentDiscovery } from "@/external-agent/discovery"

export namespace Agent {
  const log = Log.create({ service: "agent" })

  export const Info = z
    .object({
      name: z.string(),
      description: z.string().optional(),
      mode: z.enum(["subagent", "primary", "all"]),
      native: z.boolean().optional(),
      hidden: z.boolean().optional(),
      topP: z.number().optional(),
      temperature: z.number().optional(),
      color: z.string().optional(),
      permission: PermissionNext.Ruleset,
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

  const state = Instance.state(async () => {
    const cfg = await Config.get()
    const evo = Config.resolveEvolution(cfg.identity?.evolution)
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

    const result: Record<string, Info> = {
      synergy: {
        name: "synergy",
        description:
          "General-purpose orchestrator agent that plans, coordinates, executes, and verifies. Handles any task: coding, research, writing, analysis, or multi-domain work. Uses DAG-based planning for dependency tracking and parallel execution. Best for complex work that spans multiple domains or requires coordinated multi-agent effort.",
        prompt: "", // Will be set after all agents are defined via buildSynergyPrompt
        options: {},
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            question: "allow",
            arxiv_search: "allow",
            arxiv_download: "allow",
            runtime_reload: "allow",
            dagwrite: "allow",
            dagread: "allow",
            dagpatch: "allow",
            todowrite: "deny",
            todoread: "deny",
            memory_write: "allow",

            memory_edit: "allow",
            ...(evo.active ? {} : { memory_search: "deny", memory_get: "deny" }),
          }),
          user,
        ),
        mode: "all",
        native: true,
      },
      master: {
        name: "master",
        description:
          "General-purpose coding agent for executing tasks directly and efficiently. Handles implementation, debugging, refactoring, and multi-step development work. Can run in parallel for independent tasks. Use when you need straightforward task execution.",
        prompt: buildMasterPrompt(),
        options: {},
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            question: "allow",
            runtime_reload: "allow",
            memory_write: "allow",
            memory_edit: "allow",
            ...(evo.active ? {} : { memory_search: "deny", memory_get: "deny" }),
          }),
          user,
        ),
        mode: "all",
        native: true,
      },
      scholar: {
        name: "scholar",
        description:
          "Academic research agent for scholarly work. Searches arXiv and academic databases, analyzes papers, explains concepts, critically evaluates research, supports academic writing, and helps plan research. Use for literature surveys, understanding complex topics, methodology guidance, or any task involving academic knowledge.",
        prompt: buildScholarPrompt(),
        options: {},
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            question: "allow",
            arxiv_search: "allow",
            arxiv_download: "allow",
            memory_write: "allow",
            memory_edit: "allow",
            ...(evo.active ? {} : { memory_search: "deny", memory_get: "deny" }),
          }),
          user,
        ),
        mode: "all",
        native: true,
      },
      scribe: {
        name: "scribe",
        description: `Expert writing agent for crafting compelling documents. Use this agent for writing documentation, reports, guides, proposals, or any content that needs narrative flow, varied structure, and clear hierarchy. Produces engaging writing that humans actually want to read.`,
        prompt: buildScribePrompt(),
        options: {},
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            question: "allow",
            runtime_reload: "deny",
            memory_write: "allow",
            memory_edit: "allow",
            ...(evo.active ? {} : { memory_search: "deny", memory_get: "deny" }),
            skill: {
              "agent-browser": "allow",
              "frontend-design": "deny",
              "git-guide": "deny",
              "skill-creator": "deny",
            },
          }),
          user,
        ),
        mode: "all",
        native: true,
      },
      explore: {
        name: "explore",
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            read: "allow",
            lookat: "allow",
            grep: "allow",
            ast_grep: "allow",
            glob: "allow",
            list: "allow",
            bash: "allow",
            websearch: "allow",
            webfetch: "allow",
            runtime_reload: "deny",
            skill: {
              "agent-browser": "allow",
              "frontend-design": "deny",
              "git-guide": "deny",
              "skill-creator": "deny",
            },
            external_directory: {
              "*": "ask",
              [Truncate.DIR]: "allow",
            },
          }),
          user,
        ),
        description: `Fast agent specialized for exploring codebases. Use this when you are doing an open-ended search that may require multiple rounds of globbing and grepping. Answers "Where is X?", "Which files contain Y?", "Find the code that does Z". Fire multiple explore agents in parallel for broad searches across different areas. When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.`,
        prompt: PROMPT_EXPLORE,
        options: {},
        mode: "subagent",
        native: true,
        model: role("mid"),
      },
      "multimodal-looker": {
        name: "multimodal-looker",
        prompt: PROMPT_MULTIMODAL_LOOKER,
        options: {},
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            skill: { "*": "deny" },
            external_directory: { "*": "allow" },
          }),
          user,
        ),
        mode: "primary",
        native: true,
        hidden: true,
        model: role("vision"),
      },
      scout: {
        name: "scout",
        description:
          "Search external technical documentation and open-source code. Use for finding official docs, GitHub examples, library APIs, and best practices for external dependencies. Answers questions like 'How do I use X?', 'What's the API for Y?', or 'Show me examples of Z'.",
        prompt: PROMPT_SCOUT,
        options: {},
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            read: "allow",
            lookat: "allow",
            grep: "allow",
            ast_grep: "allow",
            glob: "allow",
            list: "allow",
            bash: "allow",
            websearch: "allow",
            webfetch: "allow",
            skill: {
              "agent-browser": "allow",
              "frontend-design": "deny",
              "git-guide": "allow",
              "skill-creator": "deny",
            },
            external_directory: {
              "*": "ask",
              [Truncate.DIR]: "allow",
            },
          }),
          user,
        ),
        mode: "subagent",
        native: true,
        model: role("mid"),
      },
      advisor: {
        name: "advisor",
        description:
          "Read-only strategic advisor for complex architectural decisions, debugging hard problems, and code review. Consult when: 2+ fix attempts failed, unfamiliar code patterns, security/performance concerns, multi-system tradeoffs, or after completing significant work for review.",
        prompt: PROMPT_ADVISOR,
        options: {},
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            read: "allow",
            lookat: "allow",
            grep: "allow",
            ast_grep: "allow",
            glob: "allow",
            list: "allow",
            bash: "allow",
            websearch: "allow",
            webfetch: "allow",
            skill: {
              "agent-browser": "allow",
              "frontend-design": "allow",
              "git-guide": "allow",
              "skill-creator": "allow",
            },
            external_directory: {
              "*": "ask",
              [Truncate.DIR]: "allow",
            },
          }),
          user,
        ),
        mode: "subagent",
        native: true,
        model: role("thinking"),
      },
      compaction: {
        name: "compaction",
        mode: "primary",
        native: true,
        hidden: true,
        prompt: buildCompactionPrompt(),
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            session_list: "allow",
            session_read: "allow",
            session_send: "allow",
          }),
          user,
        ),
        options: {},
        model: role("long"),
      },
      chronicler: {
        name: "chronicler",
        mode: "primary",
        native: true,
        hidden: true,
        prompt: PROMPT_CHRONICLER,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            read: "allow",
            grep: "allow",
            glob: "allow",
            memory_write: "allow",
            memory_edit: "allow",
            memory_search: "allow",
            memory_get: "allow",
            note_list: "allow",
            note_read: "allow",
            note_search: "allow",
            note_write: "allow",
            profile_get: "allow",
            profile_update: "allow",
            session_list: "allow",
            session_read: "allow",
            session_send: "allow",
          }),
          user,
        ),
        options: {},
        model: role("long"),
      },
      title: {
        name: "title",
        mode: "primary",
        options: {},
        native: true,
        hidden: true,
        temperature: 0.5,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
          }),
          user,
        ),
        prompt: PROMPT_TITLE,
        model: role("nano"),
      },
      summary: {
        name: "summary",
        mode: "primary",
        options: {},
        native: true,
        hidden: true,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
          }),
          user,
        ),
        prompt: PROMPT_SUMMARY,
        model: role("nano"),
      },
      intent: {
        name: "intent",
        mode: "primary",
        options: {},
        native: true,
        hidden: true,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
          }),
          user,
        ),
        prompt: PROMPT_INTENT,
        model: role("mini"),
      },
      script: {
        name: "script",
        mode: "primary",
        options: {},
        native: true,
        hidden: true,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
          }),
          user,
        ),
        prompt: PROMPT_SCRIPT,
        model: role("mini"),
      },
      reward: {
        name: "reward",
        mode: "primary",
        options: {},
        native: true,
        hidden: true,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
          }),
          user,
        ),
        prompt: PROMPT_REWARD,
        model: role("mini"),
      },
      genesis: {
        name: "genesis",
        mode: "primary",
        native: true,
        hidden: true,
        temperature: 0.7,
        prompt: PROMPT_GENESIS,
        model: role("mini"),
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            memory_write: "allow",
            memory_edit: "allow",
            memory_search: "allow",
            memory_get: "allow",
            profile_get: "allow",
            profile_update: "allow",
          }),
          user,
        ),
        options: {},
      },
      anima: {
        name: "anima",
        description:
          "Autonomous inner self that runs periodic routines — reflects on recent activity, organizes knowledge, plans agenda tasks, engages with the community on Agora, and explores the web to learn. Not a user-facing agent; runs as a background daily routine.",
        prompt: PROMPT_ANIMA,
        mode: "primary",
        native: true,
        hidden: true,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "allow",
            question: "deny",
            todowrite: "deny",
            todoread: "deny",
            read: "allow",
            edit: "allow",
            write: "allow",
            arxiv_search: "allow",
            arxiv_download: "allow",
            external_directory: {
              "*": "allow",
            },
          }),
          user,
        ),
        options: {},
      },
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
    }

    for (const item of Object.values(result)) {
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

    // Build synergy prompt dynamically based on available agents
    if (result.synergy) {
      const agentInfos = Object.values(result).map((a) => ({
        name: a.name,
        description: a.description ?? "",
        mode: a.mode,
        hidden: a.hidden,
      }))
      result.synergy.prompt = buildSynergyPrompt(agentInfos)
    }

    // Discover and register external agents
    const externalConfig = cfg.external_agent ?? {}
    try {
      await import("@/external-agent/adapter/codex")
    } catch (e) {
      log.warn("failed to import codex adapter", { error: String(e) })
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
          description: `External agent: ${name}`,
          mode: "all",
          native: false,
          permission: PermissionNext.merge(defaults, user),
          options: {},
          external: externalField,
        }
      }
    }

    return result
  })

  export async function reload() {
    log.info("reloading agent state")
    await state.reset()
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
    const cfg = await Config.get()
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
    const cfg = await Config.get()
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
