import { expect, spyOn, test } from "bun:test"
import { z } from "zod"
import { ScopeContext } from "../../src/scope/context"
import { RolloutArtifact } from "../../src/session/rollout/artifact"
import { Storage } from "../../src/storage/storage"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "../support/fixture"

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === "function"
  )
}

async function* metadata(owner: RolloutArtifact.Owner, options: { signal?: AbortSignal } = {}) {
  const iterate: unknown = Reflect.get(RolloutArtifact, "iterate")
  if (typeof iterate !== "function") {
    for (const ref of await RolloutArtifact.list(owner)) yield ref
    return
  }
  const values: unknown = iterate(owner, options)
  if (!isAsyncIterable(values)) throw new Error("Artifact metadata reader must be asynchronous")
  for await (const value of values) yield RolloutArtifact.Ref.parse(value)
}

test("native Artifact metadata yields its requested owner page before reading a corrupt later page", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      workspace: null,
      async fn() {
        const owner: RolloutArtifact.Owner = {
          kind: "operation",
          scopeID: ScopeContext.current.scope.id,
          operationID: crypto.randomUUID(),
        }
        const other: RolloutArtifact.Owner = { ...owner, operationID: crypto.randomUUID() }
        const refs: RolloutArtifact.Ref[] = []
        await Storage.transaction(async () => {
          for (let index = 0; index < 135; index++) refs.push(await RolloutArtifact.writeText(owner, ""))
          await RolloutArtifact.writeText(other, "")
        })
        refs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        const corrupt = refs.at(-1)!
        await Storage.write([...RolloutArtifact.root(owner), "artifacts", corrupt.id, "info"], {
          ...corrupt,
          status: "corrupt",
        })
        const childKeys = Storage.childKeys
        const pages: number[] = []
        using observed = spyOn(Storage, "childKeys").mockImplementation(async (input) => {
          pages.push(input.limit ?? 100)
          return childKeys(input)
        })
        const reader = metadata(owner)
        for (let index = 0; index < 128; index++)
          expect(await reader.next()).toEqual({ value: refs[index], done: false })
        expect(pages).toHaveLength(1)
        expect(pages[0]).toBeLessThanOrEqual(128)
        for (let index = 128; index < 134; index++)
          expect(await reader.next()).toEqual({ value: refs[index], done: false })
        await expect(reader.next()).rejects.toBeInstanceOf(z.ZodError)
        expect(pages.every((limit) => limit <= 128)).toBe(true)
        expect(await Array.fromAsync(metadata({ ...owner, operationID: crypto.randomUUID() }))).toEqual([])
        expect(await Array.fromAsync(metadata(other))).toHaveLength(1)
        await expect(metadata({ ...owner, scopeID: "../outside" }).next()).rejects.toThrow()
      },
    })
  })
})

test("native Artifact metadata returns early, stops before cancelled reads and propagates missing metadata", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      workspace: null,
      async fn() {
        const owner: RolloutArtifact.Owner = {
          kind: "operation",
          scopeID: ScopeContext.current.scope.id,
          operationID: crypto.randomUUID(),
        }
        const first = await RolloutArtifact.writeText(owner, "")
        const childKeys = Storage.childKeys
        const read = Storage.read
        let calls = 0
        using pages = spyOn(Storage, "childKeys").mockImplementation(async (input) => {
          calls++
          return childKeys(input)
        })
        using reads = spyOn(Storage, "read").mockImplementation(
          async <T>(key: string[], options?: { silentNotFound?: boolean }) => {
            calls++
            return read<T>(key, options)
          },
        )
        const early = metadata(owner)
        expect(await early.next()).toEqual({ value: first, done: false })
        const stopped = calls
        await early.return(undefined)
        expect(await early.next()).toEqual({ value: undefined, done: true })
        expect(calls).toBe(stopped)
        const reason = new Error("Stop original metadata traversal")
        const controller = new AbortController()
        controller.abort(reason)
        await expect(metadata(owner, { signal: controller.signal }).next()).rejects.toBe(reason)
        expect(calls).toBe(stopped)
        const active = new AbortController()
        const cancelled = metadata(owner, { signal: active.signal })
        expect(await cancelled.next()).toEqual({ value: first, done: false })
        const beforeCancel = calls
        active.abort(reason)
        await expect(cancelled.next()).rejects.toBe(reason)
        expect(calls).toBe(beforeCancel)
        reads.mockRestore()
        pages.mockRestore()
        const root = [...RolloutArtifact.root(owner), "artifacts", first.id]
        await Storage.transaction(async () => {
          await Storage.write([...root, "retained-child"], { orphaned: true })
          await Storage.remove([...root, "info"])
        })
        await expect(metadata(owner).next()).rejects.toBeInstanceOf(Storage.NotFoundError)
      },
    })
  })
})
