import { describe, expect, test } from "bun:test"
import { ScopeContext } from "../../src/scope/context"
import { Identifier } from "../../src/id/id"
import { Session } from "../../src/session"
import { createUserMessage, lastModel } from "../../src/session/input"
import { MessageV2 } from "../../src/session/message-v2"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const primaryModel = { providerID: "primary-provider", modelID: "primary-model" }
const subagentModel = { providerID: "subagent-provider", modelID: "subagent-model" }

async function writeUser(input: {
  sessionID: string
  agent: string
  model: { providerID: string; modelID: string }
  text: string
  metadata?: Record<string, any>
}) {
  const messageID = Identifier.ascending("message")
  await Session.updateMessage({
    id: messageID,
    sessionID: input.sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: input.agent,
    model: input.model,
    metadata: input.metadata,
  } satisfies MessageV2.User)
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID,
    sessionID: input.sessionID,
    type: "text",
    text: input.text,
  })
}

describe("session input identity anchors", () => {
  test("cortex completion messages do not replace the session model or agent anchor", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})

        await writeUser({
          sessionID: session.id,
          agent: "synergy",
          model: primaryModel,
          text: "primary request",
        })
        await writeUser({
          sessionID: session.id,
          agent: "developer",
          model: subagentModel,
          text: "background task completed",
          metadata: {
            source: "cortex",
            sourceSessionID: "ses_child0123456789",
          },
        })

        expect(await lastModel(session.id)).toEqual(primaryModel)

        const created = await createUserMessage({
          sessionID: session.id,
          model: primaryModel,
          parts: [{ type: "text", text: "next prompt" }],
        })

        expect(created.info.agent).toBe("synergy")
        expect(created.info.model).toEqual(primaryModel)
      },
    })
  })
})
