import { describe, expect, test } from "bun:test"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { shell } from "../../src/session/shell"
import { tmpdir } from "../fixture/fixture"

describe("session shell", () => {
  test.skipIf(process.platform === "win32")(
    "settles when an exited command leaves an inherited pipe open",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const session = await Session.create({})
          try {
            const startedAt = performance.now()
            const result = await shell({
              sessionID: session.id,
              agent: "build",
              model: { providerID: "test", modelID: "test" },
              command: "(sleep 30) &",
            })

            expect(performance.now() - startedAt).toBeLessThan(10_000)
            expect(result.parts.some((part) => part.type === "tool" && part.state.status === "completed")).toBe(true)
          } finally {
            await Session.remove(session.id)
          }
        },
      })
    },
    12_000,
  )
})
