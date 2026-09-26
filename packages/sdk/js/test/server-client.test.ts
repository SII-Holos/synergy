import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { createSynergy } from "../src/index"
import { createSynergyClient } from "../src/client"
import { createSynergyServer, type ManagedServerOptions } from "../src/server"

const FAKE_SCRIPT = String.raw`#!/usr/bin/env bun
const args = process.argv.slice(2)
const mode = process.env.FAKE_MODE ?? "server"
const logPath = process.env.FAKE_ARGS_LOG
if (logPath) await Bun.write(logPath, JSON.stringify({ args, pid: process.pid, root: process.env.SYNERGY_RUNTIME_ROOT, authenticated: !!process.env.SYNERGY_SERVER_TOKEN, config: JSON.parse(process.env.SYNERGY_CONFIG_CONTENT ?? "{}") }))
if (mode === "exit") process.exit(3)
if (mode === "silent") await new Promise(() => {})
const portArg = args.find((argument) => argument.startsWith("--port="))
const server = Bun.serve({
  port: Number(portArg?.split("=")[1] ?? 0),
  fetch(request) {
    if (request.headers.get("authorization") !== "Bearer " + process.env.SYNERGY_SERVER_TOKEN) return new Response("Unauthorized", { status: 401 })
    if (new URL(request.url).pathname.endsWith("/invoke")) return Response.json({ ok: true, data: { result: "roundtrip" } })
    return Response.json({ healthy: true })
  },
})
const ready = { protocol: 1, pid: process.pid, version: mode === "version" ? "2.0.0" : "1.0.0", home: process.env.SYNERGY_RUNTIME_ROOT, url: "http://127.0.0.1:" + server.port, components: [{ id: "server", version: "1.0.0", apiVersion: 1 }] }
if (mode === "component") ready.components = []
console.log("unrelated output")
const line = "SYNERGY_READY_V1 " + JSON.stringify(ready) + "\n"
process.stdout.write(line.slice(0, 29))
setTimeout(() => process.stdout.write(line.slice(29)), 5)
await new Promise(() => {})
`

async function withFakeSynergy<T>(mode: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synergy-sdk-fake-"))
  await writeFile(path.join(dir, "server.ts"), FAKE_SCRIPT)
  const previous = process.env.FAKE_MODE
  process.env.FAKE_MODE = mode
  try {
    return await fn(dir)
  } finally {
    if (previous === undefined) delete process.env.FAKE_MODE
    else process.env.FAKE_MODE = previous
    await rm(dir, { recursive: true, force: true })
  }
}

