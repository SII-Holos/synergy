import { afterAll, expect, test } from "bun:test"
import { createComponent, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { setupSolidDOM } from "../support/solid-dom"

const closeDOM = await setupSolidDOM()
afterAll(closeDOM)
const { ViewActivityProvider } = await import("../../src/context/view-activity")
const { createDisclosureMotionRef } = await import("../../src/utils/disclosure-motion")

function fixture(initial: boolean, observeResize = false) {
  const host = document.createElement("div")
  const element = document.createElement("div")
  element.textContent = "Accepted process content"
  const child = document.createElement("span")
  let height = 80
  Object.defineProperty(child, "getBoundingClientRect", { value: () => ({ height }) })
  element.append(child)
  document.body.append(host)
  Object.defineProperty(element, "getBoundingClientRect", { value: () => ({ height: 80 }) })
  window.matchMedia = (() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia
  const animations: { cancelled: boolean; finish(): void }[] = []
  element.animate = () => {
    const completion = Promise.withResolvers<void>()
    let onfinish: (() => void) | undefined
    const record = {
      cancelled: false,
      finish() {
        completion.resolve()
        onfinish?.()
      },
    }
    animations.push(record)
    return {
      finished: completion.promise,
      playState: "running",
      set onfinish(value: (() => void) | undefined) {
        onfinish = value
      },
      cancel() {
        record.cancelled = true
        completion.reject(new DOMException("Cancelled", "AbortError"))
      },
    } as unknown as Animation
  }
  const [visible, setVisible] = createSignal(initial)
  const [active, setActive] = createSignal(true)
  const [ready, setReady] = createSignal(true)
  let manual = false
  const dispose = render(
    () =>
      createComponent(ViewActivityProvider, {
        active,
        get children() {
          createDisclosureMotionRef({ visible, animate: () => manual || ready(), observeResize })(element)
          return element
        },
      }),
    host,
  )
  return {
    element,
    animations,
    setVisible,
    setActive,
    setReady,
    setManual(value: boolean) {
      manual = value
    },
    resize(value: number) {
      height = value
    },
    dispose() {
      dispose()
      host.remove()
    },
  }
}

for (const next of [false, true]) {
  for (const owner of ["activity", "readiness"] as const) {
    test(`${owner} revocation settles an in-flight ${next ? "opening" : "closing"} disclosure without replay on return`, async () => {
      const current = fixture(!next)
      try {
        current.setVisible(next)
        await Promise.resolve()
        expect(current.animations).toHaveLength(1)
        const revoke = owner === "activity" ? current.setActive : current.setReady
        revoke(false)
        expect(current.animations[0].cancelled).toBe(true)
        expect(current.element.hidden).toBe(!next)
        expect(current.element.hasAttribute("data-motion-changing")).toBe(false)
        current.animations[0].finish()
        revoke(true)
        await Promise.resolve()
        expect(current.animations).toHaveLength(1)
        expect(current.element.hidden).toBe(!next)
        current.setVisible(!next)
        await Promise.resolve()
        expect(current.animations).toHaveLength(2)
      } finally {
        current.dispose()
      }
    })
  }
}

test("revoking activity before animation preparation prevents the queued transition from starting", async () => {
  const current = fixture(true)
  try {
    current.setVisible(false)
    current.setActive(false)
    await Promise.resolve()
    expect(current.animations).toHaveLength(0)
    expect(current.element.hidden).toBe(true)
    current.setVisible(true)
    await Promise.resolve()
    expect(current.animations).toHaveLength(0)
    expect(current.element.hidden).toBe(false)
  } finally {
    current.dispose()
  }
})

test("an explicit disclosure can grant motion while automatic restoration is still unready", async () => {
  const current = fixture(false)
  try {
    current.setReady(false)
    current.setManual(true)
    current.setVisible(true)
    await Promise.resolve()
    expect(current.animations).toHaveLength(1)
    current.setActive(false)
    expect(current.animations[0].cancelled).toBe(true)
  } finally {
    current.dispose()
  }
})

test("resize observations respect activity and readiness without replaying hidden growth", () => {
  const original = globalThis.ResizeObserver
  let notify = () => {}
  globalThis.ResizeObserver = class implements ResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      notify = () => callback([], this)
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const current = fixture(true, true)
  try {
    current.resize(120)
    notify()
    expect(current.animations).toHaveLength(1)
    current.setActive(false)
    expect(current.animations[0].cancelled).toBe(true)
    current.resize(160)
    notify()
    current.setReady(false)
    current.setActive(true)
    current.resize(200)
    notify()
    expect(current.animations).toHaveLength(1)
    current.setReady(true)
    expect(current.animations).toHaveLength(1)
    current.resize(240)
    notify()
    expect(current.animations).toHaveLength(2)
  } finally {
    current.dispose()
    globalThis.ResizeObserver = original
  }
})
