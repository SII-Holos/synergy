import { describe, expect, test } from "bun:test"
import { McpServerConfig, PLUGIN_API_VERSION, PluginManifest, definePlugin, mcp } from "../src/index"

const validLocalServer: McpServerConfig = {
  type: "local",
  command: ["bunx", "example-mcp", "--stdio"],
  cwd: "/tmp/example",
  environment: { LOG_LEVEL: "debug" },
  timeout: 30_000,
  startup: "manual",
  required: true,
  connectTimeout: 5_000,
  listTimeout: 10_000,
  callTimeout: 20_000,
  retry: {
    maxAttempts: 3,
    backoffMs: 250,
    backoffMultiplier: 2,
    cooldownMs: 0,
  },
  idleShutdownMs: 60_000,
  toolFilter: { include: ["read"], exclude: ["delete"] },
  tools: { approval: "per_session", maxOutputBytes: 1024 },
  toolCache: { mode: "session", ttlMs: 5_000 },
}

const validRemoteServer: McpServerConfig = {
  type: "remote",
  url: "http://127.0.0.1:43123/mcp",
  headers: { Authorization: "Bearer fixture" },
  oauth: {
    clientId: "fixture-client",
    clientSecret: "fixture-secret",
    scope: "mcp:connect",
  },
  startup: "eager",
  connectTimeout: 5_000,
  listTimeout: 10_000,
  callTimeout: 20_000,
}

describe("McpServerConfig", () => {
  test("accepts complete local and OAuth remote server declarations", () => {
    expect(McpServerConfig.parse(validLocalServer)).toEqual(validLocalServer)
    expect(McpServerConfig.parse(validRemoteServer)).toEqual(validRemoteServer)
    expect(
      McpServerConfig.parse({
        type: "remote",
        url: "https://mcp.example.com/connect",
        oauth: false,
      }),
    ).toEqual({
      type: "remote",
      url: "https://mcp.example.com/connect",
      oauth: false,
    })
  })

  test.each([
    ["remote URL is missing", { type: "remote" }, ["url"]],
    ["remote URL is not HTTP", { type: "remote", url: "file:///tmp/mcp.sock" }, ["url"]],
    [
      "remote OAuth is not an object or false",
      { type: "remote", url: "https://example.com/mcp", oauth: "auto" },
      ["oauth"],
    ],
    ["local command is not an array", { type: "local", command: "bunx example-mcp" }, ["command"]],
    ["local command is empty", { type: "local", command: [] }, ["command"]],
    ["local command contains an empty argument", { type: "local", command: ["bunx", ""] }, ["command", 1]],
    ["server type is unknown", { type: "socket", path: "/tmp/mcp.sock" }, ["type"]],
    ["server has an unknown field", { type: "remote", url: "https://example.com/mcp", transport: "sse" }, []],
    ["lifecycle field has an invalid value", { type: "local", command: ["bunx"], startup: "automatic" }, ["startup"]],
    [
      "retry cooldown is negative",
      { type: "local", command: ["bunx"], retry: { cooldownMs: -1 } },
      ["retry", "cooldownMs"],
    ],
  ] as const)("rejects when %s", (_label, input, expectedPath) => {
    const result = McpServerConfig.safeParse(input)
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues.some((issue) => JSON.stringify(issue.path) === JSON.stringify(expectedPath))).toBe(true)
  })

  test("rejects unknown nested fields", () => {
    const result = McpServerConfig.safeParse({
      type: "remote",
      url: "https://example.com/mcp",
      oauth: { scope: "mcp:connect", audience: "synergy" },
    })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues).toContainEqual(expect.objectContaining({ path: ["oauth"] }))
  })
})

describe("PluginManifest MCP contributions", () => {
  const baseManifest = {
    manifestVersion: 1,
    apiVersion: PLUGIN_API_VERSION,
    id: "mcp-fixture",
    name: "MCP Fixture",
    version: "1.0.0",
    description: "MCP fixture",
    capabilities: [],
    contributions: [],
    artifacts: { generation: "fixture" },
  }

  test("uses the shared MCP server schema", () => {
    const manifest = PluginManifest.parse({
      ...baseManifest,
      contributions: [{ kind: "mcp", id: "remote", server: validRemoteServer }],
    })
    expect(manifest.contributions[0]).toMatchObject({ kind: "mcp", id: "remote", server: validRemoteServer })
  })

  test("rejects malformed MCP declarations in generated metadata", () => {
    const result = PluginManifest.safeParse({
      ...baseManifest,
      contributions: [{ kind: "mcp", id: "remote", server: { type: "remote", url: "not-a-url" } }],
    })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues).toContainEqual(expect.objectContaining({ path: ["contributions", 0, "server", "url"] }))
  })
})

describe("Plugin MCP trust boundary", () => {
  test("accepts host-owned declarative MCP without plugin process capabilities", () => {
    const plugin = definePlugin({
      id: "declarative-mcp",
      version: "1.0.0",
      description: "Host-owned MCP declaration",
      capabilities: [],
      contributions: [
        mcp({
          id: "local",
          server: { type: "local", command: ["frontend-kit-mcp"], startup: "eager" },
        }),
      ],
    })

    expect(plugin.capabilities).toEqual([])
    expect(plugin.contributions[0]).toMatchObject({
      kind: "mcp",
      id: "local",
      server: { type: "local", command: ["frontend-kit-mcp"], startup: "eager" },
    })
  })
})