function managed(dir: string): ManagedServerOptions {
  return {
    mode: "managed",
    executable: process.execPath,
    args: [path.join(dir, "server.ts")],
    version: "1.0.0",
    home: path.join(dir, "data"),
    components: { server: "1.0.0" },
    timeout: 5_000,
  }
}
const originalArgsLog = process.env.FAKE_ARGS_LOG
afterEach(() => {
  if (originalArgsLog === undefined) delete process.env.FAKE_ARGS_LOG
  else process.env.FAKE_ARGS_LOG = originalArgsLog
})
const capturingFetch = (captured: { request?: Request }) =>
  (async (request: Request) => {
    captured.request = request
    return new Response(JSON.stringify({ data: { ok: true } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof fetch

describe("managed Synergy runtime", () => {
  test("uses the server command, explicit home, dynamic port and structured readiness with private auth", async () => {
    await withFakeSynergy("server", async (dir) => {
      process.env.FAKE_ARGS_LOG = path.join(dir, "args.json")
      const { client, server } = await createSynergy({ ...managed(dir), config: { logLevel: "DEBUG" } })
      try {
        expect(server.owned).toBe(true)
        expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
        const recorded = await Bun.file(process.env.FAKE_ARGS_LOG!).json()
        expect(recorded.args).toEqual([
          "server",
          "--hostname=127.0.0.1",
          "--port=0",
          "--managed-ready",
          "--no-banner",
          "--non-interactive",
          "--log-level=DEBUG",
        ])
        expect(recorded.root).toBe(managed(dir).home)
        expect(recorded.authenticated).toBe(true)
        expect((await fetch(server.url)).status).toBe(401)
        expect(JSON.stringify(await client.plugin.invoke("focus", "op", {}))).toContain("roundtrip")
      } finally {
        await server.close()
      }
      expect(() => process.kill(server.pid!, 0)).toThrow()
      await server.close()
    })
  })

  for (const mode of ["silent", "exit", "version", "component"]) {
    test(`cleans its own process after ${mode} readiness failure`, async () => {
      await withFakeSynergy(mode, async (dir) => {
        process.env.FAKE_ARGS_LOG = path.join(dir, "args.json")
        await expect(
          createSynergyServer({ ...managed(dir), timeout: mode === "silent" ? 250 : 5_000 }),
        ).rejects.toThrow()
        const record = await Bun.file(process.env.FAKE_ARGS_LOG!).json()
        expect(() => process.kill(record.pid, 0)).toThrow()
      })
    })
  }

  test("abort drains the owned process during startup and after readiness", async () => {
    await withFakeSynergy("silent", async (dir) => {
      const controller = new AbortController()
      const starting = createSynergyServer({ ...managed(dir), signal: controller.signal })
      setTimeout(() => controller.abort(), 50)
      await expect(starting).rejects.toThrow(/abort/i)
    })
    await withFakeSynergy("server", async (dir) => {
      const controller = new AbortController()
      const server = await createSynergyServer({ ...managed(dir), signal: controller.signal })
      controller.abort()
      await server.close()
      expect(() => process.kill(server.pid!, 0)).toThrow()
    })
  })

  test("attaching preserves supplied credentials and close leaves the existing server running", async () => {
    const existing = Bun.serve({
      port: 0,
      fetch: (request) =>
        request.headers.get("authorization") === "Bearer existing"
          ? Response.json({ healthy: true, version: "1.0.0" })
          : new Response("unauthorized", { status: 401 }),
    })
    try {
      const attached = await createSynergyServer({
        mode: "attach",
        url: existing.url.href,
        headers: { authorization: "Bearer existing" },
      })
      expect(attached.owned).toBe(false)
      await attached.close()
      expect((await fetch(existing.url, { headers: attached.headers })).status).toBe(200)
    } finally {
      existing.stop(true)
    }
  })
})

describe("synergy sdk client", () => {
  test("Scope selection retains caller Headers and managed credentials with an injected fetch", async () => {
    const captured: { request?: Request } = {}
    const client = createSynergyClient({
      baseUrl: "http://synergy.test",
      directory: "/project",
      scopeID: "home",
      headers: new Headers({ authorization: "Bearer test", "x-company": "fixture" }),
      fetch: capturingFetch(captured),
    })
    await client.plugin.invoke("focus", "op", {})
    expect(captured.request?.headers.get("authorization")).toBe("Bearer test")
    expect(captured.request?.headers.get("x-company")).toBe("fixture")
    expect(captured.request?.headers.get("x-synergy-directory")).toBe("/project")
  })
  test("round-trips a plugin invoke against the fake server", async () => {
    await withFakeSynergy("serve", async (dir) => {
      const server = await createSynergyServer(managed(dir))
      try {
        const client = createSynergyClient({ baseUrl: server.url, headers: server.headers })
        const response = await client.plugin.invoke(
          "focus",
          "research.graph.get",
          { revision: 1 },
          {
            sessionId: "session-one",
          },
        )
        expect(JSON.stringify(response)).toContain("roundtrip")
      } finally {
        await server.close()
      }
    })
  })

  test("sends directory and scope from invoke options as query parameters", async () => {
    const captured: { request?: Request } = {}
    const client = createSynergyClient({
      baseUrl: "http://synergy.test",
      fetch: capturingFetch(captured),
    })

    await client.plugin.invoke(
      "focus",
      "op",
      { x: 1 },
      {
        sessionId: "s1",
        directory: "/path/中文",
        scopeID: "scope/1",
      },
    )

    expect(captured.request?.url).toContain("directory=%2Fpath%2F%E4%B8%AD%E6%96%87")
    expect(captured.request?.url).toContain("scopeID=scope%2F1")
  })

  test("applies directory and scope headers from client config", async () => {
    const captured: { request?: Request } = {}
    const client = createSynergyClient({
      baseUrl: "http://synergy.test",
      directory: "/ascii/path",
      scopeID: "scope-9",
      fetch: capturingFetch(captured),
    })

    await client.plugin.invoke("focus", "op", { x: 1 })

    expect(captured.request?.headers.get("x-synergy-directory")).toBe("/ascii/path")
    expect(captured.request?.headers.get("x-synergy-scope-id")).toBe("scope-9")
  })
})
