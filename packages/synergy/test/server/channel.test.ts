import { afterEach, describe, expect, mock, test } from "bun:test"
import type { Config } from "../../src/config/config"
import { Config as ConfigRuntime } from "../../src/config/config"
import { Channel } from "../../src/channel"
import type { Provider, StreamingSession } from "../../src/channel/types"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Server } from "../../src/server/server"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const originalConfigCurrent = ConfigRuntime.current

function inHome<T>(fn: () => T | Promise<T>) {
  return ScopeContext.provide({ scope: Scope.home(), fn })
}

function streaming(): StreamingSession {
  return {
    async start() {},
    async update() {},
    async updateToolProgress() {},
    async close() {},
    isActive: () => false,
  }
}

function diagnosticProvider(input: { type: string; lifecycle: "borrowed_transport" }) {
  return {
    value: {
      type: input.type,
      lifecycle: input.lifecycle,
      async connect(connectInput: Parameters<Provider["connect"]>[0]) {
        await connectInput.host.diagnostics.record({
          level: "info",
          message: `provider ${input.type} connected`,
          data: { accountId: connectInput.accountId },
        })
      },
      async replyMessage() {
        return { messageId: "reply" }
      },
      createStreamingSession: streaming,
    } satisfies Provider,
  }
}

async function configureChannel(type: string, accountId = "account") {
  ConfigRuntime.current = mock(async () => {
    return {
      channel: {
        [type]: {
          type,
          accounts: { [accountId]: { enabled: true } },
        },
      },
    } as unknown as Config.Info
  }) as typeof ConfigRuntime.current
  await inHome(async () => {
    await Channel.reload()
    await Channel.init()
  })
}

afterEach(async () => {
  ConfigRuntime.current = originalConfigCurrent
  await inHome(() => Channel.stopAll())
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("Channel diagnostics NDJSON route", () => {
  test("emits one valid JSON record per line from active connections", async () => {
    const type = `ndjson-valid-${crypto.randomUUID()}`
    const fake = diagnosticProvider({ type, lifecycle: "borrowed_transport" })
    Channel.registerProvider(fake.value)
    await configureChannel(type)
    await inHome(() => Channel.start(type, "account"))

    // Request NDJSON diagnostics through the Hono app
    const app = Server.App()
    const res = await app.request(`/channel/${type}/account/diagnostics.ndjson`)
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("application/x-ndjson")

    const text = await res.text()
    const lines = text.trim().split("\n").filter(Boolean)

    // Each line must be valid JSON
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
      const record = JSON.parse(line)
      expect(record).toHaveProperty("timestamp")
      expect(record).toHaveProperty("level")
      expect(record).toHaveProperty("message")
    }

    expect(lines.length).toBeGreaterThan(0)
  })

  test("pulls one complete NDJSON record per response chunk", async () => {
    const type = `ndjson-pull-${crypto.randomUUID()}`
    const fake = diagnosticProvider({ type, lifecycle: "borrowed_transport" })
    Channel.registerProvider(fake.value)
    await configureChannel(type)
    await inHome(() => Channel.start(type, "account"))

    const res = await Server.App().request(`/channel/${type}/account/diagnostics.ndjson`)
    const reader = res.body!.getReader()
    const first = await reader.read()
    await reader.cancel()

    expect(first.done).toBe(false)
    const lines = new TextDecoder().decode(first.value).split("\n").filter(Boolean)
    expect(lines).toHaveLength(1)
    expect(() => JSON.parse(lines[0]!)).not.toThrow()
  })

  test("rejects unknown account/provider with an error status", async () => {
    const app = Server.App()

    // Request for a completely unknown channel type and account
    const res = await app.request(`/channel/${crypto.randomUUID()}/${crypto.randomUUID()}/diagnostics.ndjson`)
    // RED: the route currently returns 200 with empty body because
    // getDiagnostics() returns [] for unknown connections.
    // The Blueprint requires rejecting unknown accounts consistently.
    expect(res.status).toBe(404)
  })

  test("each NDJSON line is a complete, parseable JSON record with known fields", async () => {
    const type = `ndjson-schema-${crypto.randomUUID()}`
    const fake = diagnosticProvider({ type, lifecycle: "borrowed_transport" })
    Channel.registerProvider(fake.value)
    await configureChannel(type)
    await inHome(() => Channel.start(type, "account"))

    const app = Server.App()
    const res = await app.request(`/channel/${type}/account/diagnostics.ndjson`)
    expect(res.status).toBe(200)

    const text = await res.text()
    const lines = text.trim().split("\n")

    for (const line of lines) {
      if (!line.trim()) continue
      const record = JSON.parse(line)

      // Verify record structure matches the API schema
      expect(typeof record.timestamp).toBe("number")
      expect(typeof record.level).toBe("string")
      expect(typeof record.message).toBe("string")
      // data is optional in the schema
      if (record.data !== undefined) {
        expect(typeof record.data).toBe("object")
      }
    }
  })

  test("NDJSON stream has correct Content-Disposition attachment header", async () => {
    const type = `ndjson-dispo-${crypto.randomUUID()}`
    const fake = diagnosticProvider({ type, lifecycle: "borrowed_transport" })
    Channel.registerProvider(fake.value)
    await configureChannel(type)
    await inHome(() => Channel.start(type, "account"))

    const app = Server.App()
    const res = await app.request(`/channel/${type}/account/diagnostics.ndjson`)

    const disposition = res.headers.get("Content-Disposition")
    expect(disposition).toBeDefined()
    expect(disposition).toContain("attachment")
    expect(disposition).toContain(type)
    expect(disposition).toContain("account")
    expect(disposition).toContain("diagnostics.ndjson")
  })

  test("sanitizes diagnostics attachment filenames", async () => {
    const type = `ndjson-filename-${crypto.randomUUID()}`
    const accountId = `account\"界`
    const fake = diagnosticProvider({ type, lifecycle: "borrowed_transport" })
    Channel.registerProvider(fake.value)
    await configureChannel(type, accountId)
    await inHome(() => Channel.start(type, accountId))

    const res = await Server.App().request(
      `/channel/${encodeURIComponent(type)}/${encodeURIComponent(accountId)}/diagnostics.ndjson`,
    )
    const disposition = res.headers.get("Content-Disposition")

    expect(res.status).toBe(200)
    expect(disposition).toBe(`attachment; filename="channel-${type}-account__-diagnostics.ndjson"`)
  })
})
