import { describe, expect, test } from "bun:test"
import path from "path"

const { GlobalBus } = await import("../../src/bus/global")
const { Scope } = await import("../../src/scope")
const { ScopeContext } = await import("../../src/scope/context")
const { Server } = await import("../../src/server/server")
const { Session } = await import("../../src/session")
const { Log } = await import("../../src/util/log")

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

describe("session summarize route", () => {
  test("publishes a canonical compaction boundary root for event-driven sync", async () => {
    const scope = (await Scope.fromDirectory(projectRoot)).scope

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({ title: "Compaction event test" })
        const messages: any[] = []
        const handler = (event: { directory?: string; payload: any }) => {
          if (event.directory !== scope.directory) return
          if (event.payload?.type !== "message.updated") return
          messages.push(event.payload.properties.info)
        }

        GlobalBus.on("event", handler)
        try {
          const app = Server.App()
          const response = await app.request(`/session/${session.id}/summarize`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-synergy-directory": scope.directory,
            },
            body: JSON.stringify({
              providerID: "test-provider",
              modelID: "test-model",
            }),
          })

          // The test intentionally uses a fake provider/model. The loop may
          // fail after the boundary is written, but event-driven sync relies
          // on the boundary's earlier message.updated payload.
          expect([200, 400, 500]).toContain(response.status)

          const boundary = messages.find(
            (message) =>
              message.sessionID === session.id &&
              message.role === "user" &&
              message.metadata?.compactionBoundary === true,
          )

          expect(boundary).toBeDefined()
          expect(boundary).toMatchObject({
            isRoot: true,
            rootID: boundary.id,
            visible: true,
          })
        } finally {
          GlobalBus.off("event", handler)
          await Session.remove(session.id)
        }
      },
    })
  })
})
