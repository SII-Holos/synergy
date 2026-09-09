import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { SessionManager } from "../../src/session/manager"
import { SessionInbox } from "../../src/session/inbox"
import { SessionInvoke } from "../../src/session/invoke"

const sessionID = "ses_wake_retry_test"
const originalDelays = [...SessionManager.WAKE_RETRY_DELAYS_MS]
const FAST_DELAYS = [5, 5, 5, 5]
const MAX_ATTEMPTS = 1 + FAST_DELAYS.length

function fastDelays() {
  SessionManager.WAKE_RETRY_DELAYS_MS.splice(0, SessionManager.WAKE_RETRY_DELAYS_MS.length, ...FAST_DELAYS)
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for wake retries")
    await Bun.sleep(5)
  }
}

describe("session wake retry", () => {
  afterEach(() => {
    SessionManager.WAKE_RETRY_DELAYS_MS.splice(0, SessionManager.WAKE_RETRY_DELAYS_MS.length, ...originalDelays)
    mock.restore()
  })

  test("wake tolerates a failed pre-loop repair and still drives the loop", async () => {
    spyOn(SessionInbox, "hasRunnableItem").mockResolvedValue(true)
    spyOn(SessionInvoke, "repairAfterAbort").mockRejectedValue(new Error("repair storage unavailable"))
    const loop = spyOn(SessionInvoke, "loop").mockResolvedValue({} as never)

    await SessionManager.wake(sessionID)

    expect(loop).toHaveBeenCalledTimes(1)
  })

  test("scheduleWake retries transient loop failures until the inbox is driven", async () => {
    fastDelays()
    spyOn(SessionInbox, "hasRunnableItem").mockResolvedValue(true)
    spyOn(SessionInvoke, "repairAfterAbort").mockResolvedValue(false)
    let attempts = 0
    const loop = spyOn(SessionInvoke, "loop").mockImplementation((() => {
      attempts++
      return attempts < 3 ? Promise.reject(new Error("transient provider failure")) : Promise.resolve({} as never)
    }) as unknown as typeof SessionInvoke.loop)

    SessionManager.scheduleWake(sessionID, "user-input")
    await waitFor(() => loop.mock.calls.length >= 3)
    expect(attempts).toBe(3)
  })

  test("scheduleWake gives up after bounded retries", async () => {
    fastDelays()
    spyOn(SessionInbox, "hasRunnableItem").mockResolvedValue(true)
    spyOn(SessionInvoke, "repairAfterAbort").mockResolvedValue(false)
    const loop = spyOn(SessionInvoke, "loop").mockRejectedValue(new Error("permanent failure"))

    SessionManager.scheduleWake(sessionID, "user-input")
    await waitFor(() => loop.mock.calls.length >= MAX_ATTEMPTS)
    await Bun.sleep(30)
    expect(loop.mock.calls.length).toBe(MAX_ATTEMPTS)
  })
  test("scheduleWake abandons the chain immediately on a permanent worktree failure", async () => {
    fastDelays()
    spyOn(SessionInbox, "hasRunnableItem").mockResolvedValue(true)
    spyOn(SessionInvoke, "repairAfterAbort").mockResolvedValue(false)
    const failure = new Error("Worktree directory not found: /tmp/gone")
    failure.name = "WorktreeNotFoundError"
    const loop = spyOn(SessionInvoke, "loop").mockRejectedValue(failure)

    SessionManager.scheduleWake(sessionID, "user-input")
    await waitFor(() => loop.mock.calls.length >= 1)
    await Bun.sleep(40)
    expect(loop.mock.calls.length).toBe(1)
  })

  test("scheduleWake abandons the chain immediately on an invalid attachment failure", async () => {
    fastDelays()
    spyOn(SessionInbox, "hasRunnableItem").mockResolvedValue(true)
    spyOn(SessionInvoke, "repairAfterAbort").mockResolvedValue(false)
    const failure = new Error("Invalid attachment URL")
    failure.name = "InvalidUrlError"
    const loop = spyOn(SessionInvoke, "loop").mockRejectedValue(failure)

    SessionManager.scheduleWake(sessionID, "user-input")
    await waitFor(() => loop.mock.calls.length >= 1)
    await Bun.sleep(40)
    expect(loop.mock.calls.length).toBe(1)
  })

  test("scheduleWake coalesces duplicate requests for the same session", async () => {
    fastDelays()
    spyOn(SessionInbox, "hasRunnableItem").mockResolvedValue(true)
    spyOn(SessionInvoke, "repairAfterAbort").mockResolvedValue(false)
    const loop = spyOn(SessionInvoke, "loop").mockRejectedValue(new Error("permanent failure"))

    SessionManager.scheduleWake(sessionID, "user-input")
    SessionManager.scheduleWake(sessionID, "user-input")
    await waitFor(() => loop.mock.calls.length >= MAX_ATTEMPTS)
    await Bun.sleep(30)
    expect(loop.mock.calls.length).toBe(MAX_ATTEMPTS)
  })
  test("scheduleWake preserves a release request arriving while the loop is finishing", async () => {
    spyOn(SessionInbox, "hasRunnableItem").mockResolvedValue(true)
    spyOn(SessionInvoke, "repairAfterAbort").mockResolvedValue(false)
    let attempts = 0
    const loop = spyOn(SessionInvoke, "loop").mockImplementation((async () => {
      attempts++
      if (attempts === 1) SessionManager.scheduleWake(sessionID, "release")
      return {} as never
    }) as unknown as typeof SessionInvoke.loop)
    SessionManager.scheduleWake(sessionID, "user-input")
    await waitFor(() => loop.mock.calls.length === 2)
    expect(attempts).toBe(2)
  })
})
