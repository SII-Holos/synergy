import { expect, test } from "bun:test"
import {
  RUNTIME_STARTUP_MAX_LINE_LENGTH,
  RUNTIME_STARTUP_PREFIX,
  RuntimeStartupProgress,
  runtimeStartupLine,
} from "../src/runtime-startup"

test("migration progress preserves advancing counts before a total is known", () => {
  const progress = { phase: "migration", step: 2, current: 256, total: 0 } as const
  expect(RuntimeStartupProgress.parse(progress)).toEqual(progress)
  expect(RuntimeStartupProgress.safeParse({ ...progress, total: 255 }).success).toBe(false)
})

test("maintenance records carry bounded lifecycle facts without arbitrary payloads", () => {
  const begin = { phase: "maintenance", id: 1, operation: "vacuum", state: "started", timeoutMs: 690_000 } as const
  for (const value of [
    begin,
    { phase: "maintenance", id: 1, state: "stage", stage: "rewrite" },
    { phase: "maintenance", id: 1, state: "completed", elapsedMs: 400_000 },
    { phase: "maintenance", id: 1, state: "failed", elapsedMs: 400_000 },
  ] as const)
    expect(RuntimeStartupProgress.parse(value)).toEqual(value)
  for (const value of [
    { ...begin, id: 0 },
    { ...begin, timeoutMs: Infinity },
    { ...begin, operation: "raw SQL" },
    { ...begin, path: "private" },
    { ...begin, timeoutMs: 0 },
    { phase: "maintenance", id: 1, state: "completed", elapsedMs: -1 },
  ])
    expect(RuntimeStartupProgress.safeParse(value).success).toBe(false)
})

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

test("validates bounded aggregate storage records with unknown totals", () => {
  const progress = { phase: "storage", stage: "scan", step: 1, current: 10, total: 0, bytes: 200 }
  expect(RuntimeStartupProgress.safeParse(progress).success).toBe(true)
  for (const value of [
    { ...progress, total: 9 },
    { ...progress, bytes: -1 },
    { ...progress, current: Infinity },
    { ...progress, step: 0 },
    { ...progress, stage: "unknown" },
    { ...progress, path: "private" },
  ])
    expect(RuntimeStartupProgress.safeParse(value).success).toBe(false)
})

test("accepts a finite engine budget only for a single physical verification announcement", () => {
  const progress = {
    phase: "storage",
    stage: "validate-engine",
    step: 1,
    current: 0,
    total: 0,
    bytes: 0,
    timeoutMs: 900_000,
  }
  expect(RuntimeStartupProgress.safeParse(progress).success).toBe(true)
  for (const value of [
    { ...progress, timeoutMs: undefined },
    { ...progress, timeoutMs: 0 },
    { ...progress, timeoutMs: 0.5 },
    { ...progress, timeoutMs: Infinity },
    { ...progress, timeoutMs: 2_147_483_648 },
    { ...progress, current: 1 },
    { ...progress, total: 1 },
    { ...progress, bytes: 1 },
    { ...progress, stage: "validate" },
    { ...progress, stage: "complete" },
  ])
    expect(RuntimeStartupProgress.safeParse(value).success).toBe(false)
})
