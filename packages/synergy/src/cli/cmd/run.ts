import type { Argv } from "yargs"
import { pathToFileURL } from "url"
import path from "path"
import { UI } from "../../util/ui"
import { cmd } from "./cmd"
import { Flag } from "../../flag/flag"
import { withScopeContext } from "../scope"
import { Command } from "../../command/command"
import { EOL } from "os"
import { select } from "@clack/prompts"
import { createSynergyClient, type ControlProfileId, type SynergyClient } from "@ericsanchezok/synergy-sdk"
import { Server } from "../../server/server"
import { runMigrations } from "../../migration"
import { Provider } from "../../provider/provider"
import { readPipedStdin } from "../stdin"
import { waitForLightLoopFinish } from "../lightloop"

const TOOL: Record<string, [string, string]> = {
  todowrite: ["Todo", UI.Style.TEXT_WARNING_BOLD],
  todoread: ["Todo", UI.Style.TEXT_WARNING_BOLD],
  dagwrite: ["DAG", UI.Style.TEXT_WARNING_BOLD],
  dagread: ["DAG", UI.Style.TEXT_WARNING_BOLD],
  dagpatch: ["DAG", UI.Style.TEXT_WARNING_BOLD],
  bash: ["Bash", UI.Style.TEXT_DANGER_BOLD],
  edit: ["Edit", UI.Style.TEXT_SUCCESS_BOLD],
  glob: ["Glob", UI.Style.TEXT_INFO_BOLD],
  grep: ["Grep", UI.Style.TEXT_INFO_BOLD],
  list: ["List", UI.Style.TEXT_INFO_BOLD],
  read: ["Read", UI.Style.TEXT_HIGHLIGHT_BOLD],
  write: ["Write", UI.Style.TEXT_SUCCESS_BOLD],
}

function isControlProfileId(value: string | undefined): value is ControlProfileId {
  return value === "guarded" || value === "autonomous" || value === "full_access"
}

async function effectiveControlProfile(sdk: SynergyClient): Promise<ControlProfileId | undefined> {
  return sdk.controlProfile
    .effective()
    .then((result) => {
      const profile = result.data?.profileId
      return isControlProfileId(profile) ? profile : undefined
    })
    .catch(() => undefined)
}

async function createSendSession(sdk: SynergyClient, title?: string) {
  const controlProfile = await effectiveControlProfile(sdk)
  return sdk.session.create({
    ...(title ? { title } : {}),
    workspace: { mode: "current" },
    ...(controlProfile ? { controlProfile } : {}),
  })
}

async function resolveSendSessionID(input: {
  sdk: SynergyClient
  continueLast?: boolean
  sessionID?: string
  title?: string
  message: string
}) {
  if (input.continueLast) {
    const result = await input.sdk.session.list()
    const sessions = result.data?.data ?? []
    return sessions.find((session) => !session.parentID)?.id
  }
  if (input.sessionID) return input.sessionID

  const title =
    input.title !== undefined
      ? input.title === ""
        ? input.message.slice(0, 50) + (input.message.length > 50 ? "..." : "")
        : input.title
      : undefined
  const result = await createSendSession(input.sdk, title)
  return result.data?.id
}

function errorMessage(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("data" in error)) return undefined
  const data = error.data
  if (!data || typeof data !== "object" || !("message" in data)) return undefined
  return typeof data.message === "string" ? data.message : undefined
}

async function assertAttachedScope(sdk: SynergyClient, scopeID?: string) {
  if (!scopeID) return
  const result = await sdk.scope.current()
  if (result.data) return
  throw new Error(errorMessage(result.error) ?? `Scope not found: ${scopeID}`)
}

