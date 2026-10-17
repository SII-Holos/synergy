import { expect, test } from "bun:test"
import { createFileStatusRegistry } from "../../../src/context/file/status"

test("status owners share an in-flight read, preserve its consumer, and publish only the final refresh", async () => {
  const registry = createFileStatusRegistry()
  const pending: Array<(value: { files: [] }) => void> = []
  const values: number[] = []
  const load = () => new Promise<{ files: [] }>((resolve) => pending.push(resolve))
  const first = registry.retain("workspace:1", load, () => values.push(1))
  const second = registry.retain("workspace:1", load, () => values.push(2))
  const hide = first.activate()
  first.invalidate()
  hide()
  second.activate()
  for (let index = 0; index < 100; index++) second.invalidate()
  expect(pending).toHaveLength(1)
  first.dispose()
  pending[0]({ files: [] })
  await Bun.sleep(550)
  expect(pending).toHaveLength(2)
  expect(values).toEqual([])
  pending[1]({ files: [] })
  await second.read()
  expect(values).toEqual([2])
  second.dispose()
})

test("hidden status owners defer automatic reads and the last release cancels outstanding work", async () => {
  const registry = createFileStatusRegistry()
  const signals: AbortSignal[] = []
  const entry = registry.retain(
    "workspace:1",
    (signal) => {
      signals.push(signal)
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
    },
    () => {},
  )
  for (let index = 0; index < 100; index++) entry.invalidate()
  await Bun.sleep(550)
  expect(signals).toHaveLength(0)
  const hide = entry.activate()
  expect(signals).toHaveLength(1)
  hide()
  expect(signals[0].aborted).toBe(false)
  entry.dispose()
  expect(signals[0].aborted).toBe(true)
  await Bun.sleep(0)
})

test("continuous invalidations respect the Workspace start interval and keep the latest status", async () => {
  const starts: number[] = []
  const registry = createFileStatusRegistry()
  let revision = 0,
    displayed = 0
  const entry = registry.retain(
    "workspace:1",
    async () => {
      starts.push(performance.now())
      return { files: [], generatedAt: revision }
    },
    (value) => {
      displayed = value.generatedAt!
    },
  )
  entry.activate()
  try {
    for (let index = 0; index < 15; index++) {
      revision++
      entry.invalidate()
      await Bun.sleep(50)
    }
    await Bun.sleep(550)
    expect(starts.length).toBeLessThanOrEqual(3)
    expect(starts.slice(1).every((value, index) => value - starts[index] >= 490)).toBe(true)
    expect(displayed).toBe(revision)
  } finally {
    entry.dispose()
  }
})
