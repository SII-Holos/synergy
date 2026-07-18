import { describe, expect, test } from "bun:test"
import { createOptimisticRootMessage } from "./session-optimistic-message"

describe("optimistic root message", () => {
  test("matches backend root semantics before the authoritative event arrives", () => {
    const message = createOptimisticRootMessage({
      id: "msg_first",
      sessionID: "session_new",
      created: 1,
      agent: "synergy",
      model: { providerID: "provider", modelID: "model" },
      variant: "high",
      metadata: { promptDraft: { version: 1 } },
    })

    expect(message).toMatchObject({
      id: "msg_first",
      sessionID: "session_new",
      role: "user",
      time: { created: 1 },
      origin: { type: "user" },
      isRoot: true,
      rootID: "msg_first",
      visible: true,
      agent: "synergy",
      model: { providerID: "provider", modelID: "model" },
      variant: "high",
      metadata: { promptDraft: { version: 1 } },
    })
  })
})
