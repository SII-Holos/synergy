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

test("assistant completion waits for contributed work before closing execution", async () => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let settled = false
  const unregister = SessionContextContributions.register("completion-test", {
    async contribute() {
      return undefined
    },
    async onAssistantComplete() {
      started.resolve()
      await release.promise
    },
  })
  const { MessageV2 } = await import("../../src/session/message-v2")
  const message = MessageV2.Assistant.parse({
    id: "assistant-context-test",
    sessionID: "session-context-test",
    parentID: "root-context-test",
    role: "assistant",
    time: { created: 1 },
    agent: "synergy",
    mode: "synergy",
    modelID: "test",
    providerID: "test",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  const completion = Promise.resolve(SessionContextContributions.onAssistantComplete(message)).then(() => {
    settled = true
  })
  try {
    await started.promise
    await Promise.resolve()
    expect(settled).toBe(false)
    release.resolve()
    await completion
    expect(settled).toBe(true)
  } finally {
    release.resolve()
    await completion
    unregister()
  }
})

test("completion failure preserves its error after the other contributions settle", async () => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const failure = new Error("completion evidence failed")
  const unregisterFailure = SessionContextContributions.register("failed-completion-test", {
    async contribute() {
      return undefined
    },
    async onAssistantComplete() {
      throw failure
    },
  })
  const unregisterPending = SessionContextContributions.register("pending-completion-test", {
    async contribute() {
      return undefined
    },
    async onAssistantComplete() {
      started.resolve()
      await release.promise
    },
  })
  const { MessageV2 } = await import("../../src/session/message-v2")
  const message = MessageV2.Assistant.parse({
    id: "assistant-context-test",
    sessionID: "session-context-test",
    parentID: "root-context-test",
    role: "assistant",
    time: { created: 1 },
    agent: "synergy",
    mode: "synergy",
    modelID: "test",
    providerID: "test",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  let settled = false
  const completion = SessionContextContributions.onAssistantComplete(message).then(
    () => {
      settled = true
      return undefined
    },
    (error: unknown) => {
      settled = true
      return error
    },
  )
  try {
    await started.promise
    await Promise.resolve()
    expect(settled).toBe(false)
    release.resolve()
    expect(await completion).toBe(failure)
  } finally {
    release.resolve()
    await completion
    unregisterFailure()
    unregisterPending()
  }
})
