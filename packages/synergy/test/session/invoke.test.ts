import { describe, expect, test, mock } from "bun:test"
import { SessionManager } from "../../src/session/manager"
import { SessionInvoke } from "../../src/session/invoke"
import { MessageV2 } from "../../src/session/message-v2"
import { PermissionNext } from "../../src/permission/next"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"

const sessionID = "ses_test"

function userMessage(id: string, noReply?: boolean): MessageV2.WithParts {
  return {
    info: {
      id,
      sessionID,
      role: "user",
      time: { created: 0 },
      agent: "synergy",
      model: { providerID: "test", modelID: "test" },
      metadata: noReply ? { noReply: true } : undefined,
    } as MessageV2.User,
    parts: [],
  }
}

function assistantMessage(id: string, parentID: string, text: string): MessageV2.WithParts {
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      time: { created: 0, completed: 0 },
      parentID,
      modelID: "test-model",
      providerID: "test-provider",
      mode: "test",
      agent: "test",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      finish: "stop",
    } as MessageV2.Assistant,
    parts: [
      {
        id: `prt_${id}`,
        sessionID,
        messageID: id,
        type: "text",
        text,
      } as MessageV2.TextPart,
    ],
  }
}

describe("SessionInvoke.selectResultMessage", () => {
  test("selects the last assistant for the latest reply-required user turn", () => {
    const user = userMessage("msg_user")
    const earlyAssistant = assistantMessage("msg_assistant_1", "msg_user", "early")
    const finalAssistant = assistantMessage("msg_assistant_2", "msg_user", "final")

    const result = SessionInvoke.selectResultMessage([user, earlyAssistant, finalAssistant])

    expect(result?.info.id).toBe("msg_assistant_2")
  })

  test("ignores assistant messages from earlier user turns", () => {
    const oldUser = userMessage("msg_old_user")
    const oldAssistant = assistantMessage("msg_old_assistant", "msg_old_user", "old final")
    const newUser = userMessage("msg_new_user")
    const newAssistant = assistantMessage("msg_new_assistant", "msg_new_user", "new final")

    const result = SessionInvoke.selectResultMessage([oldUser, oldAssistant, newUser, newAssistant])

    expect(result?.info.id).toBe("msg_new_assistant")
  })

  test("falls back to the latest assistant when there is no reply-required user", () => {
    const user = userMessage("msg_user", true)
    const assistant = assistantMessage("msg_assistant", "msg_user", "final")

    const result = SessionInvoke.selectResultMessage([user, assistant])

    expect(result?.info.id).toBe("msg_assistant")
  })
})

describe("SessionInvoke.cancel", () => {
  test("delegates to signalAbort instead of leaving runtime idle via release", () => {
    Log.init({ print: false })
    const sessionID = "ses_cancel_test"
    const runtime = SessionManager.registerRuntime(sessionID)

    // Simulate a busy runtime that was previously acquired
    runtime.abort = new AbortController()
    runtime.status = { type: "busy", description: "processing..." }

    const releaseSpy = mock(async () => {})
    ;(SessionManager as any).release = releaseSpy

    const signalAbortSpy = mock(() => {})
    ;(SessionManager as any).signalAbort = signalAbortSpy

    // Stub PermissionNext.clearForSession to avoid hitting storage
    const cleanupSpy = mock(() => Promise.resolve())
    ;(PermissionNext as any).clearForSession = cleanupSpy

    SessionInvoke.cancel(sessionID)

    // signalAbort must be called — cancel() should signal the abort,
    // not release the runtime. If cancel() calls release() instead,
    // the runtime transitions to idle before time.completed is set.
    expect(signalAbortSpy).toHaveBeenCalledTimes(1)
    expect(signalAbortSpy).toHaveBeenCalledWith(sessionID)

    // release must NOT be called by cancel — only the defer in loop()
    // should call release after the processor has exited.
    expect(releaseSpy).not.toHaveBeenCalled()

    SessionManager.unregisterRuntime(sessionID)
  })
})
