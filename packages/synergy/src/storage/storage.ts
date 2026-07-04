import path from "path"
import fs from "fs/promises"
import { Global } from "../global"
import { Lock } from "../util/lock"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import z from "zod"
import { PerformanceMetrics } from "@/performance/metrics"
import { PerformanceResources } from "@/performance/resources"

export namespace Storage {
  const READ_MANY_CONCURRENCY = 32

  export const NotFoundError = NamedError.create(
    "NotFoundError",
    z.object({
      message: z.string(),
    }),
  )

  function resolveDir() {
    return Global.Path.data
  }

  export async function remove(key: string[]) {
    const dir = resolveDir()
    const target = path.join(dir, ...key) + ".json"
    await fs.unlink(target).catch(() => {})
    await pruneEmptyParents(path.dirname(target), dir)
  }

  export async function read<T>(key: string[]) {
    const dir = resolveDir()
    const target = path.join(dir, ...key) + ".json"
    return measureStorage("read", key, async () =>
      withErrorHandling(async () => {
        using _ = await Lock.read(target)
        const file = Bun.file(target)
        const result = await file.json()
        const size = file.size
        PerformanceResources.addRead(size)
        return result as T
      }),
    )
  }

  export async function readMany<T>(keys: string[][]): Promise<(T | undefined)[]> {
    const dir = resolveDir()
    const result: (T | undefined)[] = new Array(keys.length)
    let next = 0
    const workers = Array.from({ length: Math.min(READ_MANY_CONCURRENCY, keys.length) }, async () => {
      while (next < keys.length) {
        const index = next++
        const key = keys[index]
        const target = path.join(dir, ...key) + ".json"
        try {
          using _ = await Lock.read(target)
          result[index] = (await Bun.file(target).json()) as T
        } catch {
          result[index] = undefined
        }
      }
    })
    await Promise.all(workers)
    return result
  }

  export async function update<T>(key: string[], fn: (draft: T) => void) {
    const dir = resolveDir()
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      using _ = await Lock.write(target)
      const content = await Bun.file(target).json()
      fn(content)
      await writeJsonAtomic(target, content)
      return content as T
    })
  }

  export async function write<T>(key: string[], content: T) {
    const dir = resolveDir()
    const target = path.join(dir, ...key) + ".json"
    return measureStorage("write", key, async () =>
      withErrorHandling(async () => {
        using _ = await Lock.write(target)
        const bytes = byteLength(JSON.stringify(content, null, 2))
        await writeJsonAtomic(target, content)
        PerformanceResources.addWrite(bytes)
      }),
    )
  }

  export async function scan(prefix: string[]): Promise<string[]> {
    const dir = resolveDir()
    const target = path.join(dir, ...prefix)
    try {
      const entries = await fs.readdir(target)
      return entries
        .filter((e) => !isTempFile(e))
        .map((e) => (e.endsWith(".json") ? e.slice(0, -5) : e))
        .sort()
    } catch {
      return []
    }
  }

  export async function removeTree(prefix: string[]) {
    const dir = resolveDir()
    const target = path.join(dir, ...prefix)
    await fs.rm(target, { recursive: true, force: true })
    await pruneEmptyParents(path.dirname(target), dir)
  }

  async function pruneEmptyParents(current: string, root: string) {
    while (current !== root && current.startsWith(root)) {
      try {
        const entries = await fs.readdir(current)
        if (entries.length > 0) break
        await fs.rmdir(current)
        current = path.dirname(current)
      } catch {
        break
      }
    }
  }

  async function measureStorage<T>(operation: string, key: string[], body: () => Promise<T>) {
    const start = performance.now()
    try {
      return await body()
    } finally {
      PerformanceMetrics.record({
        name: "storage.operation.duration",
        value: performance.now() - start,
        unit: "ms",
        module: "storage",
        labels: { operation, keyPrefix: key[0] ?? "root" },
      })
    }
  }

  function byteLength(value: string) {
    return new TextEncoder().encode(value).byteLength
  }

  async function withErrorHandling<T>(body: () => Promise<T>) {
    return body().catch((e) => {
      if (!(e instanceof Error)) throw e
      const errnoException = e as NodeJS.ErrnoException
      if (errnoException.code === "ENOENT") {
        throw new NotFoundError({ message: `Resource not found: ${errnoException.path}` })
      }
      throw e
    })
  }

  const glob = new Bun.Glob("**/*")
  export async function list(prefix: string[]) {
    const dir = resolveDir()
    try {
      const result = await Array.fromAsync(
        glob.scan({
          cwd: path.join(dir, ...prefix),
          onlyFiles: true,
        }),
      ).then((results) =>
        results
          .filter((x) => x.endsWith(".json") && !isTempFile(path.basename(x)))
          .map((x) => [...prefix, ...x.slice(0, -5).split(path.sep)]),
      )
      result.sort()
      return result
    } catch {
      return []
    }
  }

  async function writeJsonAtomic(target: string, content: unknown) {
    await fs.mkdir(path.dirname(target), { recursive: true })
    const tmp = path.join(
      path.dirname(target),
      `.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    )
    await Bun.write(tmp, JSON.stringify(content, null, 2))
    await fs.rename(tmp, target)
  }

  function isTempFile(name: string) {
    return name.includes(".tmp-") || name.endsWith(".tmp")
  }
}
