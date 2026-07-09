import { describe, expect, test } from "bun:test"
import z from "zod"
import { Bus } from "../../src/bus"
import { BusEvent } from "../../src/bus/bus-event"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe("Bus.publish", () => {
  test("does not await subscribers for streaming events", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const Streaming = BusEvent.define("test.streaming.publish", z.object({ value: z.string() }), {
          streaming: true,
        })
        let release!: () => void
        const slow = new Promise<void>((resolve) => {
          release = resolve
        })
        const unsubscribe = Bus.subscribe(Streaming, () => slow as never)
        try {
          const result = await Promise.race([Bus.publish(Streaming, { value: "a" }).then(() => "done"), delay(25)])
          expect(result).toBe("done")
          release()
          await slow
        } finally {
          unsubscribe()
        }
      },
    })
  })

  test("still awaits subscribers for state events", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const State = BusEvent.define("test.state.publish", z.object({ value: z.string() }))
        let release!: () => void
        const slow = new Promise<void>((resolve) => {
          release = resolve
        })
        const unsubscribe = Bus.subscribe(State, () => slow as never)
        try {
          const publish = Bus.publish(State, { value: "a" })
          const result = await Promise.race([publish.then(() => "done"), delay(25).then(() => "pending")])
          expect(result).toBe("pending")
          release()
          await publish
        } finally {
          unsubscribe()
        }
      },
    })
  })
})

test("handles rapid streaming publishes without crashing", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const Streaming = BusEvent.define("test.streaming.rapid", z.object({ n: z.number() }), {
        streaming: true,
      })
      let received = 0
      const unsubscribe = Bus.subscribe(Streaming, (_ev) => {
        received++
      })
      try {
        const N = 200
        for (let i = 0; i < N; i++) {
          await Bus.publish(Streaming, { n: i })
        }
        expect(received).toBe(N)
      } finally {
        unsubscribe()
      }
    },
  })
})

test("state events still log individually", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const State = BusEvent.define("test.state.log", z.object({ value: z.string() }))
      let received = 0
      const unsubscribe = Bus.subscribe(State, () => {
        received++
      })
      try {
        const N = 10
        for (let i = 0; i < N; i++) {
          await Bus.publish(State, { value: String(i) })
        }
        expect(received).toBe(N)
      } finally {
        unsubscribe()
      }
    },
  })
})

test("multiple streaming event types have independent rate counters", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const TypeA = BusEvent.define("test.streaming.typeA", z.object({ v: z.number() }), {
        streaming: true,
      })
      const TypeB = BusEvent.define("test.streaming.typeB", z.object({ v: z.number() }), {
        streaming: true,
      })
      let a = 0
      let b = 0
      const unsubA = Bus.subscribe(TypeA, () => {
        a++
      })
      const unsubB = Bus.subscribe(TypeB, () => {
        b++
      })
      try {
        const N = 50
        for (let i = 0; i < N; i++) {
          await Bus.publish(TypeA, { v: i })
          await Bus.publish(TypeB, { v: i })
        }
        expect(a).toBe(N)
        expect(b).toBe(N)
      } finally {
        unsubA()
        unsubB()
      }
    },
  })
})
