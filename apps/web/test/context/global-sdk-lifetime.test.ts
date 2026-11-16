import { expect, test } from "bun:test"
import { createGlobalSDKLifetime } from "../../src/context/global-sdk-lifetime"

const identity = { url: "http://runtime.example", runtimeID: "runtime-a", cacheKey: "personal-a" }
function fixture() {
  const created: Array<{
    identity: typeof identity
    value: { source: number }
    presented: boolean[]
    closed: boolean
  }> = []
  const changes: Array<{ source: number } | undefined> = []
  const lifetime = createGlobalSDKLifetime({
    create(input) {
      const entry = {
        identity: { ...input },
        value: { source: created.length + 1 },
        presented: [] as boolean[],
        closed: false,
      }
      created.push(entry)
      return {
        value: entry.value,
        presentation(value) {
          entry.presented.push(value)
        },
        dispose() {
          entry.closed = true
        },
      }
    },
    changed(value) {
      changes.push(value)
    },
  })
  return { lifetime, created, changes }
}

test("personal presentation leases reuse the same background SDK instead of opening a second source", () => {
  const f = fixture()
  try {
    const source = f.lifetime.ensure(identity)
    if (!source) throw new Error("Personal source did not open")
    const first = f.lifetime.acquire(identity)
    const second = f.lifetime.acquire(identity)
    expect(first.value).toBe(source)
    expect(second.value).toBe(source)
    expect(f.created).toHaveLength(1)
    first.release()
    expect(f.created[0].presented).toEqual([false, true])
    second.release()
    expect(f.created[0].presented).toEqual([false, true, false])
    expect(f.created[0].closed).toBe(false)
    expect(f.lifetime.ensure(identity)).toBe(source)
    expect(f.lifetime.acquire(identity).value).toBe(source)
    expect(f.created).toHaveLength(1)
  } finally {
    f.lifetime.dispose()
  }
  expect(f.created[0].closed).toBe(true)
})

test("source replacement captures identity and late presentation cleanup cannot affect the successor", () => {
  const f = fixture()
  try {
    const input = { ...identity }
    const first = f.lifetime.acquire(input)
    input.runtimeID = "mutated"
    expect(f.lifetime.ensure(identity)).toBe(first.value)
    const second = f.lifetime.acquire({ ...identity, runtimeID: "runtime-b", cacheKey: "personal-b" })
    expect(f.created).toHaveLength(2)
    expect(f.created[0].closed).toBe(true)
    expect(f.lifetime.current()).toBe(second.value)
    first.release()
    first.release()
    expect(f.created[1].presented).toEqual([false, true])
    f.lifetime.ensure()
    expect(f.created[1].closed).toBe(true)
    expect(f.lifetime.current()).toBeUndefined()
    second.release()
    expect(f.created[1].presented).toEqual([false, true, false])
  } finally {
    f.lifetime.dispose()
  }
})
