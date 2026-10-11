import { afterAll, beforeAll, expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { domFixture } from "../support/dom-fixtures"
import type { TurnExecutionSummary } from "../../src/components/execution-completion"

let dom: JSDOM
let fixture: { setSummary: (value: TurnExecutionSummary) => void; opened: () => number; dispose: () => void }
beforeAll(async () => {
  const entry = await domFixture("execution-completion.dom")
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "http://localhost/" })
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Node: dom.window.Node,
    HTMLElement: dom.window.HTMLElement,
  })
  await import(entry)
  fixture = Reflect.get(globalThis, "executionCompletionFixture")
}, 60_000)
afterAll(() => {
  fixture?.dispose()
  dom?.window.close()
})

test("a completed message retains a running subtask status supplied by the application", () => {
  expect(document.body.textContent).toContain("Running")
  expect(document.body.textContent).toContain("01:05")
  document.querySelector<HTMLButtonElement>("button")!.click()
  expect(fixture.opened()).toBe(1)
  fixture.setSummary({ status: "completed", elapsedMs: 70_000 })
  expect(document.body.textContent).toContain("Completed")
  expect(document.body.textContent).toContain("01:10")
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
