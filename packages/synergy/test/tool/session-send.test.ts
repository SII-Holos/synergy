import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { SessionSendTool } from "../../src/tool/session-send"
import { SessionManager } from "../../src/session/manager"
import { Session } from "../../src/session"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

const baseContext = {
  sessionID: "ses_source",
  messageID: "msg_source",
  callID: "call_source",
  agent: "synergy",
  abort: AbortSignal.any([]),
  metadata: () => {},
}

let originalDeliver: typeof SessionManager.deliver

beforeEach(() => {
  originalDeliver = SessionManager.deliver
})

afterEach(() => {
  ;(SessionManager.deliver as any) = originalDeliver
})

describe("session_send tool", () => {
  test("queues user-role delivery asynchronously and does not mark it as channel mailbox", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const target = await Session.create({})
        const deliveries: Parameters<typeof SessionManager.deliver>[0][] = []
        ;(SessionManager.deliver as any) = mock(async (input: Parameters<typeof SessionManager.deliver>[0]) => {
          deliveries.push(input)
        })
        const ask = mock(async () => {})

        const tool = await SessionSendTool.init()
        const result = await tool.execute(
          {
            target: target.id,
            content: "please continue",
            role: "user",
            sourceName: "Source agent",
          },
          {
            ...baseContext,
            ask,
          },
        )

        expect(ask).toHaveBeenCalledTimes(1)
        expect(deliveries).toHaveLength(1)
        expect(deliveries[0].waitForProcessing).toBe(false)
        expect(deliveries[0].mail.type).toBe("user")
        expect(deliveries[0].mail.metadata).toMatchObject({
          source: "session_send",
          sourceSessionID: "ses_source",
          sourceName: "Source agent",
        })
        expect(deliveries[0].mail.metadata?.mailbox).toBeUndefined()
        expect(deliveries[0].mail.metadata?.channelPush).toBeUndefined()
        expect(result.output).toContain("queued and scheduled for asynchronous processing")
        expect(result.output).toContain("tool call is complete")

        await Session.remove(target.id)
      },
    })
  })

  test("defaults omitted role to an actionable user delivery", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const target = await Session.create({})
        const deliveries: Parameters<typeof SessionManager.deliver>[0][] = []
        ;(SessionManager.deliver as any) = mock(async (input: Parameters<typeof SessionManager.deliver>[0]) => {
          deliveries.push(input)
        })
        const ask = mock(async () => {})

        const tool = await SessionSendTool.init()
        const result = await tool.execute(
          {
            target: target.id,
            content: "please continue",
          } as any,
          {
            ...baseContext,
            ask,
          },
        )

        expect(ask).toHaveBeenCalledTimes(1)
        expect(deliveries).toHaveLength(1)
        expect(deliveries[0].waitForProcessing).toBe(false)
        expect(deliveries[0].mail.type).toBe("user")
        expect(result.metadata.role).toBe("user")

        await Session.remove(target.id)
      },
    })
  })

  test("rejects assistant role before requesting permission or delivering", async () => {
    const ask = mock(async () => {})
    const deliver = mock(async () => {})
    ;(SessionManager.deliver as any) = deliver

    const tool = await SessionSendTool.init()
    const parsed = tool.parameters.safeParse({ target: "ses_target", content: "context update", role: "assistant" })
    expect(parsed.error?.issues[0]?.message).toBe(
      'session_send only supports role "user". Retry the call with role: "user".',
    )
    const result = tool.execute(
      {
        target: "ses_target",
        content: "context update",
        role: "assistant",
      } as any,
      {
        ...baseContext,
        ask,
      },
    )
    await expect(result).rejects.toThrow('session_send only supports role "user"')

    expect(ask).not.toHaveBeenCalled()
    expect(deliver).not.toHaveBeenCalled()
  })
})
