import path from "path"
import fs from "fs/promises"
import { Global } from "../global"
import { Lock } from "../util/lock"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import z from "zod"
import { ObservabilityIssues } from "@/observability/issues"
import { ObservabilityMetrics } from "@/observability/metrics"
import { ObservabilityResources } from "@/observability/resources"

export namespace Storage {
  const READ_MANY_CONCURRENCY = 32
  const STORAGE_DURATION_SAMPLE_RATE = 0.02

  export const NotFoundError = NamedError.create(
    "NotFoundError",
    z.object({
      message: z.string(),
    }),
  )

  function resolveDir() {
    return Global.Path.data
  }

  function assertValidKey(key: string[]): void {
    if (
      key.some(
        (segment) =>
          segment.length === 0 ||
          segment === "." ||
          segment === ".." ||
          segment.includes("\0") ||
          segment.includes("/") ||
          segment.includes("\\"),
      )
    ) {
      throw new Error("Storage path contains an invalid segment")
    }
  }

  function resolveDirectory(key: string[]): { dir: string; target: string } {
    assertValidKey(key)
    const dir = path.resolve(resolveDir())
    const target = path.resolve(dir, ...key)
    if (target !== dir && !target.startsWith(`${dir}${path.sep}`)) throw new Error("Storage path escapes data root")
    return { dir, target }
  }

  function resolveTarget(key: string[]): { dir: string; target: string } {
    const resolved = resolveDirectory(key)
    return { ...resolved, target: `${resolved.target}.json` }
  }

  export async function remove(key: string[]) {
    const { dir, target } = resolveTarget(key)
    return measureStorage("remove", key, async () => {
      await fs.unlink(target).catch(() => {})
      await pruneEmptyParents(path.dirname(target), dir)
    })
  }

  export async function read<T>(key: string[]) {
    const { target } = resolveTarget(key)
    return measureStorage("read", key, async () =>
      withErrorHandling(async () => {
        using _ = await Lock.read(target)
        const file = Bun.file(target)
        const result = await file.json()
        const size = file.size
        ObservabilityResources.addRead(size)
        return result as T
      }),
    )
  }

  export async function readMany<T>(keys: string[][]): Promise<(T | undefined)[]> {
    const targets = keys.map((key) => resolveTarget(key).target)
    return measureStorage("readMany", [keys[0]?.[0] ?? "root"], async () => {
      const result: (T | undefined)[] = new Array(keys.length)
      let next = 0
      let readBytes = 0
      const workers = Array.from({ length: Math.min(READ_MANY_CONCURRENCY, keys.length) }, async () => {
        while (next < keys.length) {
          const index = next++
          const target = targets[index]
          if (!target) continue
          try {
            using _ = await Lock.read(target)
            const file = Bun.file(target)
            result[index] = (await file.json()) as T
            readBytes += file.size
          } catch {
            result[index] = undefined
          }
        }
      })
      await Promise.all(workers)
      if (readBytes) ObservabilityResources.addRead(readBytes)
      return result
    })
  }

  export interface WriteOptions {
    compact?: boolean
  }

  function serialize(content: unknown, options?: WriteOptions) {
    return options?.compact ? JSON.stringify(content) : JSON.stringify(content, null, 2)
  }

  export async function update<T>(key: string[], fn: (draft: T) => void, options?: WriteOptions) {
    const { target } = resolveTarget(key)
    return measureStorage("update", key, async () =>
      withErrorHandling(async () => {
        using _ = await Lock.write(target)
        const content = await Bun.file(target).json()
        fn(content)
        const serialized = serialize(content, options)
        await writeJsonAtomic(target, serialized)
        ObservabilityResources.addWrite(Buffer.byteLength(serialized, "utf8"))
        return content as T
      }),
    )
  }

