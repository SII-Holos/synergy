import { expect, test } from "bun:test"
import { createPluginSurfaceLifetime } from "../../src/plugin/surface-lifetime"

test("releases owned resources once in reverse order and aborts pending work", () => {
  const errors: unknown[] = []
  const lifetime = createPluginSurfaceLifetime((error) => errors.push(error))
  const released: string[] = []
  lifetime.context.onDispose(() => released.push("first"))
  const release = lifetime.context.onDispose(() => released.push("second"))
  release()
  release()
  lifetime.dispose()
  lifetime.dispose()
  expect(lifetime.context.signal.aborted).toBe(true)
  expect(released).toEqual(["second", "first"])
  expect(errors).toEqual([])
})

test("a failing cleanup cannot retain other resources", () => {
  const errors: unknown[] = []
  const lifetime = createPluginSurfaceLifetime((error) => errors.push(error))
  let released = false
  lifetime.context.onDispose(() => {
    released = true
  })
  lifetime.context.onDispose(() => {
    throw new Error("failed cleanup")
  })
  lifetime.dispose()
  expect(released).toBe(true)
  expect(errors).toHaveLength(1)
  let late = false
  lifetime.context.onDispose(() => {
    late = true
  })
  expect(late).toBe(true)
})
