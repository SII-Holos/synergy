import { describe, expect, spyOn, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionHistory } from "../../src/session/history"
import { MessageV2 } from "../../src/session/message-v2"
import { tmpdir } from "../support/fixture"

// A session whose message count exceeds the authoritative storage queue depth
// (1024) must still load its history: the queue rejects rather than backpressures,
// so the hydration fan-out has to stay bounded by the declared window instead of
// by message count.
const MESSAGE_COUNT = 48
const HYDRATION_WINDOW = 16

async function writeAnchoredUser(sessionID: string, text: string): Promise<MessageV2.User> {
  const info = (await Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "user",
    sessionID,
    agent: "synergy",
    model: { providerID: "test-provider", modelID: "test-model" },
    time: { created: Date.now() },
  })) as MessageV2.User
  const anchored = { ...info, isRoot: true, rootID: info.id }
  await Session.updateMessage(anchored)
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: info.id,
    sessionID,
    type: "text",
    text,
  })
  return anchored
}

describe("session history load concurrency", () => {
  test("loads every message part without exceeding the declared hydration window", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        for (let index = 0; index < MESSAGE_COUNT; index++) {
          await writeAnchoredUser(session.id, `message ${index}`)
        }

        let inFlight = 0
        let peak = 0
        let loaded = 0
        const original = MessageV2.parts
        using _spy = spyOn(MessageV2, "parts").mockImplementation((async (input) => {
          inFlight++
          peak = Math.max(peak, inFlight)
          try {
            await new Promise((resolve) => setTimeout(resolve, 1))
            const parts = await original(input)
            loaded++
            return parts
          } finally {
            inFlight--
          }
        }) as typeof MessageV2.parts)

        const messages = await SessionHistory.detachedModelMessages({ sessionID: session.id })

        expect(messages).toHaveLength(MESSAGE_COUNT)
        expect(loaded).toBe(MESSAGE_COUNT)
        expect(peak).toBeLessThanOrEqual(HYDRATION_WINDOW)
      },
    })
  })
})
