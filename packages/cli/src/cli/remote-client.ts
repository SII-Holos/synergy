import { z } from "zod"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { RolloutSchema } from "@ericsanchezok/synergy-harness/session/rollout/schema"
import { RolloutQuery } from "@ericsanchezok/synergy-harness/session/rollout/query"
import type { SynergyClient } from "@ericsanchezok/synergy-sdk"
import { RuntimeEvent, type RuntimeClient } from "@ericsanchezok/synergy-runtime-local/client"

function result<T>(value: { data: T; response: Response }) {
  return { data: value.data, error: undefined, response: { status: value.response.status } }
}

function parsed<T>(schema: z.ZodType<T>, value: { data: unknown; response: Response }) {
  return result({ data: schema.parse(value.data), response: value.response })
}

export function createRemoteClient(sdk: SynergyClient): RuntimeClient {
  return {
    scope: { current: async () => parsed(Scope.Info, await sdk.scope.current({}, { throwOnError: true })) },
    controlProfile: { effective: async () => result(await sdk.controlProfile.effective({}, { throwOnError: true })) },
    app: { agents: async () => result(await sdk.app.agents({}, { throwOnError: true })) },
    event: {
      subscribe: async (_input, options) => {
        const events = await sdk.event.subscribe({}, options)
        async function* stream() {
          for await (const event of events.stream) {
            const parsed = RuntimeEvent.safeParse(event)
            if (parsed.success) yield parsed.data
          }
        }
        return { stream: stream() }
      },
    },
    permission: { respond: async (input) => result(await sdk.permission.respond(input, { throwOnError: true })) },
    question: {
      reject: async (input) => result(await sdk.question.reject(input, { throwOnError: true })),
      reply: async (input) => result(await sdk.question.reply(input, { throwOnError: true })),
    },
    workflow: {
      session: {
        set: async (input) => parsed(Session.Info, await sdk.workflow.session.set(input, { throwOnError: true })),
      },
    },
    session: {
      create: async (input) => parsed(Session.Info, await sdk.session.create(input, { throwOnError: true })),
      list: async () =>
        parsed(
          z.object({ data: z.array(Session.Info), total: z.number() }),
          await sdk.session.list({}, { throwOnError: true }),
        ),
      message: async (input) => parsed(MessageV2.WithParts, await sdk.session.message(input, { throwOnError: true })),
      run: async (input) => parsed(RolloutSchema.RunRecord, await sdk.session.run(input, { throwOnError: true })),
      runResult: async (input) =>
        parsed(RolloutQuery.Result, await sdk.session.runResult(input, { throwOnError: true })),
      cancelRun: async (input) => {
        const value = await sdk.session.cancelRun(input)
        return { data: value.data, error: value.error, response: { status: value.response.status } }
      },
      input: async (input) => parsed(SessionInbox.InputResult, await sdk.session.input(input, { throwOnError: true })),
      command: async (input) => {
        const value = await sdk.session.command(input, { throwOnError: true })
        return result({ data: undefined, response: value.response })
      },
    },
  }
}
