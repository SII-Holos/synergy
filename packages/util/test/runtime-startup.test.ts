import { expect, test } from "bun:test"
import {
  RUNTIME_STARTUP_MAX_LINE_LENGTH,
  RUNTIME_STARTUP_PREFIX,
  RuntimeStartupProgress,
  runtimeStartupLine,
} from "../src/runtime-startup"

test("startup records round trip without accepting unbounded or private fields", () => {
  const progress = { phase: "migration", step: 1, current: 358, total: 8494 } as const
  const line = runtimeStartupLine(progress)
  expect(line.length).toBeLessThan(RUNTIME_STARTUP_MAX_LINE_LENGTH)
  expect(RuntimeStartupProgress.parse(JSON.parse(line.slice(RUNTIME_STARTUP_PREFIX.length)))).toEqual(progress)
  for (const invalid of [
    { ...progress, current: -1 },
    { ...progress, current: 1.5 },
    { ...progress, current: 8495 },
    { ...progress, step: 0 },
    { ...progress, total: Infinity },
    { ...progress, sessionID: "private" },
    { phase: "starting", detail: "private" },
  ])
    expect(RuntimeStartupProgress.safeParse(invalid).success).toBe(false)
  expect(RuntimeStartupProgress.parse({ phase: "starting" })).toEqual({ phase: "starting" })
  expect(RuntimeStartupProgress.parse({ phase: "recovery", current: 960450 })).toEqual({
    phase: "recovery",
    current: 960450,
  })
  for (const current of [-1, 0.1, Infinity, Number.MAX_SAFE_INTEGER + 1])
    expect(RuntimeStartupProgress.safeParse({ phase: "recovery", current }).success).toBe(false)
  expect(RuntimeStartupProgress.safeParse({ phase: "recovery", current: 1, sessionID: "private" }).success).toBe(false)
})
