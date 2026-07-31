import { afterEach, describe, expect, mock, test } from "bun:test"
import { AgendaReactor } from "../../src/agenda/reactor"
import { AgendaStore } from "../../src/agenda/store"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionDrive } from "../../src/session/drive"
import { SessionInbox } from "../../src/session/inbox"
import { SessionInvoke } from "../../src/session/invoke"
import { tmpdir } from "../fixture/fixture"

const originalInvoke = SessionInvoke.invoke
const originalDriveRequest = SessionDrive.request

afterEach(() => {
  ;(SessionInvoke.invoke as typeof SessionInvoke.invoke) = originalInvoke
  ;(SessionDrive.request as typeof SessionDrive.request) = originalDriveRequest
})

describe("Agenda internal Session guidance", () => {
  test("fires hidden system-origin guidance into the origin Session without an Agenda child Session", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Clarus task" })
        let invokeCalls = 0
        let drivenSessionID: string | undefined
        ;(SessionInvoke.invoke as unknown as (...args: unknown[]) => unknown) = mock(async () => {
          invokeCalls++
          throw new Error("Session guidance must not create an Agenda execution Session")
        })
        ;(SessionDrive.request as unknown as (...args: unknown[]) => unknown) = mock(async (...args: unknown[]) => {
          drivenSessionID = args[0] as string
          return true
        })

        const item = await AgendaStore.create({
          title: "Clarus deadline",
          prompt: "The Clarus task deadline is approaching.",
          triggers: [{ type: "at", at: Date.now() + 60_000 }],
          createdBy: "agent",
          sessionID: session.id,
          tags: ["clarus", "deadline"],
          deliveryMode: "session_guidance",
        })

        const result = await AgendaReactor.execute(
          { type: "manual", source: item.id, timestamp: Date.now() },
          ScopeContext.current.scope.id,
        )

        expect(result.sessionID).toBeUndefined()
        expect(invokeCalls).toBe(0)
        expect(drivenSessionID).toBe(session.id)

        const inbox = await SessionInbox.list(session.id)
        expect(inbox).toHaveLength(1)
        expect(inbox[0]!.mode).toBe("steer")
        expect(inbox[0]!.message?.visible).toBe(false)
        expect(inbox[0]!.message?.origin?.type).toBe("agenda")
        expect(inbox[0]!.message?.parts).toEqual([
          {
            type: "text",
            text: "The Clarus task deadline is approaching.",
            origin: "system",
          },
        ])
      },
    })
  })
})