  export async function write<T>(key: string[], content: T, options?: WriteOptions) {
    const { target } = resolveTarget(key)
    return measureStorage("write", key, async () =>
      withErrorHandling(async () => {
        using _ = await Lock.write(target)
        const serialized = serialize(content, options)
        await writeJsonAtomic(target, serialized)
        ObservabilityResources.addWrite(Buffer.byteLength(serialized, "utf8"))
      }),
    )
  }

  export async function scan(prefix: string[]): Promise<string[]> {
    const { target } = resolveDirectory(prefix)
    return measureStorage("scan", prefix, async () => {
      try {
        const entries = await fs.readdir(target)
        return entries
          .filter((entry) => !isTempFile(entry))
          .map((entry) => (entry.endsWith(".json") ? entry.slice(0, -5) : entry))
          .sort()
      } catch {
        return []
      }
    })
  }

  export async function removeTree(prefix: string[]) {
    const { dir, target } = resolveDirectory(prefix)
    await fs.rm(target, { recursive: true, force: true })
    await pruneEmptyParents(path.dirname(target), dir)
  }

  async function pruneEmptyParents(current: string, root: string) {
    while (current !== root && current.startsWith(`${root}${path.sep}`)) {
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
    let status = "ok"
    try {
      return await body()
    } catch (error) {
      status = "error"
      ObservabilityIssues.raise({
        code: "PERF_STORAGE_OPERATION_ERROR",
        severity: "warning",
        module: "storage",
        title: "Storage operation failed",
        message: `${operation} failed for ${key[0] ?? "root"}`,
        evidence: {
          operation,
          keyPrefix: key[0] ?? "root",
          errorName: error instanceof Error ? error.name : "unknown",
        },
      })
      throw error
    } finally {
      const durationMs = performance.now() - start
      ObservabilityMetrics.record({
        name: "storage.operation.duration",
        value: durationMs,
        unit: "ms",
        module: "storage",
        labels: { operation, keyPrefix: key[0] ?? "root", status },
        sampleRate: status === "error" ? 1 : STORAGE_DURATION_SAMPLE_RATE,
      })
      ObservabilityMetrics.record({
        name: "storage.operation.count",
        value: 1,
        unit: "count",
        module: "storage",
        labels: { operation, status },
      })
      if (status === "error") {
        ObservabilityMetrics.record({
          name: "storage.operation.error",
          value: 1,
          unit: "count",
          module: "storage",
          labels: { operation },
        })
      }
    }
  }

  async function withErrorHandling<T>(body: () => Promise<T>) {
    return body().catch((error) => {
      if (!(error instanceof Error)) throw error
      const errnoException = error as NodeJS.ErrnoException
      if (errnoException.code === "ENOENT") {
        throw new NotFoundError({ message: "Resource not found" })
      }
      if (errnoException.code || errnoException.path) {
        throw new Error(`Storage I/O error: ${errnoException.code ?? "unknown"}`)
      }
      throw error
    })
  }

  const glob = new Bun.Glob("**/*")
  export async function list(prefix: string[]) {
    const { target } = resolveDirectory(prefix)
    return measureStorage("list", prefix, async () => {
      try {
        const result = await Array.fromAsync(
          glob.scan({
            cwd: target,
            onlyFiles: true,
          }),
        ).then((results) =>
          results
            .filter((entry) => entry.endsWith(".json") && !isTempFile(path.basename(entry)))
            .map((entry) => [...prefix, ...entry.slice(0, -5).split(path.sep)]),
        )
        result.sort()
        return result
      } catch {
        return []
      }
    })
  }

  async function writeJsonAtomic(target: string, serialized: string) {
    await fs.mkdir(path.dirname(target), { recursive: true })
    const tmp = path.join(
      path.dirname(target),
      `.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    )
    await Bun.write(tmp, serialized)
    await fs.rename(tmp, target)
  }

  function isTempFile(name: string) {
    return name.includes(".tmp-") || name.endsWith(".tmp")
  }
}
