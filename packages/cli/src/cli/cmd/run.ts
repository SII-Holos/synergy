import type { Argv } from "yargs"
import { pathToFileURL } from "url"
import path from "path"
import { UI } from "../../util/ui"
import { cmd } from "./cmd"
import { Flag } from "@ericsanchezok/synergy-harness/flag/flag"
import { EOL } from "os"
import { select, multiselect, text, isCancel } from "@clack/prompts"
import { createSynergyClient, type ControlProfileId } from "@ericsanchezok/synergy-sdk"
import { parseModelID } from "@ericsanchezok/synergy-harness/provider/model-id"
import { readPipedStdin } from "../stdin"
import { Experiment } from "@ericsanchezok/synergy-harness/config/experiment"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { createLocalClient, type RuntimeClient } from "@ericsanchezok/synergy-runtime-local/client"
import { openLocalRuntime } from "@ericsanchezok/synergy-runtime-local"
import { createRemoteClient } from "../remote-client"
import { findRecordingError } from "@ericsanchezok/synergy-harness/session/rollout/error"

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

async function effectiveControlProfile(sdk: RuntimeClient): Promise<ControlProfileId | undefined> {
  return sdk.controlProfile
    .effective()
    .then((result) => {
      const profile = result.data?.profileId
      return isControlProfileId(profile) ? profile : undefined
    })
    .catch(() => undefined)
}

async function createSendSession(sdk: RuntimeClient, title?: string) {
  const controlProfile = await effectiveControlProfile(sdk)
  return sdk.session.create({
    ...(title ? { title } : {}),
    workspace: { mode: "current" },
    ...(controlProfile ? { controlProfile } : {}),
  })
}

