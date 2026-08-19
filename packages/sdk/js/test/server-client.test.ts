import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { createSynergy } from "../src/index"
import { createSynergyClient } from "../src/client"
import { createSynergyServer, createSynergyTui } from "../src/server"

const FAKE_SCRIPT = `#!/usr/bin/env bun
const args = process.argv.slice(2)
const mode = process.env.FAKE_MODE ?? "serve"
const logPath = process.env.FAKE_ARGS_LOG
if (logPath) {
  await Bun.write(logPath, JSON.stringify({ args, config: JSON.parse(process.env.SYNERGY_CONFIG_CONTENT ?? "{}") }))
}
if (mode === "exit") {
  console.error("fake synergy crashed on purpose")
  process.exit(3)
}
if (mode === "badoutput") {
  console.log("synergy server listening on nowhere")
  setTimeout(() => process.exit(0), 2_000)
  await new Promise(() => {})
}
if (mode === "silent") {
  setTimeout(() => process.exit(0), 2_000)
  await new Promise(() => {})
}
if (mode === "tui-log") {
  setTimeout(() => process.exit(0), 5_000)
  await new Promise(() => {})
}
const portArg = args.find((argument) => argument.startsWith("--port="))
const requested = portArg ? Number(portArg.split("=")[1]) : 4096
const server = Bun.serve({
  port: requested || 0,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname.endsWith("/invoke")) {
      return Response.json({ ok: true, data: { result: "roundtrip" } })
    }
    return Response.json({ ok: true })
  },
})
console.log("synergy server listening on http://127.0.0.1:" + server.port)
await new Promise(() => {})
`

async function withFakeSynergy<T>(mode: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synergy-sdk-fake-"))
  const binPath = path.join(dir, "synergy")
  await writeFile(binPath, FAKE_SCRIPT, { mode: 0o755 })
  const originalPath = process.env.PATH
  const originalMode = process.env.FAKE_MODE
  process.env.PATH = `${dir}:${originalPath}`
  process.env.FAKE_MODE = mode
  try {
    return await fn(dir)
  } finally {
    process.env.PATH = originalPath
    if (originalMode === undefined) delete process.env.FAKE_MODE
    else process.env.FAKE_MODE = originalMode
    await rm(dir, { recursive: true, force: true })
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

describe("synergy sdk server", () => {
  test("starts a fake synergy server and closes it", async () => {
    await withFakeSynergy("serve", async () => {
      const server = await createSynergyServer({ port: 0, timeout: 5_000 })
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      server.close()
    })
  })

  test("passes hostname, port, and log level through the argv", async () => {
    await withFakeSynergy("serve", async (dir) => {
      const logPath = path.join(dir, "args.json")
      process.env.FAKE_ARGS_LOG = logPath
      const server = await createSynergyServer({
        hostname: "0.0.0.0",
        port: 4567,
        config: { logLevel: "DEBUG" },
        timeout: 5_000,
      })
      server.close()
      const recorded = JSON.parse(await Bun.file(logPath).text()) as {
        args: string[]
        config: Record<string, unknown>
      }
      expect(recorded.args).toEqual(["serve", "--hostname=0.0.0.0", "--port=4567", "--log-level=DEBUG"])
      expect(recorded.config).toEqual({ logLevel: "DEBUG" })
    })
  })

  test("defaults to localhost, port 4096, and an empty config payload", async () => {
    await withFakeSynergy("serve", async (dir) => {
      const logPath = path.join(dir, "args.json")
      process.env.FAKE_ARGS_LOG = logPath
      const server = await createSynergyServer({ timeout: 5_000 })
      server.close()
      const recorded = JSON.parse(await Bun.file(logPath).text()) as { args: string[]; config: unknown }
      expect(recorded.args).toEqual(["serve", "--hostname=127.0.0.1", "--port=4096"])
      expect(recorded.config).toEqual({})
    })
  })

  test("rejects when the server never announces a listening url", async () => {
    await withFakeSynergy("silent", async () => {
      await expect(createSynergyServer({ port: 0, timeout: 250 })).rejects.toThrow(
        "Timeout waiting for server to start after 250ms",
      )
    })
  })

  test("rejects when the server exits early", async () => {
    await withFakeSynergy("exit", async () => {
      await expect(createSynergyServer({ port: 0, timeout: 5_000 })).rejects.toThrow(/Server exited with code 3/)
    })
  })

  test("rejects when the listening line has no parseable url", async () => {
    await withFakeSynergy("badoutput", async () => {
      const child = Bun.spawn([process.execPath, "test/fixtures/badoutput-runner.ts"], {
        env: { ...process.env },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
      expect(exitCode).not.toBe(0)
      expect(stderr).toContain("Failed to parse server url from output")
    })
  })

  test("rejects on an aborted signal", async () => {
    await withFakeSynergy("silent", async () => {
      const controller = new AbortController()
      const starting = createSynergyServer({ port: 0, timeout: 5_000, signal: controller.signal })
      setTimeout(() => controller.abort(), 50)
      await expect(starting).rejects.toThrow(/aborted/i)
    })
  })

  test("launches the tui with project, model, session, and agent flags", async () => {
    await withFakeSynergy("tui-log", async (dir) => {
      const logPath = path.join(dir, "args.json")
      process.env.FAKE_ARGS_LOG = logPath
      const tui = createSynergyTui({ project: "proj", model: "model_x", session: "sess", agent: "agent_y" })
      const deadline = Date.now() + 3_000
      while (!(await Bun.file(logPath).exists()) && Date.now() < deadline) {
        await Bun.sleep(20)
      }
      tui.close()
      const recorded = JSON.parse(await Bun.file(logPath).text()) as { args: string[] }
      expect(recorded.args).toEqual(["--project=proj", "--model=model_x", "--session=sess", "--agent=agent_y"])
    })
  })
})

describe("synergy sdk client", () => {
  test("round-trips a plugin invoke against the fake server", async () => {
    await withFakeSynergy("serve", async () => {
      const server = await createSynergyServer({ port: 0, timeout: 5_000 })
      try {
        const client = createSynergyClient({ baseUrl: server.url })
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
        server.close()
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

describe("synergy sdk entry", () => {
  test("createSynergy wires a server and client for a round trip", async () => {
    await withFakeSynergy("serve", async () => {
      const { client, server } = await createSynergy({ port: 0, timeout: 5_000 })
      try {
        expect(server.url).toMatch(/^http:\/\//)
        const response = await client.plugin.invoke("focus", "research.graph.get", { revision: 2 })
        expect(JSON.stringify(response)).toContain("roundtrip")
      } finally {
        server.close()
      }
    })
  })
})
