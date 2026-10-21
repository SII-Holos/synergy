import { afterAll, expect, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { SessionRetry } from "../../src/session/retry"
import { MessageV2 } from "../../src/session/message-v2"
import type { StatusInfo } from "../../src/session/types"

const runtime = await testRuntime()
afterAll(() => runtime.close())

function fixture(headers?: Record<string, string>) {
  const abort = new AbortController()
  const states: Extract<StatusInfo, { type: "retry" }>[] = []
  const recovery = SessionRetry.create({
    sessionID: "session-recovery",
    rootID: "root-recovery",
    messageID: "message-recovery",
    providerID: "test",
    abort: abort.signal,
    publish: (state) => states.push(state),
  })
  const error = new MessageV2.APIError({
    message: "read ECONNRESET",
    isRetryable: true,
    responseHeaders: headers,
  }).toObject()
  return { abort, states, recovery, error }
}

test(
  "manual retry wakes one owned wait, retains recovery until output, and rejects stale clicks",
  runtime.bind(async () => {
    const { recovery, states, error } = fixture()
    try {
      const waiting = recovery.wait(error, 8, 60_000)
      expect(states.at(-1)).toMatchObject({ phase: "waiting", rootID: "root-recovery", canRetry: true })
      expect(states.at(-1)?.error).toContain("read ECONNRESET")
      expect(SessionRetry.now("session-recovery", "another-message")).toBe(false)
      expect(SessionRetry.now("session-recovery", "message-recovery")).toBe(true)
      expect(SessionRetry.now("session-recovery", "message-recovery")).toBe(false)
      await waiting
      expect(states.at(-1)).toMatchObject({ phase: "connecting", canRetry: false })
      expect(recovery.active()).toBe(true)
      expect(recovery.takeImmediate()).toBe(true)
      expect(recovery.takeImmediate()).toBe(false)
      recovery.finish()
      expect(recovery.active()).toBe(false)
    } finally {
      recovery.dispose()
    }
  }),
)

test(
  "server Retry-After cannot be skipped and stopping cancels the scheduled attempt",
  runtime.bind(async () => {
    const { recovery, states, abort, error } = fixture({ "retry-after": "60" })
    try {
      const waiting = recovery.wait(error, 1, 60_000)
      expect(states.at(-1)).toMatchObject({ phase: "waiting", canRetry: false })
      expect(SessionRetry.now("session-recovery", "message-recovery")).toBe(false)
      abort.abort(new DOMException("Stopped", "AbortError"))
      await expect(waiting).rejects.toThrow("Stopped")
      expect(SessionRetry.now("session-recovery", "message-recovery")).toBe(false)
      expect(recovery.active()).toBe(false)
    } finally {
      recovery.dispose()
    }
  }),
)