async function resolveSendSessionID(input: {
  sdk: RuntimeClient
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

async function assertAttachedScope(sdk: RuntimeClient, scopeID?: string) {
  if (!scopeID) return
  const result = await sdk.scope.current()
  if (result.data) return
  throw new Error(errorMessage(result.error) ?? `Scope not found: ${scopeID}`)
}

export function createSendCommand(runtimeFactory: typeof openLocalRuntime = openLocalRuntime) {
  return cmd({
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
        .option("experiment", { type: "string", describe: "Versioned experiment configuration file" })
        .option("non-interactive", {
          type: "boolean",
          default: false,
          describe: "Fail explicitly if the task requires user input or permission",
        })
        .option("timeout", {
          type: "number",
          default: 21600,
          describe: "Task timeout in seconds, including descendants and cleanup",
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
      if (!Number.isFinite(args.timeout) || args.timeout <= 0) throw new Error("--timeout must be positive")
      const experiment = args.experiment
        ? Experiment.File.parse(await Bun.file(path.resolve(directory, args.experiment)).json())
        : undefined
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
            throw new Error(`File not found: ${filePath}`)
          }
          if (!(await file.exists())) {
            throw new Error(`File not found: ${filePath}`)
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
        throw new Error("You must provide a message or a command")
      }

      if (args.workflow === "lightloop" && args.command) {
        throw new Error("--workflow lightloop cannot be combined with --command")
      }

      const execute = async (sdk: RuntimeClient, sessionID: string) => {
        const nonInteractive = args["non-interactive"] || !process.stdin.isTTY || args.format === "json"
        const streamAbort = new AbortController()
        const submitted = Promise.withResolvers<void>()
        let runID: string | undefined
        let sequence = 0
        let stopReason: "cancelled" | "timeout" | "interaction_required" | undefined
        let streamFailure: unknown
        let cancellation: Promise<unknown> | undefined
        let commandPending = false
        const requestStop = (reason: NonNullable<typeof stopReason>) => {
          stopReason ??= reason
          if (runID && !cancellation) {
            const id = runID
            cancellation = (async () => {
              const deadline = Date.now() + 10_000
              while (true) {
                const response = await sdk.session.cancelRun({ sessionID, runID: id })
                if (!response.error) return response.data
                if (response.response.status !== 404 || !commandPending || Date.now() >= deadline) throw response.error
                await Bun.sleep(25)
              }
            })()
            void cancellation.catch((error) => {
              streamFailure ??= error
            })
          }
        }
        const onInterrupt = () => requestStop("cancelled")
        process.once("SIGINT", onInterrupt)
        process.once("SIGTERM", onInterrupt)
        const timer = setTimeout(() => requestStop("timeout"), args.timeout * 1000)
        timer.unref()
        const output = (type: string, data: Record<string, unknown> = {}) => {
          if (args.format !== "json") return false
          process.stdout.write(
            JSON.stringify({
              version: 1,
              seq: ++sequence,
              type,
              timestamp: Date.now(),
              sessionID,
              runID: runID ?? null,
              ...data,
            }) + EOL,
          )
          return true
        }
        const descendants = new Set([sessionID])
        async function belongs(id: string, tool?: { messageID: string }): Promise<boolean> {
          if (!runID) return false
          if (id === sessionID && tool) {
            const { data } = await sdk.session.message(
              { sessionID: id, messageID: tool.messageID },
              { throwOnError: true },
            )
            return (data.info.rootID ?? (data.info.role === "assistant" ? data.info.parentID : data.info.id)) === runID
          }
          if (descendants.has(id)) return true
          const { data } = await sdk.session.runResult({ sessionID, runID }, { throwOnError: true })
          for (const snapshot of data.snapshots)
            if (snapshot.owner.kind === "session") descendants.add(snapshot.owner.sessionID)
          return descendants.has(id)
        }
        let eventProcessor = Promise.resolve()
        try {
          const events = await sdk.event.subscribe({}, { signal: streamAbort.signal })
          eventProcessor = (async () => {
            for await (const event of events.stream) {
              await submitted.promise
              if (event.type === "message.part.updated") {
                const part = event.properties.part
                if (part.sessionID !== sessionID) continue
                if (part.type === "tool" && part.state.status === "completed") {
                  if (output("tool_use", { part })) continue
                  const [tool, color] = TOOL[part.tool] ?? [part.tool, UI.Style.TEXT_INFO_BOLD]
                  UI.println(
                    color + "|",
                    UI.Style.TEXT_NORMAL + ` ${tool} `,
                    part.state.title || JSON.stringify(part.state.input),
                  )
                  if (part.tool === "bash" && part.state.output?.trim()) UI.println(part.state.output)
                }
                if (part.type === "step-start") output("step_start", { part })
                if (part.type === "step-finish")
                  output("step_finish", {
                    part,
                    callIDs: part.accounting?.kind === "rollout" ? part.accounting.callIDs : [],
                  })
                if (part.type === "text" && part.time?.end && !output("text", { part }))
                  process.stdout.write((process.stdout.isTTY ? UI.markdown(part.text) : part.text) + EOL)
              }
              if (event.type === "session.error" && event.properties.sessionID === sessionID) {
                if (!output("error", { error: event.properties.error }))
                  UI.error(errorMessage(event.properties.error) ?? "Task error")
              }
              if (
                event.type === "permission.asked" &&
                (await belongs(event.properties.sessionID, event.properties.tool))
              ) {
                const permission = event.properties
                if (nonInteractive) {
                  output("interaction_required", {
                    interaction: "permission",
                    requestID: permission.id,
                    ownerSessionID: permission.sessionID,
                  })
                  requestStop("interaction_required")
                  await sdk.permission.respond(
                    { sessionID: permission.sessionID, permissionID: permission.id, response: "reject" },
                    { throwOnError: true },
                  )
                  continue
                }
                const answer = await select({
                  message: `Permission required: ${permission.permission} (${permission.patterns.join(", ")})`,
                  options: [
                    { value: "once", label: "Allow once" },
                    { value: "reject", label: "Reject" },
                  ],
                })
                await sdk.permission.respond(
                  {
                    sessionID: permission.sessionID,
                    permissionID: permission.id,
                    response: isCancel(answer) ? "reject" : answer,
                  },
                  { throwOnError: true },
                )
              }
              if (
                event.type === "question.asked" &&
                (await belongs(event.properties.sessionID, event.properties.tool))
              ) {
                const question = event.properties
                if (nonInteractive) {
                  output("interaction_required", {
                    interaction: "question",
                    requestID: question.id,
                    ownerSessionID: question.sessionID,
                  })
                  requestStop("interaction_required")
                  await sdk.question.reject({ requestID: question.id }, { throwOnError: true })
                  continue
                }
                const answers: string[][] = []
                for (const item of question.questions) {
                  const options = item.options.map((option) => ({
                    value: option.label,
                    label: option.label,
                    hint: option.description,
                  }))
                  const answer = options.length
                    ? item.multiple
                      ? await multiselect({ message: item.question, options })
                      : await select({ message: item.question, options })
                    : await text({ message: item.question })
                  if (isCancel(answer)) {
                    requestStop("cancelled")
                    break
                  }
                  answers.push(Array.isArray(answer) ? answer : [answer])
                }
                if (!stopReason) await sdk.question.reply({ requestID: question.id, answers }, { throwOnError: true })
              }
            }
          })().catch((error) => {
            if (streamAbort.signal.aborted) return
            streamFailure = error
            requestStop("cancelled")
          })
          if (args.agent) {
            const { data } = await sdk.app.agents({}, { throwOnError: true })
            const agent = data.find((item) => item.name === args.agent)
            if (!agent || agent.mode === "subagent") throw new Error(`Primary agent not found: ${args.agent}`)
          }
          if (args.workflow === "lightloop")
            await sdk.workflow.session.set(
              { id: sessionID, workflowSetInput: { kind: "lightloop", instructions: message } },
              { throwOnError: true },
            )
          if (args.command) {
            runID = Identifier.ascending("message")
            commandPending = true
            submitted.resolve()
            if (stopReason) requestStop(stopReason)
            await sdk.session
              .command(
                {
                  sessionID,
                  messageID: runID,
                  agent: args.agent,
                  model: args.model,
                  command: args.command,
                  arguments: message,
                  variant: args.variant,
                  experiment,
                },
                { throwOnError: true },
              )
              .finally(() => {
                commandPending = false
              })
          } else {
            const { data } = await sdk.session.input(
              {
                sessionID,
                agent: args.agent,
                model: args.model ? parseModelID(args.model) : undefined,
                variant: args.variant,
                experiment,
                parts: [...fileParts, { type: "text", text: message }],
              },
              { throwOnError: true },
            )
            runID = data.status === "queued" ? data.item.messageID : data.messageID
          }
          output("run_started")
          submitted.resolve()
          if (stopReason) requestStop(stopReason)
          while (true) {
            if (streamFailure) throw streamFailure
            if (cancellation) await cancellation
            const { data: run } = await sdk.session.run({ sessionID, runID }, { throwOnError: true })
            if (run.status !== "running") break
            await Bun.sleep(250)
          }
          const { data: result } = await sdk.session.runResult({ sessionID, runID }, { throwOnError: true })
          const exitCode =
            result.run.recording === "failed"
              ? 5
              : stopReason === "interaction_required"
                ? 4
                : stopReason === "timeout"
                  ? 3
                  : result.run.status === "cancelled"
                    ? 130
                    : result.run.status !== "completed"
                      ? 2
                      : 0
          output("result", {
            result: { run: result.run, accounting: result.accounting, elapsedMs: result.elapsedMs },
            outcome: stopReason ?? result.run.status,
            exitCode,
          })
          process.exitCode = exitCode
          if (exitCode && args.format !== "json")
            UI.error(`Run ended: ${stopReason ?? result.run.status} (${result.run.recording} recording)`)
        } catch (error) {
          if (runID) {
            requestStop("cancelled")
            if (cancellation) await cancellation.catch(() => {})
          }
          const exitCode = findRecordingError(error)
            ? 5
            : stopReason === "timeout"
              ? 3
              : stopReason === "interaction_required"
                ? 4
                : 2
          process.exitCode = exitCode
          output("failed", {
            error: errorMessage(error) ?? (error instanceof Error ? error.message : String(error)),
            exitCode,
          })
          throw error
        } finally {
          clearTimeout(timer)
          process.removeListener("SIGINT", onInterrupt)
          process.removeListener("SIGTERM", onInterrupt)
          submitted.resolve()
          streamAbort.abort()
          await eventProcessor
        }
      }

      if (args.attach) {
        const sdk = createRemoteClient(
          createSynergyClient({
            baseUrl: args.attach,
            ...(args.scope ? { scopeID: args.scope } : { directory }),
          }),
        )
        await assertAttachedScope(sdk, args.scope)

        const sessionID = await resolveSendSessionID({
          sdk,
          continueLast: args.continue,
          sessionID: args.session,
          title: args.title,
          message,
        })

        if (!sessionID) {
          throw new Error("Session not found")
        }

        await execute(sdk, sessionID)
        return
      }

      const { withScopeContext } = await import("../scope")
      const { Command } = await import("@ericsanchezok/synergy-runtime-local/command/command")
      await using runtime = await runtimeFactory({
        mode: "oneshot",
        experiment,
        reporter: args.format === "json" ? { summary() {} } : undefined,
      })
      await withScopeContext(
        directory,
        async () => {
          const sdk = createLocalClient()

          if (args.command) {
            const exists = await Command.get(args.command)
            if (!exists) {
              throw new Error(`Command "${args.command}" not found`)
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
            throw new Error("Session not found")
          }

          await execute(sdk, sessionID)
        },
        args.scope,
      )
    },
  })
}

export const SendCommand = createSendCommand()
