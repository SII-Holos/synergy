import { expect, test } from "bun:test"
import { PredictionRequest, type PredictionState } from "../../../src/components/digital-twin/request"

test("only fresh successful events auto-predict; stale and dismissed sources do not replay", async () => {
  let state: PredictionState = {
    identity: "server/scope/session/epoch/model/0",
    sessionID: "session",
    anchor: { rootID: "root", assistantID: "assistant" },
    eligible: true,
    ready: true,
    automatic: true,
  }
  const replies: Array<
    (value: { proposalID: string; candidate: string; stamp: { rootID: string; assistantID: string } }) => void
  > = []
  const signals: AbortSignal[] = []
  const applied: string[] = []
  const request = new PredictionRequest({
    read: () => state,
    call: (_input, signal) => {
      signals.push(signal)
      return new Promise((resolve) => replies.push(resolve))
    },
    apply: (value) => applied.push(value.candidate!),
    clearFeedback: () => {},
    failed: () => {},
    changed: () => {},
  })
  request.update()
  expect(replies).toHaveLength(0)
  request.completed(state.anchor!)
  expect(replies).toHaveLength(1)
  state = { ...state, identity: "server/scope/session/epoch/model/1", eligible: false }
  request.update()
  expect(signals[0]!.aborted).toBe(true)
  replies[0]!({ proposalID: "p", candidate: "stale", stamp: state.anchor! })
  await Promise.resolve()
  expect(applied).toEqual([])
  state = { ...state, eligible: true }
  request.update()
  request.completed(state.anchor!)
  expect(replies).toHaveLength(1)
  state = { ...state, automatic: false }
  request.update()
  request.manual()
  expect(replies).toHaveLength(2)
  replies[1]!({ proposalID: "q", candidate: "fresh", stamp: state.anchor! })
  await Promise.resolve()
  expect(applied).toEqual(["fresh"])
  request.dispose()
})

test("completion waits for the matching synchronized anchor without replaying a mount", async () => {
  let state: PredictionState = {
    identity: "binding/old",
    binding: "binding",
    sessionID: "s",
    eligible: true,
    ready: false,
    automatic: true,
  }
  const calls: string[] = []
  const request = new PredictionRequest({
    read: () => state,
    call: async (input) => {
      calls.push(input.expected.rootID)
      return { proposalID: "p", candidate: "candidate", stamp: input.expected }
    },
    apply: () => {},
    clearFeedback: () => {},
    changed: () => {},
    failed: () => {},
  })
  request.update()
  request.completed({ rootID: "new", assistantID: "reply" })
  expect(calls).toEqual([])
  state = { ...state, identity: "binding/new", anchor: { rootID: "new", assistantID: "reply" }, ready: true }
  request.update()
  expect(calls).toEqual(["new"])
  request.completed(state.anchor!)
  expect(calls).toHaveLength(1)
  request.dispose()
})

test("completion ownership is bounded and a late background result reaches only its mounted owner", async () => {
  const { claimCompletion, registerComposer, composerMounted, saveSuggestion } =
    await import("../../../src/components/digital-twin/presence")
  const owner = { url: "https://fixture.invalid", scopeKey: "ownership", sessionID: "session" }
  const received: string[] = []
  const unregister = registerComposer(owner, (suggestion) => received.push(suggestion.text))
  const peer = { ...owner, scopeKey: "another-scope" }
  const releasePeer = registerComposer(peer, () => {
    throw new Error("Cross-Scope suggestion")
  })
  try {
    expect(composerMounted(owner)).toBe(true)
    expect(claimCompletion(owner, "first", "reply")).toBe(true)
    expect(claimCompletion(owner, "first", "reply")).toBe(false)
    expect(claimCompletion(peer, "first", "reply")).toBe(true)
    saveSuggestion(owner, { rootID: "first", assistantID: "reply", proposalID: "proposal", text: "Next input" })
    expect(received).toEqual(["Next input"])
    for (let index = 0; index < 512; index++) claimCompletion(owner, String(index), "reply")
    expect(claimCompletion(owner, "first", "reply")).toBe(true)
  } finally {
    unregister()
    releasePeer()
  }
  expect(composerMounted(owner)).toBe(false)
})
