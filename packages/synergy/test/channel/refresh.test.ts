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
  test("concurrent refresh calls share one provider sync and settle together", async () => {
    const type = `refresh-coalesce-${crypto.randomUUID()}`
    let callCount = 0
    let resolveRefresh: () => void
    const refreshDeferred = new Promise<void>((resolve) => {
      resolveRefresh = resolve
    })

    const fake = refreshProvider({
      type,
      lifecycle: "borrowed_transport",
      async refreshProjects() {
        callCount += 1
        await refreshDeferred
      },
    })
    Channel.registerProvider(fake.value)
    await configureChannel(type)

    const first = inHome(() => Channel.refreshProjects(type, "account"))
    const second = inHome(() => Channel.refreshProjects(type, "account"))
    await new Promise((resolve) => setTimeout(resolve, 5))

    expect(callCount).toBe(1)
    expect(
      await Promise.race([
        Promise.all([first, second]).then(() => "settled"),
        new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 10)),
      ]),
    ).toBe("pending")

    resolveRefresh!()
    await Promise.all([first, second])
  })

  test("refresh resolves only after provider sync reaches connected", async () => {
    const type = `refresh-await-${crypto.randomUUID()}`
    let resolveRefresh: () => void
    const refreshDeferred = new Promise<void>((resolve) => {
      resolveRefresh = resolve
    })

    const fake = refreshProvider({
      type,
      lifecycle: "borrowed_transport",
      async refreshProjects() {
        await refreshDeferred
      },
    })
    Channel.registerProvider(fake.value)
    await configureChannel(type)

    const refreshPromise = inHome(() => Channel.refreshProjects(type, "account"))
    await new Promise((resolve) => setTimeout(resolve, 5))

    expect((await inHome(() => Channel.status()))[`${type}:account`]?.status).toBe("syncing")
    expect(
      await Promise.race([
        refreshPromise.then(() => "settled"),
        new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 10)),
      ]),
    ).toBe("pending")

    resolveRefresh!()
    await refreshPromise
    expect((await inHome(() => Channel.status()))[`${type}:account`]?.status).toBe("connected")
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
        expect((await inHome(() => Channel.status()))[`${type}:account`]?.status).toBe("syncing")
        await refreshDeferred
      },
    })
    Channel.registerProvider(fake.value)
    await configureChannel(type)

    const beforeStatus = await inHome(() => Channel.status())
    const key = `${type}:account`
    expect(beforeStatus[key]?.status).toBe("connected")

    const refreshPromise = inHome(() => Channel.refreshProjects(type, "account"))
    await new Promise((resolve) => setTimeout(resolve, 10))

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

    await expect(inHome(() => Channel.refreshProjects(type, "account"))).rejects.toThrow("provider sync failure")

    expect((await inHome(() => Channel.status()))[`${type}:account`]).toEqual({
      status: "failed",
      error: "provider sync failure",
    })
  })
  test("disconnect during refresh preserves disconnected status", async () => {
    const type = `refresh-disconnect-${crypto.randomUUID()}`
    let resolveRefresh: () => void
    const refreshDeferred = new Promise<void>((resolve) => {
      resolveRefresh = resolve
    })

    const fake = refreshProvider({
      type,
      lifecycle: "borrowed_transport",
      async refreshProjects() {
        await refreshDeferred
      },
    })
    Channel.registerProvider(fake.value)
    await configureChannel(type)

    const refresh = inHome(() => Channel.refreshProjects(type, "account"))
    await Bun.sleep(5)
    await inHome(() => Channel.disconnect(type, "account"))
    resolveRefresh!()

    await expect(refresh).rejects.toThrow("disconnected during project refresh")
    expect((await inHome(() => Channel.status()))[`${type}:account`]?.status).toBe("disconnected")
  })

  test("reconnect starts a new refresh without stale status overwrite", async () => {
    const type = `refresh-reconnect-${crypto.randomUUID()}`
    const resolvers: Array<() => void> = []
    let callCount = 0

    const fake = refreshProvider({
      type,
      lifecycle: "borrowed_transport",
      async refreshProjects() {
        callCount += 1
        await new Promise<void>((resolve) => resolvers.push(resolve))
      },
    })
    Channel.registerProvider(fake.value)
    await configureChannel(type)

    const first = inHome(() => Channel.refreshProjects(type, "account"))
    await Bun.sleep(5)
    await inHome(() => Channel.start(type, "account"))
    const second = inHome(() => Channel.refreshProjects(type, "account"))
    await Bun.sleep(5)

    try {
      expect(callCount).toBe(2)
      resolvers[0]!()
      await expect(first).rejects.toThrow("disconnected during project refresh")
      expect((await inHome(() => Channel.status()))[`${type}:account`]?.status).toBe("syncing")

      resolvers[1]!()
      await second
      expect((await inHome(() => Channel.status()))[`${type}:account`]?.status).toBe("connected")
    } finally {
      for (const resolve of resolvers) resolve()
      await Promise.allSettled([first, second])
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
      async refreshProjects() {},
    })
    const originalConnect = fake.value.connect.bind(fake.value)
    ;(fake.value as { connect: typeof originalConnect }).connect = async function (
      ...args: Parameters<typeof originalConnect>
    ) {
      connectCount += 1
      return originalConnect(...args)
    }

    Channel.registerProvider(fake.value)
    await configureChannel(type)

    expect(connectCount).toBe(1)

    await inHome(() => Channel.refreshProjects(type, "account"))

    expect(connectCount).toBe(1)
  })

  test("refresh host records diagnostics for the account", async () => {
    const type = `refresh-bare-${crypto.randomUUID()}`
    let refreshHostChannelType: string | undefined
    let refreshHostAccountId: string | undefined

    const fake = refreshProvider({
      type,
      lifecycle: "borrowed_transport",
      async refreshProjects(input) {
        refreshHostChannelType = input.host.channelType
        refreshHostAccountId = input.host.accountId
        await input.host.diagnostics.record({
          level: "warn",
          message: "refresh started",
        })
      },
    })
    Channel.registerProvider(fake.value)
    await configureChannel(type)

    await inHome(() => Channel.refreshProjects(type, "account"))

    expect(refreshHostChannelType).toBe(type)
    expect(refreshHostAccountId).toBe("account")
    const records = await inHome(() => Channel.getDiagnostics(type, "account"))
    const hasRefreshDiagnostic = records.some((r) => r.message === "refresh started")
    expect(hasRefreshDiagnostic).toBe(true)
  })
})

describe.serial("Channel partial/failed refresh does not negatively reconcile", () => {
  test("failed refresh retains the connection for retry", async () => {
    const type = `refresh-partial-${crypto.randomUUID()}`
    let callCount = 0

    const fake = refreshProvider({
      type,
      lifecycle: "borrowed_transport",
      async refreshProjects() {
        callCount += 1
        throw new Error("partial refresh failure")
      },
    })
    Channel.registerProvider(fake.value)
    await configureChannel(type)

    await expect(inHome(() => Channel.refreshProjects(type, "account"))).rejects.toThrow("partial refresh failure")
    await expect(inHome(() => Channel.refreshProjects(type, "account"))).rejects.toThrow("partial refresh failure")

    expect(callCount).toBe(2)
    expect((await inHome(() => Channel.status()))[`${type}:account`]).toEqual({
      status: "failed",
      error: "partial refresh failure",
    })
  })
})
