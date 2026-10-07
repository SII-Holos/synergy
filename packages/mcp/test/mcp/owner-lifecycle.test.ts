import { expect, test } from "bun:test"
import path from "node:path"
import { McpSupervisor } from "../../src/supervisor"
import { MCP } from "../../src/index"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

test("persistent connection failures back off and still recover automatically", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    const server = path.join(tmp.path, "recover.cjs")
    const attempts = path.join(tmp.path, "attempts.jsonl")
    await Bun.write(
      server,
      `const fs = require("node:fs");
fs.appendFileSync(process.argv[2], Date.now() + "\\n");
if (fs.readFileSync(process.argv[2], "utf8").trim().split("\\n").length < 4) process.exit(1);
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const m = JSON.parse(line); if (m.id === undefined) return;
  const result = m.method === "initialize"
    ? { protocolVersion: m.params.protocolVersion, serverInfo: { name: "recovered", version: "1" }, capabilities: { tools: {} } }
    : { tools: [] };
  console.log(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
});`,
    )
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const supervisor = McpSupervisor()
        const name = `recover-${crypto.randomUUID()}`
        try {
          supervisor.add(name, {
            type: "local",
            command: [process.execPath, server, attempts],
            startup: "eager",
            retry: { maxAttempts: 1, cooldownMs: 80 },
          })
          const deadline = Date.now() + 4000
          while (supervisor.test(name)?.status !== "connected" && Date.now() < deadline) await Bun.sleep(10)
          expect(supervisor.test(name)).toEqual({ status: "connected" })
          const times = (await Bun.file(attempts).text()).trim().split("\n").map(Number)
          expect(times).toHaveLength(4)
          expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(150)
          expect(times[3]! - times[2]!).toBeGreaterThanOrEqual(310)
        } finally {
          await supervisor.remove(name)
        }
      },
    })
  }))

test("tools-only servers never receive optional discovery requests during connect or refresh", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    const server = path.join(tmp.path, "tools-only.cjs")
    const requests = path.join(tmp.path, "requests.jsonl")
    await Bun.write(
      server,
      `const fs = require("node:fs");
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const m = JSON.parse(line); if (m.id === undefined) return;
  fs.appendFileSync(process.argv[2], JSON.stringify(m.method) + "\\n");
  const result = m.method === "initialize"
    ? { protocolVersion: m.params.protocolVersion, serverInfo: { name: "tools-only", version: "1" }, capabilities: { tools: {} } }
    : m.method === "tools/list" ? { tools: [] } : undefined;
  console.log(JSON.stringify({ jsonrpc: "2.0", id: m.id, ...(result ? { result } : { error: { code: -32601, message: "not supported" } }) }));
});`,
    )
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const supervisor = McpSupervisor()
        const name = `tools-only-${crypto.randomUUID()}`
        try {
          const handle = supervisor.getOrCreate(name, {
            type: "local",
            command: [process.execPath, server, requests],
            startup: "manual",
          })
          await supervisor.connect(name, handle.identity)
          await supervisor.refresh(name)
          expect(supervisor.test(name)).toEqual({ status: "connected" })
          const methods = (await Bun.file(requests).text())
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
          expect(methods).not.toContain("prompts/list")
          expect(methods).not.toContain("resources/list")
        } finally {
          await supervisor.remove(name)
        }
      },
    })
  }))

test("advertised but unsupported discovery is reported once per connection", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    const server = path.join(tmp.path, "tools-only.cjs")
    const requests = path.join(tmp.path, "requests.jsonl")
    await Bun.write(
      server,
      `const fs = require("node:fs");
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const m = JSON.parse(line); if (m.id === undefined) return;
  fs.appendFileSync(process.argv[2], JSON.stringify(m.method) + "\\n");
  const result = m.method === "initialize"
    ? { protocolVersion: m.params.protocolVersion, serverInfo: { name: "tools-only", version: "1" }, capabilities: { tools: {}, prompts: {}, resources: {} } }
    : m.method === "tools/list" ? { tools: [] } : undefined;
  console.log(JSON.stringify({ jsonrpc: "2.0", id: m.id, ...(result ? { result } : { error: { code: -32601, message: "not supported" } }) }));
});`,
    )
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const supervisor = McpSupervisor()
        const name = `tools-only-${crypto.randomUUID()}`
        try {
          const handle = supervisor.getOrCreate(name, {
            type: "local",
            command: [process.execPath, server, requests],
            startup: "manual",
          })
          await supervisor.connect(name, handle.identity)
          await supervisor.refresh(name)
          expect(supervisor.test(name)).toEqual({ status: "connected" })
          const methods = (await Bun.file(requests).text())
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
          expect(methods.filter((method) => method === "prompts/list")).toHaveLength(1)
          expect(methods.filter((method) => method === "resources/list")).toHaveLength(1)
        } finally {
          await supervisor.remove(name)
        }
      },
    })
  }))

