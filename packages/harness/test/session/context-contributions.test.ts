import { expect, test } from "bun:test"
import { SessionContextContributions } from "../../src/session/context-contributions"

const input = () => ({
  sessionID: "session-context-test",
  scopeID: "home",
  messages: [],
  isTopSession: true,
  signal: new AbortController().signal,
})

test("absent context contributors perform no work", async () => {
  expect(await SessionContextContributions.collect(input())).toBeUndefined()
})

test("disabled context contributors do not invoke their callback", async () => {
  let calls = 0
  const unregister = SessionContextContributions.register("disabled-test", {
    enabled: () => false,
    async contribute() {
      calls++
      return { context: "unexpected", injection: {} }
    },
  })
  try {
    expect(await SessionContextContributions.collect(input())).toBeUndefined()
    expect(calls).toBe(0)
  } finally {
    unregister()
  }
})

test("context cancellation reaches the contributor and rejects collection", async () => {
  const controller = new AbortController()
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  let observed: AbortSignal | undefined
  const unregister = SessionContextContributions.register("cancel-test", {
    contribute: async ({ signal }) => {
      observed = signal
      started()
      return new Promise(() => {})
    },
  })
  try {
    const pending = SessionContextContributions.collect({ ...input(), signal: controller.signal })
    await ready
    controller.abort(new Error("cancelled context"))
    await expect(pending).rejects.toThrow("cancelled context")
    expect(observed?.aborted).toBe(true)
  } finally {
    unregister()
  }
})
