import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import z from "zod"
import { Config } from "../config/config"
import { Instance } from "../scope/instance"
import { Identifier } from "../id/id"
import PROMPT_INITIALIZE from "./command-template/initialize.txt"
import PROMPT_REVIEW from "./command-template/review.txt"
import PROMPT_COMMIT from "./command-template/commit.txt"
import PROMPT_RMSLOP from "./command-template/rmslop.txt"
import { MCP } from "../mcp"
import { Log } from "@/util/log"

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

  export const Info = z
    .object({
      name: z.string(),
      description: z.string().optional(),
      agent: z.string().optional(),
      model: z.string().optional(),
      mcp: z.boolean().optional(),
      // workaround for zod not supporting async functions natively so we use getters
      // https://zod.dev/v4/changelog?id=zfunction
      template: z.promise(z.string()).or(z.string()),
      hints: z.array(z.string()),
    })
    .meta({
      ref: "Command",
    })

  // for some reason zod is inferring `string` for z.promise(z.string()).or(z.string()) so we have to manually override it
  export type Info = Omit<z.infer<typeof Info>, "template"> & { template: Promise<string> | string }

  export function hints(template: string): string[] {
    const result: string[] = []
    const numbered = template.match(/\$\d+/g)
    if (numbered) {
      for (const match of [...new Set(numbered)].sort()) result.push(match)
    }
    if (template.includes("$ARGUMENTS")) result.push("$ARGUMENTS")
    return result
  }

  export const Default = {
    INIT: "init",
    REVIEW: "review",
    COMMIT: "commit",
    RMSLOP: "rmslop",
  } as const

  const subscriptions = Instance.state(
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
      for (const unsubscribe of unsubscribers) {
        unsubscribe()
      }
    },
  )

  function registerMcpSubscriptions() {
    subscriptions()
  }

  const state = Instance.state(async () => {
    const cfg = await Config.get()

    const result: Record<string, Info> = {
      [Default.INIT]: {
        name: Default.INIT,
        description: "create/update AGENTS.md",
        get template() {
          return PROMPT_INITIALIZE.replace("${path}", Instance.directory)
        },
        hints: hints(PROMPT_INITIALIZE),
      },
      [Default.REVIEW]: {
        name: Default.REVIEW,
        description: "review changes [commit|branch|pr], defaults to uncommitted",
        get template() {
          return PROMPT_REVIEW.replace("${path}", Instance.directory)
        },
        hints: hints(PROMPT_REVIEW),
      },
      [Default.COMMIT]: {
        name: Default.COMMIT,
        description: "stage, commit, and push changes with a well-crafted message",
        get template() {
          return PROMPT_COMMIT
        },
        hints: hints(PROMPT_COMMIT),
      },
      [Default.RMSLOP]: {
        name: Default.RMSLOP,
        description: "remove AI-generated code slop from recent changes",
        get template() {
          return PROMPT_RMSLOP
        },
        hints: hints(PROMPT_RMSLOP),
      },
    }

    for (const [name, command] of Object.entries(cfg.command ?? {})) {
      result[name] = {
        name,
        agent: command.agent,
        model: command.model,
        description: command.description,
        get template() {
          return command.template
        },
        hints: hints(command.template),
      }
    }
    for (const [name, prompt] of Object.entries(await MCP.prompts())) {
      result[name] = {
        name,
        mcp: true,
        description: prompt.description,
        get template() {
          // since a getter can't be async we need to manually return a promise here
          return new Promise<string>(async (resolve, reject) => {
            const template = await MCP.getPrompt(
              prompt.client,
              prompt.name,
              prompt.arguments
                ? // substitute each argument with $1, $2, etc.
                  Object.fromEntries(prompt.arguments?.map((argument, i) => [argument.name, `$${i + 1}`]))
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
      }
    }

    return result
  })

  export async function reload() {
    registerMcpSubscriptions()
    log.info("reloading command state")
    await state.reset()
    log.info("command state reloaded")
  }

  export async function get(name: string) {
    registerMcpSubscriptions()
    return state().then((x) => x[name])
  }

  export async function list() {
    registerMcpSubscriptions()
    return state().then((x) => Object.values(x))
  }
}
