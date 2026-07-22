import { describe, expect, test } from "bun:test"
import { isSessionCompactionPending, runSessionCompaction } from "../../../src/components/session/compact-action-core"

const model = { id: "model", provider: { id: "provider" } }
const notices = {
  noModel: { title: "Localized no model", description: "Localized connect a provider" },
  failure: { title: "Localized compaction failed", description: "Localized retry description" },
}

describe("shared session compaction", () => {
  test("deduplicates a pending request and clears pending state after success", async () => {
    let release: (() => void) | undefined
    let calls = 0
    const summarize = () => {
      calls++
      return new Promise<void>((resolve) => {
        release = resolve
      })
    }
    const notify = () => undefined

    const first = runSessionCompaction({ sessionID: "ses_a", model, summarize, notify, notices })
    expect(isSessionCompactionPending("ses_a")).toBe(true)
    expect(await runSessionCompaction({ sessionID: "ses_a", model, summarize, notify, notices })).toBe(false)
    expect(calls).toBe(1)

    release?.()
    expect(await first).toBe(true)
    expect(isSessionCompactionPending("ses_a")).toBe(false)
  })

  test("keeps pending state isolated per session", async () => {
    let release: (() => void) | undefined
    const pending = runSessionCompaction({
      sessionID: "ses_a",
      model,
      summarize: () => new Promise<void>((resolve) => (release = resolve)),
      notify: () => undefined,
      notices,
    })

    expect(isSessionCompactionPending("ses_a")).toBe(true)
    expect(isSessionCompactionPending("ses_b")).toBe(false)
    release?.()
    await pending
  })

  test("uses the injected warning without a selected model", async () => {
    const received: Array<{ type?: string; title?: string; description?: string }> = []
    const result = await runSessionCompaction({
      sessionID: "ses_model",
      model: undefined,
      summarize: async () => undefined,
      notify: (notice) => received.push(notice),
      notices,
    })

    expect(result).toBe(false)
    expect(received).toEqual([{ type: "warning", ...notices.noModel }])
  })

  test("uses injected failure copy, preserves raw errors, and permits a retry", async () => {
    const received: Array<{ type?: string; title?: string; description?: string }> = []
    const failed = await runSessionCompaction({
      sessionID: "ses_failure",
      model,
      summarize: async () => {
        throw new Error("provider unavailable")
      },
      notify: (notice) => received.push(notice),
      notices,
    })

    expect(failed).toBe(false)
    expect(isSessionCompactionPending("ses_failure")).toBe(false)
    expect(received).toEqual([{ type: "error", title: notices.failure.title, description: "provider unavailable" }])

    expect(
      await runSessionCompaction({
        sessionID: "ses_failure",
        model,
        summarize: async () => undefined,
        notify: () => undefined,
        notices,
      }),
    ).toBe(true)
  })
})
