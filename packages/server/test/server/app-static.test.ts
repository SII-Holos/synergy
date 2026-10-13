import { describe, expect, test } from "bun:test"
import path from "node:path"
import { resolveAppStaticRequest } from "@ericsanchezok/synergy-server/server/app-static"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
import { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { Server } from "../../src/server/server"
import { webApp } from "../../src/web-app"

const navigationHeaders = { accept: "text/html", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" }

async function appRuntime(directory: string, token?: string) {
  return testRuntime({
    env: token ? { SYNERGY_SERVER_TOKEN: token } : {},
    composition: {
      register() {
        registerLocalRuntime()
        Server.registerContributions({
          routes: {
            "scoped-before-assets": new Hono()
              .get(
                "/library",
                describeRoute({ operationId: "library.fixture", responses: { 200: { description: "Records" } } }),
                (c) => c.json({ scopeID: ScopeContext.current.scope.id }),
              )
              .get("/agenda", (c) => c.json({ items: [] }))
              .get("/performance", (c) => c.json({ snapshot: true }))
              .get("/library/missing", (c) => c.json({ name: "MissingLibraryRecord" }, 404))
              .post("/library", (c) => c.json({ name: "InvalidLibraryInput" }, 400)),
          },
        })
        webApp({ directory }).register()
      },
    },
  })
}

describe("Web app static routing", () => {
  test("serves existing deep-route assets but never falls missing assets through to the SPA", async () => {
    await using tmp = await tmpdir()
    const asset = path.join(tmp.path, "assets", "panel.js")
    await Bun.write(asset, "export {}")

    expect(await resolveAppStaticRequest(tmp.path, "/home/session/assets/panel.js")).toEqual({
      type: "file",
      path: asset,
      immutable: true,
    })
    expect(await resolveAppStaticRequest(tmp.path, "/home/session/assets/missing.js")).toEqual({
      type: "missing",
    })
    expect(await resolveAppStaticRequest(tmp.path, "/favicon-missing.svg")).toEqual({
      type: "missing",
    })
    expect(await resolveAppStaticRequest(tmp.path, "/home/session/session-1")).toEqual({
      type: "spa",
    })
  })

  test("browser navigation loads the shell on optional UI paths without intercepting their JSON APIs", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "index.html"), "<html><head></head><body>Web shell</body></html>")
    await using runtime = await appRuntime(tmp.path)
    await runtime.run(async () => {
      Server.mountApp()
      const app = Server.App()
      for (const route of ["/library", "/agenda", "/kanban", "/performance", "/plugins/marketplace"]) {
        const document = await app.request(route, { headers: navigationHeaders })
        expect(document.status).toBe(200)
        expect(document.headers.get("content-type")).toContain("text/html")
        expect(document.headers.get("cache-control")).toBe("no-cache")
        expect(document.headers.get("content-security-policy")).toBe(Server.spaCsp())
        expect(document.headers.get("x-synergy-seq")).not.toBeNull()
        expect(await document.text()).toContain(`window.__SYNERGY_ROUTE__=${JSON.stringify(route)}`)
      }
      for (const accept of ["application/json", "*/*", "text/html;q=0,application/json"]) {
        const response = await app.request("/library?scopeID=home", { headers: { accept } })
        expect(response.headers.get("content-type")).toContain("application/json")
        expect(await response.json()).toEqual({ scopeID: "home" })
      }
      const fetch = await app.request("/library", {
        headers: { accept: "text/html", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" },
      })
      expect(await fetch.json()).toEqual({ scopeID: "home" })
      const legacy = await app.request("/library", { headers: { accept: "text/html" } })
      expect(legacy.headers.get("content-type")).toContain("text/html")
      const missing = await app.request("/library/missing", { headers: navigationHeaders })
      expect(missing.status).toBe(404)
      expect(await missing.json()).toEqual({ name: "MissingLibraryRecord" })
      const mutation = await app.request("/library", { method: "POST", headers: navigationHeaders })
      expect(mutation.status).toBe(400)
      expect(await mutation.json()).toEqual({ name: "InvalidLibraryInput" })
      const asset = await app.request("/assets/missing.js", { headers: navigationHeaders })
      expect(asset.status).toBe(404)
      expect((await Server.openapi()).paths?.["/library"]?.get?.operationId).toBe("library.fixture")
    })
  })

  test("optional page navigation retains runtime authentication, Scope errors and CORS", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "index.html"), "<html><body>Protected shell</body></html>")
    await using runtime = await appRuntime(tmp.path, "navigation-fixture")
    await runtime.run(async () => {
      Server.mountApp()
      const app = Server.App()
      const unauthorized = await app.request("/library", { headers: navigationHeaders })
      expect(unauthorized.status).toBe(401)
      expect((await unauthorized.json()).name).toBe("Unauthorized")
      const headers = {
        ...navigationHeaders,
        authorization: "Bearer navigation-fixture",
        origin: "http://localhost:9876",
      }
      const document = await app.request("/library?scopeID=home", { headers })
      expect(document.status).toBe(200)
      expect(document.headers.get("content-type")).toContain("text/html")
      expect(document.headers.get("access-control-allow-origin")).toBe(headers.origin)
      const invalidScope = await app.request("/library?scopeID=missing-scope", { headers })
      expect(invalidScope.status).toBe(404)
      expect((await invalidScope.json()).name).toBe("ScopeNotFound")
    })
  })
})
