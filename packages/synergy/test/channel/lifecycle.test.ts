import { afterEach, describe, expect, mock, test } from "bun:test"
import type { Config } from "../../src/config/config"
import { Config as ConfigRuntime } from "../../src/config/config"
import { Channel } from "../../src/channel"
import type { Provider, StreamingSession } from "../../src/channel/types"
import { FeishuProvider } from "../../src/channel/provider/feishu"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"

const originalConfigCurrent = ConfigRuntime.current

function streaming(): StreamingSession {
  return {
    async start() {},
    async update() {},
    async updateToolProgress() {},
    async close() {},
    isActive: () => false,
  }
}

function provider(input: {
  type: string
  lifecycle: "self_connected" | "borrowed_transport"
  waitForTransport?: boolean
  onConnected?: (callbacks: { onDisconnect?: (reason?: string) => void; signal: AbortSignal }) => void
}) {
  let connectCount = 0
  let transportWaitCount = 0
  let callbacks: { onDisconnect?: (reason?: string) => void; signal: AbortSignal } | undefined
  const readyResolvers: Array<() => void> = []
  const value = {
    type: input.type,
    lifecycle: input.lifecycle,
    async connect(connectInput) {
      connectCount += 1
      callbacks = connectInput
      input.onConnected?.(connectInput)
    },
    async replyMessage() {
      return { messageId: "reply" }
    },
    async pushMessage() {
      return { messageId: "push" }
    },
    async addReaction() {},
    createStreamingSession: streaming,
  } as Provider & {
    waitForTransport?: (input: { accountId: string; signal: AbortSignal }) => Promise<void>
  }
  if (input.waitForTransport) {
    value.waitForTransport = ({ signal }) => {
      transportWaitCount += 1
      return new Promise<void>((resolve) => {
        if (signal.aborted) return resolve()
        const onAbort = () => resolve()
        signal.addEventListener("abort", onAbort, { once: true })
        readyResolvers.push(() => {
          signal.removeEventListener("abort", onAbort)
          resolve()
        })
      })
    }
  }
  return {
    value,
    connectCount: () => connectCount,
    transportWaitCount: () => transportWaitCount,
    readyTransport: () => readyResolvers.shift()?.(),
    disconnect: (reason = "test") => inHome(() => callbacks?.onDisconnect?.(reason)),
  }
}

function inHome<T>(fn: () => T | Promise<T>) {
  return ScopeContext.provide({ scope: Scope.home(), fn })
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const timeoutAt = Date.now() + 2_000
  while (!(await predicate()) && Date.now() < timeoutAt) await Bun.sleep(5)
  if (!(await predicate())) throw new Error("Timed out waiting for Channel lifecycle state")
}

async function configure(type: string, enabled: boolean) {
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

describe.serial("Channel provider lifecycle capability", () => {
  test("keeps Feishu on the self-connected lifecycle", () => {
    expect(new FeishuProvider().lifecycle).toBe("self_connected")
  })

  test("self-connected providers retain the existing reconnect loop", async () => {
    const fake = provider({ type: `self-${crypto.randomUUID()}`, lifecycle: "self_connected" })
    Channel.registerProvider(fake.value)
    await configure(fake.value.type, true)
    expect(fake.connectCount()).toBe(1)

    await fake.disconnect()

    expect(await inHome(() => Channel.status())).toMatchObject({
      [`${fake.value.type}:account`]: { status: "connecting" },
    })
    await Bun.sleep(2_100)
    expect(fake.connectCount()).toBe(2)
  })

  test("borrowed-transport providers never install a Channel reconnect loop", async () => {
    const fake = provider({ type: `borrowed-${crypto.randomUUID()}`, lifecycle: "borrowed_transport" })
    Channel.registerProvider(fake.value)
    await configure(fake.value.type, true)
    expect(fake.connectCount()).toBe(1)

    await fake.disconnect("transport_lost")

    expect(await inHome(() => Channel.status())).toMatchObject({
      [`${fake.value.type}:account`]: { status: "disconnected" },
    })
    await Bun.sleep(2_100)
    expect(fake.connectCount()).toBe(1)
  })

  test("borrowed transport waits passively and reattaches exactly once per readiness event", async () => {
    const fake = provider({
      type: `borrowed-ready-${crypto.randomUUID()}`,
      lifecycle: "borrowed_transport",
      waitForTransport: true,
    })
    Channel.registerProvider(fake.value)
    await configure(fake.value.type, true)

    await waitFor(async () => {
      const status = await inHome(() => Channel.status())
      return status[`${fake.value.type}:account`]?.status === "waiting_for_transport"
    })
    expect(fake.transportWaitCount()).toBe(1)
    expect(fake.connectCount()).toBe(0)

    fake.readyTransport()
    await waitFor(() => fake.connectCount() === 1)
    expect(await inHome(() => Channel.status())).toMatchObject({
      [`${fake.value.type}:account`]: { status: "connected" },
    })

    await fake.disconnect("transport_lost")
    await waitFor(() => fake.transportWaitCount() === 2)
    expect(fake.connectCount()).toBe(1)
    expect(await inHome(() => Channel.status())).toMatchObject({
      [`${fake.value.type}:account`]: { status: "waiting_for_transport" },
    })

    fake.readyTransport()
    await waitFor(() => fake.connectCount() === 2)
    await Bun.sleep(25)
    expect(fake.connectCount()).toBe(2)
  })

  test("disabled accounts create no connection or reconnect pressure", async () => {
    const fake = provider({ type: `disabled-${crypto.randomUUID()}`, lifecycle: "borrowed_transport" })
    Channel.registerProvider(fake.value)

    await configure(fake.value.type, false)
    await Bun.sleep(25)

    expect(fake.connectCount()).toBe(0)
    expect(await inHome(() => Channel.status())).toMatchObject({
      [`${fake.value.type}:account`]: { status: "disabled" },
    })
  })
})
