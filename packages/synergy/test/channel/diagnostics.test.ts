import path from "path"
import fs from "fs/promises"
import { afterEach, describe, expect, mock, test } from "bun:test"
import type { Config } from "../../src/config/config"
import { Config as ConfigRuntime } from "../../src/config/config"
import { Channel } from "../../src/channel"
import { ChannelHost } from "../../src/channel/host"
import type { Provider, StreamingSession } from "../../src/channel/types"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { externalIdentityHash } from "../../src/channel/identity"
import { Global } from "../../src/global"

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

/**
 * Creates a fake provider that records a diagnostic during connect.
 * Pass `onConnect` to inject custom behavior (e.g. record a large payload
 * or sensitive data for normalization tests).
 */
function diagnosticProvider(input: {
  type: string
  lifecycle: "borrowed_transport"
  onConnect?: (host: ChannelHost.Instance) => void | Promise<void>
}) {
  return {
    value: {
      type: input.type,
      lifecycle: input.lifecycle,
      async connect(connectInput: Parameters<Provider["connect"]>[0]) {
        if (input.onConnect) {
          await input.onConnect(connectInput.host)
        }
        // Baseline diagnostic recorded during every connect
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

async function configureChannel(type: string, enabled = true) {
  ConfigRuntime.current = mock(async () => {
    return {
      channel: {
        [type]: {
          type,
          accounts: { account: { enabled } },
        },
      },
    } as unknown as Config.Info
  }) as typeof ConfigRuntime.current
  await inHome(async () => {
    await Channel.reload()
    await Channel.init()
  })
}

/**
 * Reconfigure to have NO matching channel, then reload. This simulates a
 * "cold restart" where the channel config was removed. Any diagnostics
 * that survive this are durable — in-memory diagnostics do not.
 */
async function reloadWithoutChannel() {
  ConfigRuntime.current = mock(async () => {
    return { channel: {} } as unknown as Config.Info
  }) as typeof ConfigRuntime.current
  await inHome(async () => {
    await Channel.stopAll()
    await Channel.reload()
    await Channel.init()
  })
}

async function seedDiagnosticRecords(input: {
  accountHash: string
  count: number
  firstTimestamp: number
}): Promise<string> {
  const root = path.join(Global.Path.data, ...StoragePath.channelDiagnosticsRecordsRoot(input.accountHash))
  await fs.mkdir(root, { recursive: true })
  const firstID = `${input.firstTimestamp.toString().padStart(13, "0")}-seed-00000`
  const concurrency = 128
  for (let offset = 0; offset < input.count; offset += concurrency) {
    await Promise.all(
      Array.from({ length: Math.min(concurrency, input.count - offset) }, (_, index) => {
        const position = offset + index
        const timestamp = input.firstTimestamp + position
        const id = `${timestamp.toString().padStart(13, "0")}-seed-${position.toString().padStart(5, "0")}`
        return Bun.write(
          path.join(root, `${id}.json`),
          JSON.stringify({ timestamp, level: "info", message: `seed ${position}` }),
        )
      }),
    )
  }
  return firstID
}

afterEach(async () => {
  ConfigRuntime.current = originalConfigCurrent
  await inHome(() => Channel.stopAll())
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe.serial("Channel diagnostics durability", () => {
  test("diagnostics should persist across disconnect and be listable while disconnected", async () => {
    const type = `diag-persist-${crypto.randomUUID()}`
    const fake = diagnosticProvider({ type, lifecycle: "borrowed_transport" })
    Channel.registerProvider(fake.value)
    await configureChannel(type)
    await inHome(() => Channel.start(type, "account"))

    // Verify diagnostics exist while connected
    const connected = await inHome(() => Channel.getDiagnostics(type, "account"))
    expect(connected.length).toBeGreaterThan(0)
    expect(connected).toContainEqual(
      expect.objectContaining({
        level: "info",
        message: `provider ${type} connected`,
      }),
    )

    // Disconnect
    await inHome(() => Channel.disconnect(type, "account"))

    // RED: diagnostics should still be available after disconnect.
    // Current behavior: getDiagnostics() returns [] when disconnected
    // because diagnostics are stored on the in-memory Connection object.
    const disconnected = await inHome(() => Channel.getDiagnostics(type, "account"))
    expect(disconnected.length).toBeGreaterThan(0)
  })

  test("diagnostics should survive channel cold restart without reconnection", async () => {
    const type = `diag-reload-${crypto.randomUUID()}`
    const fake = diagnosticProvider({ type, lifecycle: "borrowed_transport" })
    Channel.registerProvider(fake.value)
    await configureChannel(type)
    await inHome(() => Channel.start(type, "account"))

    // Verify diagnostics exist before reload
    const beforeReload = await inHome(() => Channel.getDiagnostics(type, "account"))
    expect(beforeReload.length).toBeGreaterThan(0)

    // Simulate cold restart: remove channel from config, reload
    await reloadWithoutChannel()

    // RED: durable diagnostics should survive reload, but in-memory
    // diagnostics are lost because the Connection object was torn down.
    const afterReload = await inHome(() => Channel.getDiagnostics(type, "account"))
    expect(afterReload.length).toBeGreaterThan(0)
  })

  test("stores diagnostics as independently addressable records", async () => {
    const type = `diag-records-${crypto.randomUUID()}`
    const accountHash = externalIdentityHash(type, "account")
    await Storage.write(
      ["channel", "diagnostics", accountHash],
      [{ timestamp: Date.now(), level: "info", message: "legacy array record" }],
    )
    const fake = diagnosticProvider({
      type,
      lifecycle: "borrowed_transport",
      onConnect: async (host) => {
        await host.diagnostics.record({ level: "debug", message: "first record" })
      },
    })
    Channel.registerProvider(fake.value)
    await configureChannel(type)
    await inHome(() => Channel.start(type, "account"))

    const recordIDs = await Storage.scan(StoragePath.channelDiagnosticsRecordsRoot(accountHash))
    const records = await Storage.readMany<unknown>(
      recordIDs.map((id) => StoragePath.channelDiagnosticsRecord(accountHash, id)),
    )

    expect(recordIDs.length).toBeGreaterThanOrEqual(2)
    expect(records.every((record) => !Array.isArray(record) && typeof record === "object")).toBe(true)
    expect(await Channel.getDiagnostics(type, "account")).not.toContainEqual(
      expect.objectContaining({ message: "legacy array record" }),
    )
  })
})

describe.serial("Channel diagnostic record normalization", () => {
  test("records with secret-like data should carry redaction metadata", async () => {
    const fakeApiKey = ["sk", "1234567890abcdef"].join("-")
    const type = `diag-redact-${crypto.randomUUID()}`
    const fake = diagnosticProvider({
      type,
      lifecycle: "borrowed_transport",
      onConnect: async (host) => {
        // Record a diagnostic with secret-like data that should be redacted
        await host.diagnostics.record({
          level: "debug",
          message: `auth request with token: ${fakeApiKey} secret: 42`,
          data: {
            headers: { Authorization: "Bearer secret-token-123", "X-Api-Key": "abc123" },
            path: "/api/v1/workspaces/secret-project/credentials",
            body: { password: "super-secret" },
          },
        })
      },
    })
    Channel.registerProvider(fake.value)
    await configureChannel(type)
    await inHome(() => Channel.start(type, "account"))

    const records = await inHome(() => Channel.getDiagnostics(type, "account"))

    // RED: records should have redaction metadata
    const hasRedactionMetadata = records.some(
      (r) => r.data && (r.data["redacted"] === true || r.data["redacted_fields"] !== undefined),
    )
    expect(hasRedactionMetadata).toBe(true)

    // RED: raw secrets should not appear in serialized records.
    // The current implementation stores raw diagnostic data verbatim.
    const rawRecords = JSON.stringify(records)
    expect(rawRecords).not.toContain(fakeApiKey)
    expect(rawRecords).not.toContain("Bearer secret-token-123")
    expect(rawRecords).not.toContain("abc123")
    expect(rawRecords).not.toContain("super-secret")
  })

  test("records exceeding 256 KiB serialized should be truncated with metadata", async () => {
    const type = `diag-trunc-${crypto.randomUUID()}`
    const fake = diagnosticProvider({
      type,
      lifecycle: "borrowed_transport",
      onConnect: async (host) => {
        // Record a diagnostic with a 300 KiB message payload
        await host.diagnostics.record({
          level: "debug",
          message: "large payload",
          data: {
            body: "X".repeat(300 * 1024), // ~300 KiB of data
          },
        })
      },
    })
    Channel.registerProvider(fake.value)
    await configureChannel(type)
    await inHome(() => Channel.start(type, "account"))

    const records = await inHome(() => Channel.getDiagnostics(type, "account"))

    // Find the record with the large body
    const largeRecord = records.find((r) => r.data && typeof r.data["body"] === "string")
    expect(largeRecord).toBeDefined()

    const serialized = JSON.stringify(largeRecord)
    const sizeBytes = new TextEncoder().encode(serialized).length

    // RED: the record should be normalized to <= 256 KiB (262144 bytes).
    // Currently it's stored verbatim at ~300+ KiB.
    expect(sizeBytes).toBeLessThanOrEqual(262144)

    // RED: truncated records should carry truncation metadata
    if (largeRecord!.data) {
      expect(largeRecord!.data["truncated"]).toBe(true)
    }
  })

  test("bounded prompt/result bodies are retained after truncation", async () => {
    const type = `diag-bounded-${crypto.randomUUID()}`
    const shortPrompt = "what is 2+2?"
    const shortResult = "4"

    const fake = diagnosticProvider({
      type,
      lifecycle: "borrowed_transport",
      onConnect: async (host) => {
        await host.diagnostics.record({
          level: "info",
          message: "task completed",
          data: {
            prompt: shortPrompt,
            result: shortResult,
          },
        })
      },
    })
    Channel.registerProvider(fake.value)
    await configureChannel(type)
    await inHome(() => Channel.start(type, "account"))

    const records = await inHome(() => Channel.getDiagnostics(type, "account"))

    // Bounded prompt/result bodies should be retained in normalized records
    const taskRecord = records.find((r) => r.data?.prompt !== undefined)
    expect(taskRecord).toBeDefined()
    expect(taskRecord!.data!.prompt).toBe(shortPrompt)
    expect(taskRecord!.data!.result).toBe(shortResult)
  })
})

describe.serial("Channel diagnostic retention", () => {
  test("retention enforces 7-day window and 10,000-record cap on writes", async () => {
    const { MAX_RECORDS, RETENTION_MS } = await import("../../src/channel/diagnostics")
    expect(MAX_RECORDS).toBe(10000)
    expect(RETENTION_MS).toBeGreaterThan(0)
    expect(RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000)
  })

  test("prunes the oldest record when a write exceeds the 10,000-record cap", async () => {
    const { MAX_RECORDS, recording } = await import("../../src/channel/diagnostics")
    const type = `diag-cap-${crypto.randomUUID()}`
    const accountHash = externalIdentityHash(type, "account")
    const firstTimestamp = Date.now() - MAX_RECORDS - 1_000
    const oldestID = await seedDiagnosticRecords({
      accountHash,
      count: MAX_RECORDS,
      firstTimestamp,
    })

    try {
      await recording(type, "account", { level: "info", message: "overflow record" })

      const recordIDs = await Storage.scan(StoragePath.channelDiagnosticsRecordsRoot(accountHash))
      expect(recordIDs).toHaveLength(MAX_RECORDS)
      expect(recordIDs).not.toContain(oldestID)
    } finally {
      await Storage.removeTree(StoragePath.channelDiagnosticsRecordsRoot(accountHash))
    }
  })

  test("prunes expired records during the next bounded write", async () => {
    const { RETENTION_MS } = await import("../../src/channel/diagnostics")
    const type = `diag-retention-${crypto.randomUUID()}`
    const accountHash = externalIdentityHash(type, "account")
    const expiredAt = Date.now() - RETENTION_MS - 1
    const expiredID = `${expiredAt.toString().padStart(13, "0")}-${crypto.randomUUID()}`
    await Storage.write(StoragePath.channelDiagnosticsRecord(accountHash, expiredID), {
      timestamp: expiredAt,
      level: "info",
      message: "expired",
    })

    const fake = diagnosticProvider({ type, lifecycle: "borrowed_transport" })
    Channel.registerProvider(fake.value)
    await configureChannel(type)
    await inHome(() => Channel.start(type, "account"))

    expect(await Storage.scan(StoragePath.channelDiagnosticsRecordsRoot(accountHash))).not.toContain(expiredID)
  })
})