export const SendCommand = cmd({
  command: "send [message..]",
  describe: "send a message to synergy",
  builder: (yargs: Argv) => {
    return yargs
      .positional("message", {
        describe: "message to send",
        type: "string",
        array: true,
        default: [],
      })
      .option("command", {
        describe: "the command to run, use message for args",
        type: "string",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        describe: "session id to continue",
        type: "string",
      })
      .option("scope", {
        describe: "registered scope id (defaults to the current directory, registering it when needed)",
        type: "string",
      })

      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      })
      .option("format", {
        type: "string",
        choices: ["default", "json"],
        default: "default",
        describe: "format: default (formatted) or json (raw JSON events)",
      })
      .option("file", {
        alias: ["f"],
        type: "string",
        array: true,
        describe: "file(s) to attach to message",
      })
      .option("title", {
        type: "string",
        describe: "title for the session (uses truncated prompt if no value provided)",
      })
      .option("attach", {
        type: "string",
        describe: "attach to a running synergy server (start one with: synergy start)",
      })
      .option("port", {
        type: "number",
        describe: "port for the local server (defaults to random port if no value provided)",
      })
      .option("variant", {
        type: "string",
        describe: "model variant (provider-specific reasoning effort, e.g., high, max, minimal)",
      })
      .option("workflow", {
        type: "string",
        choices: ["lightloop"],
        describe:
          "run the message as a Light Loop workflow task: the session enables loop_stop and a reviewer loop, and send exits when the workflow reaches a terminal state",
      })
  },
  handler: async (args) => {
    const directory = Flag.SYNERGY_CWD || process.cwd()
    let message = [...args.message, ...(args["--"] || [])]
      .map((arg) => (arg.includes(" ") ? `"${arg.replace(/"/g, '\\"')}"` : arg))
      .join(" ")

    const fileParts: any[] = []
    if (args.file) {
      const files = Array.isArray(args.file) ? args.file : [args.file]

      for (const filePath of files) {
        const resolvedPath = path.resolve(directory, filePath)
        const file = Bun.file(resolvedPath)
        const stats = await file.stat().catch(() => {})
        if (!stats) {
          UI.error(`File not found: ${filePath}`)
          process.exit(1)
        }
        if (!(await file.exists())) {
          UI.error(`File not found: ${filePath}`)
          process.exit(1)
        }

        const stat = await file.stat()
        const mime = stat.isDirectory() ? "application/x-directory" : "text/plain"

        fileParts.push({
          type: "attachment",
          url: pathToFileURL(resolvedPath).href,
          filename: path.basename(resolvedPath),
          mime,
          model: stat.isDirectory()
            ? { mode: "summary", summary: `${path.basename(resolvedPath)} (directory)` }
            : { mode: "content" },
        })
      }
    }

    if (!process.stdin.isTTY) {
      const piped = await readPipedStdin()
      if (piped) message += "\n" + piped
    }

    if (message.trim().length === 0 && !args.command) {
      UI.error("You must provide a message or a command")
      process.exit(1)
    }

    if (args.workflow === "lightloop" && args.command) {
      UI.error("--workflow lightloop cannot be combined with --command")
      process.exit(1)
    }

    const execute = async (sdk: SynergyClient, sessionID: string) => {
      const printEvent = (color: string, type: string, title: string) => {
        UI.println(
          color + `|`,
          UI.Style.TEXT_NORMAL + UI.Style.TEXT_DIM + ` ${type.padEnd(7, " ")}`,
          "",
          UI.Style.TEXT_NORMAL + title,
        )
      }

      const outputJsonEvent = (type: string, data: any) => {
        if (args.format === "json") {
          process.stdout.write(JSON.stringify({ type, timestamp: Date.now(), sessionID, ...data }) + EOL)
          return true
        }
        return false
      }

      const events = await sdk.event.subscribe()
      let errorMsg: string | undefined
      const eventProcessor = (async () => {
        for await (const event of events.stream) {
          if (event.type === "message.part.updated") {
            const part = event.properties.part
            if (part.sessionID !== sessionID) continue

            if (part.type === "tool" && part.state.status === "completed") {
              if (outputJsonEvent("tool_use", { part })) continue
              const [tool, color] = TOOL[part.tool] ?? [part.tool, UI.Style.TEXT_INFO_BOLD]
              const title =
                part.state.title ||
                (Object.keys(part.state.input).length > 0 ? JSON.stringify(part.state.input) : "Unknown")
              printEvent(color, tool, title)
              if (part.tool === "bash" && part.state.output?.trim()) {
                UI.println()
                UI.println(part.state.output)
              }
            }

            if (part.type === "step-start") {
              if (outputJsonEvent("step_start", { part })) continue
            }

            if (part.type === "step-finish") {
              if (outputJsonEvent("step_finish", { part })) continue
            }

            if (part.type === "text" && part.time?.end) {
              if (outputJsonEvent("text", { part })) continue
              const isPiped = !process.stdout.isTTY
              if (!isPiped) UI.println()
              process.stdout.write((isPiped ? part.text : UI.markdown(part.text)) + EOL)
              if (!isPiped) UI.println()
            }
          }

          if (event.type === "session.error") {
            const props = event.properties
            if (props.sessionID !== sessionID || !props.error) continue
            const error = props.error as Record<string, unknown>
            const err = errorMessage(error) ?? String(error.name)
            errorMsg = errorMsg ? errorMsg + EOL + err : err
            // The server converts a terminal executor error into the durable
            // "failed" Light Loop status, so the wait loop observes it through
            // the workflow state instead of aborting here. Non-fatal errors
            // (e.g. an attachment read failure) must not kill a recoverable
            // loop, so the event is only reported, never used to cancel.
            if (outputJsonEvent("error", { error: props.error })) continue
            UI.error(err)
          }

          if (event.type === "session.idle" && event.properties.sessionID === sessionID) {
            // Light Loop reviews run as Cortex children; the parent session goes
            // idle while the reviewer runs, and a rejected review resumes the
            // executor. The end of the attempt is decided from the workflow.
            if (args.workflow === "lightloop") continue
            break
          }

          if (event.type === "permission.asked") {
            const permission = event.properties
            if (permission.sessionID !== sessionID) continue
            const result = await select({
              message: `Permission required: ${permission.permission} (${permission.patterns.join(", ")})`,
              options: [
                { value: "once", label: "Allow once" },
                { value: "reject", label: "Reject" },
              ],
              initialValue: "once",
            }).catch(() => "reject")
            const response = (result.toString().includes("cancel") ? "reject" : result) as "once" | "reject"
            await sdk.permission.respond({
              sessionID,
              permissionID: permission.id,
              response,
            })
          }
        }
      })()

      // Validate agent if specified
      const resolvedAgent = await (async () => {
        if (!args.agent) return undefined
        const result = await sdk.app.agents({}, { throwOnError: true })
        const agent = result.data.find((item) => item.name === args.agent)
        if (!agent) {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${args.agent}" not found. Falling back to default agent`,
          )
          return undefined
        }
        if (agent.mode === "subagent") {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${args.agent}" is a subagent, not a primary agent. Falling back to default agent`,
          )
          return undefined
        }
        return args.agent
      })()

      // Enable the Light Loop workflow before the first prompt so the user
      // message is projected with the Light Loop contract and the agent can
      // call loop_stop. The hard timeout covers the whole attempt, including
      // the first executor turn, so it starts before the workflow enable and
      // the prompt is submitted asynchronously (a blocking prompt would put
      // the timeout out of reach during the first turn).
      const lightLoopStartedAt = Date.now()
      if (args.workflow === "lightloop") {
        const setResult = await sdk.workflow.session.set({
          id: sessionID,
          workflowSetInput: { kind: "lightloop", instructions: message },
        })
        if (setResult.error) {
          throw new Error(errorMessage(setResult.error) ?? "Failed to enable Light Loop workflow")
        }
      }

      if (args.command) {
        await sdk.session.command({
          sessionID,
          agent: resolvedAgent,
          model: args.model,
          command: args.command,
          arguments: message,
          variant: args.variant,
        })
      } else {
        const modelParam = args.model ? Provider.parseModel(args.model) : undefined
        const promptParts = [...fileParts, { type: "text", text: message }]
        if (args.workflow === "lightloop") {
          // Submit asynchronously so the hard timeout (started above, before
          // the workflow enable) also bounds the first executor turn. The
          // blocking prompt route would otherwise hold this call open for the
          // whole first turn, making the timeout unreachable.
          const promptResult = await sdk.session.promptAsync({
            sessionID,
            agent: resolvedAgent,
            model: modelParam,
            variant: args.variant,
            parts: promptParts,
          })
          if (promptResult.error) {
            throw new Error(errorMessage(promptResult.error) ?? "Failed to submit Light Loop prompt")
          }
        } else {
          await sdk.session.prompt({
            sessionID,
            agent: resolvedAgent,
            model: modelParam,
            variant: args.variant,
            parts: promptParts,
          })
        }
      }

      if (args.workflow === "lightloop") {
        // The parent session goes idle while the reviewer runs and again after
        // a rejected review resumes the executor, so session.idle cannot end
        // the attempt. Poll the workflow until it reaches a terminal state, is
        // cleared by approval, or is replaced by another workflow.
        const outcome = await waitForLightLoopFinish(sdk, sessionID, {
          startedAt: lightLoopStartedAt,
        })

        const terminalFailure = outcome.status !== undefined && outcome.status !== "completed"
        if (terminalFailure || outcome.timedOut || outcome.replaced || outcome.clearedWithoutRecord) {
          // Stop the host-owned workflow before exiting so a later benchmark
          // attempt is not contaminated by a still-running loop (with
          // --attach) or a durable active workflow resumed on next startup.
          await sdk.workflow.session.cancelLightloop({ id: sessionID }).catch(() => undefined)
        }

        if (args.format === "json") {
          process.stdout.write(
            JSON.stringify({
              type: "lightloop_finish",
              timestamp: Date.now(),
              sessionID,
              status: outcome.status,
              elapsedMs: outcome.elapsedMs,
              timedOut: outcome.timedOut,
              aborted: outcome.aborted,
              replaced: outcome.replaced,
              clearedWithoutRecord: outcome.clearedWithoutRecord,
            }) + EOL,
          )
        }

        if (outcome.timedOut) {
          UI.error("Light Loop workflow timed out")
          process.exit(1)
        }
        if (outcome.aborted && errorMsg) {
          UI.error(errorMsg)
          process.exit(1)
        }
        if (outcome.replaced) {
          UI.error("Light Loop workflow was replaced by another workflow")
          process.exit(1)
        }
        if (outcome.clearedWithoutRecord) {
          UI.error("Light Loop workflow was cleared without a terminal record")
          process.exit(1)
        }
        if (terminalFailure) {
          UI.error(`Light Loop ended with status: ${outcome.status}`)
          process.exit(1)
        }
        return
      }

      await eventProcessor
      if (errorMsg) process.exit(1)
    }

    if (args.attach) {
      const sdk = createSynergyClient({
        baseUrl: args.attach,
        ...(args.scope ? { scopeID: args.scope } : { directory }),
      })
      await assertAttachedScope(sdk, args.scope)

      const sessionID = await resolveSendSessionID({
        sdk,
        continueLast: args.continue,
        sessionID: args.session,
        title: args.title,
        message,
      })

      if (!sessionID) {
        UI.error("Session not found")
        process.exit(1)
      }

      await execute(sdk, sessionID)
      process.exit(0)
    }

    await withScopeContext(
      directory,
      async () => {
        await runMigrations({ output: "silent" })
        const server = Server.listen({ port: args.port ?? 0, hostname: "127.0.0.1" })
        const sdk = createSynergyClient({
          baseUrl: `http://${server.hostname}:${server.port}`,
          ...(args.scope ? { scopeID: args.scope } : { directory }),
        })

        if (args.command) {
          const exists = await Command.get(args.command)
          if (!exists) {
            server.stop()
            UI.error(`Command "${args.command}" not found`)
            process.exit(1)
          }
        }

        const sessionID = await resolveSendSessionID({
          sdk,
          continueLast: args.continue,
          sessionID: args.session,
          title: args.title,
          message,
        })

        if (!sessionID) {
          server.stop()
          UI.error("Session not found")
          process.exit(1)
        }

        await execute(sdk, sessionID)
        server.stop(true)
        process.exit(0)
      },
      args.scope,
    )
  },
})
