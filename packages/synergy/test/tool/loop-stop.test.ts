import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Session } from "../../src/session"
import { ScopeContext } from "../../src/scope/context"
import { LoopStopTool } from "../../src/tool/loop-stop"
import type { Tool } from "../../src/tool/tool"
import { tmpdir } from "../fixture/fixture"

let originalGet: typeof Session.get
let originalUpdate: typeof Session.update
let originalUpdatePart: typeof Session.updatePart

beforeEach(() => {
  originalGet = Session.get
  originalUpdate = Session.update
  originalUpdatePart = Session.updatePart
})

afterEach(() => {
  ;(Session.get as any) = originalGet
  ;(Session.update as any) = originalUpdate
  ;(Session.updatePart as any) = originalUpdatePart
})

function ctx(sessionID: string): Tool.Context {
  return {
    sessionID,
    messageID: Identifier.ascending("message"),
    agent: "synergy",
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
  }
}

function sessionWithLightLoop(active: boolean, taskDescription = "Test task") {
  return {
    id: "ses_test_loop",
    workflow: active ? { kind: "lightloop", taskDescription } : { kind: "plan" },
  } as unknown as Session.Info
}

function sessionWithoutLightLoop() {
  return {
    id: "ses_test_no_loop",
  } as unknown as Session.Info
}

describe("loop_stop", () => {
  test("succeeds when Light Loop workflow is active and clears it", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = sessionWithLightLoop(true)
        ;(Session.get as any) = mock(async () => session)

        let updateCleared = false
        ;(Session.update as any) = mock(async (_sid: string, fn: (draft: any) => void) => {
          const draft = { ...session }
          fn(draft)
          if (draft.workflow === undefined) updateCleared = true
        })

        let updatePartCall: any = null
        ;(Session.updatePart as any) = mock(async (input: any) => {
          updatePartCall = input
        })

        const tool = await LoopStopTool.init()
        const result = await tool.execute({}, ctx("ses_test_loop"))

        expect(result.title).toBe("Light loop stopped")
        expect(result.output).toBe("Light loop stopped.")
        expect(result.metadata.loopStopped).toBe(true)
        expect(updateCleared).toBe(true)
        expect(updatePartCall).not.toBeNull()
        expect(updatePartCall.type).toBe("text")
        expect(updatePartCall.synthetic).toBe(true)
        expect(updatePartCall.text).toBe("Light loop stopped.")
        expect(updatePartCall.sessionID).toBe("ses_test_loop")
      },
    })
  })

  test("includes summary in output when provided", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = sessionWithLightLoop(true)
        ;(Session.get as any) = mock(async () => session)
        ;(Session.update as any) = mock(async () => {})

        let updatePartCall: any = null
        ;(Session.updatePart as any) = mock(async (input: any) => {
          updatePartCall = input
        })

        const tool = await LoopStopTool.init()
        const result = await tool.execute({ summary: "All tests pass" }, ctx("ses_test_loop"))

        expect(result.output).toBe("Light loop stopped. Summary: All tests pass")
        expect(updatePartCall.text).toBe("Light loop stopped. Summary: All tests pass")
      },
    })
  })

  test("throws when session has no Light Loop workflow", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = sessionWithoutLightLoop()
        ;(Session.get as any) = mock(async () => session)

        const tool = await LoopStopTool.init()
        await expect(tool.execute({}, ctx("ses_test_no_loop"))).rejects.toThrow(
          "No active Light Loop workflow on this session",
        )
      },
    })
  })

  test("throws when another workflow is active", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = sessionWithLightLoop(false)
        ;(Session.get as any) = mock(async () => session)

        const tool = await LoopStopTool.init()
        await expect(tool.execute({}, ctx("ses_test_loop"))).rejects.toThrow(
          "No active Light Loop workflow on this session",
        )
      },
    })
  })
})
