import { describe, expect, test } from "bun:test"
import { startupScopeLabel } from "../../src/server/runtime"
import { Server } from "../../src/server/server"
import { Scope } from "../../src/scope"
import { tmpdir } from "../fixture/fixture"
import { Global } from "../../src/global"

describe("server runtime startup output", () => {
  test("startup scope label does not require a scope context", () => {
    expect(() => startupScopeLabel()).not.toThrow()
    expect(startupScopeLabel()).toBeTruthy()
  })
})

describe("server request scope boundaries", () => {
  test("global routes do not require directory and do not resolve a project scope", async () => {
    const original = Scope.fromDirectory
    let called = false
    ;(Scope as any).fromDirectory = async () => {
      called = true
      throw new Error("global route resolved a project scope")
    }
    try {
      const app = Server.App()
      const response = await app.request("/log", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ service: "test", level: "info", message: "hello" }),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toBe(true)
      expect(called).toBe(false)
    } finally {
      ;(Scope as any).fromDirectory = original
    }
  })

  test("scoped routes return ScopeRequired when directory is missing", async () => {
    const app = Server.App()
    const response = await app.request("/path", { method: "GET" })
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.name).toBe("ScopeRequired")
  })

  test("global paths route does not require a scope", async () => {
    const app = Server.App()
    const response = await app.request("/global/paths", { method: "GET" })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.home).toBe(Global.Path.home)
    expect(body.root).toBe(Global.Path.root)
  })

  test("scoped routes use home scopeID without resolving a project directory", async () => {
    const original = Scope.fromDirectory
    let called = false
    ;(Scope as any).fromDirectory = async () => {
      called = true
      throw new Error("home scope resolved a project directory")
    }
    try {
      const app = Server.App()
      const response = await app.request("/path?scopeID=home", { method: "GET" })
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.directory).toBe(Global.Path.home)
      expect(called).toBe(false)
    } finally {
      ;(Scope as any).fromDirectory = original
    }
  })

  test("scoped routes use the explicit directory when provided", async () => {
    await using tmp = await tmpdir()
    const app = Server.App()
    const response = await app.request(`/path?directory=${encodeURIComponent(tmp.path)}`, { method: "GET" })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.directory).toBe(tmp.path)
  })

  test("hybrid routes use explicit directory when provided", async () => {
    await using tmp = await tmpdir({
      config: {
        model: "test-provider/test-model",
      },
    })
    const app = Server.App()
    const response = await app.request(`/config?directory=${encodeURIComponent(tmp.path)}`, { method: "GET" })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.model).toBe("test-provider/test-model")
  })
})
