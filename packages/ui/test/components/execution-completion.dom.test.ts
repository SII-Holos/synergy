import { afterAll, beforeAll, expect, test } from "bun:test"
import { setupSolidDOM } from "../support/solid-dom"
import type { TurnExecutionSummary } from "../../src/components/execution-completion"
import { completionRibbonGeometry } from "../../src/components/completion-ribbon-geometry"

let closeDOM: () => void
let fixture: { setSummary: (value: TurnExecutionSummary) => void; opened: () => number; dispose: () => void }
beforeAll(async () => {
  closeDOM = await setupSolidDOM()
  document.body.innerHTML = '<div id="root"></div>'
  await import("../fixtures/session-turn/execution-completion.dom")
  fixture = Reflect.get(globalThis, "executionCompletionFixture")
}, 60_000)
afterAll(() => {
  fixture?.dispose()
  closeDOM?.()
})

test("a completed message retains a running subtask status supplied by the application", () => {
  expect(document.body.textContent).toContain("Running")
  expect(document.body.textContent).toContain("01:05")
  document.querySelector<HTMLButtonElement>("button")!.click()
  expect(fixture.opened()).toBe(1)
  fixture.setSummary({ status: "completed", elapsedMs: 70_000 })
  expect(document.body.textContent).toContain("Completed")
  expect(document.body.textContent).toContain("01:10")
  expect(document.querySelector('[data-component="completion-ribbon"]')).not.toBeNull()
})

test("historical messages expose details without inventing elapsed time", () => {
  fixture.setSummary({ status: "unknown", elapsedMs: null })
  expect(document.body.textContent).toContain("Unknown")
  expect(document.body.textContent).not.toContain("00:00")
  expect(document.querySelector("button")?.textContent).toBe("Details")
})

test("a partial duration keeps its known time including a zero lower bound", () => {
  fixture.setSummary({ status: "completed", elapsedMs: 205000, elapsedLowerBound: true })
  expect(document.body.textContent).toContain("≥ 03:25")
  fixture.setSummary({ status: "unknown", elapsedMs: 0, elapsedLowerBound: true })
  expect(document.body.textContent).toContain("≥ 00:00")
})

test("non-success outcomes retain their status and details without a success signature", () => {
  for (const status of [
    "failed",
    "cancelled",
    "interrupted",
    "paused",
    "waiting",
    "queued",
    "unknown",
    "running",
  ] as const) {
    fixture.setSummary({ status, elapsedMs: null })
    expect(document.querySelector('[data-component="execution-completion"]')?.getAttribute("data-state")).toBe(status)
    expect(document.querySelector('[data-component="completion-ribbon"]')).toBeNull()
    expect(document.querySelector("button")?.textContent).toBe("Details")
  }
})

test("the ribbon clears the last line and forms beside the completion row before a short settle", () => {
  const line = new window.DOMRect(32, 100, 200, 20)
  for (const gap of [4, 10, 32, 80]) {
    const seal = new window.DOMRect(32, line.bottom + gap, 16, 16)
    const geometry = completionRibbonGeometry(line, seal, 350)!
    expect(geometry).toBeDefined()
    expect(geometry.fold[1] - geometry.foldSize / 2).toBeGreaterThanOrEqual(line.bottom + 4)
    expect(geometry.fold[1] + geometry.foldSize / 2).toBeLessThanOrEqual(seal.bottom)
    expect(geometry.signature[1] - geometry.fold[1]).toBeGreaterThanOrEqual(0)
    expect(geometry.signature[1] - geometry.fold[1]).toBeLessThanOrEqual(seal.height / 2)
    expect(geometry.fold[0] - geometry.foldSize / 2).toBe(seal.left)
    expect(geometry.fold[0] + geometry.foldSize / 2).toBeLessThan(seal.right + 10)
    expect(geometry.points[0]![0]).toBeGreaterThan(line.right)
    expect(geometry.points.slice(1).every((point) => point[1] >= line.bottom + 4)).toBe(true)
    expect(geometry.total).toBeGreaterThan(geometry.spineLength)
  }
})

test("an overlapping reply and footer decline spatial decoration", () => {
  const line = new window.DOMRect(32, 100, 200, 20)
  expect(completionRibbonGeometry(line, new window.DOMRect(32, 120, 16, 16), 350)).toBeUndefined()
})
