import { afterEach, describe, expect, mock, test } from "bun:test"
import type { Config } from "../../src/config/config"
import { Config as ConfigRuntime } from "../../src/config/config"
import { Channel } from "../../src/channel"
import type { Provider, StreamingSession } from "../../src/channel/types"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"

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

function refreshProvider(input: {
  type: string
  lifecycle: "borrowed_transport"
  refreshProjects?: Provider["refreshProjects"]
}) {
  let callbacks:
    | {
        onDisconnect?: (reason?: string) => void
        signal: AbortSignal
      }
    | undefined

  return {
    value: {
      type: input.type,
      lifecycle: input.lifecycle,
      async connect(connectInput: Parameters<Provider["connect"]>[0]) {
        callbacks = connectInput
      },
      async replyMessage() {
        return { messageId: "reply" }
      },
      createStreamingSession: streaming,
      refreshProjects: input.refreshProjects,
    } satisfies Provider,
    disconnect: (reason = "test") => {
      if (callbacks?.onDisconnect) {
        callbacks.onDisconnect(reason)
      }
    },
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

afterEach(async () => {
  ConfigRuntime.current = originalConfigCurrent
  await inHome(() => Channel.stopAll())
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe.serial("Channel project refresh coalescing", () => {
  test("concurrent refresh calls coalesce to one provider sync", async () => {
    const type = `refresh-coalesce-${crypto.randomUUID()}`
    let callCount = 0

    const fake = refreshProvider({
      type,
      lifecycle: "borrowed_transport",
      async refreshProjects() {
        callCount += 1
      },
    })
    Channel.registerProvider(fake.value)
    await configureChannel(type)

    // Issue two concurrent refresh calls. With coalescing, the provider
    // should be invoked only once regardless of concurrency.
    await Promise.all([
      inHome(() => Channel.refreshProjects(type, "account")),
      inHome(() => Channel.refreshProjects(type, "account")),
    ])

    // RED: concurrent calls should coalesce, but each call creates its
    // own host and calls provider.refreshProjects independently.
    expect(callCount).toBe(1)
  })

  test("refresh returns accepted without waiting for provider sync completion", async () => {
    const type = `refresh-async-${crypto.randomUUID()}`
    let providerCompleted = false
    let resolveRefresh: () => void
    const refreshDeferred = new Promise<void>((resolve) => {
      resolveRefresh = resolve
    })

    const fake = refreshProvider({
      type,
      lifecycle: "borrowed_transport",
      async refreshProjects() {
        await refreshDeferred
        providerCompleted = true
      },
    })
    Channel.registerProvider(fake.value)
    await configureChannel(type)

    // Start refresh
    const refreshPromise = inHome(() => Channel.refreshProjects(type, "account"))

    // Give the event loop a tick
    await new Promise((resolve) => setTimeout(resolve, 5))

    // RED: Channel.refreshProjects should return early ("accepted").
    // Currently it awaits the provider's refreshProjects before returning.
    const result = await Promise.race([
      refreshPromise.then(() => "channel_returned"),
      new Promise<string>((resolve) => setTimeout(() => resolve("channel_blocked"), 10)),
    ])

    // RED: currently "channel_blocked" because Channel.refreshProjects awaits internally
    expect(result).toBe("channel_returned")
    // Cleanup
    resolveRefresh!()
    await refreshPromise.catch(() => {})
  })
})

describe.serial("Channel refresh status lifecycle", () => {
  test("status transitions through syncing during refresh", async () => {
    const type = `refresh-status-${crypto.randomUUID()}`
    let resolveRefresh: () => void
    const refreshDeferred = new Promise<void>((resolve) => {
      resolveRefresh = resolve
    })

    const fake = refreshProvider({
      type,
      lifecycle: "borrowed_transport",
      async refreshProjects() {
        // Check status while refresh is in progress
        const status = await inHome(() => Channel.status())
        const key = `${type}:account`
        // RED: during refresh, status should show syncing activity.
        // Currently stays "connected" because nothing updates it.
        expect(status[key]?.status).not.toBe("connected")
        await refreshDeferred
      },
    })
    Channel.registerProvider(fake.value)
    await configureChannel(type)

    // Before refresh: status should be "connected"
    const beforeStatus = await inHome(() => Channel.status())
    const key = `${type}:account`
    expect(beforeStatus[key]?.status).toBe("connected")

    // Start refresh
    const refreshPromise = inHome(() => Channel.refreshProjects(type, "account"))
    // Wait for provider to start
    await new Promise((resolve) => setTimeout(resolve, 10))

    // Cleanup
    resolveRefresh!()
    await refreshPromise.catch(() => {})
  })

  test("failed refresh sets sync_failed status instead of leaving connected", async () => {
    const type = `refresh-fail-${crypto.randomUUID()}`

    const fake = refreshProvider({
      type,
      lifecycle: "borrowed_transport",
      async refreshProjects() {
        throw new Error("provider sync failure")
      },
    })
    Channel.registerProvider(fake.value)
    await configureChannel(type)

    // Attempt refresh (will throw)
    await inHome(() => Channel.refreshProjects(type, "account")).catch(() => {})

    // RED: after a failed refresh, status should indicate failure.
    // Currently stays "connected" because refreshProjects doesn't update statuses.
    const status = await inHome(() => Channel.status())
    const key = `${type}:account`
    expect(status[key]?.status).not.toBe("connected")
    // In the desired state, should be "failed" with an error message
    if (status[key]?.status === "failed") {
      expect(status[key]).toHaveProperty("error")
    }
  })
})

describe.serial("Channel refresh provider isolation", () => {
  test("refresh never reconnects borrowed-transport providers", async () => {
    const type = `refresh-borrowed-${crypto.randomUUID()}`
    let connectCount = 0

    const fake = refreshProvider({
      type,
      lifecycle: "borrowed_transport",
      async refreshProjects() {
        // The refresh creates a bare ChannelHost.create(...) with no callbacks
      },
    })
    // Wrap connect to track calls
    const originalConnect = fake.value.connect.bind(fake.value)
    ;(fake.value as { connect: typeof originalConnect }).connect = async function (
      ...args: Parameters<typeof originalConnect>
    ) {
      connectCount += 1
      return originalConnect(...args)
    }

    Channel.registerProvider(fake.value)
    await configureChannel(type)

    // Initial connection via init
    expect(connectCount).toBe(1)

    // Trigger refresh
    await inHome(() => Channel.refreshProjects(type, "account"))

    // RED: refresh should NOT reconnect a borrowed-transport provider.
    expect(connectCount).toBe(1)
  })

  test("refresh host is bare and discards diagnostic and status callbacks", async () => {
    const type = `refresh-bare-${crypto.randomUUID()}`
    let refreshHostChannelType: string | undefined
    let refreshHostAccountId: string | undefined

    const fake = refreshProvider({
      type,
      lifecycle: "borrowed_transport",
      async refreshProjects(input) {
        // Inspect the host that Channel.refreshProjects creates
        refreshHostChannelType = input.host.channelType
        refreshHostAccountId = input.host.accountId
        // Attempt to record a diagnostic through the refresh host
        await input.host.diagnostics.record({
          level: "warn",
          message: "refresh started",
        })
      },
    })
    Channel.registerProvider(fake.value)
    await configureChannel(type)

    await inHome(() => Channel.refreshProjects(type, "account"))
    // Wait for the fire-and-forget refresh to complete and persist diagnostics
    await new Promise((resolve) => setTimeout(resolve, 50))

    // RED: diagnostics recorded through the refresh host should be
    // captured. Currently the refresh host is created with no
    // onDiagnostic callback, so diagnostics are silently lost.
    const records = await inHome(() => Channel.getDiagnostics(type, "account"))
    const hasRefreshDiagnostic = records.some((r) => r.message === "refresh started")
    expect(hasRefreshDiagnostic).toBe(true)
  })
})

describe.serial("Channel partial/failed refresh does not negatively reconcile", () => {
  test("failed refresh at Channel level does not archive existing connections", async () => {
    const type = `refresh-partial-${crypto.randomUUID()}`

    const fake = refreshProvider({
      type,
      lifecycle: "borrowed_transport",
      async refreshProjects() {
        throw new Error("partial refresh failure")
      },
    })
    Channel.registerProvider(fake.value)
    await configureChannel(type)

    // Check status before the failed refresh
    const beforeStatus = await inHome(() => Channel.status())
    const key = `${type}:account`
    expect(beforeStatus[key]?.status).toBe("connected")

    // Attempt and catch the failed refresh
    await inHome(() => Channel.refreshProjects(type, "account")).catch(() => {})

    // RED: after a failed refresh, the connection should still exist.
    // The Blueprint requires that a failed refresh never performs
    // destructive negative reconciliation against projects.
    // At minimum, the connection itself should not be torn down.
    const afterStatus = await inHome(() => Channel.status())
    // Currently, the connection remains "connected" after a thrown refresh
    // (which is correct), but the status should reflect the failure.
    expect(afterStatus[key]).toBeDefined()
  })
})
