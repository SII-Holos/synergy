import { Identifier } from "../../src/id/id"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { Storage } from "../../src/storage/storage"
import type { MessageV2 } from "../../src/session/message-v2"
import { testRuntime } from "./runtime"

const [home, boundary] = process.argv.slice(2)
if (!home || !["committed", "before-head-commit"].includes(boundary ?? "") || !process.send)
  throw new Error("Expected an isolated Home, crash boundary and IPC channel")
const runtime = await testRuntime({ home })
await runtime.run(() =>
  ScopeContext.provide({
    scope: Scope.home(),
    fn: async () => {
      const session = await Session.create({ workspace: null })
      const messageID = Identifier.ascending("message")
      await Session.updateMessage({
        id: messageID,
        sessionID: session.id,
        role: "user",
        agent: "streaming-fixture",
        model: { providerID: "fixture", modelID: "fixture" },
        time: { created: 1 },
        isRoot: true,
        rootID: messageID,
        visible: true,
        origin: { type: "user" },
      })
      const part: MessageV2.TextPart = {
        id: Identifier.ascending("part"),
        sessionID: session.id,
        messageID,
        type: "text",
        text: "committed prefix".repeat(1024) + "\ud83d",
      }
      await Session.updatePartDelta(part, part.text)
      await Session.flushPartWrites(session.id)
      const ready = () => process.send!({ sessionID: session.id, messageID, partID: part.id, boundary })
      if (boundary === "before-head-commit") {
        const publish = Storage.publishPreparedBinary
        Storage.publishPreparedBinary = async (token) => {
          await publish(token)
          ready()
          await new Promise<void>(() => {})
        }
      }
      part.text += "\ude80 committed tail"
      await Session.updatePartDelta(part, "\ude80 committed tail")
      await Session.flushPartWrites(session.id)
      ready()
      await new Promise<void>(() => {})
    },
  }),
)
