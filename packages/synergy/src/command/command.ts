import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Log } from "@/util/log"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import z from "zod"
import { Config } from "../config/config"
import { ConfigMarkdown } from "../config/markdown"
import { Identifier } from "../id/id"
import { MCP } from "../mcp"
import { ScopeContext } from "../scope/context"
import { ScopedState } from "../scope/scoped-state"
import { Skill } from "../skill/skill"
import PROMPT_COMMIT from "./template/commit.txt"
import PROMPT_INITIALIZE from "./template/initialize.txt"
import PROMPT_REVIEW from "./template/review.txt"
import PROMPT_RMSLOP from "./template/rmslop.txt"

export namespace Command {
  const log = Log.create({ service: "command" })

  export const Event = {
    Executed: BusEvent.define(
      "command.executed",
      z.object({
        name: z.string(),
        sessionID: Identifier.schema("session"),
        arguments: z.string(),
        messageID: Identifier.schema("message"),
      }),
    ),
  }

  export const Kind = z.enum(["prompt", "action"])
  export type Kind = z.infer<typeof Kind>

  export const Surface = z.enum(["web", "cli", "channel"])
  export type Surface = z.infer<typeof Surface>

  export const Result = z
    .object({
      title: z.string(),
      output: z.string(),
      metadata: z.record(z.string(), z.any()).optional(),
    })
    .meta({ ref: "CommandResult" })
  export type Result = z.infer<typeof Result>

  export const Info = z
    .object({
      name: z.string(),
      description: z.string().optional(),
      kind: Kind.default("prompt"),
      surfaces: z.array(Surface).default(["web", "cli"]),
      promptVisible: z.boolean().default(true),
      agent: z.string().optional(),
      model: z.string().optional(),
      mcp: z.boolean().optional(),
      source: z.enum(["command", "mcp", "skill"]).optional(),
      action: z.string().optional(),
      // Runtime command templates can be lazy because MCP prompts and file-backed
      // skills are resolved only when executed. The API shape is normalized by
      // callers before it reaches clients.
      template: z.promise(z.string()).or(z.string()).optional(),
      hints: z.array(z.string()),
    })
    .meta({ ref: "Command" })

  export type Info = Omit<z.infer<typeof Info>, "template"> & { template?: Promise<string> | string }

  export type ActionInput = {
    messageID?: string
    sessionID: string
    agent?: string
    model?: string
    arguments: string
    command: string
    variant?: string
    parts?: unknown[]
  }

  export type ActionHandler = (input: ActionInput, command: Info) => Promise<Result>

  export const NotFoundError = NamedError.create("CommandNotFoundError", z.object({ name: z.string() }))
  export const UnknownActionError = NamedError.create("CommandUnknownActionError", z.object({ action: z.string() }))

  const actionHandlers = new Map<string, ActionHandler>()

  export function registerAction(action: string, handler: ActionHandler) {
    actionHandlers.set(action, handler)
    return () => {
      if (actionHandlers.get(action) === handler) actionHandlers.delete(action)
    }
  }

  export async function runAction(input: { action: string; input: ActionInput; command?: Info }) {
    const handler = actionHandlers.get(input.action)
    if (!handler) throw new UnknownActionError({ action: input.action })
    const command =
      input.command ??
      actionCommand({
        name: input.input.command,
        action: input.action,
        hints: [],
      })
    return handler(input.input, command)
  }

  export function hints(template: string): string[] {
    const result: string[] = []
    const numbered = template.match(/\$\d+/g)
    if (numbered) {
      for (const match of [...new Set(numbered)].sort()) result.push(match)
    }
    if (template.includes("$ARGUMENTS")) result.push("$ARGUMENTS")
    return result
  }

  function promptCommand(input: Omit<Info, "kind" | "surfaces" | "promptVisible">): Info {
    return { ...input, kind: "prompt", surfaces: ["web", "cli"], promptVisible: true }
  }

  function actionCommand(input: Omit<Info, "kind" | "surfaces" | "promptVisible">): Info {
    return { ...input, kind: "action", surfaces: ["web", "cli"], promptVisible: false }
  }

  export const Default = {
    INIT: "init",
    REVIEW: "review",
    COMMIT: "commit",
    RMSLOP: "rmslop",
    WORKTREE: "worktree",
  } as const

