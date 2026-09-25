import type { RuntimeHandle } from "@ericsanchezok/synergy-harness/lifecycle"
import { z } from "zod"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { ControlProfileCompiler } from "@ericsanchezok/synergy-harness/control-profile/compiler"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionEvent } from "@ericsanchezok/synergy-harness/session/event"
import { SessionInvoke, type InvokeInput } from "@ericsanchezok/synergy-harness/session/invoke"
import { SessionWorkflowService } from "@ericsanchezok/synergy-harness/session/workflow"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { RolloutLifecycle } from "@ericsanchezok/synergy-harness/session/rollout/lifecycle"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { RolloutQuery } from "@ericsanchezok/synergy-harness/session/rollout/query"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import { Question } from "./question"
import { abandonSession, continueSession, createSession, submitInput, submitCommand } from "./session-api"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"

export const RuntimeEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message.part.updated"), properties: MessageV2.Event.PartUpdated.properties }),
  z.object({ type: z.literal("session.error"), properties: SessionEvent.Error.properties }),
  z.object({ type: z.literal("permission.asked"), properties: PermissionNext.Request }),
  z.object({ type: z.literal("question.asked"), properties: Question.Request }),
])
export type RuntimeEvent = z.infer<typeof RuntimeEvent>

const success = <T>(data: T) => ({ data, error: undefined, response: { status: 200 } })
type RequestOptions = { throwOnError?: boolean }

async function subscribe(signal?: AbortSignal) {
  const queue: RuntimeEvent[] = []
  let wake = Promise.withResolvers<void>()
  const unsubscribe = Bus.subscribeAll((event: unknown) => {
    const parsed = RuntimeEvent.safeParse(event)
    if (!parsed.success) return
    queue.push(parsed.data)
    wake.resolve()
  })
  const abort = () => wake.resolve()
  signal?.addEventListener("abort", abort, { once: true })
  async function* stream() {
    try {
      while (!signal?.aborted) {
        if (!queue.length) await wake.promise
        wake = Promise.withResolvers<void>()
        while (queue.length) yield queue.shift()!
      }
    } finally {
      unsubscribe()
      signal?.removeEventListener("abort", abort)
    }
  }
  return { stream: stream() }
}

export type ScopeSelector = { scopeID: string } | { directory: string }

export function createLocalClient(runtime: RuntimeHandle.Handle, selector: ScopeSelector) {
  function inScope<A extends unknown[], R>(body: (...args: A) => Promise<R>) {
    return (...args: A): Promise<R> =>
      runtime.run(async () => {
        const scope = await Scope.resolve(selector)
        return await ScopeContext.provide({ scope, fn: () => body(...args) })
      })
  }
  return {
    scope: { current: inScope(async () => success(Scope.Runtime.parse(ScopeContext.current.scope))) },
    controlProfile: {
      effective: inScope(async () =>
        success({ profileId: String(ControlProfileCompiler.normalize((await Config.current()).controlProfile)) }),
      ),
    },
    app: { agents: inScope(async (_input?: unknown, _options?: RequestOptions) => success(await Agent.list())) },
    event: {
      subscribe: inScope(async (_input?: unknown, options?: { signal?: AbortSignal }) =>
        subscribe(options?.signal ? AbortSignal.any([runtime.signal, options.signal]) : runtime.signal),
      ),
    },
    permission: {
      respond: inScope(
        async (
          input: { sessionID: string; permissionID: string; response: "once" | "always" | "reject" },
          _options?: RequestOptions,
        ) => {
          await PermissionNext.reply({ requestID: input.permissionID, reply: input.response })
          return success(true)
        },
      ),
    },
    question: {
      reject: inScope(async (input: { requestID: string }, _options?: RequestOptions) => {
        await Question.reject(input.requestID)
        return success(true)
      }),
      reply: inScope(async (input: { requestID: string; answers: string[][] }, _options?: RequestOptions) => {
        await Question.reply(input)
        return success(true)
      }),
    },
    workflow: {
      session: {
        set: inScope(
          async (
            input: { id: string; workflowSetInput: { kind: "lightloop"; instructions: string } },
            _options?: RequestOptions,
          ) => success(await SessionWorkflowService.set(input.id, input.workflowSetInput)),
        ),
      },
    },
    session: {
      create: inScope(async (input: Parameters<typeof createSession>[0]) =>
        success(Session.Info.parse(await createSession(input))),
      ),
      list: inScope(async () => success(await Session.list())),
      message: inScope(async (input: { sessionID: string; messageID: string }, _options?: RequestOptions) =>
        success(await MessageV2.get(input)),
      ),
      run: inScope(async (input: { sessionID: string; runID: string }, _options?: RequestOptions) =>
        success(await RolloutLedger.getRun(RolloutLifecycle.owner(await Session.get(input.sessionID)), input.runID)),
      ),
      runResult: inScope(async (input: { sessionID: string; runID: string }, _options?: RequestOptions) =>
        success(await RolloutQuery.tree(RolloutLifecycle.owner(await Session.get(input.sessionID)), input.runID)),
      ),
      cancelRun: inScope(
        async (input: {
          sessionID: string
          runID: string
        }): Promise<{ data: unknown; error: unknown; response: { status: number } }> => {
          try {
            return success(await RolloutLifecycle.cancel(input.sessionID, input.runID))
          } catch (error) {
            if (!(error instanceof Storage.NotFoundError)) throw error
            return { data: undefined, error, response: { status: 404 } }
          }
        },
      ),
      input: inScope(async (input: InvokeInput, _options?: RequestOptions) => success(await submitInput(input))),
      command: inScope(async (input: Parameters<typeof SessionInvoke.command>[0], _options?: RequestOptions) => {
        await submitCommand(input)
        return success(undefined)
      }),
      // The explicit exits from the paused state. They live here so in-process
      // callers (Desktop main, the CLI) reach the same implementation the HTTP
      // routes use, rather than a second definition that can drift.
      continue: inScope(async (input: { sessionID: string }, _options?: RequestOptions) =>
        success({ handled: await continueSession(input.sessionID) }),
      ),
      abandon: inScope(async (input: { sessionID: string }, _options?: RequestOptions) =>
        success(await abandonSession(input.sessionID)),
      ),
    },
  }
}

export type RuntimeClient = ReturnType<typeof createLocalClient>
