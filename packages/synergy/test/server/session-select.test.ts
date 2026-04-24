import { describe, expect, test } from "bun:test"
import path from "path"
import { Session } from "../../src/session"
import { Log } from "../../src/util/log"
import { Instance } from "../../src/scope/instance"
import { Scope } from "../../src/scope"
import { Server } from "../../src/server/server"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

describe("Server.App() current contract", () => {
  describe("current session routes", () => {
    test("should list and create sessions through /session routes", async () => {
      await Instance.provide({
        scope: (await Scope.fromDirectory(projectRoot)).scope,
        fn: async () => {
          const app = Server.App()
          const created = await app.request("/session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: "Test Session" }),
          })

          expect(created.status).toBe(200)
          const session = await created.json()
          expect(session).toHaveProperty("id")
          expect(session.title).toBe("Test Session")

          const listed = await app.request("/session", { method: "GET" })
          expect(listed.status).toBe(200)
          const result = await listed.json()
          expect(result).toHaveProperty("data")
          expect(result).toHaveProperty("total")
          expect(result.data.some((item: any) => item.id === session.id)).toBe(true)

          await Session.remove(session.id)
        },
      })
    })

    test("should return 404 for a missing session on current session routes", async () => {
      await Instance.provide({
        scope: (await Scope.fromDirectory(projectRoot)).scope,
        fn: async () => {
          const app = Server.App()
          const response = await app.request("/session/ses_nonexistent123", {
            method: "GET",
          })

          expect(response.status).toBe(404)
        },
      })
    })
  })
})
