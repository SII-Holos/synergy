import { expect, test } from "bun:test"
import type { VirtualizerHandle } from "virtua/solid"
import {
  createConversationLayoutBinding,
  createConversationLayoutCache,
} from "../../../src/components/session/conversation-layout"

const layout = () => ({
  keys: ["paragraph", "tools"],
  width: 700,
  cache: [[86, 240], 40] as unknown as VirtualizerHandle["cache"],
})

test("retains accepted measurements independently of the disposed renderer and virtualizer arrays", () => {
  const cache = createConversationLayoutCache()
  const current = layout()
  cache.retain("server:scope:session:full", current)
  current.keys.pop()
  ;(current.cache as unknown as [number[], number])[0][0] = -1
  const restored = cache.restore("server:scope:session:full", layout().keys, 700)!
  expect(restored).toEqual(layout().cache)
  ;(restored as unknown as [number[], number])[0][0] = -1
  expect(cache.restore("server:scope:session:full", layout().keys, 700)).toEqual(layout().cache)
})

test("changed widths, disclosure projections and identities require current measurements", () => {
  const cache = createConversationLayoutCache()
  cache.retain("server:scope:session:full", layout())
  expect(cache.restore("server:scope:session:full", layout().keys, 350)).toBeUndefined()
  expect(cache.restore("server:scope:session:full", ["tools", "paragraph"], 700)).toBeUndefined()
  expect(cache.restore("server:scope:session:full", ["paragraph"], 700)).toBeUndefined()
  for (const identity of ["server:scope:other:full", "other:scope:session:full", "server:scope:session:minimal"])
    expect(cache.restore(identity, layout().keys, 700)).toBeUndefined()
  expect(cache.restore("server:scope:session:full", layout().keys, 700)).toEqual(layout().cache)
})

test("the byte and entry budgets span every conversation and respect recent visits", () => {
  const cache = createConversationLayoutCache(1024, 2)
  cache.retain("first", layout())
  cache.retain("second", layout())
  cache.restore("first", layout().keys, 700)
  cache.retain("third", layout())
  expect(cache.size).toBe(2)
  expect(cache.restore("second", layout().keys, 700)).toBeUndefined()
  expect(cache.restore("first", layout().keys, 700)).toEqual(layout().cache)
  for (let index = 0; index < 200; index++) cache.retain(String(index), layout())
  expect(cache.size).toBeLessThanOrEqual(2)
  expect(cache.bytes).toBeLessThanOrEqual(1024)
  cache.retain("oversized", { ...layout(), keys: ["x".repeat(1024)] })
  expect(cache.restore("oversized", ["x".repeat(1024)], 700)).toBeUndefined()
  expect(cache.bytes).toBeLessThanOrEqual(1024)
})

test("unmeasured detached views cannot publish zero-width layout caches", () => {
  const cache = createConversationLayoutCache()
  for (const width of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) cache.retain(String(width), { ...layout(), width })
  expect(cache.size).toBe(0)
  expect(cache.bytes).toBe(0)
})

test("the virtualizer publishes its accepted layout before releasing its parent handle", () => {
  const cache = createConversationLayoutCache()
  let current: VirtualizerHandle | undefined
  const binding = createConversationLayoutBinding(cache, {
    identity: () => "session",
    keys: () => layout().keys,
    width: () => 700,
    changed(value) {
      if (!value) expect(binding.restore()).toEqual(layout().cache)
      current = value
    },
  })
  binding.ref({ cache: layout().cache } as VirtualizerHandle)
  expect(current).toBeDefined()
  binding.ref(undefined)
  expect(current).toBeUndefined()
  expect(binding.restore()).toEqual(layout().cache)
})

test("a resize or density change immediately before release cannot label old measurements as current", () => {
  for (const changed of ["width", "density"]) {
    const cache = createConversationLayoutCache()
    let width = 700
    let identity = "session:full"
    const binding = createConversationLayoutBinding(cache, {
      identity: () => identity,
      keys: () => layout().keys,
      width: () => width,
      changed() {},
    })
    binding.ref({ cache: layout().cache } as VirtualizerHandle)
    if (changed === "width") width = 350
    else identity = "session:minimal"
    binding.ref(undefined)
    expect(cache.size).toBe(0)
    expect(binding.restore()).toBeUndefined()
  }
})

test("DOM removal before ref release preserves the width of the last mounted view", () => {
  const cache = createConversationLayoutCache()
  let width = 700
  const binding = createConversationLayoutBinding(cache, {
    identity: () => "session",
    keys: () => layout().keys,
    width: () => width,
    changed() {},
  })
  binding.ref({ cache: layout().cache } as VirtualizerHandle)
  width = 0
  binding.ref(undefined)
  width = 700
  expect(binding.restore()).toEqual(layout().cache)
})

test("an observed mounted resize cannot publish new measurements under the original width after DOM removal", () => {
  const cache = createConversationLayoutCache()
  let width = 700
  const binding = createConversationLayoutBinding(cache, {
    identity: () => "session",
    keys: () => layout().keys,
    width: () => width,
    changed() {},
  })
  binding.ref({ cache: layout().cache } as VirtualizerHandle)
  width = 350
  binding.resize(width)
  width = 0
  binding.ref(undefined)
  width = 700
  expect(binding.restore()).toBeUndefined()
  expect(cache.size).toBe(0)
})
