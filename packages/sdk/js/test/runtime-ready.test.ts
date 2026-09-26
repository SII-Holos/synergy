import { expect, test } from "bun:test"
import {
  parseRuntimeReady,
  runtimeReadyLine,
  RUNTIME_READY_MAX_LENGTH,
  RUNTIME_READY_PREFIX,
} from "../src/runtime-ready"

const ready = {
  protocol: 1 as const,
  pid: 42,
  version: "1.0.0",
  home: "/runtime",
  url: "http://127.0.0.1:4096",
  components: [{ id: "server", version: "1.0.0", apiVersion: 1 as const }],
}

test("runtime readiness framing is bounded, versioned and separate from terminal output", () => {
  expect(parseRuntimeReady(runtimeReadyLine(ready).trimEnd())).toEqual(ready)
  expect(parseRuntimeReady("synergy server listening on http://localhost:4096")).toBeUndefined()
  expect(parseRuntimeReady("prefix " + runtimeReadyLine(ready))).toBeUndefined()
  for (const value of [
    null,
    {},
    { ...ready, pid: -1 },
    { ...ready, protocol: 2 },
    { ...ready, components: [null] },
    { ...ready, components: [ready.components[0], ready.components[0]] },
  ])
    expect(() => parseRuntimeReady(RUNTIME_READY_PREFIX + JSON.stringify(value))).toThrow("Invalid runtime readiness")
  expect(() => parseRuntimeReady(RUNTIME_READY_PREFIX + "{")).toThrow()
  expect(() => parseRuntimeReady(RUNTIME_READY_PREFIX + "x".repeat(RUNTIME_READY_MAX_LENGTH))).toThrow("too large")
  expect(() => runtimeReadyLine({ ...ready, home: "x".repeat(RUNTIME_READY_MAX_LENGTH) })).toThrow("too large")
})