  const subscriptions = ScopedState.create(
    () => {
      const unsubscribers: Array<() => void> = []
      const reset = () => {
        void reload().catch((error) => {
          log.warn("failed to reload command state after MCP change", {
            error: error instanceof Error ? error.message : String(error),
          })
        })
      }

      unsubscribers.push(Bus.subscribe(MCP.ToolsChanged, reset))
      unsubscribers.push(Bus.subscribe(MCP.PromptsChanged, reset))
      unsubscribers.push(Bus.subscribe(MCP.Ready, reset))

      return unsubscribers
    },
    async (unsubscribers) => {
      for (const unsubscribe of unsubscribers) unsubscribe()
    },
  )

  function registerMcpSubscriptions() {
    subscriptions()
  }

  const state = ScopedState.create(async () => {
    const cfg = await Config.current()

    const result: Record<string, Info> = {
      [Default.INIT]: promptCommand({
        name: Default.INIT,
        description: "create/update AGENTS.md",
        get template() {
          return PROMPT_INITIALIZE.replace("${path}", ScopeContext.current.directory)
        },
        hints: hints(PROMPT_INITIALIZE),
      }),
      [Default.REVIEW]: promptCommand({
        name: Default.REVIEW,
        description: "review changes [commit|branch|pr], defaults to uncommitted",
        get template() {
          return PROMPT_REVIEW.replace("${path}", ScopeContext.current.directory)
        },
        hints: hints(PROMPT_REVIEW),
      }),
      [Default.COMMIT]: promptCommand({
        name: Default.COMMIT,
        description: "stage, commit, and push changes with a well-crafted message",
        get template() {
          return PROMPT_COMMIT
        },
        hints: hints(PROMPT_COMMIT),
      }),
      [Default.RMSLOP]: promptCommand({
        name: Default.RMSLOP,
        description: "remove AI-generated code slop from recent changes",
        get template() {
          return PROMPT_RMSLOP
        },
        hints: hints(PROMPT_RMSLOP),
      }),
      [Default.WORKTREE]: actionCommand({
        name: Default.WORKTREE,
        description: "manage this session's git worktree workspace: list, new, enter, status, leave, remove",
        hints: ["list | new <name> | enter <name> | status | leave | remove <name>"],
        action: "worktree",
      }),
    }

    for (const [name, command] of Object.entries(cfg.command ?? {})) {
      result[name] = promptCommand({
        name,
        agent: command.agent,
        model: command.model,
        description: command.description,
        get template() {
          return command.template
        },
        hints: hints(command.template),
      })
    }

    for (const [name, prompt] of Object.entries(await MCP.prompts())) {
      result[name] = promptCommand({
        name,
        mcp: true,
        source: "mcp",
        description: prompt.description,
        get template() {
          return new Promise<string>(async (resolve, reject) => {
            const template = await MCP.getPrompt(
              prompt.client,
              prompt.name,
              prompt.arguments
                ? Object.fromEntries(prompt.arguments?.map((argument, i) => [argument.name, `$${i + 1}`]))
                : {},
            ).catch(reject)
            resolve(
              template?.messages
                .map((message) => (message.content.type === "text" ? message.content.text : ""))
                .join("\n") || "",
            )
          })
        },
        hints: prompt.arguments?.map((_, i) => `$${i + 1}`) ?? [],
      })
    }

    for (const skill of await Skill.all()) {
      if (result[skill.name]) continue
      result[skill.name] = promptCommand({
        name: skill.name,
        description: skill.description,
        source: "skill",
        get template() {
          if (skill.content) return skill.content
          if (!skill.entryFile) return ""
          return ConfigMarkdown.parse(skill.entryFile).then((md) => md?.content ?? "")
        },
        hints: [],
      })
    }

    return result
  })

  export async function reload() {
    registerMcpSubscriptions()
    log.info("reloading command state")
    await state.resetAll()
    log.info("command state reloaded")
  }

  export async function get(name: string) {
    registerMcpSubscriptions()
    return state().then((x) => x[name])
  }

  export async function require(name: string) {
    const command = await get(name)
    if (!command) throw new NotFoundError({ name })
    return command
  }

  export async function list() {
    registerMcpSubscriptions()
    return state().then((x) => Object.values(x))
  }
}
