import { formatLocalDateTime } from "@/util/time-format"
import z from "zod"
import { Tool } from "./tool"
import { Agenda, AgendaTypes } from "../agenda"
import { AgendaDedup } from "../agenda/dedup"
import { AgendaStore } from "../agenda/store"
import { SessionManager } from "../session/manager"
import { ScopeContext } from "../scope/context"
import DESCRIPTION from "./agenda-watch.txt"

const parameters = z
  .object({
    title: z.string().describe("Short name, e.g. 'Check pipeline health'"),
    prompt: z
      .string()
      .describe(
        "Instruction you'll receive when woken up. Write it for yourself — you'll see it with full conversation history.",
      ),
    delay: z.string().optional().describe("How long to wait before waking you, e.g. '30m', '2h', '1d'"),
    onSessionEnd: z
      .object({
        sessionID: z.string().describe("Session to watch — wake when it ends a turn"),
        agent: z.string().optional().describe("Only wake when the turn's agent matches"),
        finish: z.string().optional().describe("Only wake when the turn's finish state matches (e.g. 'stop', 'error')"),
      })
      .optional()
      .describe("Wake when another session ends a turn instead of after a delay"),
    onGithub: z
      .object({
        resource: z.enum(["pr", "issue", "workflow", "check"]).describe("GitHub resource kind to watch"),
        repository: z.string().describe("Repository in owner/repo form"),
        number: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "PR/issue number or workflow run id. Omit for repository-wide pr/issue watch. For checks this is the commit's latest run set",
          ),
        ref: z
          .string()
          .optional()
          .describe(
            "Branch/tag/commit ref for workflow and check targeting (e.g. 'main', full SHA). Defaults to HEAD for checks and the default branch for workflows",
          ),
        states: z
          .array(z.string())
          .optional()
          .describe("Only wake on transitions into these states (e.g. ['merged'], ['failure'], ['completed'])"),
      })
      .optional()
      .describe("Wake when a GitHub PR / issue / workflow / check changes state instead of after a delay"),
    global: z.boolean().optional().describe("If true, visible from all scopes. Default: false (current project only)"),
  })
  .refine((v) => [v.delay, v.onSessionEnd, v.onGithub].filter(Boolean).length === 1, {
    message: "Pass exactly one of delay, onSessionEnd, or onGithub",
    path: ["delay"],
  })

export const AgendaWatchTool = Tool.define("agenda_watch", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>, ctx) {
    // Reject if there are running subagent tasks for this session.
    // Subagents auto-notify on completion — an agenda_watch is never needed for them.
    const { Cortex } = await import("../cortex")
    const runningSubagents = Cortex.getVisibleTasks(ctx.sessionID).filter((t) => t.status === "running")

    if (runningSubagents.length > 0) {
      const taskList = runningSubagents.map((t) => `  - ${t.id}: ${t.description} (agent: ${t.agent})`).join("\n")

      return {
        title: "agenda_watch rejected",
        output: [
          `You cannot set an \`agenda_watch\` while subagents are still running.`,
          ``,
          `Running subagents (${runningSubagents.length}):`,
          taskList,
          ``,
          `These subagents **auto-notify you on completion** — the system will send a lightweight notification that wakes you when they finish.`,
          `There is NO reason to poll or watch them. No watch is needed.`,
          ``,
          `Instead: continue with other independent work that does not depend on these results.`,
          `If you need a one-shot progress check, use \`task_output(task_id="...", mode="progress")\` once — but prioritize independent work and wait for the automatic completion notification.`,
          `When the notification arrives, it does NOT contain the final result; retrieve it once with \`task_output(task_id="...", mode="full")\`.`,
        ].join("\n"),
        metadata: {
          blocked: true,
          reason: "running_subagents",
          runningSubagentCount: runningSubagents.length,
          runningSubagentIds: runningSubagents.map((t) => t.id),
        } as Record<string, any>,
      }
    }

    const session = await SessionManager.getSession(ctx.sessionID).catch(() => undefined)
    if (params.onGithub) {
      // A GitHub watch can never fire while polling is disabled; reject up
      // front instead of leaving a silent, indefinite continuation blocker.
      const { Config } = await import("../config/config")
      const watch = (await Config.globalResolved().catch(() => undefined))?.github?.watch
      if (watch?.enabled === false) {
        return {
          title: "agenda_watch rejected",
          output: [
            `GitHub watch is disabled (github.watch.enabled=false in config).`,
            ``,
            `Ask the user to enable it in Settings → GitHub → "Allow GitHub agenda triggers", or set github.watch.enabled=true in 115-github.jsonc.`,
          ].join("\n"),
          metadata: { blocked: true, reason: "github_watch_disabled" } as Record<string, any>,
        }
      }
    }
    const trigger: AgendaTypes.Trigger = params.onSessionEnd
      ? {
          type: "session",
          sessionID: params.onSessionEnd.sessionID,
          event: "turn.end",
          agent: params.onSessionEnd.agent,
          finish: params.onSessionEnd.finish,
          once: true,
        }
      : params.onGithub
        ? {
            type: "github",
            resource: params.onGithub.resource,
            repository: params.onGithub.repository,
            number: params.onGithub.number,
            ref: params.onGithub.ref,
            states: params.onGithub.states,
          }
        : { type: "delay" as const, delay: params.delay! }

    const conflicts = await AgendaDedup.findConflicts(
      ScopeContext.current.scope.id,
      params.title,
      [trigger],
      params.global,
    )
    if (conflicts.length > 0) {
      return {
        title: "agenda_watch",
        output: AgendaDedup.formatConflictMessage(conflicts, "agenda_watch"),
        metadata: { conflictCount: conflicts.length, action: "conflict_found" } as Record<string, any>,
      }
    }

    const item = await Agenda.create({
      title: params.title,
      prompt: params.prompt,
      triggers: [trigger],
      global: params.global,
      wake: true,
      silent: false,
      autoDone: true,
      createdBy: "agent",
      sessionID: ctx.sessionID,
      endpoint: session?.endpoint,
    })

    const delayMs = params.delay ? AgendaStore.parseDuration(params.delay) : 0
    const firesAt = params.onSessionEnd
      ? `when session "${params.onSessionEnd.sessionID}" ends a turn`
      : params.onGithub
        ? `when GitHub ${params.onGithub.resource} in ${params.onGithub.repository}${params.onGithub.number !== undefined ? ` #${params.onGithub.number}` : ""} changes state${params.onGithub.states?.length ? ` to ${params.onGithub.states.join("|")}` : ""}`
        : formatLocalDateTime(Date.now() + delayMs)

    return {
      title: `Watch: ${params.title}`,
      output: [
        `Watch set — you'll be woken up in THIS session.`,
        ``,
        `ID: ${item.id}`,
        `Fires: ${firesAt}`,
        ``,
        `When it fires, you receive the prompt as a message and continue with full conversation history.`,
        `To cancel: agenda_cancel(id="${item.id}")`,
      ].join("\n"),
      metadata: {
        id: item.id,
        status: item.status,
        ...(params.onSessionEnd
          ? { sessionID: params.onSessionEnd.sessionID }
          : params.onGithub
            ? { github: params.onGithub }
            : { delay: params.delay }),
      } as Record<string, any>,
    }
  },
})
