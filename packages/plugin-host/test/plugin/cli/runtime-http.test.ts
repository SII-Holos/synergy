import { afterEach, expect, mock, spyOn, test } from "bun:test"
import yargs from "yargs"
import { UI } from "@ericsanchezok/synergy-cli/util/ui"
import { PluginRuntimeCommand } from "../../../src/plugin/cli/plugin-runtime"
import { PluginInfoCommand } from "../../../src/plugin/cli/plugin-info"
import { fetchPluginApi, fetchRegistryApi, PluginApiError } from "../../../src/plugin/cli/plugin-server"

afterEach(() => mock.restore())

test("plugin runtime commands use the requested server and preserve lifecycle methods and logs", async () => {
  const lines: string[] = []
  spyOn(UI, "println").mockImplementation((...args) => {
    lines.push(args.join(" "))
  })
  const requests: Array<{ path: string; method: string }> = []
  let hasRuntime = true
  let logs = [{ timestamp: 1, level: "info", message: "fixture ready" }]
  const runtime = {
    mode: "process",
    state: "ready",
    pid: 321,
    inFlight: 2,
    lastHeartbeatAt: 1,
    lastError: "fixture diagnostic",
  }
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      requests.push({ path: url.pathname, method: request.method })
      if (url.pathname === "/global/health") return Response.json({ healthy: true, version: "test" })
      if (url.pathname.endsWith("/status")) return Response.json({ runtime: hasRuntime ? runtime : null })
      if (url.pathname.endsWith("/logs")) return Response.json(logs)
      return Response.json(hasRuntime ? runtime : null)
    },
  })
  const run = (verb: string) =>
    yargs()
      .exitProcess(false)
      .command(PluginRuntimeCommand)
      .parseAsync(["runtime", verb, "demo", "--attach", server.url.href])
  try {
    await run("status")
    await run("restart")
    await run("stop")
    await run("logs")
    hasRuntime = false
    logs = []
    await run("status")
    await run("restart")
    await run("logs")
    expect(requests).toContainEqual({ path: "/api/plugins/demo/runtime/reload", method: "POST" })
    expect(requests).toContainEqual({ path: "/api/plugins/demo/runtime/stop", method: "POST" })
    expect(lines.join("\n")).toContain("fixture ready")
    expect(lines.join("\n")).toContain("fixture diagnostic")
    expect(lines.join("\n")).toContain("no active runtime")
    expect(lines.join("\n")).toContain("no runtime info returned")
    expect(lines.join("\n")).toContain("No logs captured")
  } finally {
    server.stop(true)
  }
})

test("plugin info preserves approval instructions and degraded contribution diagnostics", async () => {
  const lines: string[] = []
  spyOn(UI, "println").mockImplementation((...args) => {
    lines.push(args.join(" "))
  })
  const status = {
    id: "demo",
    name: "Demo",
    version: "1.0",
    apiVersion: "4",
    generation: "g",
    installation: { kind: "directory", path: "/fixture" },
    trust: "trusted-import",
    loaded: false,
    disabledReason: "needs approval",
    disabledPhase: "approval",
    capabilities: ["file_read"],
    tools: [{ id: "read", capabilities: ["file_read"] }],
    operations: [{ id: "inspect", type: "query", expose: ["cli"] }],
    uiContributions: 0,
    contributionHealth: { read: { state: "degraded", lastError: "fixture failure" } },
    runtime: { mode: "process", state: "crashed", inFlight: 0, pid: 321, lastError: "fixture crash" },
  }
  const server = Bun.serve({
    port: 0,
    fetch: (request) =>
      Response.json(new URL(request.url).pathname === "/global/health" ? { healthy: true, version: "test" } : status),
  })
  try {
    await yargs()
      .exitProcess(false)
      .command(PluginInfoCommand)
      .parseAsync(["info", "demo", "--attach", server.url.href])
    expect(lines.join("\n")).toContain("synergy plugin approve demo")
    expect(lines.join("\n")).toContain("directory (/fixture)")
    expect(lines.join("\n")).toContain("fixture failure")
    expect(lines.join("\n")).toContain("fixture crash")
  } finally {
    server.stop(true)
  }
})

test("plugin HTTP transport preserves structured and plain-text failures, method and request body", async () => {
  let response = Response.json(
    { code: "approval_required", message: "review first", review: { id: "r" } },
    { status: 409 },
  )
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname.startsWith("/api/registry"))
        return Response.json({ method: request.method, body: await request.json() })
      return response
    },
  })
  try {
    await expect(fetchPluginApi(server.url.href, "/demo")).rejects.toMatchObject({
      status: 409,
      body: { code: "approval_required", review: { id: "r" } },
    })
    response = new Response("fixture failure", { status: 500 })
    await expect(fetchPluginApi(server.url.href, "/demo")).rejects.toMatchObject({
      message: "fixture failure",
      status: 500,
    })
    response = new Response(null, { status: 503 })
    await expect(fetchPluginApi(server.url.href, "/demo")).rejects.toBeInstanceOf(PluginApiError)
    expect(
      await fetchRegistryApi<{ method: string; body: { id: string } }>(server.url.href, "/publish", "POST", {
        id: "demo",
      }),
    ).toEqual({ method: "POST", body: { id: "demo" } })
  } finally {
    server.stop(true)
  }
})
