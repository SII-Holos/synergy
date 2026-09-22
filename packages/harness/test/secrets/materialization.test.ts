import { expect, test } from "bun:test"
import { ScopeContext } from "../../src/scope/context"
import { Scope } from "../../src/scope"
import { Session } from "../../src/session"
import { createUserMessage } from "../../src/session/input"
import { MessageV2 } from "../../src/session/message-v2"
import { SecretMask } from "../../src/secrets/mask"
import { SecretVault } from "../../src/secrets/vault"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

test("regex capture reaches durable user-message materialization", () =>
  runtime.run(async () => {
    const value = `sk-fakekey-${crypto.randomUUID()}`
    try {
      await ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          const session = await Session.create({})
          try {
            const message = await createUserMessage({
              sessionID: session.id,
              model: { providerID: "test", modelID: "test" },
              parts: [{ type: "text", text: `use ${value}` }],
            })
            await Session.flushPartWrites(session.id)
            const parts = await MessageV2.parts({ sessionID: session.id, messageID: message.info.id })
            expect(parts.filter((part) => part.type === "text").map((part) => part.text)).toEqual([
              `use ${SecretMask.token(SecretVault.idOf(value))}`,
            ])
          } finally {
            await Session.remove(session.id)
          }
        },
      })
    } finally {
      await SecretVault.remove(SecretVault.idOf(value))
    }
  }))

afterRuntimeTests(() => runtime.close())
