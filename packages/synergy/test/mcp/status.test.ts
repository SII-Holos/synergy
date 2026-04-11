import { afterEach, beforeEach, expect, mock, test } from "bun:test"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

let promptsDeferred = deferred<{ prompts: Array<{ name: string; description?: string }> }>()
let resourcesDeferred = deferred<{ resources: Array<{ name: string; uri: string; description?: string }> }>()
let listPromptsCalls = 0
let listResourcesCalls = 0

mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    async connect() {}
    async listTools() {
      return {
        tools: [
          {
            name: "echo",
            description: "echo",
            inputSchema: {
              type: "object",
              properties: {},
            },
          },
        ],
      }
    }
    async listPrompts() {
      listPromptsCalls += 1
      return promptsDeferred.promise
    }
    async listResources() {
      listResourcesCalls += 1
      return resourcesDeferred.promise
    }
    async close() {}
    setNotificationHandler() {}
  },
}))

mock.module("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class MockStdioClientTransport {
    constructor(_opts: unknown) {}
  },
}))

mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class MockStreamableHTTPClientTransport {
    constructor(_url: URL, _opts?: unknown) {}
  },
}))

mock.module("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class MockSSEClientTransport {
    constructor(_url: URL, _opts?: unknown) {}
  },
}))

mock.module("@modelcontextprotocol/sdk/client/auth.js", () => ({
  UnauthorizedError: class UnauthorizedError extends Error {},
}))

mock.module("open", () => ({
  default: async () => {},
}))

const { MCP } = await import("../../src/mcp/index")
const { Instance } = await import("../../src/scope/instance")
const { tmpdir } = await import("../fixture/fixture")

beforeEach(() => {
  promptsDeferred = deferred()
  resourcesDeferred = deferred()
  listPromptsCalls = 0
  listResourcesCalls = 0
})

afterEach(async () => {
  await Instance.disposeAll()
})

test("status does not block on slow prompt and resource discovery", async () => {
  await using tmp = await tmpdir({
    config: {
      mcp: {
        codex: {
          type: "local",
          command: ["fake-codex-mcp"],
        },
      },
    },
  })

  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const result = await Promise.race([
        MCP.status().then(() => "resolved"),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
      ])

      expect(result).toBe("resolved")
      expect(listPromptsCalls).toBe(1)
      expect(listResourcesCalls).toBe(1)

      promptsDeferred.resolve({
        prompts: [{ name: "draft", description: "Draft prompt" }],
      })
      resourcesDeferred.resolve({
        resources: [{ name: "doc", uri: "file:///doc.txt", description: "Doc resource" }],
      })

      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(Object.keys(await MCP.prompts())).toEqual(["codex:draft"])
      expect(Object.keys(await MCP.resources())).toEqual(["codex:doc"])
    },
  })
})
