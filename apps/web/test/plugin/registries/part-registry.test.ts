import { describe, expect, test } from "bun:test"
import type { PartRenderer } from "../../../src/plugin/registries/part-registry"
import {
  getPartRenderer,
  registerPartRenderer,
  resolvePartRenderer,
} from "../../../src/plugin/registries/part-registry"
import { PART_MAPPING } from "@ericsanchezok/synergy-ui/message-part"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function rendererStub() {
  return (() => null) as unknown as PartRenderer
}

describe("plugin part renderer registry", () => {
  test("loads a renderer once and caches it", async () => {
    const type = "plugin__part__basic"
    let loads = 0
    const unregister = registerPartRenderer(type, undefined, async () => {
      loads++
      return { default: rendererStub() }
    })
    try {
      expect(getPartRenderer(type)).toBeUndefined()
      resolvePartRenderer(type)
      for (let attempt = 0; attempt < 20 && !getPartRenderer(type); attempt++) await Bun.sleep(1)
      expect(loads).toBe(1)
      expect(getPartRenderer(type)).toBeFunction()
    } finally {
      unregister()
    }
    expect(getPartRenderer(type)).toBeUndefined()
  })

  test("a stale loader resolving mid-reload does not re-trigger the replacement loader", async () => {
    const type = "plugin__part__reload-race"
    const stale = deferred<{ default: PartRenderer }>()
    const current = deferred<{ default: PartRenderer }>()
    let currentLoads = 0

    const unregisterStale = registerPartRenderer(type, undefined, () => stale.promise)
    // Start the stale load.
    resolvePartRenderer(type)

    // Reload: dispose the stale entry, register the replacement.
    unregisterStale()
    const unregisterCurrent = registerPartRenderer(type, undefined, () => {
      currentLoads++
      return current.promise
    })
    try {
      // Start the replacement load (still in flight).
      resolvePartRenderer(type)

      // The stale loader resolves while the replacement is still loading.
      // It must not clear the replacement's in-flight marker.
      stale.resolve({ default: rendererStub() })
      await Bun.sleep(5)

      // A further resolve while the replacement is in flight must be a no-op.
      resolvePartRenderer(type)
      await Bun.sleep(5)
      expect(currentLoads).toBe(1)

      // The replacement completes and becomes the renderer.
      const currentRenderer = rendererStub()
      current.resolve({ default: currentRenderer })
      for (let attempt = 0; attempt < 20 && !getPartRenderer(type); attempt++) await Bun.sleep(1)
      expect(getPartRenderer(type)).toBe(currentRenderer)
      expect(PART_MAPPING[type]).toBe(currentRenderer)
    } finally {
      unregisterCurrent()
    }
  })

  test("a rejected loader does not poison later loads of the same type", async () => {
    const type = "plugin__part__rejected"
    const unregister = registerPartRenderer(type, undefined, async () => {
      throw new Error("load failed")
    })
    try {
      resolvePartRenderer(type)
      await Bun.sleep(5)
      expect(getPartRenderer(type)).toBeUndefined()
    } finally {
      unregister()
    }

    // Re-registering the same type after a failure must be able to load again.
    const unregisterAgain = registerPartRenderer(type, undefined, async () => ({ default: rendererStub() }))
    try {
      resolvePartRenderer(type)
      for (let attempt = 0; attempt < 20 && !getPartRenderer(type); attempt++) await Bun.sleep(1)
      expect(getPartRenderer(type)).toBeFunction()
    } finally {
      unregisterAgain()
    }
  })
})
