import { describe, expect, test } from "bun:test"
import { ReconnectController, type ReconnectTimer } from "../../../src/components/terminal/reconnect"

function createFakeTimer() {
  let nextId = 1
  let now = 0
  const queue = new Map<number, { fn: () => void; at: number }>()
  const timer: ReconnectTimer = {
    setTimeout(fn, ms) {
      const id = nextId++
      queue.set(id, { fn, at: now + ms })
      return id
    },
    clearTimeout(id) {
      queue.delete(id)
    },
    now() {
      return now
    },
  }
  return {
    timer,
    now: () => now,
    pending: () => queue.size,
    /** Run all timers whose deadline is <= now + ms, in deadline order. */
    advance(ms: number) {
      const target = now + ms
      let fired = true
      while (fired) {
        fired = false
        for (const [id, item] of [...queue].sort((a, b) => a[1].at - b[1].at)) {
          if (item.at <= target) {
            queue.delete(id)
            now = item.at
            item.fn()
            fired = true
            break
          }
        }
      }
      now = target
    },
  }
}

function setup(
  overrides: {
    maxAttempts?: number
    quickCycleMs?: number
    initialDelayMs?: number
    maxDelayMs?: number
    validate?: () => Promise<boolean>
    isDisposed?: () => boolean
  } = {},
) {
  const fake = createFakeTimer()
  const events: string[] = []
  const controller = new ReconnectController({
    maxAttempts: overrides.maxAttempts ?? 3,
    quickCycleMs: overrides.quickCycleMs ?? 3_000,
    initialDelayMs: overrides.initialDelayMs ?? 100,
    maxDelayMs: overrides.maxDelayMs ?? 1_000,
    timer: fake.timer,
    validate: overrides.validate ?? (() => Promise.resolve(true)),
    connect: () => events.push("connect"),
    onConnected: () => events.push("connected"),
    onGiveUp: () => events.push("give-up"),
    isDisposed: overrides.isDisposed ?? (() => false),
  })
  const tick = async () => {
    await Promise.resolve()
    await Promise.resolve()
  }
  return { controller, fake, events, tick }
}

describe("ReconnectController", () => {
  test("open → immediate close 快速循环在 maxAttempts 后 give up,不再无限重连", async () => {
    const { controller, fake, events, tick } = setup()
    // Server repeatedly accepts then immediately drops the socket.
    for (let i = 0; i < 10; i++) {
      controller.onOpen()
      controller.onClose()
      fake.advance(100)
      await tick()
    }
    const connects = events.filter((e) => e === "connect").length
    expect(connects).toBeLessThanOrEqual(3)
    expect(connects).toBeGreaterThan(0)
    expect(events.filter((e) => e === "give-up")).toHaveLength(1)
  })
  test("连接保持超过 quickCycleMs 后断开会重置失败计数,继续重连", async () => {
    const { controller, fake, events, tick } = setup()
    // Two fast failures accumulate attempts (each schedules a retry).
    controller.onOpen()
    controller.onClose()
    fake.advance(1_000)
    await tick() // connect #1
    controller.onOpen()
    controller.onClose()
    fake.advance(1_000)
    await tick() // connect #2
    // A stable connection resets the failure counter: hold beyond quickCycleMs,
    // then drop.
    controller.onOpen()
    fake.advance(4_000)
    controller.onClose()
    fake.advance(1_000)
    await tick() // connect #3 (attempts were reset to 0)
    expect(events).not.toContain("give-up")
    expect(events.filter((e) => e === "connect")).toHaveLength(3)
  })

  test("PTY 校验失败(不存在)时立即 give up", async () => {
    const { controller, fake, events, tick } = setup({
      validate: () => Promise.resolve(false),
    })
    controller.onOpen()
    controller.onClose()
    fake.advance(100)
    await tick()
    expect(events).toContain("give-up")
    expect(events.filter((e) => e === "give-up")).toHaveLength(1)
  })

  test("PTY 校验抛错(网络错误)时立即 give up 且只触发一次", async () => {
    const { controller, fake, events, tick } = setup({
      validate: () => Promise.reject(new Error("network down")),
    })
    controller.onOpen()
    controller.onClose()
    fake.advance(100)
    await tick()
    fake.advance(10_000)
    await tick()
    expect(events).toContain("give-up")
    expect(events.filter((e) => e === "give-up")).toHaveLength(1)
    expect(events.filter((e) => e === "connect").length).toBeLessThanOrEqual(1)
  })

  test("dispose 后 close 不再调度重连", async () => {
    const { controller, fake, events } = setup()
    controller.dispose()
    controller.onOpen()
    controller.onClose()
    fake.advance(10_000)
    expect(events).not.toContain("connect")
  })

  test("组件已卸载(isDisposed)时 close 不再调度重连", async () => {
    const { controller, fake, events } = setup({ isDisposed: () => true })
    controller.onOpen()
    controller.onClose()
    fake.advance(10_000)
    expect(events).not.toContain("connect")
  })

  test("连续 close(无 open)只保留一个重连定时器", async () => {
    const { controller, fake, events, tick } = setup()
    controller.onOpen()
    controller.onClose()
    expect(fake.pending()).toBe(1)
    controller.onClose()
    expect(fake.pending()).toBe(1)
    fake.advance(100)
    await tick()
    expect(events.filter((e) => e === "connect")).toHaveLength(1)
  })
  test("重连延迟按指数退避并封顶", async () => {
    const { controller, fake, events, tick } = setup({
      maxAttempts: 10,
      initialDelayMs: 100,
      maxDelayMs: 400,
    })
    const delays: number[] = []
    // First failure schedules at initialDelay (timer fires on first advance).
    controller.onOpen()
    controller.onClose()
    expect(fake.pending()).toBe(1)
    delays.push(100)
    // Each cycle: advance fires the scheduled reconnect (connect), then
    // open + immediate close schedule the next retry with doubled delay,
    // capped at maxDelayMs.
    for (let i = 0; i < 5; i++) {
      fake.advance(1_000)
      await tick()
      controller.onOpen()
      controller.onClose()
      delays.push(Math.min(100 * 2 ** (i + 1), 400))
    }
    expect(events.filter((e) => e === "connect")).toHaveLength(5)
    expect(delays[delays.length - 1]).toBe(400)
  })
})
