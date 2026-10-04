import { afterAll, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Snapshot } from "../../src/session/snapshot"
import { SnapshotGit } from "../../src/session/snapshot-git"
import { SnapshotStore } from "../../src/session/snapshot-store"
import { ScopeContext } from "../../src/scope/context"
import { ObservabilityMetrics } from "../../src/observability/metrics"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()

async function packs(repository: string) {
  return (await fs.readdir(path.join(repository, "objects", "pack"))).filter((name) => name.endsWith(".pack")).sort()
}

test("large captures pack exact bytes once and reuse content across sessions", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const bytes = Buffer.from("\0data 7\ndone\nget-mark :1\n\xff", "binary")
        await Promise.all(
          Array.from({ length: 65 }, (_, index) =>
            fs.writeFile(path.join(tmp.path, `file-${index}.txt`), Buffer.concat([bytes, Buffer.from(String(index))])),
          ),
        )
        const first = (await Snapshot.track("capture-first"))!
        expect(first).toBeTruthy()
        const repository = SnapshotStore.repository(scope.id)
        const initial = await packs(repository)
        expect(initial).toHaveLength(1)
        const result = await SnapshotGit.run(["git", "--git-dir", repository, "show", `${first}:file-0.txt`], tmp.path)
        expect(Buffer.from(result.bytes)).toEqual(Buffer.concat([bytes, Buffer.from("0")]))
        const metrics: Array<Parameters<typeof ObservabilityMetrics.record>[0]> = []
        const second = await ObservabilityMetrics.withForwarder(
          (metric) => metrics.push(metric),
          () => Snapshot.track("capture-second"),
        )
        expect(second).toBe(first)
        expect(await packs(repository)).toEqual(initial)
        const written = metrics.find((metric) => metric.name === "snapshot.capture.objects.new")
        expect(written?.value).toBe(0)
        expect(written?.sessionID).toBe("capture-second")
        expect(written?.scopeID).toBe(scope.id)
        expect(await SnapshotStore.owns(scope.id, "capture-second", first)).toBe(true)
        await fs.writeFile(path.join(tmp.path, "file-0.txt"), "new bytes")
        const changed = await Snapshot.track("capture-second")
        expect(changed).not.toBe(first)
        expect(await packs(repository)).toEqual(initial)
        await SnapshotStore.command(repository, ["gc", "--prune=now"])
        const historical = await SnapshotGit.run(
          ["git", "--git-dir", repository, "show", `${first}:file-0.txt`],
          tmp.path,
        )
        expect(Buffer.from(historical.bytes)).toEqual(Buffer.concat([bytes, Buffer.from("0")]))
        expect(await SnapshotStore.owns(scope.id, "capture-first", first)).toBe(true)
      },
    })
  }))

test("small captures keep loose objects and byte-heavy captures bound their buffers", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await Promise.all(
          Array.from({ length: 64 }, (_, index) => fs.writeFile(path.join(tmp.path, `${index}.txt`), String(index))),
        )
        expect(await Snapshot.track("capture-small")).toBeTruthy()
        const repository = SnapshotStore.repository(scope.id)
        expect(await packs(repository)).toHaveLength(0)
        const metrics: Array<Parameters<typeof ObservabilityMetrics.record>[0]> = []
        for (let index = 0; index < 16; index++)
          await fs.writeFile(path.join(tmp.path, `large-${index}.txt`), Buffer.alloc(2 * 1024 * 1024, index))
        expect(
          await ObservabilityMetrics.withForwarder(
            (metric) => metrics.push(metric),
            () => Snapshot.track("capture-large"),
          ),
        ).toBeTruthy()
        expect(await packs(repository)).toHaveLength(1)
        expect(metrics.find((metric) => metric.name === "snapshot.capture.objects.new")?.value).toBe(16)
        expect(
          metrics.find((metric) => metric.name === "snapshot.capture.objects.reused")?.value,
        ).toBeGreaterThanOrEqual(64)
        const peak = metrics.find((metric) => metric.name === "snapshot.capture.buffer.peak")
        expect(peak?.value).toBeGreaterThan(0)
        expect(peak?.value).toBeLessThanOrEqual(32 * 1024 * 1024)
      },
    })
  }))

test("concurrent packed captures retain independent roots in the shared store", () =>
  runtime.run(async () => {
    for (let iteration = 0; iteration < 3; iteration++) {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()
      await ScopeContext.provide({
        scope,
        fn: async () => {
          await Promise.all(
            Array.from({ length: 70 }, (_, index) =>
              fs.writeFile(path.join(tmp.path, `${index}.txt`), `concurrent ${index}`),
            ),
          )
          const [first, second] = await Promise.all([Snapshot.track("packed-a"), Snapshot.track("packed-b")])
          expect(first).toBeTruthy()
          expect(second).toBe(first)
          expect(await SnapshotStore.owns(scope.id, "packed-a", first!)).toBe(true)
          expect(await SnapshotStore.owns(scope.id, "packed-b", second!)).toBe(true)
          await SnapshotStore.command(SnapshotStore.repository(scope.id), ["fsck", "--full"])
        },
      })
    }
  }))

test("cancelled packed captures preserve roots and can retry after a concurrent import", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await fs.writeFile(path.join(tmp.path, "original.txt"), "original")
        const original = (await Snapshot.track("waiting-b"))!
        expect(original).toBeTruthy()
        await Promise.all(
          Array.from({ length: 70 }, (_, index) => fs.writeFile(path.join(tmp.path, `${index}.txt`), `new ${index}`)),
        )
        const entered = Promise.withResolvers<void>()
        const released = Promise.withResolvers<void>()
        const create = SnapshotGit.blobWriter
        const importer = spyOn(SnapshotGit, "blobWriter").mockImplementation(async (...args) => {
          const writer = await create(...args)
          return {
            ...writer,
            async write(blobs) {
              entered.resolve()
              await released.promise
              await writer.write(blobs)
            },
          }
        })
        const first = Snapshot.track("waiting-a")
        try {
          await entered.promise
          expect(await Snapshot.track("waiting-b", AbortSignal.timeout(200))).toBeUndefined()
          expect(await SnapshotStore.owns(scope.id, "waiting-b", original)).toBe(true)
        } finally {
          released.resolve()
          await first
          importer.mockRestore()
        }
        const completed = (await first)!
        expect(completed).toBeTruthy()
        expect(await Snapshot.track("waiting-b")).toBe(completed)
        expect(await SnapshotStore.owns(scope.id, "waiting-a", completed)).toBe(true)
        expect(await SnapshotStore.owns(scope.id, "waiting-b", completed)).toBe(true)
        expect(await SnapshotStore.owns(scope.id, "waiting-b", original)).toBe(true)
        expect(await packs(SnapshotStore.repository(scope.id))).toHaveLength(1)
      },
    })
  }))

afterAll(() => runtime.close())
