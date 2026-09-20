import { expect, test } from "bun:test"
import { RuntimeContext } from "../../src/lifecycle/context"

const host = (home: string) => ({ home, root: `${home}/.synergy`, env: { SYNERGY_TEST_HOME: home } })

test("runtime state is isolated across interleaved work and restored after nesting", async () => {
  const a = RuntimeContext.create(host("/isolated/a"))
  const b = RuntimeContext.create(host("/isolated/b"))
  const state = RuntimeContext.state(() => new Map<string, string>())
  const ready = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const pending = a.run(async () => {
    state().set("home", "a")
    ready.resolve()
    await release.promise
    expect(state().get("home")).toBe("a")
    expect(RuntimeContext.current().host.home).toBe("/isolated/a")
  })
  await ready.promise
  await b.run(async () => {
    expect(state().size).toBe(0)
    state().set("home", "b")
    expect(a.run(() => state().get("home"))).toBe("a")
    expect(state().get("home")).toBe("b")
  })
  release.resolve()
  await pending
  expect(() => state()).toThrow("No runtime context")
})

test("a bound callback keeps its owner when another runtime invokes it", () => {
  const a = RuntimeContext.create(host("/isolated/a"))
  const b = RuntimeContext.create(host("/isolated/b"))
  const read = a.bind(() => RuntimeContext.current().host.home)
  expect(b.run(read)).toBe("/isolated/a")
  a.run(() => {
    expect(RuntimeContext.exit(() => RuntimeContext.tryCurrent())).toBeUndefined()
    expect(RuntimeContext.current()).toBe(a)
  })
})

test("runtime switching is rejected inside a protected transaction", async () => {
  const a = RuntimeContext.create(host("/isolated/a"))
  const b = RuntimeContext.create(host("/isolated/b"))
  await a.run(() =>
    RuntimeContext.transaction(async () => {
      expect(a.run(() => RuntimeContext.current())).toBe(a)
      expect(() => b.run(() => "wrong owner")).toThrow("transaction")
      await Promise.resolve()
      expect(() => b.run(() => "wrong owner")).toThrow("transaction")
    }),
  )
  expect(b.run(() => RuntimeContext.current())).toBe(b)
})

test("disposed runtime contexts reject captured continuations and cannot recreate state", () => {
  const a = RuntimeContext.create(host("/isolated/a"))
  let creations = 0
  const state = RuntimeContext.state(() => ({ value: ++creations }))
  const read = a.bind(() => state().value)
  expect(read()).toBe(1)
  a.dispose()
  a.dispose()
  expect(read).toThrow("closed")
  expect(creations).toBe(1)
  const b = RuntimeContext.create(host("/isolated/b"))
  expect(b.run(() => state().value)).toBe(2)
})

test("observability context and bound callbacks keep their Runtime owner", async () => {
  const { ObservabilityContext } = await import("../../src/observability/context")
  const a = RuntimeContext.create(host("/isolated/trace-a"))
  const b = RuntimeContext.create(host("/isolated/trace-b"))
  a.run(() =>
    ObservabilityContext.withContext({ sessionID: "session-a" }, () => {
      RuntimeContext.exit(() => {
        expect(RuntimeContext.tryCurrent()).toBeUndefined()
        expect(ObservabilityContext.current()).toEqual({})
      })
      expect(ObservabilityContext.current()).toEqual({ sessionID: "session-a" })
      const read = ObservabilityContext.bind(() => ({
        owner: RuntimeContext.current(),
        context: ObservabilityContext.current(),
      }))
      b.run(() => {
        expect(ObservabilityContext.current()).toEqual({})
        expect(read()).toEqual({ owner: a, context: { sessionID: "session-a" } })
        expect(ObservabilityContext.current()).toEqual({})
      })
    }),
  )
})
