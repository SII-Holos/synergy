import { expect, spyOn, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createConversationHydration } from "../../../src/components/session/conversation-hydration"

test("resumed hydration waits for current data and Markdown, releases once, and cancels inactive owners", async () => {
  const frames = new Map<number, FrameRequestCallback>()
  const deliveries = new Map<number, () => void>()
  const clock: {
    setTimeout(callback: () => void, delay?: number): number
    clearTimeout(id: number): void
  } = globalThis
  let sequence = 0
  const request = spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++sequence, callback)
    return sequence
  })
  const cancel = spyOn(globalThis, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id)
  })
  const timeout = spyOn(clock, "setTimeout").mockImplementation((callback) => {
    deliveries.set(++sequence, callback)
    return sequence
  })
  const clear = spyOn(clock, "clearTimeout").mockImplementation((id) => {
    deliveries.delete(id)
  })
  const advance = async () => {
    for (let index = 0; index < 4; index++) {
      const batch = [...frames]
      frames.clear()
      for (const [, callback] of batch) callback(performance.now())
      await Promise.resolve()
      const delivered = [...deliveries.values()]
      deliveries.clear()
      for (const callback of delivered) callback()
      await Promise.resolve()
    }
  }
  const surface = document.createElement("div")
  document.body.append(surface)
  let releases = 0
  const owner = createRoot((dispose) => {
    const [active, activate] = createSignal(true)
    const [ready, accept] = createSignal(false)
    const hydrated = createConversationHydration({
      active,
      ready,
      surface: () => surface,
      onHydrated: () => releases++,
    })
    return { dispose, activate, accept, hydrated }
  })
  try {
    await advance()
    expect(releases).toBe(0)
    const marker = document.createElement("div")
    marker.dataset.markdownPending = ""
    surface.append(marker)
    owner.accept(true)
    await advance()
    expect(owner.hydrated()).toBe(false)
    await new Promise<void>((resolve) => {
      const observer = new MutationObserver(() => {
        observer.disconnect()
        resolve()
      })
      observer.observe(surface, { childList: true })
      marker.remove()
    })
    await advance()
    expect(owner.hydrated()).toBe(true)
    expect(releases).toBe(1)
    surface.append(document.createTextNode("Later live text"))
    owner.accept(false)
    owner.accept(true)
    await advance()
    expect(releases).toBe(1)
    owner.activate(false)
    expect(owner.hydrated()).toBe(false)
    owner.accept(false)
    owner.activate(true)
    await advance()
    expect(releases).toBe(1)
    owner.accept(true)
    owner.activate(false)
    await advance()
    expect(releases).toBe(1)
    owner.activate(true)
    await advance()
    expect(releases).toBe(2)
    owner.activate(false)
    owner.activate(true)
    owner.dispose()
    await advance()
    expect(releases).toBe(2)
    expect(frames.size).toBe(0)
    expect(deliveries.size).toBe(0)
  } finally {
    owner.dispose()
    surface.remove()
    request.mockRestore()
    cancel.mockRestore()
    timeout.mockRestore()
    clear.mockRestore()
  }
})
