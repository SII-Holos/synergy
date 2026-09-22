import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../support/fixture"
import { StorageBootstrap } from "../../src/storage/bootstrap"
import { Storage } from "../../src/storage/storage"
import { Session } from "../../src/session"
import { ScopeContext } from "../../src/scope/context"
import { Scope } from "../../src/scope"
import { Identifier } from "../../src/id/id"
import { SessionUserMessageMaterialization } from "../../src/session/user-message-materialization"
import { MessageV2 } from "../../src/session/message-v2"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

test.each([false, true])(
  "a rolled-back materialization does not survive in the drain buffer (retry=%s)",
  runtime.bind(async (retry) => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".synergy")
    const prepared = await StorageBootstrap.prepare({ root })
    try {
      await Storage.provide({ store: prepared.store, artifactDirectory: path.join(root, "data") }, () =>
        ScopeContext.provide({
          scope: Scope.home(),
          fn: async () => {
            const session = await Session.create({ title: "part failure" })
            const messageID = Identifier.ascending("message")
            const info: MessageV2.User = {
              id: messageID,
              sessionID: session.id,
              role: "user",
              time: { created: Date.now() },
              agent: "synergy",
              model: { providerID: "openai", modelID: "gpt-4.1" },
              isRoot: true,
              visible: true,
              includeInContext: true,
              origin: { type: "user" },
            }
            const part: MessageV2.TextPart = {
              id: Identifier.ascending("part"),
              messageID,
              sessionID: session.id,
              type: "text",
              text: "test",
            }
            const original = Storage.write
            {
              using failure = spyOn(Storage, "write").mockImplementation(async (key, value) => {
                if (key[5] === "parts") throw new Error("transient part write failure")
                return original(key, value)
              })
              await expect(SessionUserMessageMaterialization.write({ info, parts: [part] })).rejects.toThrow(
                "transient",
              )
            }
            expect(await Storage.readMany([["sessions", "home", session.id, "messages", messageID, "info"]])).toEqual([
              undefined,
            ])
            const drained = await Session.flushPartWrites(session.id).then(
              () => "ok",
              (error: unknown) => (error instanceof Error ? error.message : String(error)),
            )
            if (retry) {
              await SessionUserMessageMaterialization.write({
                info,
                parts: [{ ...part, id: Identifier.ascending("part") }],
              })
              await Session.flushPartWrites(session.id)
              expect(
                (await MessageV2.parts({ sessionID: session.id, messageID })).map((item) =>
                  item.type === "text" ? item.text : item.type,
                ),
              ).toEqual(["test"])
            } else expect(drained).toBe("ok")
          },
        }),
      )
    } finally {
      await prepared.store.close()
    }
  }),
)

afterRuntimeTests(() => runtime.close())
