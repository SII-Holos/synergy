import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { generateSpecs } from "hono-openapi"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { Server } from "@ericsanchezok/synergy-server/server/server"
import { BrowserPreviewRoutes } from "../../src/routes/browser-preview-route"
import { registerHttp } from "../../src/http"
import { htmlPreview, previewFixture } from "../support/preview"
import { testRuntime } from "../support/runtime"

const authorization = "Bearer preview-runtime-fixture"

function previewRequest(
  body: unknown = { url: "https://docs.example.org/document#part" },
  headers: Record<string, string> = {},
) {
  return {
    method: "POST",
    headers: { authorization, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }
}

describe("BrowserPreviewRoutes authenticated Scope composition", () => {
  test("uses Server authentication, does not require a native ticket, and creates no Session, Browser page or identity", async () => {
    await using fixture = previewFixture(() => htmlPreview())
    await using runtime = await testRuntime(
      () =>
        Server.registerContributions({
          routes: { "scoped-after-assets": new Hono().route("", BrowserPreviewRoutes(fixture.options)) },
        }),
      { SYNERGY_SERVER_TOKEN: "preview-runtime-fixture" },
    )
    await runtime.run(async () => {
      const app = Server.App()
      const before = await Storage.list(["browser"])
      const sessions = await Storage.list(["session"])
      const unauthorized = await app.request(
        "/home/browser/preview?mode=scope&scopeID=home",
        previewRequest(undefined, { authorization: "Bearer wrong" }),
      )
      expect(unauthorized.status).toBe(401)
      expect(fixture.requests).toHaveLength(0)
      const result = await app.request("/home/browser/preview?mode=scope&scopeID=home", previewRequest())
      expect(result.status).toBe(200)
      expect(result.headers.get("cache-control")).toBe("no-store")
      expect(await result.json()).toEqual({
        source: "docs.example.org",
        path: "/document#part",
        title: "Public document",
        description: "Anonymous public description",
      })
      expect(fixture.requests).toHaveLength(1)
      expect(fixture.requests[0].headers.has("authorization")).toBe(false)
      expect(await Storage.list(["browser"])).toEqual(before)
      expect(await Storage.list(["session"])).toEqual(sessions)
      expect(await Storage.readMany([["browser", "profiles-v1"]])).toEqual([undefined])
    })
  })

  test("keeps target query, userinfo and caller credentials out of response and runtime logs", async () => {
    await using fixture = previewFixture(() => htmlPreview())
    await using runtime = await testRuntime(
      () => Server.registerContributions({ routes: { "scoped-after-assets": BrowserPreviewRoutes(fixture.options) } }),
      { SYNERGY_SERVER_TOKEN: "preview-runtime-fixture" },
    )
    await runtime.run(async () => {
      await Log.init({ print: false, level: "DEBUG" })
      const secret = "preview-fixture-sensitive-value"
      for (const url of [
        `https://docs.example.org/document?access_token=${secret}`,
        `https://fixture-user:${secret}@docs.example.org/document`,
      ]) {
        const result = await Server.App().request(
          "/home/browser/preview?scopeID=home",
          previewRequest(
            { url },
            {
              cookie: `website=${secret}`,
              referer: `https://private.example.org/${secret}`,
            },
          ),
        )
        expect(result.status).toBe(200)
        expect(JSON.stringify(await result.json())).not.toContain(secret)
      }
      await Log.close()
      const output = await Bun.file(Log.file()).text()
      expect(output).toContain("/home/browser/preview")
      expect(output).not.toContain(secret)
      expect(output).not.toContain("fixture-user")
      expect(output).not.toContain("preview-runtime-fixture")
      expect(fixture.requests).toHaveLength(0)
    })
  })

  test("validates request shape and Scope without dispatching any upstream request", async () => {
    await using fixture = previewFixture(() => htmlPreview())
    await using runtime = await testRuntime(() =>
      Server.registerContributions({ routes: { "scoped-after-assets": BrowserPreviewRoutes(fixture.options) } }),
    )
    await runtime.run(async () => {
      const app = Server.App()
      for (const body of [{}, { url: 42 }, { url: "https://docs.example.org/document", authorization: "private" }]) {
        expect((await app.request("/home/browser/preview?mode=scope", previewRequest(body))).status).toBe(400)
      }
      expect(
        (await app.request("/home/browser/preview?mode=session&sessionID=ses_fake", previewRequest())).status,
      ).toBe(400)
      expect((await app.request("/home/browser/preview?scopeID=missing-scope", previewRequest())).status).not.toBe(200)
      expect((await app.request("/home/browser/preview", previewRequest({ url: "a".repeat(40_000) }))).status).toBe(413)
      expect(fixture.requests).toHaveLength(0)
      expect(fixture.connections).toHaveLength(0)
    })
  })

  test("rejects a mismatched mounted Scope before DNS instead of inferring owner from path", async () => {
    await using fixture = previewFixture(() => htmlPreview())
    await using runtime = await testRuntime()
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          const result = await BrowserPreviewRoutes(fixture.options).request(
            "/other-directory/browser/preview?scopeID=other-scope",
            previewRequest(),
          )
          expect(result.status).toBe(400)
          expect(await result.json()).toEqual({
            code: "browser_preview_scope_mismatch",
            message: "Preview Scope does not match the request context.",
          })
          expect(fixture.connections).toHaveLength(0)
          expect(fixture.requests).toHaveLength(0)
        },
      }),
    )
  })

  test("propagates request cancellation and does not leak caller credentials into the response", async () => {
    await using fixture = previewFixture(() => htmlPreview())
    await using runtime = await testRuntime(() =>
      Server.registerContributions({ routes: { "scoped-after-assets": BrowserPreviewRoutes(fixture.options) } }),
    )
    await runtime.run(async () => {
      const controller = new AbortController()
      controller.abort(new Error("fixture-secret-cancellation"))
      const result = await Server.App().request("/home/browser/preview?scopeID=home", {
        ...previewRequest(),
        signal: controller.signal,
      })
      expect(result.status).toBe(200)
      const body = await result.json()
      expect(body).toMatchObject({ source: "docs.example.org", unavailable: "cancelled" })
      expect(JSON.stringify(body)).not.toContain("fixture-secret")
      expect(fixture.requests).toHaveLength(0)
    })
  })

  test("publishes browser.preview and its typed result on the mounted parent OpenAPI contract", async () => {
    const parent = new Hono().route("", BrowserPreviewRoutes())
    const spec = await generateSpecs(parent, { documentation: { info: { title: "Browser preview", version: "1" } } })
    expect(spec.paths?.["/{directory}/browser/preview"]?.post?.operationId).toBe("browser.preview")
    expect(spec.components?.schemas?.BrowserPreviewResult).toBeDefined()
    const operation = spec.paths?.["/{directory}/browser/preview"]?.post
    expect(operation?.requestBody).toBeDefined()
    expect(operation?.responses?.["200"]).toBeDefined()
  })

  test("exposes the production HTTP contribution in pure Web without a native ticket and preserves its OpenAPI operation", async () => {
    await using runtime = await testRuntime(registerHttp)
    await runtime.run(async () => {
      const result = await Server.App().request(
        "/home/browser/preview?scopeID=home&mode=scope",
        previewRequest({ url: "http://127.0.0.1/private" }),
      )
      expect(result.status).toBe(200)
      expect(await result.json()).toMatchObject({ source: "127.0.0.1", unavailable: "blocked_address" })
      const spec = await Server.openapi()
      expect(spec.paths?.["/{directory}/browser/preview"]?.post?.operationId).toBe("browser.preview")
    })
  })
})
