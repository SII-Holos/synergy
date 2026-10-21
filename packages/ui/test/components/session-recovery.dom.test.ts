import { afterAll, beforeAll, expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import type { AssistantMessage, SessionStatus } from "@ericsanchezok/synergy-sdk/client"
import { domFixture } from "../support/dom-fixtures"

let dom: JSDOM
let harness: {
  setStatus(state: SessionStatus): void
  setError(error?: AssistantMessage["error"]): void
  calls: unknown[]
  resolve(): void
  dispose(): void
}
const update = () => new Promise((resolve) => setTimeout(resolve, 0))
const waiting = (attempt: number): Extract<SessionStatus, { type: "retry" }> => ({
  type: "retry",
  rootID: "root",
  messageID: "message",
  attempt,
  phase: "waiting",
  message: "read ECONNRESET",
  error: "Error: read ECONNRESET",
  startedAt: Date.now(),
  next: Date.now() + 60_000,
  canRetry: true,
})

beforeAll(async () => {
  const entry = await domFixture("session-recovery.dom")
  dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" })
  const w = dom.window
  Object.assign(globalThis, {
    window: w,
    document: w.document,
    navigator: w.navigator,
    Node: w.Node,
    Element: w.Element,
    HTMLElement: w.HTMLElement,
    HTMLButtonElement: w.HTMLButtonElement,
    MutationObserver: w.MutationObserver,
    getComputedStyle: w.getComputedStyle.bind(w),
    requestAnimationFrame: (f: FrameRequestCallback) => setTimeout(() => f(performance.now()), 0),
    cancelAnimationFrame: clearTimeout,
  })
  await import(entry)
  harness = (globalThis as typeof globalThis & { __recovery: typeof harness }).__recovery
}, 60_000)
afterAll(() => {
  harness?.dispose()
  dom?.window.close()
})

test("retries reuse one card and preserve raw details; successful output removes it", async () => {
  harness.setStatus(waiting(1))
  await update()
  const card = document.querySelector('[data-component="error-card"]')!
  expect(document.querySelectorAll('[data-component="error-card"]')).toHaveLength(1)
  ;(card.querySelector('[data-slot="error-card-details-trigger"]') as HTMLButtonElement).click()
  await update()
  expect(card.textContent).toContain("Error: read ECONNRESET")
  expect(card.textContent).not.toContain("Stop")
  harness.setStatus(waiting(5))
  await update()
  expect(document.querySelector('[data-component="error-card"]')).toBe(card)
  expect(card.textContent).toContain("5")
  const retry = card.querySelector('[data-slot="error-card-retry"]') as HTMLButtonElement
  retry.click()
  retry.click()
  expect(harness.calls).toHaveLength(1)
  harness.setStatus({ ...waiting(5), phase: "connecting", next: undefined, canRetry: false })
  harness.resolve()
  await update()
  expect(document.querySelector('[data-component="error-card"]')).toBe(card)
  expect(card.querySelector('[role="progressbar"]')).toBeNull()
  harness.setStatus({ type: "busy", activity: { rootID: "root", phase: "responding", startedAt: Date.now() } })
  await update()
  expect(document.querySelector('[data-component="error-card"]')).toBeNull()
})

test("final errors stay visible and expose only meaningful recovery actions", async () => {
  harness.setStatus({ type: "paused", reason: "failed", since: Date.now() })
  harness.setError({ name: "APIError", data: { message: "Invalid request", statusCode: 400, isRetryable: false } })
  await update()
  expect(document.querySelector('[data-component="error-card"]')?.textContent).toContain("Invalid request")
  expect(document.querySelector('[data-slot="error-card-retry"]')).toBeNull()
  harness.setError({ name: "ProviderAuthError", data: { providerID: "test", message: "Token expired" } })
  await update()
  expect(document.querySelector('[data-slot="error-card-retry"]')?.textContent).toBe("Reconnect")
  harness.setError({ name: "APIError", data: { message: "Unavailable", isRetryable: true } })
  await update()
  expect(document.querySelector('[data-slot="error-card-retry"]')?.textContent).toBe("Retry")
  const card = document.querySelector('[data-component="error-card"]')
  harness.setStatus({ type: "busy", activity: { rootID: "root", phase: "preparing_context", startedAt: Date.now() } })
  await update()
  expect(document.querySelector('[data-component="error-card"]')).toBe(card)
  expect(card?.textContent).toContain("Reconnecting")
  expect(document.querySelector('[data-slot="error-card-retry"]')).toBeNull()
  harness.setStatus({ type: "paused", reason: "aborted", since: Date.now() })
  harness.setError(undefined)
  await update()
  expect(document.querySelector('[data-component="error-card"]')).toBeNull()
})
