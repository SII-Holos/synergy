import { afterEach, expect, mock, spyOn, test } from "bun:test"
import yargs from "yargs"
import type { CommandModule } from "yargs"
import type { RuntimeOptions } from "../../src/server/runtime"
import { UI } from "@ericsanchezok/synergy-cli/util/ui"
import { ServerProcessLock } from "@ericsanchezok/synergy-harness/util/server-process-lock"

const started: RuntimeOptions[] = []
const opened: string[] = []
let startupError: unknown
mock.module(import.meta.resolve("../../src/server/runtime"), () => ({
  run: async (options: RuntimeOptions) => {
    if (startupError) throw startupError
    started.push(options)
  },
}))
mock.module(import.meta.resolve("open"), () => ({
  default: async (url: string) => {
    opened.push(url)
  },
}))
const { ServerCommand } = await import("../../src/cli/server")
const { WebCommand } = await import("../../src/cli/web")

afterEach(() => {
  mock.restore()
  startupError = undefined
  started.length = 0
  opened.length = 0
  process.exitCode = 0
})

function captureUI() {
  const lines: string[] = []
  spyOn(UI, "error").mockImplementation((text) => {
    lines.push(String(text))
  })
  spyOn(UI, "println").mockImplementation((...text) => {
    lines.push(text.map(String).join(" "))
  })
  spyOn(UI, "empty").mockImplementation(() => {})
  return lines
}

async function execute(command: unknown, args: string[]) {
  return yargs()
    .exitProcess(false)
    .help(false)
    .command(command as CommandModule)
    .parseAsync(args)
}

test("server command passes interactive and managed lifecycle options to the full runtime", async () => {
  captureUI()
  await execute(ServerCommand, ["server", "--hostname", "127.0.0.1", "--port", "45217"])
  await execute(ServerCommand, ["server", "--managed-service", "--no-banner"])
  expect(started[0]).toMatchObject({
    interactive: true,
    printBanner: true,
    printChannelStatus: true,
    network: { port: 45217, hostname: "127.0.0.1" },
  })
  expect(started[1]).toMatchObject({ interactive: false, printBanner: false, printChannelStatus: false })
})

test("server startup failures preserve a nonzero exit and actionable diagnostics", async () => {
  const lines = captureUI()
  startupError = new Error("fixture startup failure")
  await execute(ServerCommand, ["server", "--non-interactive"])
  expect(process.exitCode).toBe(1)
  expect(lines.join("\n")).toContain("fixture startup failure")
  expect(lines.join("\n")).toContain("--print-logs")
})

test("an existing server lock reports process health and ownership without starting another runtime", async () => {
  const lines = captureUI()
  startupError = new ServerProcessLock.AlreadyRunningError({
    pid: 12345,
    ownerToken: "fixture",
    startedAt: Date.now(),
    mode: "server",
    cwd: "/fixture",
    command: ["bun", "server"],
  })
  spyOn(ServerProcessLock, "inspect").mockResolvedValue({
    pid: 12345,
    alive: true,
    healthy: false,
    ppid: 12,
    pgid: 13,
    cpu: 0,
    elapsed: "00:01",
    listeningPorts: [45217],
    command: "bun server",
  })
  await execute(ServerCommand, ["server", "--hostname", "::", "--port", "45217"])
  expect(started).toEqual([])
  expect(process.exitCode).toBe(1)
  expect(lines.join("\n")).toContain("pid 12345")
  expect(lines.join("\n")).toContain("did not respond to /global/health")
  expect(lines.join("\n")).toContain("45217")
})

test("web opens only a healthy runtime serving HTML and normalizes the attached URL", async () => {
  captureUI()
  const server = Bun.serve({
    port: 0,
    fetch: (request) =>
      new URL(request.url).pathname === "/global/health"
        ? Response.json({ healthy: true, version: "fixture" })
        : new Response("<html>runtime</html>", { headers: { "content-type": "text/html" } }),
  })
  try {
    await execute(WebCommand, ["web", "--attach", `${server.url.href}`])
    expect(opened).toEqual([server.url.href.replace(/\/$/, "")])
  } finally {
    server.stop(true)
  }
})

for (const healthy of [false, true]) {
  test(`web refuses ${healthy ? "a healthy API without a Web bundle" : "an unhealthy API"}`, async () => {
    const lines = captureUI()
    spyOn(process, "exit").mockImplementation(() => {
      throw new Error("fixture exit")
    })
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ healthy, version: "fixture" }) })
    try {
      await expect(execute(WebCommand, ["web", "--attach", server.url.href])).rejects.toThrow("fixture exit")
      expect(opened).toEqual([])
      expect(lines.join("\n")).toContain(healthy ? "not serving the web UI" : "No running server found")
    } finally {
      server.stop(true)
    }
  })
}
