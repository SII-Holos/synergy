import { expect, test } from "bun:test"
import { createPluginSurfaceLifetime } from "../../src/plugin/surface-lifetime"

test("retained plugin activity pauses and resumes without disposing its domain lifetime", () => {
  const errors: unknown[] = []
  const lifetime = createPluginSurfaceLifetime((error) => errors.push(error))
  const activity: boolean[] = []
  lifetime.context.onActivity!((active) => activity.push(active))
  lifetime.setActive(false)
  lifetime.setActive(false)
  expect(lifetime.context.active!()).toBe(false)
  expect(lifetime.context.signal.aborted).toBe(false)
  lifetime.setActive(true)
  lifetime.dispose()
  lifetime.setActive(true)
  expect(activity).toEqual([true, false, true, false])
  expect(lifetime.context.signal.aborted).toBe(true)
  expect(errors).toEqual([])
})

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