test("MCP manual owner connects real stdio capabilities, reads resources and releases its client", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    const server = path.join(tmp.path, "mcp-fixture.cjs")
    await Bun.write(
      server,
      `const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const m = JSON.parse(line); if (m.id === undefined) return;
  let result = {};
  if(m.method === "initialize") result = { protocolVersion: m.params.protocolVersion, serverInfo: { name: "fixture", version: "1" }, capabilities: { tools: {}, prompts: {}, resources: {} } };
  else if(m.method === "tools/list") result = { tools: [{ name: "echo", description: "Echo input", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] };
  else if(m.method === "tools/call") result = { content: [{ type: "text", text: m.params.arguments.text }] };
  else if(m.method === "prompts/list") result = { prompts: [{ name: "review", description: "Review" }] };
  else if(m.method === "prompts/get") result = { messages: [{ role: "user", content: { type: "text", text: "review evidence" } }] };
  else if(m.method === "resources/list") result = { resources: [{ uri: "fixture://evidence", name: "evidence", mimeType: "text/plain" }] };
  else if(m.method === "resources/read") result = { contents: [{ uri: "fixture://evidence", mimeType: "text/plain", text: "stored evidence" }] };
  console.log(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
});`,
    )
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        try {
          await McpSupervisor().ready()
          const name = `fixture-${crypto.randomUUID()}`
          const config = { type: "local" as const, command: [process.execPath, server], startup: "manual" as const }
          const handle = McpSupervisor().getOrCreate(name, config)
          expect(McpSupervisor().getOrCreate(name, config)).toBe(handle)
          expect(McpSupervisor().getClient(name)).toBeUndefined()
          await expect(McpSupervisor().connect(name, "stale identity")).rejects.toThrow("not found")
          await McpSupervisor().connect(name, handle.identity)
          expect(McpSupervisor().test(name)).toEqual({ status: "connected" })
          await McpSupervisor().refresh(name)
          expect(McpSupervisor().inspect(name)).toMatchObject({
            toolNames: ["echo"],
            resourceNames: ["evidence"],
            promptNames: ["review"],
          })
          expect((await MCP.listServers()).find((server) => server.name === name)?.source).toBe("runtime")
          expect((await MCP.getPrompt(name, "review"))?.messages[0]?.content).toEqual({
            type: "text",
            text: "review evidence",
          })
          expect((await MCP.readResource(name, "fixture://evidence"))?.contents[0]).toMatchObject({
            text: "stored evidence",
          })
          expect(
            (
              await McpSupervisor()
                .getClient(name)!
                .callTool({ name: "echo", arguments: { text: "actual request" } })
            ).content,
          ).toEqual([{ type: "text", text: "actual request" }])
          const sampled = await McpSupervisor().resourceStats()
          expect(sampled.processCount).toBe(1)
          if (process.platform === "darwin" || process.platform === "linux") {
            expect(sampled.measuredProcessCount).toBe(1)
            expect(sampled.currentBytes).toBeGreaterThan(0)
            const entry = handle.localProcess!
            const identity = entry.identity
            const older = McpSupervisor().resourceStats()
            const latest = McpSupervisor().resourceStats()
            expect((await older).measuredProcessCount).toBe(0)
            expect((await latest).measuredProcessCount).toBe(1)
            entry.identity = "different-process-start"
            expect(await McpSupervisor().resourceStats()).toMatchObject({
              processCount: 1,
              measuredProcessCount: 0,
              currentBytes: 0,
            })
            expect(entry.currentRssBytes).toBeUndefined()
            expect(entry.peakRssBytes).toBeGreaterThan(0)
            entry.identity = identity
          }
          await McpSupervisor().disconnect(name)
          expect(McpSupervisor().test(name)).toEqual({ status: "disabled" })
          expect(McpSupervisor().getClient(name)).toBeUndefined()
          await McpSupervisor().remove(name)
          expect(McpSupervisor().inspect(name)).toBeUndefined()
          expect(await MCP.getPrompt(name, "review")).toBeUndefined()
          expect(await MCP.readResource(name, "fixture://evidence")).toBeUndefined()
        } finally {
          await McpSupervisor().reset()
        }
      },
    })
  }))

afterRuntimeTests(() => runtime.close())
