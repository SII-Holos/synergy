import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import path from "path"

const homes: string[] = []
const servers: ReturnType<typeof Bun.serve>[] = []

async function isolatedHome(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "mcp-cli-home-"))
  homes.push(dir)
  return dir
}

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true)
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})

type StubState = "connected" | "needs_auth" | "disabled"

function startStub(state: StubState) {
  const requests: string[] = []
  const status = (value: string) =>
    value === "needs_auth"
      ? {
          name: "demo",
          status: value,
          error: "Server requires OAuth authentication. Run: synergy mcp auth demo",
        }
      : { name: "demo", status: value }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname
      requests.push(`${request.method} ${pathname}`)
      if (pathname === "/global/health") return Response.json({ healthy: true, version: "0.0.0" })
      if (pathname === "/mcp") return Response.json({ demo: status(state) })
      if (pathname === "/mcp/demo/connect") return Response.json(true)
      if (pathname === "/mcp/demo/test")
        return Response.json(status(state === "connected" ? "connected" : "needs_auth"))
      if (pathname === "/mcp/demo/restart") {
        return Response.json({ name: "demo", status: "reconnecting", attempt: 1, maxAttempts: 3 })
      }
      return new Response("not found", { status: 404 })
    },
  })
  servers.push(server)
  return { url: `http://127.0.0.1:${server.port}`, requests }
}

async function mcpCli(args: string[], home: string) {
  const proc = Bun.spawn([process.execPath, "--conditions=browser", "src/index.ts", ...args], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: { ...process.env, SYNERGY_HOME: home, NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, output: stdout + stderr }
}

describe("mcp connect and restart CLI", () => {
  test("connect drives the running server over HTTP and reports the settled status", async () => {
    const { url, requests } = startStub("connected")

    const result = await mcpCli(["mcp", "connect", "demo", "--attach", url], await isolatedHome())

    expect(result.exitCode).toBe(0)
    expect(requests).toEqual(["GET /global/health", "GET /mcp", "POST /mcp/demo/connect", "GET /mcp/demo/test"])
    expect(result.output).toContain("demo")
    expect(result.output).toContain("connected")
  })

  test("connect fails loudly with the server's actionable reason when the server needs authorization", async () => {
    const { url } = startStub("needs_auth")

    const result = await mcpCli(["mcp", "connect", "demo", "--attach", url], await isolatedHome())

    expect(result.exitCode).toBe(1)
    expect(result.output).toContain("Server requires OAuth authentication. Run: synergy mcp auth demo")
  })

  test("connect exits nonzero with a recovery hint when no server is reachable", async () => {
    const result = await mcpCli(["mcp", "connect", "demo", "--attach", "http://127.0.0.1:1"], await isolatedHome())

    expect(result.exitCode).toBe(1)
    expect(result.output).toContain("No running server found at http://127.0.0.1:1")
    expect(result.output).toContain("synergy start")
  })

  test("restart posts to the running server and prints the initiated status", async () => {
    const { url, requests } = startStub("connected")

    const result = await mcpCli(["mcp", "restart", "demo", "--attach", url], await isolatedHome())

    expect(result.exitCode).toBe(0)
    expect(requests).toEqual(["GET /global/health", "GET /mcp", "POST /mcp/demo/restart"])
    expect(result.output).toContain("reconnecting (1/3)")
  })
})
