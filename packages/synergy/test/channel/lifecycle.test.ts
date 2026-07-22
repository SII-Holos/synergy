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
  onConnected?: (callbacks: { onDisconnect?: (reason?: string) => void; signal: AbortSignal }) => void
}) {
  let connectCount = 0
  let callbacks: { onDisconnect?: (reason?: string) => void; signal: AbortSignal } | undefined
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
  } satisfies Provider
  return {
    value,
    connectCount: () => connectCount,
    disconnect: (reason = "test") => inHome(() => callbacks?.onDisconnect?.(reason)),
  }
}

function inHome<T>(fn: () => T | Promise<T>) {
  return ScopeContext.provide({ scope: Scope.home(), fn })
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
